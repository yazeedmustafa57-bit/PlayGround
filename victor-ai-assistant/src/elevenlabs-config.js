'use strict';

// Phase 4 – ElevenLabs-Konfiguration, nur über Prozess-Umgebung (.env).
// Keine Hardcodes, keine Secrets in Logs/Antworten.
// Die Agent-ID wird später ausschließlich via ELEVENLABS_AGENT_ID gesetzt.

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const STATUS_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function getElevenLabsConfig() {
  return {
    apiKey: readEnv('ELEVENLABS_API_KEY'),
    agentId: readEnv('ELEVENLABS_AGENT_ID'),
    baseUrl: (readEnv('ELEVENLABS_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

function isApiKeyConfigured() {
  return getElevenLabsConfig().apiKey.length > 0;
}

function isAgentConfigured() {
  return getElevenLabsConfig().agentId.length > 0;
}

function isFullyConfigured() {
  const cfg = getElevenLabsConfig();
  return cfg.apiKey.length > 0 && cfg.agentId.length > 0;
}

// Sichere, synchrone Basis-Statusantwort (ohne Netz) – niemals Secrets.
function getPublicStatus() {
  return {
    configured: isFullyConfigured(),
    agentConfigured: isAgentConfigured(),
    keyConfigured: isApiKeyConfigured(),
    connected: false,
    verified: false,
    voiceConfigured: readEnv('ELEVENLABS_VOICE_ID').length > 0,
    sttModel: readEnv('ELEVENLABS_STT_MODEL') || 'scribe_v2_realtime',
    ttsModel: readEnv('ELEVENLABS_TTS_MODEL') || 'eleven_flash_v2_5',
  };
}

let cachedStatus = null; // { key, at, value }

function resetElevenLabsStatusCache() {
  cachedStatus = null;
}

function safeError(err) {
  if (err && err.name === 'AbortError') return 'timeout';
  return 'request-failed';
}

// Live-Prüfung des Agenten (read-only). "verified" ist nur true, wenn die
// API den konfigurierten Agenten tatsächlich zurückliefert.
async function verifyElevenLabsConfig({ fetchImpl, timeoutMs, force = false } = {}) {
  const cfg = getElevenLabsConfig();
  const base = getPublicStatus();

  if (!isFullyConfigured()) {
    return { ...base, verified: false, verificationError: 'not-configured' };
  }

  const key = [cfg.baseUrl, cfg.agentId, cfg.apiKey].join('|');
  if (!force && cachedStatus && cachedStatus.key === key && Date.now() - cachedStatus.at < STATUS_TTL_MS) {
    return cachedStatus.value;
  }

  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') {
    const value = { ...base, verified: false, verificationError: 'fetch-unavailable' };
    cachedStatus = { key, at: Date.now(), value };
    return value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  let value;
  try {
    const res = await impl(
      `${cfg.baseUrl}/v1/convai/agents/${encodeURIComponent(cfg.agentId)}`,
      { headers: { 'xi-api-key': cfg.apiKey }, signal: controller.signal }
    );
    let body = {};
    try { body = typeof res.json === 'function' ? await res.json() : {}; } catch { body = {}; }

    if (!res.ok) {
      value = { ...base, verified: false, verificationError: `agent-http-${res.status}` };
    } else if (body?.agent_id && body.agent_id !== cfg.agentId) {
      value = { ...base, verified: false, verificationError: 'agent-mismatch' };
    } else {
      value = {
        ...base,
        verified: true,
        connected: true,
        verificationError: null,
        agentName: typeof body?.name === 'string' ? body.name : null,
      };
    }
  } catch (err) {
    value = { ...base, verified: false, verificationError: safeError(err) };
  } finally {
    clearTimeout(timer);
  }

  cachedStatus = { key, at: Date.now(), value };
  return value;
}

async function getElevenLabsStatus(options = {}) {
  return verifyElevenLabsConfig(options);
}

function getVoiceSettings() {
  return {
    voiceId: readEnv('ELEVENLABS_VOICE_ID'),
    sttModel: readEnv('ELEVENLABS_STT_MODEL') || 'scribe_v2_realtime',
    ttsModel: readEnv('ELEVENLABS_TTS_MODEL') || 'eleven_flash_v2_5',
  };
}

module.exports = {
  getElevenLabsConfig,
  isApiKeyConfigured,
  isAgentConfigured,
  isFullyConfigured,
  getPublicStatus,
  getElevenLabsStatus,
  verifyElevenLabsConfig,
  resetElevenLabsStatusCache,
  getVoiceSettings,
};
