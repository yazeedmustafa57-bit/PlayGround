'use strict';

// Phase 3 – lokaler Gesprächszustand, vollständig deterministisch, nur Speicher.
// Keine DB, keine externen Dienste, keine Hardcodes von echten Daten.

const { classifyCallPurpose, cleanMessageText } = require('./call-purpose');

const COLLECTION_MODES = ['idle', 'collecting_contact', 'collecting_message', 'collecting_appointment'];

function createInitialState() {
  return {
    purpose: null,
    contactName: null,
    phoneNumber: null,
    message: null,
    requestedTime: null,
    requestedDate: null,
    callerName: null,
    notes: null,
    collectionMode: 'idle',
  };
}

function cloneState(state) {
  return { ...createInitialState(), ...(state || {}) };
}

function cleanName(raw) {
  if (!raw) return null;
  const word = String(raw).trim().split(/\s+/)[0].replace(/[.,;:!?)"'»«]+$/g, '');
  if (!word || word.length < 2) return null;
  const lower = word.toLowerCase();
  if (['ihm', 'ihr', 'ihnen', 'mir', 'dir', 'uns', 'mich', 'dich', 'ihn', 'sie'].includes(lower)) return null;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function extractContactName(text) {
  const s = String(text || '');
  let m;
  m = s.match(/(?:er|sie|es)\s+hei[sß]t\s+([A-Za-zäöüÄÖÜß][A-Za-zäöüÄÖÜß-]*)/i);
  if (m) {
    const n = cleanName(m[1]);
    if (n) return n;
  }
  m = s.match(/(?:sein(?:er)?|ihr(?:er)?)\s+name\s+ist\s+([A-Za-zäöüÄÖÜß][A-Za-zäöüÄÖÜß-]*)/i);
  if (m) {
    const n = cleanName(m[1]);
    if (n) return n;
  }
  m = s.match(/\bmit\s+([A-ZÄÖÜ][A-Za-zäöüÄÖÜß-]{1,30})\b/);
  if (m) {
    const n = cleanName(m[1]);
    if (n) return n;
  }
  m = s.match(/\bfür\s+([A-ZÄÖÜ][A-Za-zäöüÄÖÜß-]{1,30})\b/);
  if (m) {
    const n = cleanName(m[1]);
    if (n) return n;
  }
  m = s.match(/\bkontakt\s+ist\s+([A-Za-zäöüÄÖÜß][A-Za-zäöüÄÖÜß-]*)/i);
  if (m) {
    const n = cleanName(m[1]);
    if (n) return n;
  }
  return null;
}

function extractCallerName(text) {
  const s = String(text || '');
  let m;
  m = s.match(/\bich\s+hei[sß]e\s+([A-Za-zäöüÄÖÜß][A-Za-zäöüÄÖÜß-]*)/i);
  if (m) return cleanName(m[1]);
  m = s.match(/\bich\s+bin\s+([A-ZÄÖÜ][A-Za-zäöüÄÖÜß-]{1,30})\b/);
  if (m) return cleanName(m[1]);
  m = s.match(/\bmein\s+name\s+ist\s+([A-Za-zäöüÄÖÜß][A-Za-zäöüÄÖÜß-]*)/i);
  if (m) return cleanName(m[1]);
  return null;
}

function normalizePhoneNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}

function extractPhoneNumber(text) {
  const s = String(text || '');
  const candidates =
    s.match(/(?:\+49[\s\-/.]*\(?\d[\d\s\-/.()]{5,}\d|0\d{2,4}[\s\-/.]*\d[\d\s\-/.]{4,}\d)/g) || [];
  for (const cand of candidates) {
    const digits = cand.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      const norm = normalizePhoneNumber(cand);
      if (norm) return norm;
    }
  }
  return null;
}

function extractDateTime(text) {
  const s = String(text || '');
  let requestedDate = null;
  let requestedTime = null;

  const dateMatch = s.match(
    /\b(übermorgen|uebermorgen|morgen|heute|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|nächste woche|naechste woche)\b/i
  );
  if (dateMatch) requestedDate = dateMatch[1].trim();

  const timeMatch = s.match(/((gegen|um)\s+)?\d{1,2}(:\d{2})?\s*Uhr/i) || s.match(/\bum\s+\d{1,2}(:\d{2})?\b/i);
  if (timeMatch) requestedTime = timeMatch[0].trim();

  return { requestedDate, requestedTime };
}

function hasCallIntent(text) {
  return /ruf|anruf|anrufen|telefon/i.test(String(text || ''));
}

function updateCollectionMode(state) {
  const s = state;
  if (!s.contactName && !s.phoneNumber) {
    if (s.purpose || s.message || s.requestedDate || s.requestedTime || s.callerName) {
      return 'collecting_contact';
    }
    return s.collectionMode === 'idle' ? 'idle' : 'collecting_contact';
  }
  if ((s.purpose === 'Nachricht übermitteln') && !s.message) return 'collecting_message';
  if ((s.purpose === 'Termin vereinbaren' || s.purpose === 'Termin verschieben') && !s.requestedDate && !s.requestedTime) {
    return 'collecting_appointment';
  }
  if (!s.purpose && (!s.message)) {
    // Kontakt da, aber Zweck fehlt -> weiter fragen, nicht idle
    return 'collecting_message';
  }
  return 'idle';
}

// Verarbeitet EINE Benutzernachricht, ergänzt Zustand monoton (kein Löschen).
// Message wird NUR bei expliziter Nachrichten-Absicht gesetzt (kein Längen-Fallback).
// Telefon/Name/Datum werden nie als Nachricht gespeichert.
function processUserMessage(prevState, rawText) {
  const state = cloneState(prevState);
  const text = String(rawText || '').trim();
  if (!text) {
    state.collectionMode = updateCollectionMode(state);
    return { state, textPurpose: null };
  }

  const phone = extractPhoneNumber(text);
  if (phone) state.phoneNumber = phone;

  const caller = extractCallerName(text);
  if (caller) state.callerName = caller;

  const contact = extractContactName(text);
  if (contact && !caller) {
    // "Ich heiße X" ist Caller, nicht Kontakt (bereits getrennt)
    state.contactName = contact;
  }

  const { requestedDate, requestedTime } = extractDateTime(text);
  if (requestedDate) state.requestedDate = requestedDate;
  if (requestedTime) state.requestedTime = requestedTime;

  const textPurpose = classifyCallPurpose(text);
  if (textPurpose) state.purpose = textPurpose;

  // Nachricht nur bei expliziter Nachrichten-Absicht in DIESEM Satz
  if (textPurpose === 'Nachricht übermitteln' && !phone) {
    const cleaned = cleanMessageText(text);
    const isTechnical =
      /hier die nummer|seine nummer|ihre nummer|telefonnummer|er hei[sß]t|sie hei[sß]t/i.test(text);
    if (cleaned && cleaned.length >= 3 && !isTechnical) {
      state.message = cleaned;
    }
  }

  // Sammelmodus bestimmen (mit Call-Intent-Fallback)
  let mode = updateCollectionMode(state);
  if (mode === 'idle' && !state.contactName && !state.phoneNumber && hasCallIntent(text)) {
    mode = 'collecting_contact';
  }
  if (!state.contactName && !state.phoneNumber && (textPurpose || hasCallIntent(text) || requestedDate || requestedTime)) {
    mode = 'collecting_contact';
  }
  state.collectionMode = mode;

  return { state, textPurpose };
}

function getCallStatus() {
  return { status: 'idle', phase: 3 };
}

function startCallPlaceholder() {
  throw new Error('Not implemented in Phase 3 – nur lokale Logik, keine Anrufe.');
}

module.exports = {
  createInitialState,
  processUserMessage,
  extractContactName,
  extractCallerName,
  extractPhoneNumber,
  normalizePhoneNumber,
  extractDateTime,
  updateCollectionMode,
  getCallStatus,
  startCallPlaceholder,
  COLLECTION_MODES,
};
