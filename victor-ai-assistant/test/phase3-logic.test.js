'use strict';

// Phase 3 – Logik-Tests, nur Node-Bordmittel. Keine externen Dienste.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { classifyCallPurpose, cleanMessageText } = require('../src/call-purpose');
const {
  createInitialState,
  processUserMessage,
  extractPhoneNumber,
  normalizePhoneNumber,
  extractDateTime,
} = require('../src/call-controller');
const { sanitizeState, redactForLogging } = require('../src/personal-data-policy');
const { buildDynamicFirstGreeting } = require('../src/call-greeting');

// ---- Zweck ----
test('Zweck: Nachricht übermitteln (Sag ihm)', () => {
  assert.equal(classifyCallPurpose('Sag ihm, dass ich später komme.'), 'Nachricht übermitteln');
});

test('Zweck: Nachricht übermitteln (Richte aus / hinterlassen)', () => {
  assert.equal(classifyCallPurpose('Richte ihm aus, dass ich mich morgen melde.'), 'Nachricht übermitteln');
  assert.equal(classifyCallPurpose('Ich möchte ihm eine Nachricht hinterlassen.'), 'Nachricht übermitteln');
  assert.equal(classifyCallPurpose('Übermittel ihm bitte folgende Nachricht.'), 'Nachricht übermitteln');
});

test('Zweck: Termin vereinbaren', () => {
  assert.equal(classifyCallPurpose('Vereinbare einen Termin.'), 'Termin vereinbaren');
  assert.equal(classifyCallPurpose('Mach einen Termin mit ihm aus.'), 'Termin vereinbaren');
  assert.equal(classifyCallPurpose('Ich möchte einen Termin vereinbaren.'), 'Termin vereinbaren');
});

test('Zweck: Termin verschieben', () => {
  assert.equal(classifyCallPurpose('Verschiebe den Termin.'), 'Termin verschieben');
  assert.equal(classifyCallPurpose('Kannst du den Termin auf nächste Woche verschieben?'), 'Termin verschieben');
  assert.equal(classifyCallPurpose('Sag ihm, dass ich den Termin verschieben muss.'), 'Termin verschieben');
});

test('Zweck: Verfügbarkeit erfragen', () => {
  assert.equal(classifyCallPurpose('Frag ihn, ob er morgen Zeit hat.'), 'Verfügbarkeit erfragen');
  assert.equal(classifyCallPurpose('Frag nach seiner Verfügbarkeit.'), 'Verfügbarkeit erfragen');
  assert.equal(classifyCallPurpose('Ist er morgen verfügbar?'), 'Verfügbarkeit erfragen');
});

test('Zweck: Rückruf erbitten', () => {
  assert.equal(classifyCallPurpose('Bitte ihn, mich zurückzurufen.'), 'Rückruf erbitten');
  assert.equal(classifyCallPurpose('Sag ihm, er soll mich zurückrufen.'), 'Rückruf erbitten');
  assert.equal(classifyCallPurpose('Ich brauche einen Rückruf.'), 'Rückruf erbitten');
});

test('Zweck: Auskunft einholen', () => {
  assert.equal(classifyCallPurpose('Frag ihn, ob das Paket angekommen ist.'), 'Auskunft einholen');
  assert.equal(classifyCallPurpose('Kannst du ihn nach dem Stand fragen?'), 'Auskunft einholen');
  assert.equal(classifyCallPurpose('Ich brauche eine Auskunft.'), 'Auskunft einholen');
});

test('Imperativ „Frag ihn“ wird erkannt (nicht null)', () => {
  assert.equal(classifyCallPurpose('Frag ihn, ob das Paket da ist.'), 'Auskunft einholen');
});

test('Imperativ „Vereinbare“ wird erkannt', () => {
  assert.equal(classifyCallPurpose('Vereinbare bitte einen Termin mit Jacko.'), 'Termin vereinbaren');
});

test('Imperativ „Verschiebe“ wird erkannt', () => {
  assert.equal(classifyCallPurpose('Verschiebe bitte den Termin auf morgen.'), 'Termin verschieben');
});

// ---- Bereinigung ----
test('cleanMessageText: Sag ihm, dass ...', () => {
  assert.equal(cleanMessageText('Sag ihm, dass ich morgen später komme.'), 'Ich komme morgen später.');
});

test('cleanMessageText: Richte Jacko aus, dass ...', () => {
  assert.equal(cleanMessageText('Richte Jacko aus, dass ich mich um 17 Uhr melde.'), 'Ich melde mich um 17 Uhr.');
});

// ---- Mehrteiliger Auftrag ----
test('Mehrteilig: Ruf ihn an -> Jacko -> Nummer -> Nachricht', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Ruf ihn an.'));
  assert.equal(state.message, null);
  ({ state } = processUserMessage(state, 'Er heißt Jacko.'));
  assert.equal(state.contactName, 'Jacko');
  assert.equal(state.message, null);
  ({ state } = processUserMessage(state, 'Seine Nummer ist 0176 12345678.'));
  assert.ok(state.phoneNumber.includes('0176'));
  assert.equal(state.message, null);
  ({ state } = processUserMessage(state, 'Sag ihm, dass ich morgen später komme.'));
  assert.equal(state.contactName, 'Jacko');
  assert.ok(state.phoneNumber.includes('0176'));
  assert.equal(state.message, 'Ich komme morgen später.');
  assert.notEqual(state.message, 'Er heißt Jacko.');
});

test('„Er heißt Jacko“ wird NICHT als message gespeichert', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Er heißt Jacko.'));
  assert.equal(state.contactName, 'Jacko');
  assert.equal(state.message, null);
});

