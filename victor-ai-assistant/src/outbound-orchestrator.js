'use strict';

// Orchestrator: Text-Chat → ausgehender Anruf → Live-Transkript.
// Ablauf: instruct() parst Anweisung (lokal, deterministisch) → startCall()
// legt Session an + startet Twilio (oder simuliert) → im Live-Betrieb
// übernimmt der ElevenLabs Conversational AI Agent das Gespräch
// (Audio ↔ Agent ↔ Audio, siehe bridge.js). Alles In-Memory, keine DB.
// Kein externes LLM (kein ChatGPT): Die Dialoglogik liegt beim Agenten.

const { parseInstruction, buildCallSystemPrompt } = require('./instruction');
const { startOutboundCall, toE164 } = require('./twilio-voice');
const { getAppConfig } = require('./app-config');

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

function publicSession(s) {
  return {
    id: s.id,
    to: s.to,
    contactName: s.contactName,
    goal: s.goal,
    purpose: s.purpose,
    status: s.status,
    simulated: s.simulated,
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

// Schritt 3: Anruf starten (Twilio oder Simulation).
async function startCall({ instruction, to, contactName, goal, twilioClient } = {}) {
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
  const result = await startOutboundCall({ to: target, client: twilioClient });
  const session = {
    id: newId('call'),
    to: target,
    contactName: contactName || plan.contactName || null,
    goal: goal || plan.goal || instruction || '',
    purpose: plan.purpose || null,
    status: result.simulated ? 'simulated-ringing' : 'ringing',
    simulated: result.simulated,
    twilioSid: result.sid,
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
  appendTranscript(session, 'victor', `Anruf ${result.simulated ? '(Simulation) ' : ''}an ${target} gestartet. Ziel: ${session.goal}`);
  broadcastinect({ type: 'call-status', callId: session.id, status: session.status });
  return publicSession(session);
}

function getSession(id) {
  return sessions.get(id) || null;
}

function findSessionByTwilioSid(twilioSid) {
  if (!twilioSid) return null;
  for (const s of sessions.values()) {
    if (s.twilioSid === twilioSid) return s;
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
  findSessionByTwilioSid,
  setSessionStatus,
  listSessions,
  clearSessions,
  appendTranscript,
  handleCallerUtterance,
  dashboardSockets,
  broadcastinect,
};
