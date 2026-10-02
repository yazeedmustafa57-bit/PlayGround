'use strict';

// Tests: Audio-Codec + Live-Bridge (Twilio <-> ElevenLabs).
// Nur lokale Module + Mocks. Kein Netz, keine Secrets, keine echten Calls.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const codec = require('../src/audio-codec');
const {
  createLiveBridge,
  fetchSignedUrl,
  encodeUserAudio,
  decodeAgentAudio,
} = require('../src/live-bridge');

// ---- Codec ----
test('Codec: Referenzwerte dec(FF)=0, dec(00)=-32124', () => {
  assert.equal(codec.mulawToPcm16(0xff), 0);
  assert.equal(codec.mulawToPcm16(0x00), -32124);
  assert.equal(codec.mulawToPcm16(0x80), 32124);
  assert.equal(codec.pcm16ToMulaw(0), 0xff);
});

test('Codec: Rundungsfehler im Quantisierungsrahmen (<=512)', () => {
  let maxErr = 0;
  for (let p = -32635; p <= 32635; p += 37) {
    const back = codec.mulawToPcm16(codec.pcm16ToMulaw(p));
    maxErr = Math.max(maxErr, Math.abs(back - p));
  }
  assert.ok(maxErr <= 512, `maxErr=${maxErr}`);
});

test('Codec: symmetrisch, base64- und resampling-Helfer', () => {
  for (let p = 1; p <= 32635; p += 503) {
    assert.equal(codec.pcm16ToMulaw(-p), codec.pcm16ToMulaw(p) ^ 0x80);
  }
  const b64 = codec.pcm16ToMulawBase64(new Int16Array([0, 1000, -1000]));
  assert.equal(codec.mulawBase64ToPcm16(b64).length, 3);
  assert.equal(codec.upsample8kTo16k(new Int16Array([5, 6])).length, 4);
  assert.equal(codec.downsample16kTo8k(new Int16Array([5, 6, 7, 8])).length, 2);
});

// ---- Signed URL ----
test('fetchSignedUrl: hängender Request bricht mit Timeout ab', async () => {
  const hanging = () => new Promise(() => {});
  await assert.rejects(
    () => fetchSignedUrl('a', 'k', hanging, 40),
    (e) => e.code === 'SIGNED_URL_TIMEOUT'
  );
});

test('fetchSignedUrl: Fehler ohne Agent/Key, Erfolg mit Mock', async () => {
  await assert.rejects(() => fetchSignedUrl('', 'k'), (e) => e.code === 'MISSING_AGENT_ID');
  await assert.rejects(() => fetchSignedUrl('a', ''), (e) => e.code === 'MISSING_API_KEY');
  const okFetch = async () => ({ ok: true, json: async () => ({ signed_url: 'wss://mock/conv?sig=1' }) });
  assert.equal(await fetchSignedUrl('a', 'k', okFetch), 'wss://mock/conv?sig=1');
  const badFetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => fetchSignedUrl('a', 'k', badFetch), (e) => e.code === 'SIGNED_URL_FAILED');
});

// ---- Live-Bridge mit Mock-WebSocket ----
function mockWs() {
  const handlers = {};
  return {
    sent: [],
    closed: false,
    on(ev, cb) { handlers[ev] = cb; },
    trigger(ev, ...args) { if (handlers[ev]) handlers[ev](...args); },
    send(s) { this.sent.push(s); },
    close() { this.closed = true; if (handlers.close) handlers.close(1000, 'x'); },
  };
}

const mockFetch = async () => ({ ok: true, json: async () => ({ signed_url: 'wss://mock/conv?sig=1' }) });

function connectedBridge(overrides = {}) {
  const m = mockWs();
  const b = createLiveBridge({
    agentId: 'agent_x', apiKey: 'key_y',
    firstMessage: 'Hallo Anna',
    dynamicVariables: { ziel: 'Termin' },
    briefing: 'Zweck: Termin.',
    wsFactory: () => m,
    fetchImpl: mockFetch,
    ...overrides,
  });
  const p = b.connect();
  setImmediate(() => m.trigger('open'));
  return p.then(() => ({ bridge: b, mock: m }));
}

test('Bridge connect: Initiierung mit first_message + Variablen', async () => {
  const { bridge, mock } = await connectedBridge();
  assert.equal(bridge.state.status, 'connecting');
  const init = JSON.parse(mock.sent[0]);
  assert.equal(init.type, 'conversation_initiation_client_data');
  assert.equal(init.conversation_config_override.agent.first_message, 'Hallo Anna');
  assert.equal(init.dynamic_variables.ziel, 'Termin');
});

