'use strict';

// Provider-neutrales Media-Stream-Nachrichtenformat.
//
// Dieses Modul beschreibt das JSON-Framing, mit dem ein Telefonie-Gateway
// (z. B. eine künftige SIP-/Zadarma-Anbindung) Audio an den Server schickt
// und zurückerhält. Es ist bewusst unabhängig von einem konkreten Anbieter
// und enthält kein SDK, kein Netzwerk und keine Anbieter-Zugangsdaten.
//
// Audio liegt als base64 vor (klassisch: 8 kHz mulaw). Die Umkodierung
// mulaw<->pcm erfolgt in audio-codec.js / live-bridge.js.

const VALID_EVENTS = ['connected', 'start', 'media', 'stop', 'mark', 'disconnect'];

function parseStreamMessage(rawText) {
  let msg;
  try {
    msg = JSON.parse(String(rawText));
  } catch {
    const err = new Error('Invalid media stream JSON');
    err.code = 'INVALID_JSON';
    err.reason = 'invalid-json';
    throw err;
  }
  if (!msg || typeof msg.event !== 'string' || !VALID_EVENTS.includes(msg.event)) {
    const err = new Error('Unknown media stream event');
    err.code = 'UNKNOWN_EVENT';
    err.reason = 'unknown-event';
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
    err.reason = 'invalid-payload-encoding';
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

module.exports = {
  parseStreamMessage,
  extractAudioPayload,
  buildMediaMessage,
  buildMarkMessage,
  VALID_EVENTS,
};
