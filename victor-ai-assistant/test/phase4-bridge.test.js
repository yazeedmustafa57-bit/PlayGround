'use strict';

// Phase 4 – Bridge-Tests, nur Node-Bordmittel, Mock-WebSocket (Dependency Injection).
// KEIN echter ElevenLabs-Aufruf, KEIN Twilio, KEINE Secrets.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createElevenBridge,
  buildConversationUrl,
  buildInitiationPayload,
  buildUserMessagePayload,
  buildAudioChunkPayload,
  buildPongPayload,
  redactForLog,
} = require('../src/bridge');
const { buildCallBriefing } = require('../src/call-briefing');
const { createInitialState } = require('../src/call-controller');

let savedApiKey;
let savedAgentId;

beforeEach(() => {
  savedApiKey = process.env.ELEVENLABS_API_KEY;
  savedAgentId = process.env.ELEVENLABS_AGENT_ID;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_AGENT_ID;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = savedApiKey;
  if (savedAgentId === undefined) delete process.env.ELEVENLABS_AGENT_ID;
  else process.env.ELEVENLABS_AGENT_ID = savedAgentId;
});

function createMockWs() {
  const handlers = {};
  return {
    sent: [],
    closed: false,
    on(ev, cb) { handlers[ev] = cb; },
    trigger(ev, ...args) { if (handlers[ev]) handlers[ev](...args); },
    send(s) { this.sent.push(s); },
    close() { this.closed = true; if (handlers.close) handlers.close(1000, 'done'); },
  };
}

// 1. fehlender API-Key wird erkannt
test('1. fehlender API-Key -> nicht konfiguriert', () => {
  process.env.ELEVENLABS_AGENT_ID = 'agent_test123';
  const b = createElevenBridge({ wsFactory: () => createMockWs() });
  assert.equal(b.getStatus().configured, false);
});

// 2. fehlende Agent-ID wird erkannt
test('2. fehlende Agent-ID -> Fehler MISSING_AGENT_ID', () => {
  process.env.ELEVENLABS_API_KEY = 'dummy';
  const b = createElevenBridge({ wsFactory: () => createMockWs() });
  assert.equal(b.getStatus().agentConfigured, false);
  assert.throws(() => b.buildUrl(), (e) => e.code === 'MISSING_AGENT_ID');
  assert.throws(() => b.connect({}), (e) => e.code === 'MISSING_AGENT_ID');
});

// 3. vollständige Konfiguration wird erkannt
test('3. vollständige Konfiguration (Key + Agent) erkannt', () => {
  process.env.ELEVENLABS_API_KEY = 'dummy-key';
  process.env.ELEVENLABS_AGENT_ID = 'agent_test123';
  const b = createElevenBridge({ wsFactory: () => createMockWs() });
  assert.equal(b.getStatus().configured, true);
  assert.equal(b.getStatus().agentConfigured, true);
  assert.ok(buildConversationUrl('agent_test123').includes('agent_test123'));
});

// 4. Dynamische first_message: Override mit kurzem auftragsverankertem Einstieg,
//    keine statische Schablone, keine Identitätsannahme.
test('4. first_message-Override dynamisch aus Kontext', () => {
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'k' });
  const withContact = b.buildInitiationPayloadForContext({ contactName: 'Jacko', purpose: 'Nachricht übermitteln' });
  assert.equal(withContact.type, 'conversation_initiation_client_data');
  const fm = withContact.conversation_config_override.agent.first_message;
  assert.equal(fm, 'Guten Tag, hier ist Victor. Ich rufe im Auftrag von Yazeed an.');
  assert.doesNotMatch(fm, /Jacko/);
  assert.doesNotMatch(fm, /Es geht um/);
  assert.doesNotMatch(fm, /Wie kann ich Ihnen helfen\?/);
  const without = b.buildInitiationPayloadForContext({});
  assert.ok(!without.conversation_config_override, 'ohne Kontext kein Override (Direct Chat)');
});

