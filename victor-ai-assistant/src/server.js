'use strict';

// Victor KI-Telefonassistent – Express + WebSocket-Server.
// - Statische Bestandsseiten + Dashboard
// - Diagnose: /health, /api/elevenlabs/status, /api/twilio/status, /api/settings, /api/llm/status
// - Chat-Steuerung: POST /api/chat/instruct, POST /api/call/start, GET /api/calls, GET /api/call/:id/transcript
// - Twilio-Voice-Webhooks: POST /voice/outgoing, POST /voice/incoming, POST /voice/status (TwiML)
// - WebSockets: /media-stream (Twilio ulaw_8000), /dashboard-stream (Live-Transkript)
// Alles ohne Secrets in Antworten/Logs. Ohne Credentials: simulierter Modus.

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { createInitialState, processUserMessage } = require('./call-controller');
const { sanitizeState } = require('./personal-data-policy');
const { getPublicStatus } = require('./elevenlabs-config');
const { getTwilioPublicStatus } = require('./twilio-config');
const { getPublicSettings, getAppConfig } = require('./app-config');
const orchestrator = require('./outbound-orchestrator');
const { buildOutboundTwiml } = require('./twilio-voice');
const { parseStreamMessage, extractAudioPayload, buildMediaMessage } = require('./twilio-media');
const { createSessionDiagnostics, shortSid } = require('./media-diagnostics');
const { redactForLog } = require('./bridge');
const { createLiveBridge } = require('./live-bridge');
const { buildDynamicFirstGreeting } = require('./call-greeting');
const { buildCallBriefing } = require('./call-briefing');
const { getElevenLabsConfig } = require('./elevenlabs-config');

