'use strict';

// Live-Prüfung des ElevenLabs-Agenten – ohne Netz (injiziertes fetch).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_BASE_URL'];
const AGENT_ID = 'agent_test_123';
const API_KEY = 'sk_test_secret_value';

let savedEnv = {};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of ENV_KEYS) delete process.env[k];
  require('../src/elevenlabs-config').resetElevenLabsStatusCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  require('../src/elevenlabs-config').resetElevenLabsStatusCache();
});

test('ElevenLabs-Status ohne Konfiguration ruft kein Netz auf', async () => {
  const cfg = require('../src/elevenlabs-config');
  let called = false;
  const status = await cfg.getElevenLabsStatus({ fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(status.configured, false);
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'not-configured');
});

test('ElevenLabs-Agent wird live verifiziert, ohne Secrets', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const cfg = require('../src/elevenlabs-config');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ agent_id: AGENT_ID, name: 'Victor Telefon' });
  };
  const status = await cfg.getElevenLabsStatus({ fetchImpl });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/convai\/agents\/agent_test_123$/);
  assert.equal(calls[0].options.headers['xi-api-key'], API_KEY);
  assert.equal(status.verified, true);
  assert.equal(status.connected, true);
  assert.equal(status.agentName, 'Victor Telefon');
  assert.doesNotMatch(JSON.stringify(status), /sk_test_secret_value/);
});

test('ElevenLabs-Agent: fremde Agent-ID gilt nicht als verifiziert', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const cfg = require('../src/elevenlabs-config');
  const status = await cfg.getElevenLabsStatus({
    fetchImpl: async () => jsonResponse({ agent_id: 'agent_other', name: 'Fremd' }),
  });
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'agent-mismatch');
});

test('ElevenLabs-Agent: HTTP-Fehler wird sicher gemeldet', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const cfg = require('../src/elevenlabs-config');
  const status = await cfg.getElevenLabsStatus({
    fetchImpl: async () => jsonResponse({ detail: 'unauthorized' }, 401),
  });
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'agent-http-401');
  assert.doesNotMatch(JSON.stringify(status), /sk_test_secret_value/);
});
