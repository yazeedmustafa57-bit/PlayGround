'use strict';

// Twilio Voice: ausgehende Anrufe + TwiML für Media Streams.
// - startOutboundCall(): nur mit Credentials, sonst MOCK-Modus (kein Netz).
// - TwiML-Builder: Begrüßung als KI-Assistent + <Stream> zum Backend.
// Twilio-SDK wird lazy geladen, damit Tests ohne Netz/SDK-Creds laufen.

const { getTwilioConfig, isTwilioConfigured } = require('./twilio-config');
const { getAppConfig } = require('./app-config');
const { buildVoiceTwiml } = require('./twilio-media');

function escapeXml(s) {
  return String(s || '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

// Standard-Begrüßung: stellt sich als KI-Assistent vor (Pflicht laut Spec).
function buildIntroSayText({ agentName, contactName }) {
  const name = agentName || 'Victor';
  const who = contactName ? ` ${contactName}` : '';
  return `Hallo${who}, hier ist ${name}, Ihr KI-Assistent.`;
}

function mediaStreamUrl(publicBaseUrl) {
  const base = String(publicBaseUrl || '').replace(/\/$/, '');
  if (!base) return '';
  return base.replace(/^http/, 'ws') + '/media-stream';
}

// TwiML für ausgehende Anrufe: direkt bidirektionaler Media Stream.
// WICHTIG (Twilio-Fehler 31941): Mit <Connect> ist NUR track="inbound_track"
// erlaubt (bzw. kein Attribut = Default). both_tracks/outbound gehen nur mit
// <Start> und legen sonst den Anruf sofort auf. Unser Audio zurück an Twilio
// funktioniert trotzdem (Media-Nachrichten gehen immer).
// KEIN <Say>: Die Begrüßung spricht der ElevenLabs-Agent selbst (Helmut),
// damit der Anrufer nur EINE Stimme hört (keine Twilio-Stimme davor).
function buildOutboundTwiml({ publicBaseUrl } = {}) {
  const streamUrl = mediaStreamUrl(publicBaseUrl);
  const streamPart = streamUrl
    ? `    <Stream url="${escapeXml(streamUrl)}" />`
    : '    <!-- PUBLIC_BASE_URL fehlt: Media Stream inaktiv -->';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    streamPart,
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

// Wandelt deutsche/übliche Schreibweisen in E.164 um (Twilio-Pflicht).
// 0176... → +49176... | 0049... → +49... | +49... bleibt. Sonst null.
function toE164(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s\-/.()]/g, '');
  if (s.startsWith('+')) {
    return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
  }
  if (s.startsWith('00')) {
    const e = `+${s.slice(2)}`;
    return /^\+[1-9]\d{7,14}$/.test(e) ? e : null;
  }
  if (s.startsWith('0')) {
    const e = `+49${s.slice(1)}`;
    return /^\+[1-9]\d{7,14}$/.test(e) ? e : null;
  }
  return null;
}

// Startet einen ausgehenden Anruf. Ohne Credentials: simuliertes Ergebnis
// (simulated:true), KEIN Netz. Mit Credentials: echte Twilio-REST-Nutzung.
async function startOutboundCall({ to, twimlUrl, statusCallbackUrl, client } = {}) {
  const cfg = getTwilioConfig();
  const app = getAppConfig();
  const target = toE164(to);
  if (!target) {
    const err = new Error(
      !to || typeof to !== 'string'
        ? 'Missing target number "to"'
        : 'Ungültige Zielnummer – bitte im Format +49... oder 01... angeben.'
    );
    err.code = !to || typeof to !== 'string' ? 'MISSING_TO' : 'INVALID_TO';
    throw err;
  }
  if (!isTwilioConfigured()) {
    return {
      ok: true,
      simulated: true,
      sid: `MOCK-${Date.now()}`,
      to: target,
      from: cfg.phoneNumber || 'unconfigured',
      note: 'Twilio nicht konfiguriert – simulierter Anruf, kein Netz.',
    };
  }
  const twilioClient = client || (() => {
    // eslint-disable-next-line global-require
    const twilio = require('twilio');
    return twilio(cfg.accountSid, cfg.authToken);
  })();
  const base = String(app.publicBaseUrl || '').replace(/\/$/, '');
  const call = await twilioClient.calls.create({
    to: target,
    from: cfg.phoneNumber,
    url: twimlUrl || `${base}/voice/outgoing`,
    statusCallback: statusCallbackUrl || `${base}/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
  });
  return { ok: true, simulated: false, sid: call.sid, to: target, from: cfg.phoneNumber };
}

module.exports = {
  buildIntroSayText,
  buildOutboundTwiml,
  startOutboundCall,
  toE164,
  mediaStreamUrl,
  buildVoiceTwiml,
};
