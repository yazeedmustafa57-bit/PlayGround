'use strict';

// Phase 3 – lokale, deterministische Auftragserkennung. Keine externen Dienste.
// Unterstützt natürliche Imperative, keine überempfindliche Erkennung.
// Unbekannt -> null.

const PURPOSES = {
  MESSAGE: 'Nachricht übermitteln',
  APPOINTMENT: 'Termin vereinbaren',
  RESCHEDULE: 'Termin verschieben',
  AVAILABILITY: 'Verfügbarkeit erfragen',
  CALLBACK: 'Rückruf erbitten',
  INFO: 'Auskunft einholen',
};

function normalize(text) {
  return (text || '').toLowerCase().trim();
}

function classifyCallPurpose(text) {
  const t = normalize(text);
  if (!t || t.length < 3) return null;

  // 1. Termin verschieben (vor Termin vereinbaren prüfen)
  if (
    /verschieb/.test(t) ||
    /verleg.*termin|termin.*verleg/.test(t) ||
    /termin.*umbuch|umbuch.*termin/.test(t)
  ) {
    // Nur wenn Termin-Kontext dabei ist oder Verschieben eindeutig
    if (/termin/.test(t) || /verschieb/.test(t)) return PURPOSES.RESCHEDULE;
  }

  // 2. Rückruf erbitten
  if (
    /rückruf/.test(t) ||
    /zurückruf/.test(t) ||
    /zurück ruf/.test(t) ||
    /mich zurückrufen|mich zurueckrufen|soll mich zurückrufen|er soll mich/.test(t) ||
    /bitte ihn.*zurück|zurück.*ruf/.test(t)
  ) {
    return PURPOSES.CALLBACK;
  }

  // 3. Verfügbarkeit erfragen
  if (
    /verfügbarkeit/.test(t) ||
    /verfuegbarkeit/.test(t) ||
    /verfügbar/.test(t) ||
    /verfuegbar/.test(t) ||
    /ob er.*zeit hat|ob sie.*zeit hat|hat er.*zeit|hat sie.*zeit/.test(t) ||
    /ist er.*verfügbar|ist sie.*verfügbar/.test(t) ||
    /frag.*zeit hat/.test(t)
  ) {
    return PURPOSES.AVAILABILITY;
  }

  // 4. Termin vereinbaren
  if (
    /termin vereinbaren|termin ausmachen|termine vereinbaren/.test(t) ||
    /vereinbare/.test(t) ||
    /mach.*termin|machen.*termin/.test(t) ||
    /frag.*nach einem termin|frag ihn nach einem termin/.test(t) ||
    /nach einem termin frag/.test(t) ||
    /einen termin mit|einem termin mit/.test(t) ||
    (/termin/.test(t) && /frag ihn|frag nach|vereinbar|ausmach/.test(t))
  ) {
    return PURPOSES.APPOINTMENT;
  }

  // 5. Auskunft einholen (generische Fragen)
  if (
    /auskunft/.test(t) ||
    /paket.*angekommen|angekommen.*paket/.test(t) ||
    /nach dem stand frag|frag.*nach dem stand/.test(t) ||
    /erkundige dich/.test(t) ||
    /frag ihn,? ob das|frag sie,? ob das|frag ihn ob|kannst du ihn nach/.test(t) ||
    (/frag ihn|frag sie|frag nach/.test(t) && /ob |was |wie |wo |wann /.test(t))
  ) {
    return PURPOSES.INFO;
  }

  // Generischer Frag-Fallback ohne Details -> Auskunft (aber nicht für reine Kontakt-/Nummern-Sätze)
  if (/^(frag ihn|frag sie|frag nach|erkundige dich)\b/.test(t) && !/heißt|nummer|telefon/.test(t)) {
    // Nur wenn Frage-Charakter erkennbar oder Mindestlänge mit Inhalt
    if (/ob |was |wie |wo |wann|bitte|mal /.test(t) || t.length > 12) return PURPOSES.INFO;
  }

  // 6. Nachricht übermitteln
  if (
    /nachricht hinterlassen|nachricht übermitteln|nachricht uebermitteln|folgende nachricht/.test(t) ||
    /richte.*aus/.test(t) ||
    /übermitt.*nachricht|uebermitt.*nachricht/.test(t) ||
    /sag ihm|sag ihr|sag jacko|say ihm/.test(t) ||
    (/sag ihm,? dass|richte.*dass/.test(t))
  ) {
    return PURPOSES.MESSAGE;
  }

  // Nachricht über implizite Melde-Formulierung nur mit klarem Übermittlungs-Kontext
  if (/ich möchte.*nachricht|möchte.*nachricht hinterlassen/.test(t)) {
    return PURPOSES.MESSAGE;
  }

  return null;
}

