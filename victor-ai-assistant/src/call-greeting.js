'use strict';

// Entscheidungsstelle für die Gesprächseröffnung (first_message) bei
// AUSGEHENDEN Telefonaten.
//
// Konzept (keine statische Schablone, keine Kategorie-Hinweise wie
// „Es geht um …“): Die Eröffnung nennt nur kurz Vorstellung und
// Auftraggeberbezug und übergibt dann das Wort. Der eigentliche
// Gesprächszweck entsteht danach natürlich aus dem vollständigen Auftrag,
// den der Agent als Kontext besitzt. So stabilisiert Turn 1 den
// Outbound-Rahmen, ohne Inhalt vorwegzunehmen oder zu schematisieren.
// Ohne Auftragskontext (Direct Chat) -> null (kein Override).

const PRINCIPAL_FIRST_NAME = 'Yazeed';

function getGreeting() {
  return 'Hallo, hier ist Victor.';
}

function buildDynamicFirstGreeting(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const purpose = typeof ctx.purpose === 'string' && ctx.purpose.trim() ? ctx.purpose.trim() : null;
  if (!purpose) return null;
  const agent = typeof ctx.agentName === 'string' && ctx.agentName.trim() ? ctx.agentName.trim() : 'Victor';
  return `Guten Tag, hier ist ${agent}. Ich rufe im Auftrag von ${PRINCIPAL_FIRST_NAME} an.`;
}

module.exports = { getGreeting, buildDynamicFirstGreeting, PRINCIPAL_FIRST_NAME };
