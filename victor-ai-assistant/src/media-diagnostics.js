'use strict';

// Diagnose-Helfer für den Twilio→live-bridge Audio-Uplink.
// Reine Zählung + Logging, KEINE Call-Logik, KEINE Audioinhalte,
// KEINE Secrets, KEINE Telefonnummern (SIDs nur gekürzt).

function shortSid(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createSessionDiagnostics() {
  const tStart = Date.now();
  const d = {
    mediaReceived: 0,
    mediaRejected: 0,
    audioForwarded: 0,
    rejectReasons: {},
    firstMediaAt: null,
    lastMediaAt: null,
    firstForwardedAt: null,
    lastForwardedAt: null,
    elevenLabsOpened: false,
    elevenLabsErrors: 0,
    elevenLabsCloseCode: null,
    twilioCloseCode: null,
    ended: false,
  };

  function logLine(msg, extra) {
    const line = extra === undefined
      ? `[media-stream] ${msg}`
      : `[media-stream] ${msg} ${JSON.stringify(extra).slice(0, 400)}`;
    console.log(line);
  }

  const tracker = {
    onStart({ streamSid, callSid, mediaFormat, tracks, hasSession }) {
      logLine('start', {
        at: nowIso(),
        stream: shortSid(streamSid),
        call: shortSid(callSid),
        encoding: (mediaFormat && mediaFormat.encoding) || null,
        sampleRate: (mediaFormat && mediaFormat.sampleRate) || null,
        channels: (mediaFormat && mediaFormat.channels) || null,
        tracks: tracks === undefined ? null : tracks,
        hasSession: Boolean(hasSession),
      });
    },

    onParseError(reason) {
      d.mediaRejected += 1;
      d.rejectReasons[reason] = (d.rejectReasons[reason] || 0) + 1;
      logLine('rejected', { reason });
    },

    onMedia({ payloadLength, track, chunk }) {
      d.mediaReceived += 1;
      const at = nowIso();
      if (!d.firstMediaAt) d.firstMediaAt = at;
      d.lastMediaAt = at;
      if (d.mediaReceived === 1 || d.mediaReceived % 200 === 0) {
        logLine('inbound', {
          count: d.mediaReceived,
          payloadLength: payloadLength === undefined ? null : payloadLength,
          track: track === undefined ? null : track,
          chunk: chunk === undefined ? null : chunk,
        });
      }
    },

    onReject(reason) {
      d.mediaRejected += 1;
      d.rejectReasons[reason] = (d.rejectReasons[reason] || 0) + 1;
      logLine('rejected', { reason });
    },

    onForwarded() {
      d.audioForwarded += 1;
      const at = nowIso();
      if (!d.firstForwardedAt) d.firstForwardedAt = at;
      d.lastForwardedAt = at;
    },

    onBridgeEvent(ev) {
      const type = ev && ev.type;
      if (type === 'connecting') logLine('bridge-connecting');
      if (type === 'open' || type === 'session_started') d.elevenLabsOpened = true;
      if (type === 'live') {
        d.elevenLabsOpened = true;
        const detail = (ev && ev.detail) || {};
        logLine('bridge-live', { in: detail.in || null, out: detail.out || null });
      }
      if (type === 'error') {
        d.elevenLabsErrors += 1;
        logLine('bridge-error');
      }
      if (type === 'close') {
        const detail = (ev && ev.detail) || {};
        if (d.elevenLabsCloseCode === null) d.elevenLabsCloseCode = detail.code === undefined ? null : detail.code;
      }
    },

    onTwilioClose({ code, reason, source }) {
      d.twilioCloseCode = code === undefined ? null : code;
      logLine('twilio-close', {
        source: source || null,
        code: d.twilioCloseCode,
        reason: typeof reason === 'string' ? reason.slice(0, 120) : null,
      });
      tracker.summarize('twilio-close');
    },

    onTwilioError(message) {
      logLine('twilio-error', { message: String(message || 'unknown').slice(0, 160) });
      tracker.summarize('twilio-error');
    },

    // Bridge-Aufbau pro Session: nur Booleans + gekürzte IDs, nie Secrets.
    onAgentStart({ attempt, hasSession, sessionShort, keyConfigured, agentConfigured }) {
      logLine('agent-start', {
        attempt: attempt === undefined ? null : attempt,
        hasSession: Boolean(hasSession),
        session: sessionShort || null,
        keyConfigured: Boolean(keyConfigured),
        agentConfigured: Boolean(agentConfigured),
      });
    },

    onAgentReady() {
      logLine('bridge-ready');
    },

    onAgentFailed(safeMessage) {
      logLine('bridge-failed', { error: String(safeMessage || 'unknown').slice(0, 200) });
    },

    onStop() {
      tracker.summarize('stop');
    },

    summarize(source) {
      if (d.ended) return null;
      d.ended = true;
      const summary = {
        durationMs: Date.now() - tStart,
        mediaReceived: d.mediaReceived,
        mediaRejected: d.mediaRejected,
        audioForwardedToElevenLabs: d.audioForwarded,
        firstMediaAt: d.firstMediaAt,
        lastMediaAt: d.lastMediaAt,
        firstForwardedAt: d.firstForwardedAt,
        lastForwardedAt: d.lastForwardedAt,
        elevenLabsOpened: d.elevenLabsOpened,
        elevenLabsErrors: d.elevenLabsErrors,
        elevenLabsCloseCode: d.elevenLabsCloseCode,
        rejectReasons: { ...d.rejectReasons },
        endedBy: source || null,
      };
      console.log(`MEDIA_SESSION_SUMMARY ${JSON.stringify(summary)}`);
      return summary;
    },

    snapshot() {
      return {
        mediaReceived: d.mediaReceived,
        mediaRejected: d.mediaRejected,
        audioForwarded: d.audioForwarded,
        firstMediaAt: d.firstMediaAt,
        lastMediaAt: d.lastMediaAt,
        elevenLabsOpened: d.elevenLabsOpened,
        elevenLabsErrors: d.elevenLabsErrors,
      };
    },
  };

  return tracker;
}

module.exports = { createSessionDiagnostics, shortSid };