test('Bridge: Metadaten -> live + Briefing als Hintergrund (kein user_turn)', async () => {
  const { bridge, mock } = await connectedBridge();
  bridge.handleMessage(JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: {
      conversation_id: 'conv_1',
      user_input_audio_format: 'pcm_16000',
      agent_output_audio_format: 'pcm_16000',
    },
  }));
  assert.equal(bridge.state.status, 'live');
  assert.equal(bridge.state.conversationId, 'conv_1');
  const last = JSON.parse(mock.sent[mock.sent.length - 1]);
  assert.equal(last.type, 'contextual_update');
  assert.match(last.text, /Termin/);
});

test('Bridge: ping -> pong, Transkripte an Callbacks', async () => {
  const got = {};
  const { bridge, mock } = await connectedBridge({
    onUserTranscript: (t) => { got.user = t; },
    onAgentResponse: (r) => { got.agent = r; },
  });
  bridge.handleMessage(JSON.stringify({ type: 'ping', ping_event: { event_id: 9 } }));
  assert.equal(JSON.parse(mock.sent[mock.sent.length - 1]).type, 'pong');
  bridge.handleMessage(JSON.stringify({ type: 'user_transcript', user_transcription_event: { user_transcript: 'Ja gerne' } }));
  bridge.handleMessage(JSON.stringify({ type: 'agent_response', agent_response_event: { agent_response: 'Sehr gut' } }));
  assert.equal(got.user, 'Ja gerne');
  assert.equal(got.agent, 'Sehr gut');
});

test('Bridge: Agent-Audio (pcm16k) -> mulaw-base64 für Twilio', async () => {
  let out = null;
  const { bridge } = await connectedBridge({ onAgentAudio: (b64) => { out = b64; } });
  bridge.handleMessage(JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: {
      conversation_id: 'c', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000',
    },
  }));
  // 4 Samples PCM16LE 16kHz: [1000, -1000, 2000, -2000] -> 8k mulaw (2 Samples)
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(1000, 0); pcm.writeInt16LE(-1000, 2);
  pcm.writeInt16LE(2000, 4); pcm.writeInt16LE(-2000, 6);
  bridge.handleMessage(JSON.stringify({
    type: 'audio', audio_event: { audio_base_64: pcm.toString('base64'), event_id: '1' },
  }));
  assert.ok(typeof out === 'string' && out.length > 0);
  assert.equal(Buffer.from(out, 'base64').length, 2);
  assert.equal(bridge.state.audioToTwilio, 1);
});

test('Bridge: sendUserAudio zählt + kodiert (ulaw-Passthrough möglich)', async () => {
  const { bridge, mock } = await connectedBridge();
  const inB64 = Buffer.from([0xff, 0x7f, 0x00]).toString('base64');
  bridge.sendUserAudio(inB64);
  const sent = JSON.parse(mock.sent[mock.sent.length - 1]);
  assert.ok(sent.user_audio_chunk.length > 0);
  const sum = bridge.getSummary();
  assert.equal(sum.audioReceivedFromTwilio, 1);
  assert.equal(sum.audioForwardedToElevenLabs, 1);
  assert.equal(sum.audioRejected, 0);
  assert.ok(sum.firstInboundAudioAt);
  assert.ok(sum.firstAudioToAgentAt);
  // ulaw-Format: Passthrough
  assert.equal(encodeUserAudio(inB64, 'ulaw_8000'), inB64);
  assert.equal(decodeAgentAudio(inB64, 'ulaw_8000'), inB64);
});

test('Bridge: sendUserAudio ohne Verbindung wirft + zählt Rejected', async () => {
  const { createLiveBridge } = require('../src/live-bridge');
  const b = createLiveBridge({ agentId: 'a', apiKey: 'k', wsFactory: () => null });
  assert.throws(() => b.sendUserAudio('abcd'), /not connected/i);
  const sum = b.getSummary();
  assert.equal(sum.audioReceivedFromTwilio, 1);
  assert.equal(sum.audioRejected, 1);
  assert.equal(sum.audioForwardedToElevenLabs, 0);
});

test('Bridge: Summary-Einmaligkeit + Form (keine Secrets/Audio)', async () => {
  const { bridge } = await connectedBridge();
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { lines.push(String(msg)); };
  try {
    const first = bridge.logSummary();
    const second = bridge.logSummary();
    assert.ok(first && typeof first.durationMs === 'number');
    assert.equal(second, null);
    const summaryLines = lines.filter((l) => l.startsWith('BRIDGE_SESSION_SUMMARY'));
    assert.equal(summaryLines.length, 1);
    assert.doesNotMatch(summaryLines[0], /key_y/);
    const parsed = JSON.parse(summaryLines[0].replace('BRIDGE_SESSION_SUMMARY ', ''));
    assert.deepEqual(Object.keys(parsed).sort(), [
      'audioForwardedToElevenLabs', 'audioReceivedFromTwilio', 'audioRejected', 'durationMs',
      'elevenLabsCloseCode', 'elevenLabsErrors', 'elevenLabsOpened', 'firstAudioToAgentAt',
      'firstInboundAudioAt', 'lastAudioToAgentAt', 'lastInboundAudioAt',
    ].sort());
  } finally {
    console.log = orig;
  }
});

