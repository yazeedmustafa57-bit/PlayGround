'use strict';

// Orchestrator: Text-Chat → Anruf-Session → Live-Transkript.
// Ablauf: instruct() parst Anweisung (lokal, deterministisch) → startCall()
// legt eine Session an. Ist der ElevenLabs-SIP-Trunk konfiguriert, wird der
// Anruf nur nach ausdrücklicher Bestätigung und erfolgreicher Live-Prüfung
// über die native Outbound-API ausgelöst. Ohne Konfiguration bleibt es bei
// einer klar gekennzeichneten Session ohne Anruf (kein Twilio, kein Fake).
// Im Live-Betrieb übernimmt der ElevenLabs Conversational AI Agent das
// Gespräch (Audio ↔ Agent ↔ Audio, siehe bridge.js).
// Alles In-Memory, keine DB.
// Kein externes LLM (kein ChatGPT): Die Dialoglogik liegt beim Agenten.

const { parseInstruction, buildCallSystemPrompt } = require('./instruction');
const { toE164 } = require('./phone-number');
const { getAppConfig } = require('./app-config');
const telephony = require('./telephony-config');

const sessions = new Map(); // id -> session
const dashboardSockets = new Set(); // WS-Clients für Live-Transkript

function newId(prefix) {
  return `${prefix || 'call'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function broadcastinect(event) {
  const text = JSON.stringify(event);
  for (const ws of dashboardSockets) {
    try {
      if (ws.readyState === 1) ws.send(text);
    } catch { /* ignore */ }
  }
}

const CALL_ERROR_TEXT = {
  'not-configured': 'Telefonie ist nicht konfiguriert.',
  'outbound-not-supported': 'Der SIP-Trunk ist für ausgehende Anrufe nicht freigegeben.',
  'outbound-trunk-missing': 'Am SIP-Trunk fehlt die ausgehende Konfiguration.',
  'agent-mismatch': 'Die SIP-Nummer ist einem anderen ElevenLabs-Agenten zugeordnet.',
  'not-a-sip-trunk': 'Die Nummer ist keinem SIP-Trunk zugeordnet.',
  'TELEPHONY_PROVIDER_REJECTED': 'Der Telefonie-Anbieter hat den Anruf nicht gestartet.',
};

function describeCallError(code) {
  const value = code == null ? '' : String(code);
  if (!value) return null;

  const sip = /^sip-(\d{3})$/.exec(value);
  if (sip) {
    if (sip[1] === '603') {
      return 'SIP 603: Anruf vom Provider abgelehnt. Mögliche Ursachen: CallerID, ausgehende Freigabe/Guthaben oder Zielnummer prüfen.';
    }
    if (sip[1] === '401' || sip[1] === '407') {
      return `SIP ${sip[1]}: Anmeldung am SIP-Trunk fehlgeschlagen.`;
    }
    if (sip[1] === '403') {
      return 'SIP 403: Provider verweigert den Anruf. Freigabe, CallerID und IP-Freigabe prüfen.';
    }
    if (sip[1] === '404' || sip[1] === '484') {
      return `SIP ${sip[1]}: Zielnummer ungültig oder nicht erreichbar.`;
    }
    return `SIP ${sip[1]}: Anruf vom Telefonie-Provider abgelehnt.`;
  }

  const http = /^TELEPHONY_PROVIDER_(\d+)$/.exec(value);
  if (http) return `Der Telefonie-Anbieter hat den Anruf abgelehnt (HTTP ${http[1]}).`;
  if (/^phone-number-http-(\d+)$/.test(value)) {
    return 'ElevenLabs konnte die SIP-Nummer nicht laden. API-Key und Nummern-ID prüfen.';
  }
  return CALL_ERROR_TEXT[value] || null;
}

function publicSession(s) {
  return {
    id: s.id,
    to: s.to,
    contactName: s.contactName,
    goal: s.goal,
    purpose: s.purpose,
    status: s.status,
    simulated: s.simulated,
    provider: s.provider === undefined ? null : s.provider,
    callRef: s.callRef || null,
    conversationId: s.conversationId || null,
    error: s.error || null,
    errorText: describeCallError(s.error),
    createdAt: s.createdAt,
    transcript: s.transcript.slice(),
  };
}

function appendTranscript(session, speaker, text) {
  const entry = { at: new Date().toISOString(), speaker, text: String(text || '') };
  session.transcript.push(entry);
  broadcastinect({ type: 'transcript', callId: session.id, entry });
  return entry;
}

// Schritt 1–2: Anweisung verstehen (lokal, deterministisch, kein Netz).
async function instruct(instruction) {
  const plan = parseInstruction(instruction);
  return {
    ok: true,
    instruction: String(instruction || ''),
    to: plan.to,
    contactName: plan.contactName,
    goal: plan.goal,
    purpose: plan.purpose,
    needsNumber: !plan.to,
    source: plan.source,
  };
}

// Schritt 3: Anruf-Session anlegen und – nur wenn konfiguriert, verifiziert
// und ausdrücklich bestätigt – über den ElevenLabs-SIP-Trunk auslösen.
// Ohne Konfiguration wird bewusst kein Anbieter aufgerufen und kein
// Fake-Erfolg erzeugt.
async function startCall({
  instruction,
  to,
  contactName,
  goal,
  confirm,
  fetchImpl,
  timeoutMs,
} = {}) {
  const plan = parseInstruction(instruction || goal || '');
  const rawTarget = (to || plan.to || '').trim();
  const target = toE164(rawTarget);
  if (!target) {
    const err = new Error(
      rawTarget
        ? 'Ungültige Zielnummer – bitte im Format +49... oder 01... angeben.'
        : 'Zielnummer fehlt – bitte im Chat eine Nummer angeben.'
    );
    err.code = rawTarget ? 'INVALID_TO' : 'MISSING_TO';
    throw err;
  }
  const app = getAppConfig();
  const session = {
    id: newId('call'),
    to: target,
    contactName: contactName || plan.contactName || null,
    goal: goal || plan.goal || instruction || '',
    message: plan.message || null,
    purpose: plan.purpose || null,
    status: 'telephony-unavailable',
    simulated: true,
    provider: null,
    callRef: null,
    error: null,
    systemPrompt: buildCallSystemPrompt({
      agentName: app.agentName,
      goal: goal || plan.goal,
      contactName: contactName || plan.contactName,
    }),
    messages: [
      { role: 'system', content: buildCallSystemPrompt({
        agentName: app.agentName, goal: goal || plan.goal, contactName: contactName || plan.contactName,
      }) },
    ],
    transcript: [],
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);

  if (!telephony.isTelephonyConfigured()) {
    appendTranscript(
      session,
      'victor',
      `Kein Telefonie-Backend konfiguriert – Anruf an ${target} nicht gestartet. Ziel: ${session.goal}`
    );
    broadcastinect({ type: 'call-status', callId: session.id, status: session.status });
    return publicSession(session);
  }

  session.provider = 'elevenlabs-sip';

  // Stufe 1: ausdrückliche Bestätigung durch den Menschen (kein Auto-Dial).
  if (confirm !== true) {
    session.status = 'confirmation-required';
    appendTranscript(
      session,
      'victor',
      `Bestätigung erforderlich – Anruf an ${target} wurde noch nicht gestartet.`
    );
    broadcastinect({ type: 'call-status', callId: session.id, status: session.status });
    return publicSession(session);
  }

  // Stufe 2: bestehende Nummer live prüfen (read-only, gecacht).
  const verification = await telephony.verifyTelephonyConfig({ fetchImpl, timeoutMs });
  if (!verification.verified || verification.supportsOutbound !== true) {
    session.status = 'telephony-unverified';
    session.error = verification.verificationError || 'outbound-not-verified';
    appendTranscript(
      session,
      'victor',
      `Telefonie nicht verifiziert (${session.error}) – Anruf an ${target} nicht gestartet.`
    );
    broadcastinect({ type: 'call-status', callId: session.id, status: session.status });
    return publicSession(session);
  }

  // Stufe 3: echter Anruf über den bereits verbundenen SIP-Trunk.
  try {
    const result = await telephony.startOutboundCall({ toNumber: target, fetchImpl, timeoutMs });
    session.status = 'dialing';
    session.simulated = false;
    session.conversationId = result.conversationId || null;
    session.callRef = result.conversationId || result.sipCallId || null;
    appendTranscript(session, 'victor', `Anruf an ${target} über ElevenLabs SIP-Trunk gestartet.`);
  } catch (err) {
    session.status = 'call-failed';
    session.simulated = false;
    session.error = err && err.code ? String(err.code) : 'TELEPHONY_ERROR';
    appendTranscript(
      session,
      'victor',
      `Anruf an ${target} konnte nicht gestartet werden (${session.error}).`
    );
  }

  broadcastinect({ type: 'call-status', callId: session.id, status: session.status });
  return publicSession(session);
}

function getSession(id) {
  return sessions.get(id) || null;
}

// Holt für native SIP-Anrufe das echte Transkript von ElevenLabs nach.
// Best-effort: Fehler werden gespeichert, aber nie als Erfolg dargestellt.
async function syncSessionTranscript(callId, { fetchImpl, timeoutMs, force = false } = {}) {
  const session = sessions.get(callId);
  if (!session) return null;
  if (!session.conversationId) return session;
  const terminal = session.status === 'completed' || session.status === 'call-failed';
  if (terminal && session.transcriptSyncedAt && !force) return session;
  if (!force && session.transcriptSyncedAt && Date.now() - session.transcriptSyncedAt < 15_000) return session;

  try {
    const details = await telephony.getConversationDetails(session.conversationId, { fetchImpl, timeoutMs });
    if (details.transcript.length > 0) {
      session.transcript = details.transcript;
      broadcastinect({ type: 'transcript-reset', callId: session.id });
    }
    session.transcriptSyncedAt = Date.now();
    session.transcriptSyncError = null;
    if (details.status === 'done') session.status = 'completed';
    else if (details.status === 'failed') {
      session.status = 'call-failed';
      session.error = details.errorCode ? `sip-${details.errorCode}` : (details.callResult || 'conversation-failed');
    } else if (details.status === 'in-progress') session.status = 'in-progress';
    else if (details.status === 'processing') session.status = 'processing';
    broadcastinect({ type: 'call-status', callId: session.id, status: session.status });
  } catch (err) {
    session.transcriptSyncError = err && err.code ? String(err.code) : 'transcript-unavailable';
  }
  return session;
}

function findSessionByCallRef(callRef) {
  if (!callRef) return null;
  for (const s of sessions.values()) {
    if (s.callRef === callRef) return s;
  }
  return null;
}

function setSessionStatus(id, status) {
  const s = sessions.get(id);
  if (!s) return null;
  s.status = status;
  broadcastinect({ type: 'call-status', callId: s.id, status });
  return s;
}

function listSessions() {
  return [...sessions.values()].map(publicSession);
}

function clearSessions() {
  sessions.clear();
}

// Schritt 5–8 (Media-Stream-Pipeline, austauschbar):
// Im Live-Betrieb antwortet der ElevenLabs-Agent direkt (bridge.js).
// Diese Funktion bildet das für Tests/Simulation ab: Die Antwort kommt vom
// injizierten Agent-Adapter (agentReply) – ohne Adapter gibt es eine klar
// gekennzeichnete lokale Platzhalter-Antwort (kein Fake-LLM).
async function handleCallerUtterance(callId, callerText, { agentReply, llmStream, tts, sendAudio } = {}) {
  const session = sessions.get(callId);
  if (!session) {
    const err = new Error('Unknown call id');
    err.code = 'UNKNOWN_CALL';
    throw err;
  }
  appendTranscript(session, 'caller', callerText);
  session.messages.push({ role: 'user', content: String(callerText || '') });

  const answer = agentReply || llmStream; // llmStream nur aus Kompatibilität, wird nicht mehr verwendet
  let reply = '';
  if (answer) {
    reply = await answer(session.messages);
  } else {
    reply = `Verstanden. Ich kümmere mich um: ${session.goal} (lokale Antwort, ElevenLabs-Agent nicht verbunden).`;
  }
  session.messages.push({ role: 'assistant', content: reply });
  appendTranscript(session, 'victor', reply);

  if (tts && sendAudio) {
    const { splitForStreamingTts } = require('./elevenlabs-rt');
    for (const sentence of splitForStreamingTts(reply)) {
      const audio = await tts(sentence);
      if (audio && audio.audioBase64) await sendAudio(audio.audioBase64);
    }
  }
  return { reply };
}

module.exports = {
  instruct,
  startCall,
  getSession,
  syncSessionTranscript,
  findSessionByCallRef,
  setSessionStatus,
  listSessions,
  clearSessions,
  appendTranscript,
  describeCallError,
  handleCallerUtterance,
  dashboardSockets,
  broadcastinect,
};
