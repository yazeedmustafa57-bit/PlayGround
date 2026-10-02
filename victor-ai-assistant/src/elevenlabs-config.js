'use strict';

// Phase 4 – ElevenLabs-Konfiguration, nur über Prozess-Umgebung (.env).
// Keine Hardcodes, keine Secrets in Logs/Antworten.
// Die Agent-ID wird später ausschließlich via ELEVENLABS_AGENT_ID gesetzt.

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function getElevenLabsConfig() {
  return {
    apiKey: readEnv('ELEVENLABS_API_KEY'),
    agentId: readEnv('ELEVENLABS_AGENT_ID'),
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

// Sichere Statusantwort für GET /api/elevenlabs/status – niemals Secrets.
function getPublicStatus() {
  return {
    configured: isFullyConfigured(),
    agentConfigured: isAgentConfigured(),
    keyConfigured: isApiKeyConfigured(),
    connected: false,
    voiceConfigured: readEnv('ELEVENLABS_VOICE_ID').length > 0,
    sttModel: readEnv('ELEVENLABS_STT_MODEL') || 'scribe_v2_realtime',
    ttsModel: readEnv('ELEVENLABS_TTS_MODEL') || 'eleven_flash_v2_5',
  };
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
  getVoiceSettings,
};
