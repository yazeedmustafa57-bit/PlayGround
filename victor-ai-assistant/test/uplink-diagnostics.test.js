'use strict';

// Tests: Diagnose-Schicht für den Twilio→live-bridge Audio-Uplink.
// Keine echten Anrufe, keine echten WS-Verbindungen, nur lokale Module + Mocks.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { parseStreamMessage, extractAudioPayload } = require('../src/twilio-media');
const { createSessionDiagnostics, shortSid } = require('../src/media-diagnostics');

let logs = [];
let origLog;

beforeEach(() => {
  logs = [];
  origLog = console.log;
  console.log = (msg, ...rest) => {
    logs.push([String(msg), ...rest.map(String)].join(' '));
  };
});

afterEach(() => {
  console.log = origLog;
});

function summaryLines() {
  return logs.filter((l) => l.startsWith('MEDIA_SESSION_SUMMARY'));
}

// ---- twilio-media: Reasons bei identischem Verhalten ----
test('Parser-Reasons: invalid-json / unknown-event', () => {
  assert.throws(() => parseStreamMessage('kein-json{{{'), (e) => e.code === 'INVALID_JSON' && e.reason === 'invalid-json');
  assert.throws(() => parseStreamMessage('{"event":"fax"}'), (e) => e.code === 'UNKNOWN_EVENT' && e.reason === 'unknown-event');
  // Gültige Events unverändert:
  assert.equal(parseStreamMessage('{"event":"start","start":{}}').event, 'start');
});

test('Extract: null-Vertrag unverändert, Throw mit reason', () => {
  const b64 = Buffer.from([1, 2, 3]).toString('base64');
  assert.equal(extractAudioPayload({ event: 'media', media: { payload: b64 } }), b64);
  assert.equal(extractAudioPayload({ event: 'start' }), null);
  assert.equal(extractAudioPayload({ event: 'media' }), null);
  assert.equal(extractAudioPayload({ event: 'media', media: {} }), null);
  assert.equal(extractAudioPayload({ event: 'media', media: { payload: '' } }), null);
  assert.equal(extractAudioPayload({ event: 'media', media: { payload: 123 } }), null);
  assert.throws(
    () => extractAudioPayload({ event: 'media', media: { payload: '!!!kein-base64!!!' } }),
    (e) => e.code === 'INVALID_PAYLOAD' && e.reason === 'invalid-payload-encoding'
  );
});

// ---- Tracker: start/media ----
test('Tracker: start loggt Format ohne Secrets', () => {
  const t = createSessionDiagnostics();
  t.onStart({
    streamSid: 'MZ1234567890abcdef1234',
    callSid: 'CA1234567890abcdef1234',
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    tracks: ['inbound'],
    hasSession: true,
  });
  const startLine = logs.find((l) => l.includes('start'));
  assert.ok(startLine);
  assert.match(startLine, /8000/);
  assert.match(startLine, /mulaw/);
  assert.doesNotMatch(startLine, /MZ1234567890abcdef1234/);
  assert.doesNotMatch(startLine, /CA1234567890abcdef1234/);
  assert.match(startLine, /MZ1234…/);
});

test('Tracker: media zählen, erster/letzter Zeitpunkt, Metadaten', () => {
  const t = createSessionDiagnostics();
  t.onMedia({ payloadLength: 160, track: 'inbound', chunk: '7' });
  t.onMedia({ payloadLength: 160 });
  const snap = t.snapshot();
  assert.equal(snap.mediaReceived, 2);
  assert.ok(snap.firstMediaAt);
  assert.equal(snap.lastMediaAt, snap.firstMediaAt); // gleiche ms möglich
  const inbound = logs.find((l) => l.includes('inbound'));
  assert.ok(inbound);
  assert.match(inbound, /"count":1/);
});

// ---- Tracker: rejects mit Grund ----
test('Tracker: jeder Verwerfungsgrund unterscheidbar', () => {
  const t = createSessionDiagnostics();
  for (const reason of ['missing-media', 'empty-payload', 'invalid-payload-type', 'extract-error:invalid-payload-encoding', 'bridge-not-created', 'bridge-not-ready', 'forward-error:x', 'invalid-json']) {
    t.onReject(reason);
  }
  const snap = t.snapshot();
  assert.equal(snap.mediaRejected, 8);
  const sum = t.summarize('test');
  assert.equal(sum.rejectReasons['missing-media'], 1);
  assert.equal(sum.rejectReasons['bridge-not-ready'], 1);
  const rejected = logs.filter((l) => l.includes('rejected'));
  assert.equal(rejected.length, 8);
});