test('Bridge: keine Secrets in Events/Logs', async () => {
  const { bridge } = await connectedBridge();
  bridge.handleMessage('kein-json{{{');
  const dump = JSON.stringify(bridge.events);
  assert.doesNotMatch(dump, /key_y/);
});

test('Bridge: end() schließt + Status ended', async () => {
  const { bridge, mock } = await connectedBridge();
  bridge.end();
  assert.equal(mock.closed, true);
  assert.equal(bridge.state.status, 'ended');
});

test('Bridge ohne Factory: sauberer Fehler, kein Crash', async () => {
  const b = createLiveBridge({ agentId: 'a', apiKey: 'k' });
  await assert.rejects(() => b.connect(), (e) => e.code === 'NO_WS_FACTORY');
});

test('REGRESSION (Prod-Bug): kein Senden bei readyState 0 trotz OPEN===1', async () => {
  // Echte ws@8-Sockets liefern ws.OPEN === 1 auch während CONNECTING.
  // Die alte Prüfung (readyState===1 || OPEN===1) hat dadurch sofort auf
  // dem noch geschlossenen Socket gesendet -> "WebSocket is not open".
  const handlers = {};
  const mock = {
    readyState: 0,
    OPEN: 1,
    sent: [],
    on(ev, cb) { handlers[ev] = cb; },
    send(s) {
      if (this.readyState !== 1) throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
      this.sent.push(s);
    },
    close() {},
  };
  const b = createLiveBridge({ agentId: 'a', apiKey: 'k', wsFactory: () => mock, fetchImpl: mockFetch });
  let settled = false;
  const p = b.connect().then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mock.sent.length, 0, 'nichts gesendet vor echtem open');
  assert.equal(settled, false, 'connect wartet statt sofort zu scheitern');
  // Echtes open danach: Initiierung geht genau einmal raus.
  mock.readyState = 1;
  handlers.open();
  await p;
  assert.equal(mock.sent.length, 1);
  assert.equal(JSON.parse(mock.sent[0]).type, 'conversation_initiation_client_data');
});

test('REIHENFOLGE: Briefing vor erstem User-Audio (Auftrag beim ersten Turn bekannt)', async () => {
  // Simuliert exakt den Live-Ablauf: open -> initiation -> metadata -> user audio.
  // Das Briefing muss synchron bei metadata rausgehen, also VOR jedem Audio-Chunk.
  const handlers = {};
  const mock = {
    sent: [], closed: false,
    on(ev, cb) { handlers[ev] = cb; },
    send(s) { this.sent.push(s); },
    close() {},
  };
  const b = createLiveBridge({
    agentId: 'a', apiKey: 'k',
    dynamicVariables: { kanal: 'telefon', auftrag: 'Krankmeldung an Beling', kontakt: 'Beling' },
    briefing: 'AUFTRAG: Krankmeldung an Beling.',
    wsFactory: () => mock, fetchImpl: mockFetch,
  });
  const p = b.connect();
  await new Promise((r) => setTimeout(r, 30));
  handlers.open();
  await p;
  // 1. Initiierung trägt Vars, KEIN first_message-Override:
  const init = JSON.parse(mock.sent[0]);
  assert.equal(init.type, 'conversation_initiation_client_data');
  assert.deepEqual(init.dynamic_variables, { kanal: 'telefon', auftrag: 'Krankmeldung an Beling', kontakt: 'Beling' });
  assert.ok(!init.conversation_config_override, 'kein Override ohne firstMessage');
  // 2. Metadata -> Briefing SOFORT (synchron), noch vor Audio:
  b.handleMessage(JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: { conversation_id: 'c1', user_input_audio_format: 'ulaw_8000', agent_output_audio_format: 'ulaw_8000' },
  }));
  assert.equal(mock.sent.length, 2, 'Briefing direkt nach Metadata');
  const brief = JSON.parse(mock.sent[1]);
  assert.equal(brief.type, 'contextual_update');
  assert.match(brief.text, /Beling/);
  // 3. Erst danach User-Audio:
  b.sendUserAudio(Buffer.from([0xff, 0x7f]).toString('base64'));
  assert.equal(mock.sent.length, 3);
  assert.ok(JSON.parse(mock.sent[2]).user_audio_chunk, 'Audio erst nach Briefing');
});

