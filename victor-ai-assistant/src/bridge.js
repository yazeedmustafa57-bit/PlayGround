'use strict';

// Phase 4 – ElevenLabs Conversational-AI-Bridge (generisch, Audio-agnostisch).
//
// Aktuelle Schnittstelle (ElevenLabs-Docs, Stand 2026, verifiziert):
//   WS:   wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}
//   Auth: öffentliche Agents direkt per agent_id; private Agents per Signed-URL
//         GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=...
//         mit Header "xi-api-key" (nur serverseitig, 15 Min gültig, Key nie ans Client).
//   Init (Client -> Server, nach open):
//         { type: "conversation_initiation_client_data",
//           conversation_config_override: { agent: { first_message, language? },
//             tts: { voice_id? }, conversation: {...}, asr: {...} },
//           dynamic_variables: {...}, custom_llm_extra_body: {...}, user_id?... }
//   Client -> Server: { user_audio_chunk: base64 }, { type: "user_message", text },
//         { type: "contextual_update", text }, { type: "pong", event_id }
//   Server -> Client: conversation_initiation_metadata { conversation_id,
//         agent_output_audio_format, user_input_audio_format }, ping, audio
//         { audio_event: { audio_base_64, event_id } }, user_transcript,
//         agent_response, interruption, ...
//   Die Bridge ersetzt NICHT den Agent-Systemprompt (nur per-call first_message
//   + user_message-Briefing). Twilio folgt in späterer Phase (kein Twilio-Code hier).
//   Keine echten Verbindungen in Tests (WebSocket per Dependency Injection / Mock).

const { buildDynamicFirstGreeting } = require('./call-greeting');
const { getElevenLabsConfig } = require('./elevenlabs-config');

const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io/v1/convai/conversation';
const SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';

function buildConversationUrl(agentId) {
  return `${ELEVENLABS_WS_BASE}?agent_id=${encodeURIComponent(agentId)}`;
}