// ---- Tracker: forwarding ----
test('Tracker: forwarding-Zeiten', () => {
  const t = createSessionDiagnostics();
  t.onForwarded();
  t.onForwarded();
  const sum = t.summarize('test');
  assert.equal(sum.audioForwardedToElevenLabs, 2);
  assert.ok(sum.firstForwardedAt);
  assert.ok(sum.lastForwardedAt);
});

// ---- Tracker: agent start/ready/failed ----
test('Tracker: agent-start nur mit Booleans, nie Secrets', () => {
  const t = createSessionDiagnostics();
  t.onAgentStart({ attempt: 1, hasSession: true, sessionShort: 'call_a…1234', keyConfigured: true, agentConfigured: false });
  t.onAgentReady();
  t.onAgentFailed('MISSING_API_KEY: ELEVENLABS_API_KEY missing');
  const startLine = logs.find((l) => l.includes('agent-start'));
  assert.ok(startLine);
  assert.match(startLine, /"attempt":1/);
  assert.match(startLine, /"keyConfigured":true/);
  assert.match(startLine, /"agentConfigured":false/);
  assert.doesNotMatch(logs.join('\n'), /sk-/);
  assert.ok(logs.some((l) => l.includes('bridge-ready')));
  assert.ok(logs.some((l) => l.includes('bridge-failed') && l.includes('MISSING_API_KEY')));
});

// ---- Tracker: bridge events ----
test('Tracker: bridge live/error/close', () => {
  const t = createSessionDiagnostics();
  t.onBridgeEvent({ type: 'connecting', at: new Date().toISOString() });
  t.onBridgeEvent({ type: 'live', at: new Date().toISOString(), detail: { in: 'ulaw_8000', out: 'ulaw_8000' } });
  t.onBridgeEvent({ type: 'error', at: new Date().toISOString(), detail: 'boom' });
  t.onBridgeEvent({ type: 'close', at: new Date().toISOString(), detail: { code: 1006, reason: '' } });
  const sum = t.summarize('test');
  assert.equal(sum.elevenLabsOpened, true);
  assert.equal(sum.elevenLabsErrors, 1);
  assert.equal(sum.elevenLabsCloseCode, 1006);
  assert.ok(logs.some((l) => l.includes('bridge-live') && l.includes('ulaw_8000')));
});

// ---- Summary: genau einmal, exakte Form, keine Inhalte ----
test('Summary: einmalig, exakte Felder, kein Payload/Telefon/Secret', () => {
  const t = createSessionDiagnostics();
  t.onStart({ streamSid: 'MZ1', callSid: 'CA1', mediaFormat: {}, tracks: null, hasSession: false });
  t.onMedia({ payloadLength: 99999 });
  t.onReject('empty-payload');
  t.onForwarded();
  const first = t.summarize('stop');
  const second = t.summarize('stop');
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(summaryLines().length, 1);
  assert.deepEqual(Object.keys(first).sort(), [
    'audioForwardedToElevenLabs', 'durationMs', 'elevenLabsCloseCode', 'elevenLabsErrors',
    'elevenLabsOpened', 'firstForwardedAt', 'firstMediaAt', 'lastForwardedAt', 'lastMediaAt',
    'mediaReceived', 'mediaRejected', 'rejectReasons', 'endedBy',
  ].sort());
  assert.equal(typeof first.durationMs, 'number');
  // Auch mit bösem Input: kein Payload, keine Nummer, kein Key im Output.
  const t2 = createSessionDiagnostics();
  t2.onMedia({ payloadLength: 12345 });
  t2.onReject('forward-error:boom');
  const s2 = t2.summarize('x');
  const dump = JSON.stringify(s2) + summaryLines().join('');
  assert.doesNotMatch(dump, /\+49/);
  assert.doesNotMatch(dump, /sk-/);
  assert.ok(!('payload' in s2));
});

// ---- WS close/error ----
test('Tracker: twilio close/error mit Code und Summary', () => {
  const t = createSessionDiagnostics();
  t.onMedia({ payloadLength: 10 });
  t.onTwilioClose({ code: 1005, reason: 'gone', source: 'twilio-close' });
  assert.equal(summaryLines().length, 1);
  const parsed = JSON.parse(summaryLines()[0].replace('MEDIA_SESSION_SUMMARY ', ''));
  assert.equal(parsed.mediaReceived, 1);
  assert.equal(parsed.endedBy, 'twilio-close');
  t.onTwilioClose({ code: 1006, reason: 'x', source: 'twilio-close' });
  assert.equal(summaryLines().length, 1); // nur einmal

  const t2 = createSessionDiagnostics();
  t2.onTwilioError('socket hang up');
  assert.equal(summaryLines().length, 2);
});