test('4b. Beling-Regression: dynamischer Einstieg + vollständiger Kontext', () => {
  const { parseInstruction } = require('../src/instruction');
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'k' });
  const plan = parseInstruction('Ruf Herrn Beling an und sag ihm, dass ich diese Woche krankgeschrieben bin.');
  assert.equal(plan.contactName, 'Beling');
  const payload = b.buildInitiationPayloadForContext(
    { contactName: plan.contactName, purpose: plan.purpose },
    { dynamicVariables: { auftrag: plan.goal, kontakt: plan.contactName } }
  );
  assert.equal(payload.type, 'conversation_initiation_client_data');
  assert.deepEqual(payload.dynamic_variables, { auftrag: plan.goal, kontakt: 'Beling' });
  assert.match(payload.conversation_config_override.agent.first_message, /Yazeed/);
  assert.doesNotMatch(payload.conversation_config_override.agent.first_message, /Beling/);
});

// 5. Briefing wird mit 4 Blöcken erzeugt
test('5. Briefing enthält FAKTEN/GRENZEN/ZIEL', () => {
  const t = buildCallBriefing({ purpose: 'Termin vereinbaren', contactName: 'Jacko' });
  assert.match(t, /AUFTRAG \/ FAKTEN/);
  assert.match(t, /FREIGEGEBENE PERSÖNLICHE DATEN/);
  assert.match(t, /VERBINDLICHE GRENZEN/);
  assert.match(t, /GESPRÄCHSZIEL/);
  assert.match(t, /Jacko/);
});

// 6. Briefing enthält keine Antwortvorlagen/Dialoge
test('6. Briefing ohne Antwortvorlagen und Skripte', () => {
  const t = buildCallBriefing({ purpose: 'Nachricht übermitteln', message: 'Ich komme morgen.' });
  assert.doesNotMatch(t, /sagen Sie wörtlich|Beispieldialog|Skript/i);
  assert.doesNotMatch(t, /Hallo, hier ist ein Beispiel/i);
});

// 7. Briefing erfindet keine Daten
test('7. leeres Briefing erfindet nichts', () => {
  const t = buildCallBriefing(createInitialState());
  assert.match(t, /nicht angegeben/);
  assert.doesNotMatch(t, /0176|\+49|Max Mustermann/i);
});

// 8. nicht freigegebene Daten werden maskiert/nicht aufgenommen
test('8. Telefon standardmäßig maskiert', () => {
  const masked = buildCallBriefing({ phoneNumber: '017612345678' });
  assert.doesNotMatch(masked, /017612345678/);
  assert.match(masked, /\*\*\*/);
  const open = buildCallBriefing({ phoneNumber: '017612345678' }, { includePhone: true });
  assert.match(open, /017612345678/);
});

// 9. Session-Lifecycle: connecting -> connected -> ended
test('9. Lifecycle mit Mock-WebSocket', () => {
  const mock = createMockWs();
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'k', wsFactory: () => mock });
  b.connect({});
  assert.equal(b.state.status, 'connecting');
  mock.trigger('open');
  assert.equal(b.state.status, 'connected');
  assert.equal(b.getStatus().connected, true);
  b.endSession();
  assert.equal(b.state.status, 'ended');
  assert.equal(mock.closed, true);
});

// 10. Fehlerbehandlung: kein Factory, Senden ohne Connect
test('10. Fehler sauber (NO_WS_FACTORY, send ohne Connect)', () => {
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'k' });
  assert.throws(() => b.connect({}), (e) => e.code === 'NO_WS_FACTORY');
  const b2 = createElevenBridge({ agentId: 'agent_x', apiKey: 'k', wsFactory: () => createMockWs() });
  assert.throws(() => b2.sendAudio('abc'), /not connected/i);
});

// 11. Mock-WebSocket: Initiation-Payload korrekt (ohne Schablone)
test('11. Initiation über Mock gesendet', () => {
  const mock = createMockWs();
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'k', wsFactory: () => mock });
  b.connect({ contactName: 'Jacko' });
  mock.trigger('open');
  const payload = b.sendInitiation({ contactName: 'Jacko' });
  assert.equal(payload.type, 'conversation_initiation_client_data');
  const sent = JSON.parse(mock.sent[mock.sent.length - 1]);
  assert.equal(sent.type, 'conversation_initiation_client_data');
  assert.doesNotMatch(JSON.stringify(sent), /ich habe eine Nachricht für Sie/);
});

