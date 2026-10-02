'use strict';

// Entscheidungsstelle für die Gesprächseröffnung (first_message).
//
// BEWUSSTE ENTSCHEIDUNG (kein Bug): Diese Funktion liefert KEINE
// vorformulierte Gesprächsrede mehr zurück, sondern null.
// Begründung: Eine code-seitig erzeugte Schablone (z. B.
// „… ich habe eine Nachricht für Sie.“) wird von ElevenLabs als
// first_message WÖRTLICH gesprochen und wirkt wie ein Callcenter-Skript.
// Stattdessen formuliert der Agent die Eröffnung selbst aus dem bereits
// übergebenen Kontext (Briefing als contextual_update + dynamic_variables
// auftrag/kontakt). Der Auftrag selbst bleibt davon unberührt und wird
// weiterhin vollständig übergeben (siehe instruction.js / call-briefing.js).

function getGreeting() {
  return 'Hallo, hier ist Victor.';
}

function buildDynamicFirstGreeting(context) {
  void context;
  return null;
}

module.exports = { getGreeting, buildDynamicFirstGreeting };
