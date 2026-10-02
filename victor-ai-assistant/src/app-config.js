'use strict';

// Zentrale App-Konfiguration (nur .env, keine Secrets in Antworten/Logs).
// Alle Werte haben sichere Defaults, damit Dashboard + Tests ohne Keys laufen.

function readEnv(name, fallback) {
  const v = process.env[name];
  if (typeof v !== 'string' || !v.trim()) return fallback;
  return v.trim();
}

function getAppConfig() {
  return {
    port: Number.parseInt(process.env.PORT || '5051', 10) || 5051,
    publicBaseUrl: readEnv('PUBLIC_BASE_URL', ''),
    agentName: readEnv('AGENT_NAME', 'Victor'),
    agentLanguage: readEnv('AGENT_LANGUAGE', 'de'),
    // Kein externes LLM: Dialoglogik = ElevenLabs Conversational AI Agent.
    llmModel: 'elevenlabs-agent',
    llmConfigured: false,
    audioFormat: 'ulaw_8000', // Twilio-Pflichtformat: 8 kHz mono ulaw
  };
}

// Öffentliche Settings fürs Dashboard (rechte Spalte) – ohne Secrets.
function getPublicSettings() {
  const cfg = getAppConfig();
  const eleven = require('./elevenlabs-config');
  const twilio = require('./twilio-config');
  const voice = eleven.getVoiceSettings();
  return {
    agentName: cfg.agentName,
    agentLanguage: cfg.agentLanguage,
    audioFormat: cfg.audioFormat,
    llmModel: cfg.llmModel,
    llmConfigured: cfg.llmConfigured,
    elevenlabs: {
      agentConfigured: eleven.isAgentConfigured(),
      keyConfigured: eleven.isApiKeyConfigured(),
      voiceConfigured: voice.voiceId.length > 0,
      sttModel: voice.sttModel,
      ttsModel: voice.ttsModel,
    },
    twilio: twilio.getTwilioPublicStatus(),
    // Öffentliche Erreichbarkeit (Tunnel-URL, kein Secret – nur Hostname).
    cloudflare: {
      connected: cfg.publicBaseUrl.length > 0,
      publicBaseUrl: cfg.publicBaseUrl || null,
    },
  };
}

module.exports = { getAppConfig, getPublicSettings };