test('VETRAG kontaktlos: auftrag+kanal ohne kontakt, kein Override, Briefing bleibt', async () => {
  // Zahnarzt-Fall: kein Personenname -> kein {{kontakt}}, aber der Auftrag
  // muss vollständig als Hintergrundkontext ankommen (kein Helper-Fallback).
  const { parseInstruction } = require('../src/instruction');
  const { buildCallBriefing } = require('../src/call-briefing');
  const order = 'Kannst du mir einen Termin vereinbaren beim Zahnarzt ist egal wann hauptsache früh';
  const plan = parseInstruction(order);
  assert.equal(plan.contactName, null);
  assert.equal(plan.purpose, 'Termin vereinbaren');
  const vars = { kanal: 'telefon', auftrag: plan.goal.slice(0, 500) };
  assert.ok(vars.auftrag && vars.kanal);
  assert.ok(!('kontakt' in vars), 'kontakt fehlt (nicht erfunden)');
  const state = { purpose: plan.purpose, contactName: plan.contactName, phoneNumber: null, message: plan.message || plan.goal };
  const briefing = buildCallBriefing(state);
  assert.match(briefing, /Termin vereinbaren/);
  assert.doesNotMatch(briefing, /Kontaktname: (?!nicht angegeben)[A-ZÄÖÜ]/);
  const handlers = {};
  const mock = { sent: [], on(ev, cb) { handlers[ev] = cb; }, send(s) { this.sent.push(s); }, close() {} };
  const b = createLiveBridge({
    agentId: 'a', apiKey: 'k', dynamicVariables: vars, briefing,
    wsFactory: () => mock, fetchImpl: mockFetch,
  });
  const p = b.connect();
  await new Promise((r) => setTimeout(r, 30));
  handlers.open();
  await p;
  const init = JSON.parse(mock.sent[0]);
  assert.ok(!init.conversation_config_override, 'kein first_message-Override');
  assert.equal(init.dynamic_variables.kanal, 'telefon');
  assert.match(init.dynamic_variables.auftrag, /Zahnarzt/);
  b.handleMessage(JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: { conversation_id: 'c9', user_input_audio_format: 'ulaw_8000', agent_output_audio_format: 'ulaw_8000' },
  }));
  assert.equal(JSON.parse(mock.sent[1]).type, 'contextual_update');
});

test('VERTRAG Telefonmodus: kanal=telefon + auftrag immer dabei, nie Override', async () => {
  // Schützt davor, dass der Telefonmodus-Kontext (Erdung des realen Anrufs)
  // aus der Initiierung entfernt wird. Kein Override -> keine Schablone.
  const handlers = {};
  const mock = { sent: [], on(ev, cb) { handlers[ev] = cb; }, send(s) { this.sent.push(s); }, close() {} };
  const b = createLiveBridge({
    agentId: 'a', apiKey: 'k',
    dynamicVariables: { kanal: 'telefon', auftrag: 'Krankmeldung an Beling' },
    briefing: 'AUFTRAG: Krankmeldung.',
    wsFactory: () => mock, fetchImpl: mockFetch,
  });
  const p = b.connect();
  await new Promise((r) => setTimeout(r, 30));
  handlers.open();
  await p;
  const init = JSON.parse(mock.sent[0]);
  assert.equal(init.dynamic_variables.kanal, 'telefon', 'Kanal-Signal vorhanden');
  assert.ok(init.dynamic_variables.auftrag, 'Auftrag vorhanden');
  assert.ok(!init.conversation_config_override, 'kein Override');
  b.handleMessage(JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: { conversation_id: 'ct', user_input_audio_format: 'ulaw_8000', agent_output_audio_format: 'ulaw_8000' },
  }));
  assert.equal(JSON.parse(mock.sent[1]).type, 'contextual_update', 'Briefing als Hintergrund, kein Turn');
});

test('PAYLOAD-RAHMUNG: auftrag mit Laufzeit-Etikett, Original unverändert', () => {
  const { buildPhoneVars } = require('../src/server.js');
  const order = 'Ruf bitte bei der Ausländerbehörde an und vereinbare einen Termin';
  const withContact = buildPhoneVars({ goal: order, contactName: 'Beling' });
  assert.equal(withContact.kanal, 'telefon');
  assert.equal(withContact.kontakt, 'Beling');
  assert.ok(withContact.auftrag.startsWith('Bereits laufendes Telefonat – jetzt auszuführender Auftrag: '));
  assert.ok(withContact.auftrag.endsWith(order), 'Originaltext unverändert enthalten');
  const withoutContact = buildPhoneVars({ goal: order, contactName: null });
  assert.ok(!('kontakt' in withoutContact), 'kontakt fehlt (nicht erfunden)');
  assert.ok(withoutContact.auftrag.includes(order));
  assert.deepEqual(buildPhoneVars(null), { kanal: 'telefon' });
  assert.deepEqual(buildPhoneVars({ goal: '', contactName: null }), { kanal: 'telefon' });
});