// ---- shortSid ----
test('shortSid kürzt lange IDs, lässt kurze/fehlende in Ruhe', () => {
  assert.equal(shortSid('MZ1234567890abcdef'), 'MZ1234…cdef');
  assert.equal(shortSid('kurz'), 'kurz');
  assert.equal(shortSid(null), null);
  assert.equal(shortSid(''), null);
});

// ---- Ende-zu-Ende: simulierter Twilio-Client gegen echten Server (ohne Netz) ----
const FAKE_CALL_SID = 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAKE_STREAM_SID = 'MZbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function scrubElevenLabsEnv() {
  const saved = {};
  for (const k of ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_VOICE_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function startTestServer() {
  // Require NACH dem Scrubben wäre ideal; dotenv läuft beim Require:
  // deshalb danach erneut löschen (siehe phase4-Präzedenz).
  const { createServer } = require('../src/server.js');
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_AGENT_ID;
  delete process.env.ELEVENLABS_VOICE_ID;
  const server = createServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function wsClient(port) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function twilioStart() {
  return JSON.stringify({
    event: 'start',
    streamSid: FAKE_STREAM_SID,
    start: {
      accountSid: 'ACtest000000000000000000000001',
      callSid: FAKE_CALL_SID,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
}

function twilioMedia(chunk) {
  return JSON.stringify({
    event: 'media',
    streamSid: FAKE_STREAM_SID,
    media: { track: 'inbound', chunk: String(chunk), timestamp: String(chunk * 20), payload: Buffer.from([0xff, 0x7f, 0x00]).toString('base64') },
  });
}

test('E2E: Start ohne Creds -> sichtbarer Fehler, Media gezählt+verworfen, Summary', async () => {
  const saved = scrubElevenLabsEnv();
  const server = await startTestServer();
  try {
    const port = server.address().port;
    const ws = await wsClient(port);
    ws.send(twilioStart());
    await sleep(250);
    ws.send(twilioMedia(1));
    ws.send(twilioMedia(2));
    ws.send(twilioMedia(3));
    await sleep(250);
    ws.send(JSON.stringify({ event: 'stop', streamSid: FAKE_STREAM_SID }));
    await sleep(250);
    try { ws.close(); } catch { /* ignore */ }

    const dump = logs.join('\n');
    assert.ok(dump.includes('agent-start'), 'agent-start geloggt');
    assert.match(dump, /"keyConfigured":false/);
    assert.ok(dump.includes('bridge-failed'), 'Fehler sichtbar');
    assert.match(dump, /MISSING_(API_KEY|AGENT_ID)/);
    const sums = summaryLines();
    assert.equal(sums.length, 1);
    const s = JSON.parse(sums[0].replace('MEDIA_SESSION_SUMMARY ', ''));
    assert.equal(s.mediaReceived, 3);
    assert.equal(s.mediaRejected, 3);
    assert.equal(s.audioForwardedToElevenLabs, 0);
    assert.equal(s.rejectReasons['bridge-not-created'], 3);
    assert.equal(s.endedBy, 'stop');
    assert.ok(s.firstMediaAt && s.lastMediaAt);
    // Keine vollständigen IDs, keine Secrets:
    assert.doesNotMatch(dump, /CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.doesNotMatch(dump, /MZbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.doesNotMatch(dump, /sk-/);
  } finally {
    await new Promise((r) => server.close(r));
    restoreEnv(saved);
  }
});

test('E2E: genau EIN Retry nach Fehlschlag, dann Ruhe', async () => {
  const saved = scrubElevenLabsEnv();
  const server = await startTestServer();
  try {
    const port = server.address().port;
    const ws = await wsClient(port);
    ws.send(twilioStart());
    await sleep(2600); // Retry-Fenster (2s) abwarten
    const starts = logs.filter((l) => l.includes('agent-start'));
    assert.equal(starts.length, 2, 'genau 2 Versuche (initial + 1 Retry)');
    assert.ok(starts[1].includes('"attempt":2'));
    ws.send(JSON.stringify({ event: 'stop', streamSid: FAKE_STREAM_SID }));
    try { ws.close(); } catch { /* ignore */ }
    await sleep(2600); // kein dritter Versuch mehr
    assert.equal(logs.filter((l) => l.includes('agent-start')).length, 2, 'kein 3. Versuch');
    assert.equal(summaryLines().length, 1, 'genau eine Summary');
  } finally {
    await new Promise((r) => server.close(r));
    restoreEnv(saved);
  }
});
