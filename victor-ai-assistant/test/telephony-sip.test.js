'use strict';

// Tests für die ElevenLabs-SIP-Trunk-Telefonie (Zadarma-Nummer).
// Nur Node-Bordmittel + lokale Module. Kein Netz: fetch wird injiziert.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'ELEVENLABS_PHONE_NUMBER_ID',
  'ELEVENLABS_BASE_URL',
];

const AGENT_ID = 'agent_test_123';
const PHONE_ID = 'phnum_test_456';
const API_KEY = 'sk_test_secret_value';
const NUMBER = '+4944168304115';

let savedEnv = {};

function setConfiguredEnv() {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  process.env.ELEVENLABS_PHONE_NUMBER_ID = PHONE_ID;
}

function phoneNumberBody(overrides = {}) {
  return {
    phone_number: NUMBER,
    provider: 'sip_trunk',
    supports_inbound: true,
    supports_outbound: true,
    assigned_agent: { agent_id: AGENT_ID, agent_name: 'Victor Telefon' },
    provider_config: { username: '393441', has_auth_credentials: true },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeFetch({
  phone = phoneNumberBody(),
  phoneStatus = 200,
  agent = { agent_id: AGENT_ID, phone_numbers: [{ phone_number_id: PHONE_ID, provider: 'sip_trunk', label: 'Zadarma DE' }] },
  agentStatus = 200,
  phoneList = [{ phone_number_id: PHONE_ID, provider: 'sip_trunk', assigned_agent: { agent_id: AGENT_ID } }],
  phoneListStatus = 200,
  conversation = {
    conversation_id: 'conv_1',
    agent_id: AGENT_ID,
    status: 'done',
    metadata: { call_duration_secs: 42 },
    transcript: [
      { role: 'agent', message: 'Guten Tag, hier ist Victor.', time_in_call_secs: 0 },
      { role: 'user', message: 'Ja, gerne.', time_in_call_secs: 3 },
    ],
  },
  conversationStatus = 200,
  outbound = { success: true, conversation_id: 'conv_1', sip_call_id: 'sip_1' },
  outboundStatus = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/v1/convai/sip-trunk/outbound-call')) {
      return jsonResponse(outbound, outboundStatus);
    }
    if (url.includes('/v1/convai/conversations/')) {
      return jsonResponse(conversation, conversationStatus);
    }
    if (/\/v1\/convai\/phone-numbers\?/.test(url)) {
      return jsonResponse(phoneList, phoneListStatus);
    }
    if (url.includes('/v1/convai/phone-numbers/')) {
      return jsonResponse(phone, phoneStatus);
    }
    if (url.includes('/v1/convai/agents/')) {
      return jsonResponse(agent, agentStatus);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of ENV_KEYS) delete process.env[k];
  require('../src/telephony-config').resetTelephonyStatusCache();
  require('../src/outbound-orchestrator').clearSessions();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  require('../src/telephony-config').resetTelephonyStatusCache();
  require('../src/outbound-orchestrator').clearSessions();
});

test('Telefonie-Zusammenfassung: ohne Konfiguration nicht implementiert', () => {
  const telephony = require('../src/telephony-config');
  assert.equal(telephony.isTelephonyConfigured(), false);
  assert.deepEqual(telephony.getTelephonySummary(), {
    provider: null,
    configured: false,
    mode: 'not-configured',
  });
});

test('Telefonie-Zusammenfassung: konfiguriert über ElevenLabs-SIP-Trunk', () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  assert.equal(telephony.isTelephonyConfigured(), true);
  assert.deepEqual(telephony.getTelephonySummary(), {
    provider: 'elevenlabs-sip',
    configured: true,
    mode: 'sip-trunk',
  });
});

