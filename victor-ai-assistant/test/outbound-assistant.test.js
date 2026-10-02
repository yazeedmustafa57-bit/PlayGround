'use strict';

// Tests für KI-Telefonassistent (ausgehende Anrufe per Text-Chat).
// Nur Node-Bordmittel + lokale Module. Kein Netz, keine Secrets, keine SDK-Calls.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let savedEnv = {};

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_VOICE_ID']) {
    delete process.env[k];
  }
  const orch = require('../src/outbound-orchestrator');
  orch.clearSessions();
});

afterEach(() => {
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_VOICE_ID']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  const orch = require('../src/outbound-orchestrator');
  orch.clearSessions();
});

// ---- instruction.js: lokale Erkennung ohne LLM ----
test('Anweisung lokal: Nummer + Zweck aus „Rufe … an“', () => {
  const { parseInstruction } = require('../src/instruction');
  const p = parseInstruction('Rufe 0176 12345678 an und sag, dass ich morgen komme.');
  assert.ok((p.to || '').includes('0176'));
  assert.equal(p.source, 'local');
});

test('Anweisung lokal: erfindet keine Nummer', () => {
  const { parseInstruction } = require('../src/instruction');
  const p = parseInstruction('Rufe bei Dr. Müller an und vereinbare einen Termin.');
  assert.equal(p.to, null);
});

test('Kontakt mit bitte + Apposition („Ruf bitte Herrn Beling, meinen Arbeitgeber, an“)', () => {
  const { extractContactName } = require('../src/call-controller');
  assert.equal(extractContactName('Ruf Herrn Beling an'), 'Beling');
  assert.equal(extractContactName('Ruf bitte Herrn Beling an'), 'Beling');
  assert.equal(extractContactName('Ruf bitte Herrn Beling, meinen Arbeitgeber, an'), 'Beling');
  assert.equal(extractContactName('Rufe Herrn Beling, meinen Arbeitgeber, an'), 'Beling');
  assert.equal(
    extractContactName('Ruf bitte Herrn Beling an und sag ihm, dass ich diese Woche krankgeschrieben bin.'),
    'Beling'
  );
});

test('Organisation ohne Person bleibt ohne Kontakt (kein Erfinden)', () => {
  const { extractContactName } = require('../src/call-controller');
  assert.equal(extractContactName('Ruf diese Zahnarztpraxis an und vereinbare einen Termin.'), null);
  assert.equal(extractContactName('Ruf bei der Ausländerbehörde an und frag nach.'), null);
  assert.equal(extractContactName('Ruf meinen Arbeitgeber an.'), null);
  assert.equal(extractContactName('Ruf ihn an.'), null);
  assert.equal(extractContactName('Rufe morgen an.'), null);
  assert.equal(extractContactName('Rufe Beling an und sag ihm Bescheid.'), 'Beling');
  assert.equal(extractContactName('Rufe beling an.'), 'Beling');
});

test('Call-Kontext stellt KI-Assistent vor (deutsch, kurz)', () => {
  const { buildCallSystemPrompt } = require('../src/instruction');
  const s = buildCallSystemPrompt({ agentName: 'Victor', goal: 'Termin vereinbaren', contactName: 'Müller' });
  assert.match(s, /KI-Assistent|KI-Telefonassistent/);
  assert.match(s, /Müller/);
});

// ---- elevenlabs-rt.js ----
test('ElevenLabs TTS-Request: Flash v2.5 + ulaw_8000', () => {
  const { buildTtsRequest, splitForStreamingTts } = require('../src/elevenlabs-rt');
  const r = buildTtsRequest('Hallo, hier ist Victor.', { voiceId: 'v1', model: 'eleven_flash_v2_5' });
  assert.equal(r.body.output_format, 'ulaw_8000');
  assert.equal(r.body.model_id, 'eleven_flash_v2_5');
  assert.ok(!JSON.stringify(r.headers).includes('sk-'));
  const parts = splitForStreamingTts('Hallo. Wie geht es? Gut!');
  assert.equal(parts.length, 3);
});

test('ElevenLabs STT ohne Key: sauberer Fehler, kein Netz', () => {
  const { createSttSession } = require('../src/elevenlabs-rt');
  const s = createSttSession({ wsFactory: () => { throw new Error('must not connect'); } });
  assert.throws(() => s.connect(), (e) => e.code === 'STT_NOT_CONFIGURED');
});

// ---- twilio-voice.js ----
test('TwiML: KEIN Say (nur Helmut spricht), Stream zum Backend', () => {
  const { buildOutboundTwiml, buildIntroSayText } = require('../src/twilio-voice');
  const intro = buildIntroSayText({ agentName: 'Victor' });
  assert.match(intro, /KI-Assistent/);
  const xml = buildOutboundTwiml({ publicBaseUrl: 'https://example.invalid' });
  assert.doesNotMatch(xml, /<Say/);
  assert.match(xml, /<Response>/);
  assert.match(xml, /<Connect>/);
  // Connect+Stream: KEIN track-Attribut (Twilio 31941 erlaubt hier nur Default).
  assert.doesNotMatch(xml, /track=/);
  assert.match(xml, /wss:\/\/example\.invalid\/media-stream/);
});

