'use strict';

// Phase 4 – dynamisches Call-Briefing für späteren ElevenLabs user_message.
// NUR Fakten + Grenzen + Ziel. Keine Antwortsätze, keine Dialogbeispiele,
// keine Beispielnummern, keine erfundenen Daten, kein Skript.

const { sanitizeState } = require('./personal-data-policy');

const BOUNDARIES = [
  'keine erfundenen Informationen',
  'keine nicht freigegebenen persönlichen Daten',
  'keine technischen Erklärungen gegenüber dem Gesprächspartner',
  'keine Behauptung, etwas erledigt zu haben, wenn es nicht erledigt wurde',
];

function maskPhone(phone) {
  if (typeof phone !== 'string' || !phone.trim()) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-3)}`;
}

function goalForPurpose(purpose) {
  switch (purpose) {
    case 'Nachricht übermitteln':
      return 'Die Nachricht sachlich übermitteln und bestätigen lassen.';
    case 'Termin vereinbaren':
      return 'Einen passenden Terminvorschlag erfragen und festhalten.';
    case 'Termin verschieben':
      return 'Den Verschiebewunsch anbringen und eine Alternative erfragen.';
    case 'Verfügbarkeit erfragen':
      return 'Die Verfügbarkeit zum genannten Zeitpunkt erfragen.';
    case 'Rückruf erbitten':
      return 'Um einen Rückruf bitten und Erreichbarkeit klären.';
    case 'Auskunft einholen':
      return 'Die offene Frage sachlich klären.';
    default:
      return 'Den genannten Auftrag sachlich klären.';
  }
}

// options: { includePhone: boolean } – Standard maskiert (Logs-sicher).
function buildCallBriefing(rawState, options) {
  const state = sanitizeState(rawState || {});
  const includePhone = !!(options && options.includePhone);
  const line = (label, value) => `- ${label}: ${value || 'nicht angegeben'}`;

  const phoneDisplay = state.phoneNumber
    ? (includePhone ? state.phoneNumber : maskPhone(state.phoneNumber))
    : 'nicht angegeben';

  const facts = [
    '=== AUFTRAG / FAKTEN ===',
    line('Zweck', state.purpose),
    line('Kontaktname', state.contactName),
    `- Telefonnummer: ${phoneDisplay}`,
    line('Nachricht', state.message),
    line('Datum', state.requestedDate),
    line('Uhrzeit', state.requestedTime),
  ].join('\n');

  const released = [];
  if (state.contactName) released.push(`- Kontaktname: ${state.contactName}`);
  if (state.message) released.push('- Nachricht: freigegeben (Auftragstext)');
  if (state.requestedDate) released.push(`- Datum: ${state.requestedDate}`);
  if (state.requestedTime) released.push(`- Uhrzeit: ${state.requestedTime}`);
  if (includePhone && state.phoneNumber) released.push('- Telefonnummer: für diesen Anruf freigegeben');
  const releasedBlock = [
    '=== FREIGEGEBENE PERSÖNLICHE DATEN ===',
    released.length ? released.join('\n') : '- keine (nur Auftragskontext)',
  ].join('\n');

  const boundariesBlock = [
    '=== VERBINDLICHE GRENZEN ===',
    ...BOUNDARIES.map((b) => `- ${b}`),
  ].join('\n');

  const goalBlock = [
    '=== GESPRÄCHSZIEL ===',
    goalForPurpose(state.purpose),
  ].join('\n');

  return [facts, releasedBlock, boundariesBlock, goalBlock].join('\n\n');
}

module.exports = { buildCallBriefing, maskPhone, goalForPurpose, BOUNDARIES };