test('Nummern-ID ist optional: Key + Agent genügen, Nummer wird ermittelt', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const telephony = require('../src/telephony-config');
  assert.equal(telephony.isTelephonyConfigured(), true);

  const fetchImpl = makeFetch();
  const resolved = await telephony.resolvePhoneNumberId({ fetchImpl });
  assert.equal(resolved.id, PHONE_ID);
  assert.equal(resolved.error, null);
  assert.match(fetchImpl.calls[0].url, /\/v1\/convai\/agents\/agent_test_123$/);

  const status = await telephony.getTelephonyStatus({ fetchImpl, force: true });
  assert.equal(status.verified, true);
  assert.equal(status.phoneNumberId, PHONE_ID);
});

test('Auto-Ermittlung: mehrere SIP-Nummern werden nicht geraten', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const telephony = require('../src/telephony-config');
  const fetchImpl = makeFetch({
    agent: {
      agent_id: AGENT_ID,
      phone_numbers: [
        { phone_number_id: 'phnum_a', provider: 'sip_trunk' },
        { phone_number_id: 'phnum_b', provider: 'sip_trunk' },
      ],
    },
  });
  const status = await telephony.getTelephonyStatus({ fetchImpl });
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'multiple-sip-numbers');
});

test('Auto-Ermittlung nutzt die Listen-API (Array) als Fallback', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const telephony = require('../src/telephony-config');
  const fetchImpl = makeFetch({ agent: { agent_id: AGENT_ID } });
  const resolved = await telephony.resolvePhoneNumberId({ fetchImpl });
  assert.equal(resolved.id, PHONE_ID);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /phone-numbers\?page_size=100$/);
});

test('Status ohne Konfiguration ruft kein Netz auf', async () => {
  const telephony = require('../src/telephony-config');
  let called = false;
  const status = await telephony.getTelephonyStatus({
    fetchImpl: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(status.configured, false);
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'not-configured');
});

test('Live-Prüfung: SIP-Trunk + Outbound + Agent-Zuordnung = verifiziert', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const fetchImpl = makeFetch();
  const status = await telephony.getTelephonyStatus({ fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/v1\/convai\/phone-numbers\/phnum_test_456$/);
  assert.equal(fetchImpl.calls[0].options.headers['xi-api-key'], API_KEY);
  assert.equal(status.provider, 'elevenlabs-sip');
  assert.equal(status.configured, true);
  assert.equal(status.verified, true);
  assert.equal(status.supportsInbound, true);
  assert.equal(status.supportsOutbound, true);
  assert.equal(status.phoneNumber, NUMBER);
  assert.equal(status.verificationError, null);
  assert.doesNotMatch(JSON.stringify(status), /sk_test_secret_value/);
});

test('Live-Prüfung: deprecatete supports-Flags defaulten auf true', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const status = await telephony.getTelephonyStatus({
    fetchImpl: makeFetch({
      phone: phoneNumberBody({ supports_inbound: undefined, supports_outbound: undefined }),
    }),
  });
  assert.equal(status.verified, true);
  assert.equal(status.supportsInbound, true);
  assert.equal(status.supportsOutbound, true);
  assert.equal(status.verificationError, null);
});

test('Live-Prüfung: outbound_trunk wird secret-frei zusammengefasst', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const status = await telephony.getTelephonyStatus({
    fetchImpl: makeFetch({
      phone: phoneNumberBody({
        provider_config: undefined,
        outbound_trunk: {
          address: 'sip.zadarma.com',
          transport: 'tls',
          media_encryption: 'allowed',
          username: '393441',
          password: 'super-secret',
          has_auth_credentials: true,
          has_outbound_trunk: true,
          enabled_codecs: ['ulaw', 'alaw'],
        },
      }),
    }),
  });
  assert.equal(status.verified, true);
  assert.deepEqual(status.outboundTrunk, {
    hasOutboundTrunk: true,
    hasAuthCredentials: true,
    address: 'sip.zadarma.com',
    transport: 'tls',
    mediaEncryption: 'allowed',
    codecs: ['ulaw', 'alaw'],
  });
  assert.doesNotMatch(JSON.stringify(status), /super-secret|393441/);
});