// Baut die Dynamic Variables für den Telefon-Agenten aus der Session.
// Der Auftragstext selbst bleibt unverändert; nur das Etikett davor kennzeichnet
// ihn als bereits laufenden Vorgang (kein Skript, keine Wortvorgabe). Verhindert,
// dass Imperative wie "Ruf bitte an ..." als zukünftige Aufgabe gelesen werden.
function buildPhoneVars(session) {
  const goal = session && session.goal ? String(session.goal) : '';
  const contactName = session ? session.contactName : null;
  const vars = { kanal: 'telefon' };
  if (goal) vars.auftrag = 'Bereits laufendes Telefonat – jetzt auszuführender Auftrag: ' + goal.slice(0, 500);
  if (contactName) vars.kontakt = contactName;
  return vars;
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  // ---- Diagnose (Bestand, secret-frei) ----
  app.get('/health', (req, res) => res.json({ ok: true, service: 'victor-ai-assistant' }));
  app.get('/api/elevenlabs/status', (req, res) => res.json(getPublicStatus()));
  app.get('/api/twilio/status', (req, res) => res.json(getTwilioPublicStatus()));
  app.get('/api/settings', (req, res) => res.json({ ok: true, settings: getPublicSettings() }));
  app.get('/api/llm/status', (req, res) => {
    // Kein externes LLM: Dialog = ElevenLabs Conversational AI Agent.
    res.json({ ok: true, configured: false, model: 'elevenlabs-agent', mode: 'elevenlabs-conversational-ai' });
  });
  app.get('/api/calls', (req, res) => res.json({ ok: true, calls: orchestrator.listSessions() }));
  app.get('/api/call/:id/transcript', (req, res) => {
    const s = orchestrator.getSession(req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'Unknown call id' });
    return res.json({ ok: true, id: s.id, transcript: s.transcript });
  });

  // ---- Bestand: lokale Auftragserkennung ----
  app.post('/api/test/message', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const incoming = req.body?.state && typeof req.body.state === 'object'
      ? req.body.state
      : createInitialState();
    const { state } = processUserMessage(incoming, text);
    const clean = sanitizeState(state);
    res.json({
      ok: true,
      purpose: clean.purpose,
      message: clean.message,
      contactName: clean.contactName,
      phoneNumber: clean.phoneNumber,
      requestedDate: clean.requestedDate,
      requestedTime: clean.requestedTime,
      callerName: clean.callerName,
      collectionMode: clean.collectionMode,
      state: clean,
    });
  });

  // ---- Neu: Chat-Anweisung verstehen (Schritt 1–2, kein Anruf) ----
  app.post('/api/chat/instruct', async (req, res) => {
    try {
      const instruction = String(req.body?.instruction || req.body?.text || '');
      if (!instruction.trim()) return res.status(400).json({ ok: false, error: 'Missing instruction' });
      const plan = await orchestrator.instruct(instruction);
      res.json(plan);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'instruct failed' });
    }
  });

  // ---- Neu: Anruf starten (Schritt 3, Twilio oder Simulation) ----
  app.post('/api/call/start', async (req, res) => {
    try {
      const { instruction, to, contactName, goal } = req.body || {};
      const text = String(instruction || goal || '');
      if (!text.trim() && !to) return res.status(400).json({ ok: false, error: 'Missing instruction or to' });
      const session = await orchestrator.startCall({ instruction: text, to, contactName, goal });
      res.json({ ok: true, call: session });
    } catch (err) {
      if (err && (err.code === 'MISSING_TO' || err.code === 'INVALID_TO')) {
        return res.status(400).json({ ok: false, error: String(err.message) });
      }
      // Twilio-Fehler mit Code + Meldung weitergeben (keine Secrets),
      // damit das Dashboard die echte Ursache zeigt statt nur „failed“.
      const detail = err && err.code && err.code !== 500
        ? ` (Code ${err.code}: ${err.message || 'Twilio-Fehler'})`
        : '';
      res.status(500).json({ ok: false, error: `call start failed${detail}` });
    }
  });

  // ---- Twilio Voice-Webhooks (TwiML, ohne Say: Agent begrüßt selbst) ----
  const twiml = (xml, res) => res.type('text/xml').send(xml);
  app.post('/voice/outgoing', (req, res) => {
    const appCfg = getAppConfig();
    const xml = buildOutboundTwiml({ publicBaseUrl: appCfg.publicBaseUrl });
    twiml(xml, res);
  });
  app.post('/voice/incoming', (req, res) => {
    const appCfg = getAppConfig();
    const xml = buildOutboundTwiml({ publicBaseUrl: appCfg.publicBaseUrl });
    twiml(xml, res);
  });
  app.post('/voice/status', (req, res) => res.json({ ok: true }));

  // ---- Bestandsseiten (saubere URLs) ----
  const pages = {
    '/': 'index.html',
    '/chat': 'chat.html',
    '/eleven-chat': 'eleven-chat.html',
    '/call': 'call.html',
    '/journal': 'journal.html',
    '/setup': 'setup.html',
    '/dashboard': 'dashboard.html',
  };
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, (req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
  }
  app.use(express.static(PUBLIC_DIR));

  // ---- 404 + Fehler ----
  // GET-only-Routen mit falscher Methode -> 405 (Bestandskompatibilität).
  const GET_ONLY = new Set(['/health', '/api/elevenlabs/status', '/api/twilio/status', '/api/settings', '/api/llm/status', '/api/calls']);
  app.use((req, res, next) => {
    const p = req.path;
    if ((GET_ONLY.has(p) || /^\/api\/call\/[^/]+\/transcript$/.test(p)) && req.method !== 'GET') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }
    next();
  });
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not Found' });
    return res.status(404).json({ ok: false, error: 'Not Found' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }
    return res.status(500).json({ ok: false, error: 'Internal error' });
  });
  return app;
}

