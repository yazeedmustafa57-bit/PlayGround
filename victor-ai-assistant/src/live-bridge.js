'use strict';

// Live-Bridge: Twilio Media Stream <-> ElevenLabs Conversational AI Agent.
// Ablauf: Signed-URL holen (Server, Key nie ans Telefon) -> ConvAI-WebSocket
// -> Initiierung mit first_message + dynamic_variables -> Briefing als
// user_message -> Audio beide Richtungen (Formate aus Initiation-Metadaten).
// Alles injizierbar (wsFactory/fetchImpl), damit Tests ohne Netz laufen.
// Secrets landen nie in Logs (redactForLog aus bridge.js).

const {
  mulawBase64ToPcm16,
  pcm16ToMulawBase64,
  upsample8kTo16k,
  downsample16kTo8k,
  pcm16ToBytesLE,
  bytesLEToPcm16,
} = require('./audio-codec');
const { redactForLog } = require('./bridge');

const SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const CONNECT_TIMEOUT_MS = 15000;

function parseRate(format, fallback) {
  const m = /(\d+)\s*$/.exec(String(format || ''));
  const rate = m ? Number.parseInt(m[1], 10) : NaN;
  return Number.isSafeInteger(rate) ? rate : fallback;
}

// Twilio-mulaw (8k) -> Format, das der Agent als Input gemeldet hat.
function encodeUserAudio(mulawB64, inputFormat) {
  const fmt = String(inputFormat || 'pcm_16000');
  if (fmt.startsWith('ulaw')) return String(mulawB64 || '');
  const pcm8k = mulawBase64ToPcm16(mulawB64);
  const rate = parseRate(fmt, 16000);
  const pcm = rate >= 16000 ? upsample8kTo16k(pcm8k) : pcm8k;
  return pcm16ToBytesLE(pcm).toString('base64');
}

// Agent-Audio -> Twilio-mulaw (8k base64).
function decodeAgentAudio(audioB64, outputFormat) {
  const fmt = String(outputFormat || 'pcm_16000');
  if (fmt.startsWith('ulaw')) return String(audioB64 || '');
  const raw = Buffer.from(String(audioB64 || ''), 'base64');
  const rate = parseRate(fmt, 16000);
  const pcm = rate >= 16000 ? downsample16kTo8k(bytesLEToPcm16(raw)) : bytesLEToPcm16(raw);
  return pcm16ToMulawBase64(pcm);
}