test('Ausgehender Anruf ohne Credentials: simuliert, kein Netz', async () => {
  const { startOutboundCall } = require('../src/twilio-voice');
  const r = await startOutboundCall({ to: '+491701234567' });
  assert.equal(r.simulated, true);
  assert.equal(r.ok, true);
});

test('toE164: 0176… → +49…, 0049… → +49…, Müll → null', () => {
  const { toE164 } = require('../src/twilio-voice');
  assert.equal(toE164('017680282611'), '+4917680282611');
  assert.equal(toE164('0176 80282611'), '+4917680282611');
  assert.equal(toE164('004917680282611'), '+4917680282611');
  assert.equal(toE164('+4917680282611'), '+4917680282611');
  assert.equal(toE164('abc'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164(null), null);
});

test('startOutboundCall wandelt nationale Nummer um (simuliert)', async () => {
  const { startOutboundCall } = require('../src/twilio-voice');
  const r = await startOutboundCall({ to: '017680282611' });
  assert.equal(r.ok, true);
  assert.equal(r.to, '+4917680282611');
});

test('startOutboundCall mit Müll-Nummer: Fehler INVALID_TO', async () => {
  const { startOutboundCall } = require('../src/twilio-voice');
  await assert.rejects(() => startOutboundCall({ to: 'keine-nummer' }), (e) => e.code === 'INVALID_TO');
});

// ---- orchestrator ----
test('Orchestrator instruct: Plan ohne Anruf', async () => {
  const orch = require('../src/outbound-orchestrator');
  const plan = await orch.instruct('Rufe 0176 12345678 an und vereinbare einen Termin für Dienstag.');
  assert.equal(plan.ok, true);
  assert.ok((plan.to || '').includes('0176'));
});

test('Orchestrator startCall ohne Nummer: Fehler MISSING_TO', async () => {
  const orch = require('../src/outbound-orchestrator');
  await assert.rejects(() => orch.startCall({ instruction: 'Rufe Dr. Müller an.' }), (e) => e.code === 'MISSING_TO');
});

test('Orchestrator Pipeline: Antwort vom ElevenLabs-Agent (Mock) + Transkript', async () => {
  const orch = require('../src/outbound-orchestrator');
  const s = await orch.startCall({ instruction: 'Test', to: '+491701234567' });
  assert.equal(s.simulated, true);
  const sent = [];
  const { reply } = await orch.handleCallerUtterance(s.id, 'Ja, Dienstag passt.', {
    agentReply: async () => 'Sehr gut. Dienstag ist notiert.',
    tts: async (sentence) => ({ audioBase64: Buffer.from(sentence).toString('base64') }),
    sendAudio: async (b64) => { sent.push(b64); },
  });
  assert.match(reply, /Dienstag/);
  assert.ok(sent.length >= 1);
  const full = orch.getSession(s.id);
  assert.equal(full.transcript.length, 3); // start + caller + victor
});

// ---- HTTP-API ----
function startServer() {
  const { createServer } = require('../src/server.js');
  const server = createServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function postJSON(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function getJSON(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    }).on('error', reject);
  });
}

