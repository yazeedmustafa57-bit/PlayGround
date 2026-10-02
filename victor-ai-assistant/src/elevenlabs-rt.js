'use strict';

// ElevenLabs Realtime-Sprachbausteine:
//   STT: Scribe v2 Realtime (Audio → Text) via WebSocket
//   TTS: Flash v2.5 (Text → Audio, ulaw_8000 für Twilio) via REST
//
// Design: reine Payload-Builder + Session-Klasse mit injizierbarem
// WebSocket/fetch, damit Tests ohne Netz + ohne Key laufen. Kein Auto-Call.

const { getElevenLabsConfig, getVoiceSettings } = require('./elevenlabs-config');

const STT_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const TTS_REST_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

function getSpeechConfig() {
  const base = getElevenLabsConfig();
  const voice = getVoiceSettings();
  return {
    apiKey: base.apiKey,
    voiceId: voice.voiceId,
    sttModel: voice.sttModel,
    ttsModel: voice.ttsModel,
    outputFormat: 'ulaw_8000', // Twilio-Pflichtformat
  };
}

// STT-Session (Scribe v2 Realtime). Caller übergibt wsFactory(url) im Test;
// live wird `ws`-Paket verwendet (lazy require).
function createSttSession({ onTranscript, wsFactory } = {}) {
  const cfg = getSpeechConfig();
  let ws = null;
  let closed = false;
  const emit = (text, isFinal) => {
    if (typeof onTranscript === 'function') {
      try { onTranscript({ text, isFinal: Boolean(isFinal) }); } catch { /* ignore */ }
    }
  };
  return {
    config: { model: cfg.sttModel },
    isOpen() { return Boolean(ws) && !closed; },
    connect() {
      if (!cfg.apiKey) {
        const err = new Error('ELEVENLABS_API_KEY missing');
        err.code = 'STT_NOT_CONFIGURED';
        throw err;
      }
      const factory = wsFactory || (() => {
        // eslint-disable-next-line global-require
        const WebSocket = require('ws');
        return new WebSocket(`${STT_WS_URL}?model_id=${encodeURIComponent(cfg.sttModel)}`, {
          headers: { 'xi-api-key': cfg.apiKey },
        });
      });
      ws = factory(`${STT_WS_URL}?model_id=${encodeURIComponent(cfg.sttModel)}`);
      if (ws && typeof ws.on === 'function') {
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data));
            if (msg && typeof msg.text === 'string') emit(msg.text, msg.is_final !== false);
          } catch { /* ignore */ }
        });
        ws.on('close', () => { closed = true; });
        ws.on('error', () => { closed = true; });
      }
      return ws;
    },
    // Twilio liefert mulaw-base64; Scribe erwartet rohes Audio base64 im Feld "audio".
    sendAudioChunk(ulawBase64) {
      if (!ws) throw new Error('STT session not connected');
      ws.send(JSON.stringify({ audio: String(ulawBase64 || '') }));
    },
    // Reine Test-/Debug-Hilfe: eingehende Server-Nachricht verarbeiten.
    handleServerMessage(raw) {
      try {
        const msg = JSON.parse(String(raw));
        if (msg && typeof msg.text === 'string') {
          emit(msg.text, msg.is_final !== false);
          return msg;
        }
      } catch { /* ignore */ }
      return null;
    },
    close() {
      closed = true;
      try { if (ws && typeof ws.close === 'function') ws.close(); } catch { /* ignore */ }
    },
  };
}

// Baut den TTS-Request für Flash v2.5 (ulaw_8000). Kein Versand hier.
function buildTtsRequest(text, overrides) {
  const cfg = getSpeechConfig();
  return {
    url: `${TTS_REST_URL}/${encodeURIComponent(overrides?.voiceId || cfg.voiceId || 'default')}`,
    method: 'POST',
    headers: { 'xi-api-key': '[[REDACTED]]', 'Content-Type': 'application/json' },
    body: {
      text: String(text || ''),
      model_id: (overrides?.model) || cfg.ttsModel,
      output_format: 'ulaw_8000',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
  };
}

// TTS-Versand (nur mit Key + Voice). Gibt { audioBase64, mime } zurück.
// fetchImpl injizierbar für Tests.
async function synthesizeSpeech(text, { fetchImpl, voiceId, model } = {}) {
  const cfg = getSpeechConfig();
  if (!cfg.apiKey) {
    const err = new Error('ELEVENLABS_API_KEY missing');
    err.code = 'TTS_NOT_CONFIGURED';
    throw err;
  }
  const vid = voiceId || cfg.voiceId;
  if (!vid) {
    const err = new Error('ELEVENLABS_VOICE_ID missing');
    err.code = 'VOICE_NOT_CONFIGURED';
    throw err;
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('No fetch implementation available');
  const res = await doFetch(`${TTS_REST_URL}/${encodeURIComponent(vid)}`, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(text || ''),
      model_id: model || cfg.ttsModel,
      output_format: 'ulaw_8000',
    }),
  });
  if (!res.ok) {
    const err = new Error(`TTS request failed: ${res.status}`);
    err.code = 'TTS_REQUEST_FAILED';
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { audioBase64: buf.toString('base64'), mime: 'audio/basic', format: 'ulaw_8000' };
}

// Teilt LLM-Streamtext in TTS-fähige Satzhäppchen (früh starten → weniger Latenz).
function splitForStreamingTts(fullText) {
  return String(fullText || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  getSpeechConfig,
  createSttSession,
  buildTtsRequest,
  synthesizeSpeech,
  splitForStreamingTts,
  STT_WS_URL,
  TTS_REST_URL,
};