test('Live-Prüfung: fehlender Outbound-Trunk wird erkannt', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const status = await telephony.getTelephonyStatus({
    fetchImpl: makeFetch({
      phone: phoneNumberBody({
        provider_config: undefined,
        outbound_trunk: { address: 'sip.zadarma.com', has_outbound_trunk: false },
      }),
    }),
  });
  assert.equal(status.verified, false);
  assert.equal(status.supportsOutbound, false);
  assert.equal(status.verificationError, 'outbound-trunk-missing');
});

test('Live-Prüfung: falscher Agent wird nicht als verifiziert gemeldet', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const status = await telephony.getTelephonyStatus({
    fetchImpl: makeFetch({ phone: phoneNumberBody({ assigned_agent: { agent_id: 'agent_other' } }) }),
  });
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'agent-mismatch');
});

test('Live-Prüfung: fehlender Outbound-Support wird erkannt', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const status = await telephony.getTelephonyStatus({
    fetchImpl: makeFetch({ phone: phoneNumberBody({ supports_outbound: false }) }),
  });
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'outbound-not-supported');
});

test('Live-Prüfung: HTTP-Fehler wird sicher gemeldet', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const status = await telephony.getTelephonyStatus({ fetchImpl: makeFetch({ phoneStatus: 401 }) });
  assert.equal(status.verified, false);
  assert.equal(status.verificationError, 'phone-number-http-401');
  assert.doesNotMatch(JSON.stringify(status), /sk_test_secret_value/);
});

test('Outbound-Aufruf nutzt die native SIP-Trunk-API mit korrektem Body', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const fetchImpl = makeFetch();
  const result = await telephony.startOutboundCall({ toNumber: '+491701234567', fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/v1\/convai\/sip-trunk\/outbound-call$/);
  assert.equal(fetchImpl.calls[0].options.method, 'POST');
  assert.equal(fetchImpl.calls[0].options.headers['xi-api-key'], API_KEY);
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    agent_id: AGENT_ID,
    agent_phone_number_id: PHONE_ID,
    to_number: '+491701234567',
  });
  assert.deepEqual(result, { conversationId: 'conv_1', sipCallId: 'sip_1' });
});

test('Outbound-Aufruf ermittelt die Nummern-ID bei Bedarf automatisch', async () => {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  const telephony = require('../src/telephony-config');
  const fetchImpl = makeFetch();
  const result = await telephony.startOutboundCall({ toNumber: '+491701234567', fetchImpl });

  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /\/v1\/convai\/agents\//);
  const sent = JSON.parse(fetchImpl.calls[1].options.body);
  assert.equal(sent.agent_phone_number_id, PHONE_ID);
  assert.equal(result.conversationId, 'conv_1');
});

test('Orchestrator: ohne Konfiguration keine Bestätigungsabfrage und kein Anruf', async () => {
  const orch = require('../src/outbound-orchestrator');
  const s = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(s.status, 'telephony-unavailable');
  assert.equal(s.provider, null);
  assert.equal(s.simulated, true);
});

test('Orchestrator: konfiguriert, aber ohne Bestätigung wird nicht angerufen', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch();
  const s = await orch.startCall({ instruction: 'Test', to: '+491701234567', fetchImpl });

  assert.equal(s.status, 'confirmation-required');
  assert.equal(s.provider, 'elevenlabs-sip');
  assert.equal(s.simulated, true);
  assert.equal(s.callRef, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('Orchestrator: bestätigt + verifiziert startet echten Anruf', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch();
  const s = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    confirm: true,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(s.status, 'dialing');
  assert.equal(s.simulated, false);
  assert.equal(s.provider, 'elevenlabs-sip');
  assert.equal(s.callRef, 'conv_1');
  assert.equal(s.error, null);
  const sent = JSON.parse(fetchImpl.calls[1].options.body);
  assert.equal(sent.to_number, '+491701234567');
});

test('Orchestrator: Anbieter-Ablehnung erzeugt call-failed ohne Secrets', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch({ outbound: { detail: 'nope' }, outboundStatus: 400 });
  const s = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    confirm: true,
    fetchImpl,
  });

  assert.equal(s.status, 'call-failed');
  assert.equal(s.simulated, false);
  assert.equal(s.error, 'TELEPHONY_PROVIDER_400');
  assert.equal(s.callRef, null);
  assert.doesNotMatch(JSON.stringify(s), /sk_test_secret_value/);
});

