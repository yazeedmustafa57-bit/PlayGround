'use strict';

// Phase 3 – lokale Schutzschicht für persönliche Daten.
// Grundsatz: Nur Daten verwenden, die der Benutzer im aktuellen Auftrag
// ausdrücklich angegeben hat. Keine Hardcodes, keine erfundenen Daten,
// keine Persistenz, keine Weitergabe an externe Dienste.

const ALLOWED_FIELDS = [
  'purpose',
  'contactName',
  'phoneNumber',
  'message',
  'requestedTime',
  'requestedDate',
  'callerName',
  'notes',
  'collectionMode',
];

function getPolicySummary() {
  return {
    personalData: 'explicit-input-only',
    storage: 'memory-only',
    externalSharing: 'none',
    secrets: 'via-env-only',
    phase: 3,
  };
}

// Entfernt unerlaubte Felder, trimmt Strings, behält nur explizite Eingaben.
function sanitizeState(state) {
  const input = state && typeof state === 'object' ? state : {};
  const out = {};
  for (const key of ALLOWED_FIELDS) {
    const value = input[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      out[key] = trimmed ? trimmed : null;
    } else {
      out[key] = value == null ? null : value;
    }
  }
  if (out.collectionMode == null) out.collectionMode = 'idle';
  return out;
}

// Prüft, ob ein Feld aus expliziter Benutzereingabe stammen darf.
// Hier: alles ablehnen, was leer ist oder nach technischem Platzhalter aussieht.
function isExplicitlyProvided(value) {
  if (typeof value !== 'string') return value != null;
  const t = value.trim();
  if (!t) return false;
  if (/^(test|beispiel|xxx|123)$/i.test(t)) return false;
  return true;
}

// Maskiert Telefonnummern für Logs/Anzeigen (letzte 3 Ziffern sichtbar).
function redactForLogging(state) {
  const clean = sanitizeState(state);
  if (typeof clean.phoneNumber === 'string' && clean.phoneNumber.length > 3) {
    const digits = clean.phoneNumber.replace(/\D/g, '');
    const visible = digits.slice(-3).padStart(Math.min(digits.length, 6), '*');
    clean.phoneNumber = `***${visible}`;
  }
  return clean;
}

module.exports = {
  getPolicySummary,
  sanitizeState,
  isExplicitlyProvided,
  redactForLogging,
  ALLOWED_FIELDS,
};