test('API: /api/chat/instruct versteht Anweisung', async () => {
  const server = await startServer();
  try {
    const r = await postJSON(server.address().port, '/api/chat/instruct', {
      instruction: 'Rufe 0176 12345678 an und sag Bescheid.',
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
  } finally { await new Promise((r) => server.close(r)); }
});

test('API: /api/call/start simuliert + Transkript abrufbar', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const r = await postJSON(port, '/api/call/start', { instruction: 'Testanruf', to: '+491701234567' });
    assert.equal(r.status, 200);
    const call = JSON.parse(r.body).call;
    assert.equal(call.simulated, true);
    const t = await getJSON(port, `/api/call/${call.id}/transcript`);
    assert.equal(t.status, 200);
    assert.ok(JSON.parse(t.body).transcript.length >= 1);
    const list = await getJSON(port, '/api/calls');
    assert.equal(JSON.parse(list.body).calls.length, 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test('API: /api/settings + /api/llm/status ohne Secrets', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const s = await getJSON(port, '/api/settings');
    assert.equal(s.status, 200);
    assert.doesNotMatch(s.body, /sk-|AUTH_TOKEN/);
    const settings = JSON.parse(s.body).settings;
    assert.equal(settings.elevenlabs.keyConfigured, false);
    assert.equal(settings.elevenlabs.agentConfigured, false);
    const l = await getJSON(port, '/api/llm/status');
    assert.equal(JSON.parse(l.body).model, 'elevenlabs-agent');
  } finally { await new Promise((r) => server.close(r)); }
});

test('API: /voice/outgoing liefert TwiML ohne Say (Agent begrüßt)', async () => {
  const server = await startServer();
  try {
    const r = await postJSON(server.address().port, '/voice/outgoing', {});
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /<Say/);
    assert.match(r.body, /<Response>/);
    assert.match(r.body, /<Stream/);
  } finally { await new Promise((r) => server.close(r)); }
});

test('API: /dashboard erreichbar', async () => {
  const server = await startServer();
  try {
    const r = await getJSON(server.address().port, '/dashboard');
    assert.equal(r.status, 200);
    assert.match(r.body, /KI-Telefonassistent/);
  } finally { await new Promise((r) => server.close(r)); }
});

test('Regression Beling: Kontakt erkannt, Briefing vollständig, dynamischer Einstieg', async () => {
  const order = 'Ruf Herrn Beling an, sag ihm, dass ich diese Woche krankgeschrieben bin und ich kann nicht zur Arbeit kommen.';
  const { parseInstruction } = require('../src/instruction');
  const { buildCallBriefing } = require('../src/call-briefing');
  const { buildDynamicFirstGreeting } = require('../src/call-greeting');
  const plan = parseInstruction(order);
  assert.equal(plan.contactName, 'Beling');
  assert.ok(plan.to === null || typeof plan.to === 'string'); // Nummer nur wenn im Text
  // Session-State wie server.js/startCall ihn baut (message mit goal-Fallback):
  const state = {
    purpose: plan.purpose,
    contactName: plan.contactName,
    phoneNumber: '+4917680282611',
    message: plan.message || plan.goal,
  };
  const briefing = buildCallBriefing(state);
  assert.match(briefing, /Beling/);
  assert.doesNotMatch(briefing, /Nachricht: nicht angegeben/);
  assert.match(briefing, /krankgeschrieben/);
  // Dynamische Eröffnung aus Kontext (kurz, ohne Kategorie-Floskel, ohne Identitätsannahme):
  const fm = buildDynamicFirstGreeting({ contactName: 'Beling', purpose: plan.purpose });
  assert.equal(fm, 'Guten Tag, hier ist Victor. Ich rufe im Auftrag von Yazeed an.');
  assert.doesNotMatch(fm, /Beling/);
  assert.doesNotMatch(fm, /Wie kann ich Ihnen helfen\?/);
  // Initiierung mit dynamischer firstMessage (Mock, kein Netz):
  const { createLiveBridge } = require('../src/live-bridge');
  const handlers = {};
  const mock = {
    sent: [], on(ev, cb) { handlers[ev] = cb; },
    send(s) { this.sent.push(s); }, close() {},
  };
  const mockFetch = async () => ({ ok: true, json: async () => ({ signed_url: 'wss://mock/conv?sig=1' }) });
  const b = createLiveBridge({
    agentId: 'agent_x', apiKey: 'key_y',
    firstMessage: buildDynamicFirstGreeting({ contactName: 'Beling', purpose: plan.purpose }),
    dynamicVariables: { kanal: 'telefon', auftrag: plan.goal, kontakt: plan.contactName },
    briefing, wsFactory: () => mock, fetchImpl: mockFetch,
  });
  const p = b.connect();
  await new Promise((r) => setTimeout(r, 50));
  handlers.open();
  await p;
  const init = JSON.parse(mock.sent[0]);
  assert.equal(init.type, 'conversation_initiation_client_data');
  assert.match(init.conversation_config_override.agent.first_message, /im Auftrag von Yazeed/);
  assert.doesNotMatch(init.conversation_config_override.agent.first_message, /Beling/);
  assert.deepEqual(init.dynamic_variables, { kanal: 'telefon', auftrag: plan.goal, kontakt: 'Beling' });
});

test('Kein lokales ASR-Rewriting: Transcript kommt wörtlich an', async () => {
  const { createLiveBridge } = require('../src/live-bridge');
  const handlers = {};
  const mock = {
    sent: [], on(ev, cb) { handlers[ev] = cb; },
    send(s) { this.sent.push(s); }, close() {},
  };
  const mockFetch = async () => ({ ok: true, json: async () => ({ signed_url: 'wss://mock/conv?sig=1' }) });
  let got = null;
  const b = createLiveBridge({
    agentId: 'a', apiKey: 'k', wsFactory: () => mock, fetchImpl: mockFetch,
    onUserTranscript: (t) => { got = t; },
  });
  const p = b.connect();
  await new Promise((r) => setTimeout(r, 50));
  handlers.open();
  await p;
  b.handleMessage(JSON.stringify({ type: 'user_transcript', user_transcription_event: { user_transcript: 'Gefahr.' } }));
  assert.equal(got, 'Gefahr.', 'keine lokale Uminterpretation des Transkripts');
});
