'use strict';

// Twilio-Konfiguration, nur über Prozess-Umgebung (.env).
// Keine Hardcodes, keine Secrets in Logs/Antworten, kein SDK, keine Live-Calls.
// Echte Anrufe/Media Streams werden erst in einer späteren Phase mit
// expliziter Freigabe angeschlossen.

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function getTwilioConfig() {
  return {
    accountSid: readEnv('TWILIO_ACCOUNT_SID'),
    authToken: readEnv('TWILIO_AUTH_TOKEN'),
    phoneNumber: readEnv('TWILIO_PHONE_NUMBER'),
  };
}

function isTwilioConfigured() {
  const cfg = getTwilioConfig();
  return Boolean(cfg.accountSid && cfg.authToken && cfg.phoneNumber);
}

// Sichere Statusantwort – niemals Secrets oder Rufnummern.
function getTwilioPublicStatus() {
  const cfg = getTwilioConfig();
  return {
    configured: isTwilioConfigured(),
    accountConfigured: Boolean(cfg.accountSid),
    phoneConfigured: Boolean(cfg.phoneNumber),
    connected: false,
    mode: 'scaffold-only',
  };
}

module.exports = { getTwilioConfig, isTwilioConfigured, getTwilioPublicStatus };