// Serverseitig: Signed-URL holen (wird in Phase 4 NICHT automatisch aufgerufen).
async function fetchSignedUrl(agentId, apiKey, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('No fetch implementation available');
  const res = await doFetch(
    `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { 'xi-api-key': apiKey } }
  );
  if (!res.ok) throw new Error(`Signed URL request failed: ${res.status}`);
  const body = await res.json();
  if (!body || !body.signed_url) throw new Error('Signed URL response invalid');
  return body.signed_url;
}

// Secrets/Telefonnummern niemals vollständig loggen.
function redactForLog(value) {
  if (typeof value !== 'string') {
    try {
      return JSON.parse(JSON.stringify(value, (k, v) => {
        if (/^(xi-api-key|api_?key)$/i.test(k)) return '[redacted]';
        return v;
      }));
    } catch {
      return '[unloggable]';
    }
  }
  return value
    .replace(/xi-api-key\s*[:=]\s*\S+/gi, 'xi-api-key: [redacted]')
    .replace(/\+?\d[\d\s\-/.]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[phone-redacted]' : m));
}

function buildInitiationPayload({ firstMessage, dynamicVariables, extraBody } = {}) {
  const payload = { type: 'conversation_initiation_client_data' };
  if (firstMessage) {
    payload.conversation_config_override = { agent: { first_message: firstMessage } };
  }
  if (dynamicVariables && typeof dynamicVariables === 'object') {
    payload.dynamic_variables = dynamicVariables;
  }
  if (extraBody && typeof extraBody === 'object') {
    payload.custom_llm_extra_body = extraBody;
  }
  return payload;
}

function buildUserMessagePayload(text) {
  return { type: 'user_message', text: String(text || '') };
}

function buildContextualUpdatePayload(text) {
  return { type: 'contextual_update', text: String(text || '') };
}

function buildAudioChunkPayload(base64Audio) {
  return { user_audio_chunk: String(base64Audio || '') };
}

function buildPongPayload(eventId) {
  return { type: 'pong', event_id: eventId };
}

function createElevenBridge(options = {}) {
  const env = getElevenLabsConfig();
  const agentId = options.agentId || env.agentId || '';
  const apiKey = options.apiKey || env.apiKey || '';
  const wsFactory = options.wsFactory || null;
  const onAudioOutput = typeof options.onAudioOutput === 'function' ? options.onAudioOutput : null;
  const logFn = typeof options.logger === 'function' ? options.logger : null;

  const events = [];
  const state = {
    status: 'idle', // idle | connecting | connected | ended | error
    conversationId: null,
    url: null,
    lastError: null,
    lastAgentResponse: null,
    lastUserTranscript: null,
    audioChunksReceived: 0,
    audioChunksSent: 0,
  };
  let ws = null;

  function log(event, detail) {
    const entry = { event, at: new Date().toISOString() };
    if (detail !== undefined) entry.detail = redactForLog(detail);
    events.push(entry);
    if (logFn) {
      try {
        logFn(entry);
      } catch { /* ignore */ }
    }
  }

  function sendObject(obj) {
    if (!ws || state.status !== 'connected' && state.status !== 'connecting') {
      throw new Error('Bridge not connected');
    }
    ws.send(JSON.stringify(obj));
  }

  function attachHandlers(socket) {
    const onOpen = () => {
      state.status = 'connected';
      log('open');
    };
    const onMessage = (data) => {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data && data.data ? data.data : data);
      handleServerMessage(text);
    };
    const onError = (err) => {
      state.status = 'error';
      state.lastError = err && err.message ? err.message : String(err);
      log('error', state.lastError);
    };
    const onClose = (code, reason) => {
      if (state.status !== 'error') state.status = 'ended';
      log('close', { code, reason: reason ? String(reason) : '' });
    };
    if (socket && typeof socket.on === 'function') {
      socket.on('open', onOpen);
      socket.on('message', onMessage);
      socket.on('error', onError);
      socket.on('close', onClose);
    } else if (socket) {
      socket.onopen = onOpen;
      socket.onmessage = (ev) => onMessage(ev && ev.data !== undefined ? ev.data : ev);
      socket.onerror = onError;
      socket.onclose = (ev) => onClose(ev && ev.code, ev && ev.reason);
    }
  }

  function handleServerMessage(rawText) {
    let msg;
    try {
      msg = JSON.parse(String(rawText));
    } catch {
      log('unparseable-message');
      return null;
    }
    const type = msg && msg.type;
    if (type === 'conversation_initiation_metadata') {
      const ev = msg.conversation_initiation_metadata_event || {};
      state.conversationId = ev.conversation_id || null;
      log('init-metadata', { conversationId: state.conversationId });
    } else if (type === 'ping') {
      const eventId = msg.ping_event && msg.ping_event.event_id;
      try {
        if (ws) ws.send(JSON.stringify(buildPongPayload(eventId)));
        log('pong-sent');
      } catch (err) {
        log('pong-failed', err && err.message);
      }
    } else if (type === 'audio') {
      state.audioChunksReceived += 1;
      const b64 = msg.audio_event && msg.audio_event.audio_base_64;
      if (b64 && onAudioOutput) {
        try {
          onAudioOutput(Buffer.from(String(b64), 'base64'));
        } catch (err) {
          log('audio-output-failed', err && err.message);
        }
      }
    } else if (type === 'user_transcript') {
      const t = msg.user_transcription_event && msg.user_transcription_event.user_transcript;
      if (t) state.lastUserTranscript = String(t);
    } else if (type === 'agent_response') {
      const r = msg.agent_response_event && msg.agent_response_event.agent_response;
      if (r) state.lastAgentResponse = String(r);
    } else if (type === 'interruption') {
      log('interruption');
    }
    return msg;
  }

  const bridge = {
    state,
    events,

    getStatus() {
      return {
        configured: Boolean(agentId && apiKey),
        agentConfigured: Boolean(agentId),
        connected: state.status === 'connected',
        status: state.status,
        conversationId: state.conversationId,
      };
    },

    buildFirstMessage(context) {
      return buildDynamicFirstGreeting(context || {});
    },

    buildInitiationPayloadForContext(context, extra) {
      const firstMessage = buildDynamicFirstGreeting(context || {});
      return buildInitiationPayload({
        firstMessage,
        dynamicVariables: extra && extra.dynamicVariables,
        extraBody: extra && extra.extraBody,
      });
    },

    buildUrl() {
      if (!agentId) {
        const err = new Error('ELEVENLABS_AGENT_ID missing');
        err.code = 'MISSING_AGENT_ID';
        throw err;
      }
      return buildConversationUrl(agentId);
    },

    connect(context) {
      if (!agentId) {
        const err = new Error('ELEVENLABS_AGENT_ID missing');
        err.code = 'MISSING_AGENT_ID';
        state.status = 'error';
        state.lastError = err.message;
        log('connect-failed', err.message);
        throw err;
      }
      if (!wsFactory) {
        const err = new Error('No WebSocket factory injected (Phase 4 test mode, no live connect)');
        err.code = 'NO_WS_FACTORY';
        state.status = 'error';
        state.lastError = err.message;
        log('connect-failed', err.message);
        throw err;
      }
      state.status = 'connecting';
      state.url = buildConversationUrl(agentId);
      log('connecting');
      ws = wsFactory(state.url);
      attachHandlers(ws);
      // Initiation wird beim 'open' gesendet? Für Mocks sofort senden,
      // sobald Socket send-bereit ist (send vorhanden). Echte Sockets:
      // open-Handler markiert connected; Initiation sendet connect() separat.
      return ws;
    },

    sendInitiation(context, extra) {
      const payload = bridge.buildInitiationPayloadForContext(context, extra);
      log('initiation-prepared');
      if (!ws) throw new Error('Bridge not connected');
      ws.send(JSON.stringify(payload));
      return payload;
    },

    sendAudio(base64Audio) {
      const payload = buildAudioChunkPayload(base64Audio);
      if (!ws) throw new Error('Bridge not connected');
      ws.send(JSON.stringify(payload));
      state.audioChunksSent += 1;
      return payload;
    },

    sendUserMessage(text) {
      const payload = buildUserMessagePayload(text);
      if (!ws) throw new Error('Bridge not connected');
      ws.send(JSON.stringify(payload));
      log('user-message-sent', { length: String(text || '').length });
      return payload;
    },

    sendContextualUpdate(text) {
      const payload = buildContextualUpdatePayload(text);
      if (!ws) throw new Error('Bridge not connected');
      ws.send(JSON.stringify(payload));
      return payload;
    },

    handleServerMessage,

    endSession() {
      try {
        if (ws && typeof ws.close === 'function') ws.close();
      } catch { /* ignore */ }
      if (state.status !== 'error') state.status = 'ended';
      log('ended');
    },
  };

  return bridge;
}

// Rückwärtskompatibilität (Phase 1-3 Tests requiren nur das Modul).
function createBridge(options = {}) {
  return createElevenBridge(options);
}

module.exports = {
  createBridge,
  createElevenBridge,
  buildConversationUrl,
  buildInitiationPayload,
  buildUserMessagePayload,
  buildContextualUpdatePayload,
  buildAudioChunkPayload,
  buildPongPayload,
  fetchSignedUrl,
  redactForLog,
  ELEVENLABS_WS_BASE,
  SIGNED_URL_ENDPOINT,
};
