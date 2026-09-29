'use strict';

// Phase 2 – Regressionstests, nur Node-Bordmittel (node:test, node:assert, node:http).
// Keine externen Dienste, kein Tunnel, keine API-Keys.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.join(__dirname, '..');
const { createServer } = require('../src/server.js');

let server;
let baseUrl;

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + pathname, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('keine .env im Grundgerüst', () => {
  assert.equal(fs.existsSync(path.join(root, '.env')), false, '.env darf nicht vorhanden sein');
});

test('Platzhalter-Module sind ladbar', () => {
  assert.doesNotThrow(() => require('../src/bridge.js'));
  assert.doesNotThrow(() => require('../src/call-greeting.js'));
  assert.doesNotThrow(() => require('../src/call-controller.js'));
  assert.doesNotThrow(() => require('../src/call-purpose.js'));
  assert.doesNotThrow(() => require('../src/personal-data-policy.js'));
});

test('/health liefert HTTP 200 + gültiges JSON', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /application\/json/);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.equal(json.service, 'victor-ai-assistant');
});

test('/ ist erreichbar (Victor Startseite)', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /Victor/);
  assert.match(res.body, /Dein pers/);
});

test('/chat ist erreichbar', async () => {
  const res = await get('/chat');
  assert.equal(res.status, 200);
  assert.match(res.body, /Chat mit Victor/);
});

test('/eleven-chat ist erreichbar', async () => {
  const res = await get('/eleven-chat');
  assert.equal(res.status, 200);
  assert.match(res.body, /Noch nicht verbunden/);
});

test('/call ist erreichbar', async () => {
  const res = await get('/call');
  assert.equal(res.status, 200);
  assert.match(res.body, /Telefon/);
});

test('/journal ist erreichbar', async () => {
  const res = await get('/journal');
  assert.equal(res.status, 200);
  assert.match(res.body, /Journal/);
});

test('/setup ist erreichbar', async () => {
  const res = await get('/setup');
  assert.equal(res.status, 200);
  assert.match(res.body, /Einstellungen/);
});

test('unbekannte Route liefert 404', async () => {
  const res = await get('/diese-route-gibt-es-nicht-12345');
  assert.equal(res.status, 404);
});