// Entfernt technische Auftragssprache, erhält den eigentlichen Inhalt.
// "Sag ihm, dass ich morgen später komme." -> "Ich komme morgen später."
function cleanMessageText(text) {
  if (text == null) return '';
  let s = String(text).trim();
  if (!s) return '';

  // Führende Übermittlungs-Floskeln entfernen (mehrere Varianten)
  const prefixes = [
    // Sag ihm/ihr/name, dass ...
    /^\s*sag\s+(ihm|ihr|ihnen)(,?\s*ihm|,?\s*ihr)?,?\s*dass\s+/i,
    /^\s*sag\s+[A-ZÄÖÜa-zäöüß]+(,?\s*(ihm|ihr))?,?\s*dass\s+/i,
    /^\s*sag\s+(ihm|ihr|ihnen),?\s+/i,
    // Richte X aus, dass ...
    /^\s*richt(e|et)?\s+[A-ZÄÖÜa-zäöüß]+\s+aus,?\s*(dass\s+)?/i,
    /^\s*richt(e|et)?\s+(ihm|ihr|ihnen)\s+aus,?\s*(dass\s+)?/i,
    // Übermittel ...
    /^\s*übermitt?e?l\w*\s+(ihm|ihr|ihnen)(\s+bitte)?\s*(folgende\s+nachricht\s*:?\s*)?/i,
    /^\s*bitte\s+übermitt?e?l\w*\s+.*/i,
    // Nachricht hinterlassen
    /^\s*ich\s+möchte\s+(ihm|ihr|ihnen)\s+eine\s+nachricht\s+hinterlassen\s*:?\s*(dass\s+)?/i,
    /^\s*hinterlass(e)?\s+(ihm|ihr|ihnen)\s+(folgende\s+)?nachricht\s*:?\s*/i,
  ];

  // Spezialfall: "Übermittel ihm bitte folgende Nachricht: <Inhalt>" -> Inhalt nach Doppelpunkt
  const colonMatch = s.match(/folgende\s+nachricht\s*:\s*(.+)$/i);
  if (colonMatch) {
    s = colonMatch[1].trim();
  } else {
    for (const re of prefixes) {
      if (re.test(s)) {
        s = s.replace(re, '');
        break;
      }
    }
  }

  s = s.trim().replace(/^["'„“»«]+|["'„“»«.,;]+$/g, '').trim();
  // "dass "-Rest am Anfang entfernen, falls übrig
  s = s.replace(/^dass\s+/i, '').trim();
  if (!s) return '';

  // Nebensatz (Verb am Ende) -> Hauptsatz (Verb an 2. Stelle):
  // "ich morgen später komme" -> "ich komme morgen später"
  // Nur wenn 2. Wort kein finites Verb in Zweitstellung ist (sonst bereits Hauptsatz).
  s = subordinateToMainClause(s);

  // Ersten Buchstaben groß, Satzpunkt sicherstellen
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s += '.';

  return s;
}

// Heuristik, deterministisch: "ich <Rest...> <Verb>" -> "ich <Verb> <Rest...>".
// Wird nur angewendet, wenn das 2. Wort eindeutig kein Verb in Zweitstellung ist.
function subordinateToMainClause(sentence) {
  const words = sentence.trim().split(/\s+/);
  if (words.length < 3) return sentence;
  const first = words[0].toLowerCase();
  if (first !== 'ich' && first !== 'wir') return sentence;
  const second = words[1].toLowerCase().replace(/[.,;:!?]+$/g, '');
  // Häufige Verben in Zweitstellung -> bereits Hauptsatz, nichts tun.
  const mainClauseSecond = new Set([
    'komme', 'komm', 'melde', 'mich', 'rufe', 'bin', 'habe', 'hab',
    'werde', 'kann', 'muss', 'müsste', 'möchte', 'will', 'brauche',
    'fahre', 'gehe', 'bleibe', 'arbeite', 'frage', 'bitte',
  ]);
  // "mich" ist Sonderfall: "ich mich ..." ist IMMER Nebensatz ("dass ich mich melde"),
  // daher aus der Skip-Liste entfernen.
  mainClauseSecond.delete('mich');
  if (mainClauseSecond.has(second)) return sentence;
  const verb = words[words.length - 1].replace(/[.,;:!?]+$/g, '');
  if (!/^[a-zäöüß]+$/i.test(verb) || verb.length < 3) return sentence;
  const rest = words.slice(1, -1).join(' ');
  if (!rest) return sentence;
  const pronoun = first === 'wir' ? 'Wir' : 'Ich';
  return `${pronoun} ${verb} ${rest}`;
}

function getCallPurpose() {
  return { purpose: 'placeholder', phase: 2 };
}

module.exports = {
  classifyCallPurpose,
  cleanMessageText,
  getCallPurpose,
  PURPOSES,
};
