'use strict';

// Telefonnummer-Normalisierung (provider-neutral).
// Wandelt deutsche/übliche Schreibweisen in E.164 um.
// 0176... → +49176... | 0049... → +49... | +49... bleibt. Sonst null.

function toE164(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[\s\-/.()]/g, '');
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

function isValidE164(value) {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

module.exports = { toE164, isValidE164 };
