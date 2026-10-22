'use strict';

// Telefonie über den bereits bei ElevenLabs importierten Zadarma-SIP-Trunk.
// Kein zweites Gateway und kein Twilio: ausgehende Anrufe laufen über die
// native ElevenLabs-SIP-Trunk-API. Die Nummer bleibt bei ElevenLabs zugeordnet.
// Secrets kommen ausschließlich aus der Prozess-Umgebung und erscheinen nie in
// Statusantworten oder Logs.

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const STATUS_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function getTelephonyConfig() {
  return {
    provider: 'elevenlabs-sip',
    apiKey: readEnv('ELEVENLABS_API_KEY'),
    agentId: readEnv('ELEVENLABS_AGENT_ID'),
    phoneNumberId: readEnv('ELEVENLABS_PHONE_NUMBER_ID'),
    baseUrl: (readEnv('ELEVENLABS_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

function isTelephonyConfigured() {
  const cfg = getTelephonyConfig();
  // Die Nummern-ID ist optional: fehlt sie, wird die dem Agenten zugeordnete
  // SIP-Trunk-Nummer read-only ermittelt (keine zweite Konfiguration nötig).
  return Boolean(cfg.apiKey && cfg.agentId);
}

// Synchroner, secret-freier Status für Dashboard/App-Konfiguration.
// "verified" ist hier bewusst nicht enthalten: nur ein echter API-Aufruf
// (siehe getTelephonyStatus) darf eine Verbindung als geprüft melden.
function getTelephonySummary() {
  if (!isTelephonyConfigured()) {
    return { provider: null, configured: false, mode: 'not-configured' };
  }
  return { provider: 'elevenlabs-sip', configured: true, mode: 'sip-trunk' };
}

let cachedStatus = null; // { key, at, value }
let resolvedNumber = null; // { key, at, id, error }

function cacheKey(cfg) {
  return [cfg.baseUrl, cfg.agentId, cfg.phoneNumberId || 'auto', cfg.apiKey].join('|');
}

function resetTelephonyStatusCache() {
  cachedStatus = null;
  resolvedNumber = null;
}

async function readJson(res) {
  try {
    if (typeof res.json === 'function') return await res.json();
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function requestJson(url, { method = 'GET', headers = {}, body, fetchImpl, timeoutMs } = {}) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') {
    const err = new Error('Kein HTTP-Client verfügbar.');
    err.code = 'FETCH_UNAVAILABLE';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await impl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    return { res, body: await readJson(res) };
  } finally {
    clearTimeout(timer);
  }
}

function safeError(err) {
  if (err && err.name === 'AbortError') return 'timeout';
  if (err && err.code === 'FETCH_UNAVAILABLE') return 'fetch-unavailable';
  return 'request-failed';
}

// Ermittelt bei fehlender ELEVENLABS_PHONE_NUMBER_ID die dem Agenten
// zugeordnete SIP-Trunk-Nummer. Bei mehreren SIP-Nummern wird bewusst nicht
// geraten, sondern ein klarer Fehler gemeldet.
async function resolvePhoneNumberId({ fetchImpl, timeoutMs, force = false } = {}) {
  const cfg = getTelephonyConfig();
  if (cfg.phoneNumberId) return { id: cfg.phoneNumberId, error: null };

  const key = [cfg.baseUrl, cfg.agentId, cfg.apiKey].join('|');
  if (!force && resolvedNumber && resolvedNumber.key === key && Date.now() - resolvedNumber.at < STATUS_TTL_MS) {
    return resolvedNumber;
  }

  const numberId = (n) => (n && (n.phone_number_id || n.id)) || null;
  const pickSip = (numbers) => numbers.filter(
    (n) => n && n.provider === 'sip_trunk' && typeof numberId(n) === 'string'
  );

  let value;
  try {
    const { res, body } = await requestJson(
      `${cfg.baseUrl}/v1/convai/agents/${encodeURIComponent(cfg.agentId)}`,
      { headers: { 'xi-api-key': cfg.apiKey }, fetchImpl, timeoutMs }
    );
    if (!res.ok) {
      value = { key, at: Date.now(), id: null, error: `agent-http-${res.status}` };
    } else {
      let sipNumbers = pickSip(Array.isArray(body?.phone_numbers) ? body.phone_numbers : []);

      // Fallback für API-Versionen, die die Zuordnung nicht im Agenten liefern:
      // Liste ist ein Array (kein {phone_numbers: […]}) und wird nach Agent gefiltert.
      if (sipNumbers.length === 0) {
        const list = await requestJson(
          `${cfg.baseUrl}/v1/convai/phone-numbers?page_size=100`,
          { headers: { 'xi-api-key': cfg.apiKey }, fetchImpl, timeoutMs }
        );
        const raw = list.body;
        const numbers = Array.isArray(raw) ? raw : (Array.isArray(raw?.phone_numbers) ? raw.phone_numbers : []);
        sipNumbers = pickSip(numbers).filter((n) => {
          const assigned = n?.assigned_agent?.agent_id;
          return !assigned || assigned === cfg.agentId;
        });
      }

      if (sipNumbers.length === 1) {
        value = { key, at: Date.now(), id: numberId(sipNumbers[0]), error: null };
      } else if (sipNumbers.length === 0) {
        value = { key, at: Date.now(), id: null, error: 'no-sip-number' };
      } else {
        value = { key, at: Date.now(), id: null, error: 'multiple-sip-numbers' };
      }
    }
  } catch (err) {
    value = { key, at: Date.now(), id: null, error: safeError(err) };
  }

  resolvedNumber = value;
  return value;
}

// Liefert eine secret-freie Zusammenfassung der Outbound-Trunk-Konfiguration.
// ElevenLabs liefert je nach API-Version `outbound_trunk` (neu) oder
// `provider_config` (deprecated). Beide werden read-only ausgewertet.
function summarizeOutboundTrunk(body) {
  const trunk = body?.outbound_trunk || body?.provider_config;
  if (!trunk || typeof trunk !== 'object') return null;
  const summary = {
    hasOutboundTrunk: trunk.has_outbound_trunk !== false,
    hasAuthCredentials: trunk.has_auth_credentials === true,
  };
  if (typeof trunk.address === 'string' && trunk.address) summary.address = trunk.address;
  if (typeof trunk.transport === 'string' && trunk.transport) summary.transport = trunk.transport;
  if (typeof trunk.media_encryption === 'string' && trunk.media_encryption) {
    summary.mediaEncryption = trunk.media_encryption;
  }
  if (Array.isArray(trunk.enabled_codecs)) {
    summary.codecs = trunk.enabled_codecs.filter((codec) => typeof codec === 'string');
  }
  return summary;
}

// Prüft die bestehende Nummer live bei ElevenLabs (read-only).
// Eine Verbindung gilt nur dann als verifiziert, wenn der Trunk tatsächlich
// ausgehend kann und die Nummer dem konfigurierten Agenten zugeordnet ist.
async function verifyTelephonyConfig({ fetchImpl, timeoutMs, force = false } = {}) {
  const cfg = getTelephonyConfig();
  if (!isTelephonyConfigured()) {
    return {
      provider: null,
      configured: false,
      verified: false,
      mode: 'not-configured',
      supportsInbound: null,
      supportsOutbound: null,
      outboundTrunk: null,
      verificationError: 'not-configured',
    };
  }

  const key = cacheKey(cfg);
  if (!force && cachedStatus && cachedStatus.key === key && Date.now() - cachedStatus.at < STATUS_TTL_MS) {
    return cachedStatus.value;
  }

  const base = {
    provider: 'elevenlabs-sip',
    configured: true,
    verified: false,
    mode: 'sip-trunk',
    supportsInbound: null,
    supportsOutbound: null,
    outboundTrunk: null,
    phoneNumber: null,
    phoneNumberId: cfg.phoneNumberId || null,
    agentId: cfg.agentId,
    verificationError: null,
  };

  let value;
  let phoneNumberId = cfg.phoneNumberId;
  if (!phoneNumberId) {
    const resolved = await resolvePhoneNumberId({ fetchImpl, timeoutMs, force });
    if (!resolved.id) {
      value = { ...base, verificationError: resolved.error || 'phone-number-not-resolved' };
      cachedStatus = { key, at: Date.now(), value };
      return value;
    }
    phoneNumberId = resolved.id;
    base.phoneNumberId = phoneNumberId;
  }

  try {
    const { res, body } = await requestJson(
      `${cfg.baseUrl}/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
      { headers: { 'xi-api-key': cfg.apiKey }, fetchImpl, timeoutMs }
    );
    if (!res.ok) {
      value = { ...base, verificationError: `phone-number-http-${res.status}` };
    } else {
      const assignedAgentId = body?.assigned_agent?.agent_id || null;
      const outboundTrunk = summarizeOutboundTrunk(body);
      // supports_* sind deprecated und defaulten laut ElevenLabs auf true.
      // Fehlt der Outbound-Trunk, ist ein Anruf trotzdem nicht möglich.
      const supportsOutboundFlag = body?.supports_outbound !== false;
      const hasOutboundTrunk = outboundTrunk === null || outboundTrunk.hasOutboundTrunk;
      const supportsOutbound = supportsOutboundFlag && hasOutboundTrunk;
      const supportsInbound = body?.supports_inbound !== false;
      const isSip = body?.provider === 'sip_trunk';
      let verificationError = null;
      if (!isSip) verificationError = 'not-a-sip-trunk';
      else if (body?.supports_outbound === false) verificationError = 'outbound-not-supported';
      else if (!hasOutboundTrunk) verificationError = 'outbound-trunk-missing';
      else if (assignedAgentId && assignedAgentId !== cfg.agentId) verificationError = 'agent-mismatch';

      value = {
        ...base,
        verified: verificationError === null,
        supportsInbound,
        supportsOutbound,
        outboundTrunk,
        phoneNumber: typeof body?.phone_number === 'string' ? body.phone_number : null,
        verificationError,
      };
    }
  } catch (err) {
    value = { ...base, verificationError: safeError(err) };
  }

  cachedStatus = { key, at: Date.now(), value };
  return value;
}

async function getTelephonyStatus(options = {}) {
  return verifyTelephonyConfig(options);
}


// Lädt ein Gespräch (inkl. Transkript) read-only von ElevenLabs.
// Wird für native SIP-Anrufe genutzt, deren Audio nicht über unser Backend läuft.
async function getConversationDetails(conversationId, { fetchImpl, timeoutMs } = {}) {
  const cfg = getTelephonyConfig();
  if (!isTelephonyConfigured()) {
    const err = new Error('Telefonie ist nicht konfiguriert.');
    err.code = 'TELEPHONY_NOT_CONFIGURED';
    throw err;
  }
  if (!conversationId) {
    const err = new Error('Gesprächs-ID fehlt.');
    err.code = 'MISSING_CONVERSATION_ID';
    throw err;
  }

  const { res, body } = await requestJson(
    `${cfg.baseUrl}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    { headers: { 'xi-api-key': cfg.apiKey }, fetchImpl, timeoutMs }
  );
  if (!res.ok) {
    const err = new Error('Gespräch konnte nicht geladen werden.');
    err.code = `CONVERSATION_HTTP_${res.status}`;
    throw err;
  }

  const transcript = (Array.isArray(body?.transcript) ? body.transcript : [])
    .map((entry) => {
      const text = typeof entry?.message === 'string'
        ? entry.message
        : (Array.isArray(entry?.multivoice_message?.parts)
          ? entry.multivoice_message.parts.map((p) => p?.text || '').join(' ')
          : '');
      if (!text) return null;
      return {
        timeInCallSecs: typeof entry?.time_in_call_secs === 'number' ? entry.time_in_call_secs : null,
        speaker: entry?.role === 'user' ? 'caller' : 'victor',
        text,
      };
    })
    .filter(Boolean);

  const errorCode = typeof body?.metadata?.error?.code === 'number' ? body.metadata.error.code : null;
  return {
    status: typeof body?.status === 'string' ? body.status : null,
    agentId: typeof body?.agent_id === 'string' ? body.agent_id : null,
    durationSecs: typeof body?.metadata?.call_duration_secs === 'number' ? body.metadata.call_duration_secs : null,
    callResult: typeof body?.metadata?.phone_call?.call_result === 'string'
      ? body.metadata.phone_call.call_result
      : null,
    errorCode,
    transcript,
  };
}

// Löst einen echten ausgehenden Anruf über den ElevenLabs-SIP-Trunk aus.
// Der Aufrufer muss Konfiguration + Bestätigung vorher geprüft haben.
async function startOutboundCall({ toNumber, fetchImpl, timeoutMs } = {}) {
  const cfg = getTelephonyConfig();
  if (!isTelephonyConfigured()) {
    const err = new Error('Telefonie ist nicht konfiguriert.');
    err.code = 'TELEPHONY_NOT_CONFIGURED';
    throw err;
  }
  if (!toNumber) {
    const err = new Error('Zielnummer fehlt.');
    err.code = 'MISSING_TO';
    throw err;
  }

  let phoneNumberId = cfg.phoneNumberId;
  if (!phoneNumberId) {
    const resolved = await resolvePhoneNumberId({ fetchImpl, timeoutMs });
    if (!resolved.id) {
      const err = new Error('SIP-Trunk-Nummer konnte nicht ermittelt werden.');
      err.code = 'TELEPHONY_PHONE_NUMBER_UNRESOLVED';
      throw err;
    }
    phoneNumberId = resolved.id;
  }

  const { res, body } = await requestJson(`${cfg.baseUrl}/v1/convai/sip-trunk/outbound-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': cfg.apiKey },
    body: JSON.stringify({
      agent_id: cfg.agentId,
      agent_phone_number_id: phoneNumberId,
      to_number: toNumber,
    }),
    fetchImpl,
    timeoutMs,
  });

  if (!res.ok) {
    const err = new Error('Der Telefonie-Anbieter hat den Anruf abgelehnt.');
    err.code = `TELEPHONY_PROVIDER_${res.status}`;
    throw err;
  }
  if (body?.success === false) {
    const err = new Error('Der Telefonie-Anbieter hat den Anruf nicht gestartet.');
    err.code = 'TELEPHONY_PROVIDER_REJECTED';
    throw err;
  }

  return {
    conversationId: typeof body?.conversation_id === 'string' ? body.conversation_id : null,
    sipCallId: typeof body?.sip_call_id === 'string' ? body.sip_call_id : null,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  getTelephonyConfig,
  isTelephonyConfigured,
  getTelephonySummary,
  getTelephonyStatus,
  resolvePhoneNumberId,
  verifyTelephonyConfig,
  startOutboundCall,
  getConversationDetails,
  resetTelephonyStatusCache,
};
