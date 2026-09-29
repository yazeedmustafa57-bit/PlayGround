'use strict';

// Phase 3 – Vorbereitung dynamischer Begrüßung für spätere ElevenLabs first_message.
// Kurz, natürlich, variierend. Keine erzwungene KI-Selbstvorstellung,
// keine künstliche Smalltalk-Frage.

function getGreeting() {
  return 'Hallo, hier ist Victor.';
}

function buildDynamicFirstGreeting(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const contact = typeof ctx.contactName === 'string' && ctx.contactName.trim()
    ? ctx.contactName.trim()
    : null;
  const purpose = typeof ctx.purpose === 'string' ? ctx.purpose : null;

  if (contact && purpose === 'Nachricht übermitteln') {
    return `Hallo ${contact}, hier ist Victor. Ich habe eine Nachricht für Sie.`;
  }
  if (contact && (purpose === 'Termin vereinbaren' || purpose === 'Termin verschieben')) {
    return `Hallo ${contact}, hier ist Victor. Es geht um einen Termin.`;
  }
  if (contact && purpose === 'Rückruf erbitten') {
    return `Hallo ${contact}, hier ist Victor. Man bat um einen Rückruf.`;
  }
  if (contact) {
    return `Hallo ${contact}, hier ist Victor.`;
  }
  if (purpose === 'Termin vereinbaren' || purpose === 'Termin verschieben') {
    return 'Hallo, hier ist Victor. Es geht um einen Termin.';
  }
  return 'Hallo, hier ist Victor.';
}

module.exports = { getGreeting, buildDynamicFirstGreeting };
