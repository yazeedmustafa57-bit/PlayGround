'use strict';

// Restarbeiten-Tests: Twilio-Scaffolding, Status-Endpunkte, Security-Headers.
// Nur Node-Bordmittel, kein Netzwerk nach außen, keine Secrets.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { getTwilioPublicStatus, isTwilioConfigured } = require('../src/twilio-config');
const {
  parseStreamMessage,
  extractAudioPayload,
  buildMediaMessage,
  buildMarkMessage,
  buildVoiceTwiml,
} = require('../src/twilio-media');

let savedSid;
let savedToken;
let savedPhone;

beforeEach(() => {
  savedSid = process.env.TWILIO_ACCOUNT_SID;
  savedToken = process.env.TWILIO_AUTH_TOKEN;
  savedPhone = process.env.TWILIO_PHONE_NUMBER;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
});

afterEach(() => {
  if (savedSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
  else process.env.TWILIO_ACCOUNT_SID = savedSid;
  if (savedToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = savedToken;
  if (savedPhone === undefined) delete process.env.TWILIO_PHONE_NUMBER;
  else process.env.TWILIO_PHONE_NUMBER = savedPhone;
});

test('Twilio ohne Credentials -> nicht konfiguriert, keine Secrets im Status', () => {
  assert.equal(isTwilioConfigured(), false);
  const s = getTwilioPublicStatus();
  assert.equal(s.configured, false);
  assert.equal(s.connected, false);
  assert.ok(!('authToken' in s) && !('accountSid' in s) && !('phoneNumber' in s));
});

test('Twilio mit allen Werten -> konfiguriert (Status weiter secret-frei)', () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN = 'secret-token';
  process.env.TWILIO_PHONE_NUMBER = '+491701234567';
  assert.equal(isTwilioConfigured(), true);
  const body = JSON.stringify(getTwilioPublicStatus());
  assert.doesNotMatch(body, /secret-token/);
  assert.doesNotMatch(body, /\+491701234567/);
});

test('Stream-Parser: connected/start/media/stop ok, unbekannt -> Fehler', () => {
  assert.equal(parseStreamMessage('{"event":"connected"}').event, 'connected');
  assert.equal(parseStreamMessage('{"event":"start","start":{}}').event, 'start');
  assert.throws(() => parseStreamMessage('not-json'), (e) => e.code === 'INVALID_JSON');
  assert.throws(() => parseStreamMessage('{"event":"fax"}'), (e) => e.code === 'UNKNOWN_EVENT');
});

test('Audio-Payload: nur media-Events, base64-validiert', () => {
  const b64 = Buffer.from('audio-bytes').toString('base64');
  assert.equal(extractAudioPayload({ event: 'media', media: { payload: b64 } }), b64);
  assert.equal(extractAudioPayload({ event: 'start' }), null);
  assert.throws(
    () => extractAudioPayload({ event: 'media', media: { payload: '!!!kein-base64!!!' } }),
    (e) => e.code === 'INVALID_PAYLOAD'
  );
});

test('Builder: media/mark-Nachrichten + TwiML ohne Injection', () => {
  const m = buildMediaMessage('stream-1', 'abcd');
  assert.equal(m.event, 'media');
  assert.equal(m.media.payload, 'abcd');
  const mark = buildMarkMessage('stream-1', 'teil-1');
  assert.equal(mark.event, 'mark');
  const twiml = buildVoiceTwiml({ streamUrl: 'wss://example.invalid/stream' });
  assert.match(twiml, /<Response>/);
  assert.match(twiml, /example\.invalid/);
  const evil = buildVoiceTwiml({ streamUrl: '"><XSS' });
  assert.doesNotMatch(evil, /"><XSS/);
});

function startServer() {
  const { createServer } = require('../src/server.js');
  const server = createServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
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

test('GET /api/twilio/status: 200, secret-frei, Methode POST -> 405', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const r = await getJSON(port, '/api/twilio/status');
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.connected, false);
    assert.ok(!('authToken' in json));
    const post = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/twilio/status', method: 'POST' },
        (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(post, 405);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('Security-Headers auf JSON- und HTML-Antworten', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const h = await getJSON(port, '/health');
    assert.equal(h.headers['x-content-type-options'], 'nosniff');
    assert.equal(h.headers['x-frame-options'], 'DENY');
    const page = await getJSON(port, '/');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('Bisherige Routen weiter intakt (/health, /chat, 404)', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    assert.equal((await getJSON(port, '/health')).status, 200);
    assert.equal((await getJSON(port, '/chat')).status, 200);
    assert.equal((await getJSON(port, '/eleven-chat')).status, 200);
    assert.equal((await getJSON(port, '/gibt-es-nicht')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