async function fetchSignedUrl(agentId, apiKey, fetchImpl, timeoutMs) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('No fetch implementation available');
  if (!agentId) {
    const err = new Error('ELEVENLABS_AGENT_ID missing');
    err.code = 'MISSING_AGENT_ID';
    throw err;
  }
  if (!apiKey) {
    const err = new Error('ELEVENLABS_API_KEY missing');
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  // Begrenzte Wartezeit: Ein hängender Signing-Request darf den Bridge-Aufbau
  // nicht still für immer blockieren (sonst: ewig bridge-not-created).
  const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Signed URL request timeout');
      err.code = 'SIGNED_URL_TIMEOUT';
      reject(err);
    }, limit);
  });
  try {
    const res = await Promise.race([
      doFetch(
        `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { 'xi-api-key': apiKey } }
      ),
      timeout,
    ]);
    if (!res.ok) {
      const err = new Error(`Signed URL request failed: ${res.status}`);
      err.code = 'SIGNED_URL_FAILED';
      throw err;
    }
    const body = await res.json();
    if (!body || !body.signed_url) {
      const err = new Error('Signed URL response invalid');
      err.code = 'SIGNED_URL_INVALID';
      throw err;
    }
    return body.signed_url;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createLiveBridge(options = {}) {
  const agentId = options.agentId || '';
  const apiKey = options.apiKey || '';
  // first_message bleibt ABSICHTLICH leer (null), sofern der Aufrufer keine
  // übergibt: Der Agent formuliert die Eröffnung selbst aus dem Kontext.
  // Eine Default-Schablone hier würde wieder wörtlich gesprochen (Skript!).
  const firstMessage = options.firstMessage || null;
  const dynamicVariables = options.dynamicVariables && typeof options.dynamicVariables === 'object'
    ? options.dynamicVariables
    : {};
  const briefing = typeof options.briefing === 'string' ? options.briefing : '';
  const wsFactory = options.wsFactory || null;
  const fetchImpl = options.fetchImpl || null;
  const onAgentAudio = typeof options.onAgentAudio === 'function' ? options.onAgentAudio : null;
  const onUserTranscript = typeof options.onUserTranscript === 'function' ? options.onUserTranscript : null;
  const onAgentResponse = typeof options.onAgentResponse === 'function' ? options.onAgentResponse : null;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  const state = {
    status: 'idle', // idle | connecting | live | ended | error
    conversationId: null,
    inputFormat: 'pcm_16000',
    outputFormat: 'pcm_16000',
    lastError: null,
    audioToAgent: 0,
    audioToTwilio: 0,
  };
  const events = [];
  let ws = null;
  let briefingSent = false;

  // Diagnose-Zähler (nur Zählung/Logs, kein Einfluss auf Audiofluss).
  const tStart = Date.now();
  const diag = {
    audioReceivedFromTwilio: 0,
    audioRejected: 0,
    audioForwardedToElevenLabs: 0,
    firstInboundAudioAt: null,
    lastInboundAudioAt: null,
    firstAudioToAgentAt: null,
    lastAudioToAgentAt: null,
    elevenLabsOpened: false,
    elevenLabsErrors: 0,
    elevenLabsCloseCode: null,
    summaryEmitted: false,
  };

  function stamp(field) {
    const at = new Date().toISOString();
    if (!diag[field]) diag[field] = at;
    return at;
  }

  function log(event, detail) {
    const entry = { event, at: new Date().toISOString() };
    if (detail !== undefined) entry.detail = redactForLog(detail);
    events.push(entry);
    if (onEvent) {
      try { onEvent(entry); } catch { /* ignore */ }
    }
  }

  function send(obj) {
    if (!ws) throw new Error('LiveBridge not connected');
    ws.send(JSON.stringify(obj));
  }

  function sendInitiation() {
    const payload = { type: 'conversation_initiation_client_data' };
    // Override NUR bei explizit übergebener first_message (sonst formuliert
    // der Agent die Eröffnung selbst aus Briefing + Dynamic Variables).
    if (firstMessage) {
      payload.conversation_config_override = { agent: { first_message: firstMessage } };
    }
    if (Object.keys(dynamicVariables).length) payload.dynamic_variables = dynamicVariables;
    send(payload);
    log('initiation-sent');
  }

  // Briefing als contextual_update (NICHT user_message): Hintergrundwissen,
  // das keinen Antwort-Turn auslöst. Als user_message würde der Agent es als
  // neue Anweisung vom Gegenüber lesen und in den Planungsmodus fallen
  // („Möchtest du, dass ich X anrufe?“) statt zu handeln.
  function sendBriefing() {
    if (briefingSent || !briefing) return;
    briefingSent = true;
    send({ type: 'contextual_update', text: briefing });
    log('briefing-sent', { length: briefing.length });
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      log('unparseable');
      return null;
    }
    const type = msg && msg.type;
    if (type === 'conversation_initiation_metadata') {
      const ev = msg.conversation_initiation_metadata_event || {};
      state.conversationId = ev.conversation_id || null;
      if (ev.user_input_audio_format) state.inputFormat = ev.user_input_audio_format;
      if (ev.agent_output_audio_format) state.outputFormat = ev.agent_output_audio_format;
      state.status = 'live';
      log('live', { conversationId: state.conversationId, in: state.inputFormat, out: state.outputFormat });
      sendBriefing();
    } else if (type === 'ping') {
      const eventId = msg.ping_event && msg.ping_event.event_id;
      try {
        send({ type: 'pong', event_id: eventId });
      } catch (err) {
        log('pong-failed', err && err.message);
      }
    } else if (type === 'audio') {
      const b64 = msg.audio_event && msg.audio_event.audio_base_64;
      if (b64) {
        state.audioToTwilio += 1;
        if (onAgentAudio) {
          try {
            onAgentAudio(decodeAgentAudio(String(b64), state.outputFormat));
          } catch (err) {
            log('audio-decode-failed', err && err.message);
          }
        }
      }
    } else if (type === 'user_transcript') {
      const t = msg.user_transcription_event && msg.user_transcription_event.user_transcript;
      if (t && onUserTranscript) {
        try { onUserTranscript(String(t)); } catch { /* ignore */ }
      }
    } else if (type === 'agent_response') {
      const r = msg.agent_response_event && msg.agent_response_event.agent_response;
      if (r && onAgentResponse) {
        try { onAgentResponse(String(r)); } catch { /* ignore */ }
      }
    } else if (type === 'interruption') {
      log('interruption');
    }
    return msg;
  }

  function bridgeSummary() {
    return {
      durationMs: Date.now() - tStart,
      audioReceivedFromTwilio: diag.audioReceivedFromTwilio,
      audioRejected: diag.audioRejected,
      audioForwardedToElevenLabs: diag.audioForwardedToElevenLabs,
      firstInboundAudioAt: diag.firstInboundAudioAt,
      lastInboundAudioAt: diag.lastInboundAudioAt,
      firstAudioToAgentAt: diag.firstAudioToAgentAt,
      lastAudioToAgentAt: diag.lastAudioToAgentAt,
      elevenLabsOpened: diag.elevenLabsOpened,
      elevenLabsErrors: diag.elevenLabsErrors,
      elevenLabsCloseCode: diag.elevenLabsCloseCode,
    };
  }

  function emitSummary() {
    if (diag.summaryEmitted) return null;
    diag.summaryEmitted = true;
    const summary = bridgeSummary();
    console.log(`BRIDGE_SESSION_SUMMARY ${JSON.stringify(summary)}`);
    return summary;
  }

  function attach(socket) {
    const text = (data) => (typeof data === 'string' ? data
      : Buffer.isBuffer(data) ? data.toString('utf8')
      : String((data && data.data !== undefined ? data.data : data)));
    if (socket && typeof socket.on === 'function') {
      socket.on('message', (data) => handleMessage(text(data)));
      socket.on('open', () => {
        diag.elevenLabsOpened = true;
        log('open');
      });
      socket.on('error', (err) => {
        state.status = 'error';
        state.lastError = (err && err.message) || String(err);
        diag.elevenLabsErrors += 1;
        log('error', state.lastError);
      });
      socket.on('close', (code, reason) => {
        if (state.status !== 'error') state.status = 'ended';
        if (diag.elevenLabsCloseCode === null) diag.elevenLabsCloseCode = code === undefined ? null : code;
        log('close', { code, reason: reason ? String(reason).slice(0, 120) : '' });
        emitSummary();
      });
    } else if (socket) {
      socket.onmessage = (ev) => handleMessage(text(ev && ev.data !== undefined ? ev.data : ev));
      socket.onerror = (err) => {
        state.status = 'error';
        state.lastError = String((err && err.message) || err);
        log('error', state.lastError);
      };
      socket.onclose = (ev) => {
        if (state.status !== 'error') state.status = 'ended';
        if (diag.elevenLabsCloseCode === null) diag.elevenLabsCloseCode = ev && ev.code !== undefined ? ev.code : null;
        log('close', { code: ev && ev.code });
        emitSummary();
      };
    }
  }

  const bridge = {
    state,
    events,
    handleMessage,

    async connect() {
      if (!wsFactory) {
        const err = new Error('No WebSocket factory injected');
        err.code = 'NO_WS_FACTORY';
        throw err;
      }
      state.status = 'connecting';
      log('connecting');
      const url = await fetchSignedUrl(agentId, apiKey, fetchImpl);
      ws = wsFactory(url);
      attach(ws);
      // Initiierung sofort nach Verbindungsaufbau senden.
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ElevenLabs connect timeout')), CONNECT_TIMEOUT_MS);
        const done = (ok, err) => { clearTimeout(timer); ok ? resolve() : reject(err); };
        if (ws && typeof ws.on === 'function') {
          ws.on('open', () => { try { sendInitiation(); done(true); } catch (e) { done(false, e); } });
          ws.on('error', (e) => done(false, e instanceof Error ? e : new Error(String(e))));
        } else if (ws) {
          const prevOpen = ws.onopen;
          ws.onopen = () => {
            if (typeof prevOpen === 'function') { try { prevOpen(); } catch { /* ignore */ } }
            try { sendInitiation(); done(true); } catch (e) { done(false, e); }
          };
          const prevErr = ws.onerror;
          ws.onerror = (e) => {
            if (typeof prevErr === 'function') { try { prevErr(e); } catch { /* ignore */ } }
            done(false, e instanceof Error ? e : new Error('WebSocket error'));
          };
        } else {
          done(false, new Error('WebSocket factory returned nothing'));
        }
        // Bereits offener Socket (Race): Initiierung NUR bei echtem
        // readyState OPEN senden. KEIN ws.OPEN-Vergleich: echte ws-Sockets
        // exponieren OPEN als 1, was fälschlich auch im CONNECTING feuern
        // würde und den produzierenden Fehler verursachte.
        if (ws && ws.readyState === 1) {
          try { sendInitiation(); done(true); } catch (e) { done(false, e); }
        }
      });
      await ready;
      return ws;
    },

    sendUserAudio(twilioMulawB64) {
      // Zählung vor/nach dem Senden; Fehlerverhalten unverändert (throw).
      diag.audioReceivedFromTwilio += 1;
      stamp('firstInboundAudioAt');
      diag.lastInboundAudioAt = new Date().toISOString();
      let payload;
      try {
        payload = { user_audio_chunk: encodeUserAudio(twilioMulawB64, state.inputFormat) };
      } catch (err) {
        diag.audioRejected += 1;
        throw err;
      }
      try {
        send(payload);
      } catch (err) {
        diag.audioRejected += 1;
        throw err;
      }
      diag.audioForwardedToElevenLabs += 1;
      stamp('firstAudioToAgentAt');
      diag.lastAudioToAgentAt = new Date().toISOString();
    },

    sendUserMessage(text) {
      send({ type: 'user_message', text: String(text || '') });
    },

    end() {
      try {
        if (ws && typeof ws.close === 'function') ws.close();
      } catch { /* ignore */ }
      if (state.status !== 'error') state.status = 'ended';
      log('ended');
      emitSummary();
    },

    getSummary: bridgeSummary,
    logSummary: emitSummary,
  };

  return bridge;
}

module.exports = {
  createLiveBridge,
  fetchSignedUrl,
  encodeUserAudio,
  decodeAgentAudio,
  SIGNED_URL_ENDPOINT,
};