test('Telefonnummer wird nicht zur Nachricht', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Seine Nummer ist 0176 12345678.'));
  assert.ok(state.phoneNumber);
  assert.equal(state.message, null);
});

test('„hier die Nummer“ wird nicht als Nachrichteninhalt gespeichert', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Hier die Nummer: 0176 12345678.'));
  assert.equal(state.message, null);
});

test('Datum wird erkannt (morgen)', () => {
  const { requestedDate } = extractDateTime('Sag ihm, dass ich morgen komme.');
  assert.match(requestedDate || '', /morgen/i);
});

test('Uhrzeit wird erkannt (um 17 Uhr)', () => {
  const { requestedTime } = extractDateTime('Richte aus, dass ich mich um 17 Uhr melde.');
  assert.match(requestedTime || '', /17 Uhr/);
});

test('unbekannter Auftrag -> null', () => {
  assert.equal(classifyCallPurpose('Wie ist das Wetter heute?'), null);
  assert.equal(classifyCallPurpose('Ruf ihn an.'), null);
  assert.equal(classifyCallPurpose('Hallo.'), null);
});

test('keine zufällige Fallback-Nachricht bei langem Satz ohne Absicht', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Ich war gestern lange spazieren und habe viel nachgedacht.'));
  assert.equal(state.message, null);
});

test('mehrere Nachrichten ergänzen Zustand (Kontakt bleibt, Zeit kommt dazu)', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Vereinbare einen Termin mit Jacko.'));
  assert.equal(state.contactName, 'Jacko');
  ({ state } = processUserMessage(state, 'Gegen 15:30 Uhr morgen bitte.'));
  assert.equal(state.contactName, 'Jacko');
  assert.ok(state.requestedTime || state.requestedDate);
});

test('spätere explizite Nachricht ersetzt keine Kontaktinformationen', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Er heißt Jacko.'));
  ({ state } = processUserMessage(state, 'Seine Nummer ist 0176 12345678.'));
  ({ state } = processUserMessage(state, 'Sag ihm, dass ich morgen später komme.'));
  assert.equal(state.contactName, 'Jacko');
  assert.ok(state.phoneNumber);
  assert.equal(state.message, 'Ich komme morgen später.');
});

test('spätere explizite Nachricht setzt tatsächliche Nachricht korrekt (Überschreiben)', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Sag ihm, dass ich heute komme.'));
  assert.equal(state.message, 'Ich komme heute.');
  ({ state } = processUserMessage(state, 'Sag ihm, dass ich morgen später komme.'));
  assert.equal(state.message, 'Ich komme morgen später.');
});

test('Telefonnormalisierung DE-Formate', () => {
  assert.equal(normalizePhoneNumber('0176 12345678'), '017612345678');
  assert.equal(normalizePhoneNumber('+49 176 12345678'), '+4917612345678');
  assert.equal(normalizePhoneNumber('0176/12345678'), '017612345678');
  assert.ok((extractPhoneNumber('Seine Nummer ist +49-176-12345678.') || '').includes('49176'));
});

test('collectionMode: Kontakt fehlt -> collecting_contact', () => {
  let state = createInitialState();
  ({ state } = processUserMessage(state, 'Ruf ihn an.'));
  assert.equal(state.collectionMode, 'collecting_contact');
});

test('personal-data-policy: sanitize + redact ohne Hardcodes', () => {
  const clean = sanitizeState({ purpose: 'Termin vereinbaren', contactName: ' Jacko ', unknown: 'x' });
  assert.equal(clean.contactName, 'Jacko');
  assert.equal(clean.unknown, undefined);
  const red = redactForLogging({ phoneNumber: '017612345678' });
  assert.ok(!String(red.phoneNumber).includes('017612345678'));
});

test('Keine Schablonen-Begrüßung: Agent formuliert Eröffnung selbst', () => {
  // Vertrag: buildDynamicFirstGreeting liefert null (keine wörtlich
  // gesprochene Schablone); Kontext bleibt über instruction/briefing erhalten.
  assert.equal(buildDynamicFirstGreeting({ contactName: 'Jacko', purpose: 'Nachricht übermitteln' }), null);
  assert.equal(buildDynamicFirstGreeting({ contactName: 'Jacko', purpose: 'Termin vereinbaren' }), null);
  assert.equal(buildDynamicFirstGreeting({}), null);
});

test('Beling-Auftrag: keine Nachricht-Schablone, Kontext vollständig', () => {
  const { parseInstruction } = require('../src/instruction');
  const { buildCallBriefing } = require('../src/call-briefing');
  const plan = parseInstruction('Ruf Herrn Beling an und sag ihm, dass ich diese Woche krankgeschrieben bin.');
  assert.equal(plan.contactName, 'Beling');
  assert.equal(plan.purpose, 'Nachricht übermitteln');
  assert.equal(buildDynamicFirstGreeting({ contactName: plan.contactName, purpose: plan.purpose }), null);
  const briefing = buildCallBriefing(plan.state);
  assert.match(briefing, /Beling/);
  assert.doesNotMatch(briefing, /ich habe eine Nachricht für Sie/);
});

// ---- HTTP-Endpunkt ----
test('POST /api/test/message liefert erkannten Zustand (lokal)', async () => {
  const { createServer } = require('../src/server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const body = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ text: 'Sag ihm, dass ich morgen später komme.' });
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/test/message', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(body.status, 200);
    const json = JSON.parse(body.data);
    assert.equal(json.purpose, 'Nachricht übermitteln');
    assert.equal(json.message, 'Ich komme morgen später.');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