// 12. Audio-Nachricht wird verarbeitet und weitergereicht
test('12. eingehendes Audio -> onAudioOutput (Buffer)', () => {
  let received = null;
  const mock = createMockWs();
  const b = createElevenBridge({
    agentId: 'agent_x', apiKey: 'k',
    wsFactory: () => mock,
    onAudioOutput: (buf) => { received = buf; },
  });
  b.connect({});
  mock.trigger('open');
  const b64 = Buffer.from('hello-audio').toString('base64');
  b.handleServerMessage(JSON.stringify({ type: 'audio', audio_event: { audio_base_64: b64, event_id: '3' } }));
  assert.ok(Buffer.isBuffer(received));
  assert.equal(received.toString(), 'hello-audio');
  assert.equal(b.state.audioChunksReceived, 1);
  // ping -> pong
  b.handleServerMessage(JSON.stringify({ type: 'ping', ping_event: { event_id: 42, ping_ms: 100 } }));
  const last = JSON.parse(mock.sent[mock.sent.length - 1]);
  assert.equal(last.type, 'pong');
});

// 13. user_message-Payload + sendUserMessage
test('13. user_message-Briefing sendbar', () => {
  const mock = createMockWs();
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'k', wsFactory: () => mock });
  b.connect({});
  mock.trigger('open');
  const briefing = buildCallBriefing({ purpose: 'Auskunft einholen' });
  const p = b.sendUserMessage(briefing);
  assert.equal(p.type, 'user_message');
  assert.ok(p.text.includes('AUSKUNFT') || p.text.includes('Auskunft') || p.text.includes('AUFTRAG'));
  assert.equal(buildUserMessagePayload('x').type, 'user_message');
  assert.equal(buildAudioChunkPayload('ab').user_audio_chunk, 'ab');
  assert.equal(buildPongPayload(7).type, 'pong');
  assert.equal(buildInitiationPayload({}).type, 'conversation_initiation_client_data');
});

// 14. keine Secrets in Logs
test('14. Logs redigieren Key + Telefon', () => {
  const r1 = redactForLog('xi-api-key: sk-geheim123 Key 0176 12345678');
  assert.doesNotMatch(r1, /sk-geheim123/);
  assert.doesNotMatch(r1, /0176 12345678/);
  const b = createElevenBridge({ agentId: 'agent_x', apiKey: 'super-secret-key', wsFactory: () => createMockWs() });
  b.connect({ contactName: 'Jacko' });
  const dump = JSON.stringify(b.events);
  assert.doesNotMatch(dump, /super-secret-key/);
});

// 15. GET /api/elevenlabs/status ohne Secrets
test('15. Status-Endpunkt: configured false, keine Secrets', async () => {
  const { createServer } = require('../src/server.js');
  // server.js lädt .env beim Require (dotenv) – danach erneut leeren,
  // damit der Test deterministisch ohne echte Credentials läuft.
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_AGENT_ID;
  delete process.env.ELEVENLABS_VOICE_ID;
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const { status, body } = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/elevenlabs/status`, (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }).on('error', reject);
    });
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.configured, false);
    assert.equal(json.agentConfigured, false);
    assert.equal(json.connected, false);
    assert.ok(!('apiKey' in json) && !('agentId' in json));
    assert.doesNotMatch(body, /sk-/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// 8b. Freigabe-Regression (Beling-Krankmeldung): nur Vorhandenes freigegeben,
// Telefon trotz vollständigem Auftrag standardmäßig maskiert.
test('8b. nur vorhandene Kategorien freigegeben, Telefon maskiert', () => {
  const { buildCallBriefing } = require('../src/call-briefing');
  const t = buildCallBriefing({
    purpose: 'Nachricht übermitteln',
    contactName: 'Beling',
    phoneNumber: '017612345678',
    message: 'Ich bin diese Woche krankgeschrieben.',
  });
  assert.match(t, /Beling/);
  assert.doesNotMatch(t, /017612345678/);
  assert.match(t, /\*\*\*/);
});
