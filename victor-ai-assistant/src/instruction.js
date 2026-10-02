'use strict';

// Lokale Anweisungs-Erkennung (kein externes LLM, kein Netz).
// Die Dialoglogik im Gespräch übernimmt der ElevenLabs Conversational AI
// Agent (Audio ↔ Agent ↔ Audio); hier geht es nur um Schritt 1–2:
// Zielnummer + Gesprächsziel aus der Text-Anweisung verstehen.

const { processUserMessage, createInitialState } = require('./call-controller');

// Deterministisch, erfindet NIEMALS eine Nummer (to = null wenn keine dasteht).
function parseInstruction(instruction) {
  const text = String(instruction || '').trim();
  const { state } = processUserMessage(createInitialState(), text);
  return {
    to: state.phoneNumber || null,
    contactName: state.contactName || null,
    goal: text,
    purpose: state.purpose || null,
    requestedDate: state.requestedDate || null,
    requestedTime: state.requestedTime || null,
    message: state.message || null,
    state,
    source: 'local',
  };
}

// Per-Call-Kontext für den ElevenLabs-Agenten (wird als first_message +
// user_message-Briefing übergeben, ersetzt NICHT den Agent-Systemprompt).
function buildCallSystemPrompt({ agentName, goal, contactName }) {
  const name = agentName || 'Victor';
  return [
    `Du bist ${name}, ein KI-Telefonassistent. Du rufst gerade an und sprichst Deutsch.`,
    'Stelle dich zu Beginn kurz als KI-Assistent vor.',
    contactName ? `Gesprächspartner: ${contactName}.` : 'Gesprächspartner: unbekannt.',
    `Gesprächsziel: ${goal || 'Anliegen sachlich klären'}.`,
    'Regeln: keine erfundenen Infos, keine technischen Details über Twilio/ElevenLabs, höflich und kurz (max. 2 Sätze pro Antwort).',
  ].join('\n');
}

module.exports = { parseInstruction, buildCallSystemPrompt };