test('Orchestrator: unverifizierte Nummer blockiert den Anruf', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch({ phone: phoneNumberBody({ supports_outbound: false }) });
  const s = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    confirm: true,
    fetchImpl,
  });

  assert.equal(s.status, 'telephony-unverified');
  assert.equal(s.simulated, true);
  assert.equal(s.error, 'outbound-not-supported');
  assert.equal(fetchImpl.calls.length, 1);
});

test('Gesprächsdetails: Transkript wird auf caller/victor abgebildet', async () => {
  setConfiguredEnv();
  const telephony = require('../src/telephony-config');
  const fetchImpl = makeFetch();
  const details = await telephony.getConversationDetails('conv_1', { fetchImpl });
  assert.equal(fetchImpl.calls[0].options.headers['xi-api-key'], API_KEY);
  assert.equal(details.status, 'done');
  assert.equal(details.durationSecs, 42);
  assert.deepEqual(details.transcript.map((e) => [e.speaker, e.text]), [
    ['victor', 'Guten Tag, hier ist Victor.'],
    ['caller', 'Ja, gerne.'],
  ]);
  assert.doesNotMatch(JSON.stringify(details), /sk_test_secret_value/);
});

test('Orchestrator: echtes Transkript wird nach dem Anruf nachgeladen', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch();
  const started = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    confirm: true,
    fetchImpl,
  });
  assert.equal(started.status, 'dialing');
  assert.equal(started.conversationId, 'conv_1');

  const session = await orch.syncSessionTranscript(started.id, { fetchImpl, force: true });
  assert.equal(session.status, 'completed');
  assert.equal(session.transcript.length, 2);
  assert.equal(session.transcript[0].speaker, 'victor');
  assert.equal(session.transcriptSyncError, null);
});

test('Orchestrator: Transkript-Fehler wird gespeichert, nicht als Erfolg gemeldet', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch({ conversationStatus: 404 });
  const started = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    confirm: true,
    fetchImpl,
  });
  const session = await orch.syncSessionTranscript(started.id, { fetchImpl, force: true });
  assert.equal(session.status, 'dialing');
  assert.equal(session.transcriptSyncError, 'CONVERSATION_HTTP_404');
});

test('Orchestrator: SIP-Ablehnung wird als echter Fehlercode sichtbar', async () => {
  setConfiguredEnv();
  const orch = require('../src/outbound-orchestrator');
  const fetchImpl = makeFetch({
    conversation: {
      conversation_id: 'conv_1',
      agent_id: AGENT_ID,
      status: 'failed',
      metadata: {
        call_duration_secs: 0,
        error: { code: 603, reason: 'Decline' },
        phone_call: { type: 'sip_trunking', call_result: 'failed' },
      },
      transcript: [],
    },
  });
  const started = await orch.startCall({
    instruction: 'Test',
    to: '+491701234567',
    confirm: true,
    fetchImpl,
  });
  const session = await orch.syncSessionTranscript(started.id, { fetchImpl, force: true });
  assert.equal(session.status, 'call-failed');
  assert.equal(session.error, 'sip-603');
  assert.match(orch.describeCallError(session.error), /SIP 603/);
  assert.match(orch.describeCallError(session.error), /CallerID/);
  assert.equal(orch.describeCallError(null), null);
});

test('Fehlertexte nennen keine Secrets', () => {
  const orch = require('../src/outbound-orchestrator');
  const texts = [
    orch.describeCallError('sip-603'),
    orch.describeCallError('sip-403'),
    orch.describeCallError('TELEPHONY_PROVIDER_400'),
    orch.describeCallError('outbound-trunk-missing'),
  ];
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text, /sk_|secret|password/i);
  }
});
