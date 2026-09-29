'use strict';

// Twilio Media-Stream-Scaffolding (Phase 5, lokal, Mock-only).
//
// Zielarchitektur (später, NICHT aktiv):
//   Twilio Media Stream <-> twilio-media.js <-> ElevenLabs-Bridge <-> ElevenLabs
//
// Aktuell: reine Nachrichten-Parser/Builder ohne SDK, ohne Netzwerk.
// Audio liegt als base64 vor (Twilio: 8kHz mulaw, base64 in "media.payload").
// Die Umkodierung mulaw<->pcm erfolgt erst mit echter Bridge; hier nur
// Durchreichung + Validierung, damit Tests deterministisch bleiben.

const VALID_EVENTS = ['connected', 'start', 'media', 'stop', 'mark', 'disconnect'];

function parseStreamMessage(rawText) {
  let msg;
  try {
    msg = JSON.parse(String(rawText));
  } catch {
    const err = new Error('Invalid Twilio stream JSON');
    err.code = 'INVALID_JSON';
    throw err;
  }
  if (!msg || typeof msg.event !== 'string' || !VALID_EVENTS.includes(msg.event)) {
    const err = new Error('Unknown Twilio stream event');
    err.code = 'UNKNOWN_EVENT';
    throw err;
  }
  return msg;
}

// Extrahiert base64-Audio aus "media"-Event, validiert Form, gibt null bei leer.
function extractAudioPayload(msg) {
  if (!msg || msg.event !== 'media') return null;
  const payload = msg.media && msg.media.payload;
  if (typeof payload !== 'string' || !payload) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
    const err = new Error('Invalid audio payload encoding');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  return payload;
}

function buildMediaMessage(streamSid, base64Audio) {
  return {
    event: 'media',
    streamSid: String(streamSid || ''),
    media: { payload: String(base64Audio || '') },
  };
}

function buildMarkMessage(streamSid, markName) {
  return {
    event: 'mark',
    streamSid: String(streamSid || ''),
    mark: { name: String(markName || 'victor-mark') },
  };
}

// Minimaler TwiML-Builder für spätere Voice-Webhooks (statisch, keine Secrets).
function buildVoiceTwiml({ streamUrl } = {}) {
  const url = String(streamUrl || '').replace(/[<>&'"]/g, '');
  const streamPart = url
    ? `    <Stream url="${url}" />`
    : '    <!-- Stream-URL folgt in späterer Phase -->';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    streamPart,
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

module.exports = {
  parseStreamMessage,
  extractAudioPayload,
  buildMediaMessage,
  buildMarkMessage,
  buildVoiceTwiml,
  VALID_EVENTS,
};