function attachWebSockets(server) {
  let WSS;
  try {
    // eslint-disable-next-line global-require
    WSS = require('ws').WebSocketServer;
  } catch {
    return null;
  }
  const wss = new WSS({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = String(req.url || '').split('?')[0];
    if (url === '/media-stream' || url === '/dashboard-stream') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
  wss.on('connection', (ws, req) => {
    const url = String(req.url || '').split('?')[0];
    if (url === '/dashboard-stream') {
      orchestrator.dashboardSockets.add(ws);
      ws.on('close', () => orchestrator.dashboardSockets.delete(ws));
      try { ws.send(JSON.stringify({ type: 'hello', calls: orchestrator.listSessions() })); } catch { /* ignore */ }
      return;
    }
    // /media-stream: Twilio (mulaw_8000) <-> ElevenLabs-Agent (live).
    // Der Agent spricht (Helmut) und antwortet; Transkripte gehen live
    // ins Dashboard. Kein Netz ohne Credentials: dann Stille statt Fake-Audio.
    let streamSid = null;
    let session = null;
    let live = null;
    let bridgeReady = false;
    // Diagnose-Tracker (Zählung/Logging only, kein Einfluss auf Audiofluss).
    const diag = createSessionDiagnostics();
    // Session-lokal: genau EINE Bridge pro Stream; Retry nur solange aktiv.
    let sessionEnded = false;
    let agentAttempts = 0;

    function safeErrorMessage(err) {
      const raw = err && err.code ? `${err.code}: ${err.message || ''}` : String((err && err.message) || err);
      const redacted = redactForLog(raw);
      return String(typeof redacted === 'string' ? redacted : raw).slice(0, 200);
    }

    function sendToTwilio(mulawB64) {
      if (!streamSid) return;
      try {
        ws.send(JSON.stringify(buildMediaMessage(streamSid, mulawB64)));
      } catch { /* ignore */ }
    }

    async function startAgent(twilioCallSid, attempt) {
      attempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
      agentAttempts = Math.max(agentAttempts, attempt);
      session = orchestrator.findSessionByTwilioSid(twilioCallSid) || null;
      const appCfg = getAppConfig();
      const elCfg = getElevenLabsConfig();
      // Sichtbarer Startpunkt: Session-Bindung + Config-Booleans (nie Secrets).
      diag.onAgentStart({
        attempt,
        hasSession: Boolean(session),
        sessionShort: session ? shortSid(session.id) : null,
        keyConfigured: (elCfg.apiKey || '').length > 0,
        agentConfigured: (elCfg.agentId || '').length > 0,
      });
      const ctx = session
        ? { contactName: session.contactName, purpose: session.purpose, agentName: appCfg.agentName }
        : {};
      const vars = buildPhoneVars(session);
      // Briefing-State: vollständiger Auftragsinhalt aus vorhandenen Session-Daten.
      // message fällt auf goal zurück, damit der konkrete Auftragstext nie als
      // "nicht angegeben" verloren geht (keine erfundenen Inhalte).
      const state = session
        ? { purpose: session.purpose, contactName: session.contactName, phoneNumber: session.to, message: session.message || session.goal || null }
        : {};
      try {
        live = createLiveBridge({
          agentId: elCfg.agentId,
          apiKey: elCfg.apiKey,
          firstMessage: buildDynamicFirstGreeting(ctx),
          dynamicVariables: vars,
          briefing: buildCallBriefing(state),
          onAgentAudio: sendToTwilio,
          onUserTranscript: (t) => { if (session) orchestrator.appendTranscript(session, 'caller', t); },
          onAgentResponse: (r) => { if (session) orchestrator.appendTranscript(session, 'victor', r); },
          onEvent: (ev) => {
            // Diagnose-Feed (Formate/Lifecycle), nie Audio, nie Secrets.
            diag.onBridgeEvent(ev);
          },
          wsFactory: (url) => new (require('ws'))(url),
        });
        await live.connect();
        bridgeReady = true;
        diag.onAgentReady();
        if (session) {
          orchestrator.setSessionStatus(session.id, 'in-progress');
          orchestrator.appendTranscript(session, 'victor', `Live-Gespräch mit ElevenLabs-Agent verbunden (${appCfg.agentName}).`);
        }
      } catch (err) {
        bridgeReady = false;
        live = null;
        // Fehler NIE still schlucken: sichtbare Ursache (ohne Secrets).
        diag.onAgentFailed(safeErrorMessage(err));
        if (session) orchestrator.setSessionStatus(session.id, 'error');
        // Genau EIN bewachter Neuversuch, nur solange der Stream lebt und
        // keine neuere Etablierung läuft (kein Dauer-Race, keine Duplikate).
        if (attempt < 2 && !sessionEnded && !live && !bridgeReady) {
          setTimeout(() => {
            if (!sessionEnded && !live && !bridgeReady) {
              startAgent(twilioCallSid, attempt + 1).catch(() => { /* bereits geloggt */ });
            }
          }, 2000);
        }
      }
    }

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = parseStreamMessage(String(data));
      } catch (err) {
        // Diagnose only: Parser-Fehler zählen, Nachricht weiter verwerfen.
        diag.onParseError((err && (err.reason || err.code)) || 'parse-error');
        return;
      }
      if (msg.event === 'start') {
        streamSid = (msg.start && msg.start.streamSid) || msg.streamSid || null;
        const callSid = (msg.start && (msg.start.callSid || msg.start.CallSid)) || msg.callSid || null;
        const mediaFormat = (msg.start && msg.start.mediaFormat) || {};
        diag.onStart({
          streamSid,
          callSid,
          mediaFormat: {
            encoding: mediaFormat.encoding,
            sampleRate: mediaFormat.sampleRate,
            channels: mediaFormat.channels,
          },
          tracks: msg.start && msg.start.tracks !== undefined ? msg.start.tracks : null,
          hasSession: Boolean(orchestrator.findSessionByTwilioSid(callSid)),
        });
        await startAgent(callSid);
        return;
      }
      if (msg.event === 'media') {
        // Diagnose: jedes Media-Event zählen (nur Metadaten, nie Payload).
        const media = msg.media || {};
        diag.onMedia({
          payloadLength: typeof media.payload === 'string' ? media.payload.length : null,
          track: media.track === undefined ? null : media.track,
          chunk: media.chunk === undefined ? null : media.chunk,
        });
        let payload = null;
        let extractError = null;
        try {
          payload = extractAudioPayload(msg);
        } catch (err) {
          extractError = err;
        }
        if (extractError) {
          diag.onReject('extract-error:' + ((extractError && (extractError.reason || extractError.code)) || 'unknown'));
          return;
        }
        if (!payload) {
          // Verhalten unverändert (verwerfen); Grund jetzt unterscheidbar.
          diag.onReject(!msg.media ? 'missing-media' : (typeof media.payload !== 'string' ? 'invalid-payload-type' : 'empty-payload'));
          return;
        }
        if (!live) {
          diag.onReject('bridge-not-created');
          return;
        }
        if (!bridgeReady) {
          diag.onReject('bridge-not-ready');
          return;
        }
        try {
          live.sendUserAudio(payload);
          diag.onForwarded();
        } catch (err) {
          diag.onReject('forward-error:' + String((err && err.message) || err).slice(0, 80));
        }
        return;
      }
      if (msg.event === 'stop') {
        sessionEnded = true; // Retry-Fenster schließen (Diagnose only).
        try { if (live) live.end(); } catch { /* ignore */ }
        try {
          if (session) orchestrator.setSessionStatus(session.id, 'completed');
        } catch { /* ignore */ }
        diag.onStop();
        try { ws.close(); } catch { /* ignore */ }
      }
    });
    ws.on('close', (code, reason) => {
      sessionEnded = true; // Retry-Fenster schließen (Diagnose only).
      try { if (live) live.end(); } catch { /* ignore */ }
      diag.onTwilioClose({ code, reason: typeof reason === 'string' ? reason : (reason ? String(reason) : null), source: 'twilio-close' });
    });
    ws.on('error', (err) => {
      sessionEnded = true; // Retry-Fenster schließen (Diagnose only).
      try { if (live) live.end(); } catch { /* ignore */ }
      diag.onTwilioError((err && err.message) || String(err));
    });
  });
  return wss;
}

function createServer() {
  const app = createApp();
  const server = http.createServer(app);
  attachWebSockets(server);
  return server;
}

function getPort() {
  const parsed = Number.parseInt(process.env.PORT || '5051', 10);
  return Number.isSafeInteger(parsed) ? parsed : 5051;
}

if (require.main === module) {
  const server = createServer();
  const port = getPort();
  server.listen(port, () => {
    console.log(`victor-ai-assistant listening on http://localhost:${port}`);
    console.log(`Dashboard: http://localhost:${port}/dashboard`);
  });
}

module.exports = { createServer, createApp, attachWebSockets, getPort, buildPhoneVars, requestHandler: createApp() };
