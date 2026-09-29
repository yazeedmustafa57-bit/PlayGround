'use strict';

// Phase 3 – Lokales Node.js-Backend, nur Bordmittel (http, fs, path).
// Neu: POST /api/test/message für lokale deterministische Logik-Tests.
// Phase 4: GET /api/elevenlabs/status (Diagnose, keine Secrets, kein Live-Connect).
// Keine Express-, ElevenLabs-, Twilio-, Cloudflare- oder DB-Abhängigkeiten.
// Keine externen API-Aufrufe, keine Secrets.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createInitialState, processUserMessage } = require('./call-controller');
const { sanitizeState } = require('./personal-data-policy');
const { getPublicStatus } = require('./elevenlabs-config');
const { getTwilioPublicStatus } = require('./twilio-config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ROUTE_TO_FILE = {
  '/': 'index.html',
  '/chat': 'chat.html',
  '/eleven-chat': 'eleven-chat.html',
  '/call': 'call.html',
  '/journal': 'journal.html',
  '/setup': 'setup.html',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Minimale Security-Headers für alle Antworten (lokal, keine externen Deps).
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function resolveSafeFile(urlPathname) {
  let mapped = ROUTE_TO_FILE[urlPathname];
  if (!mapped) {
    const cleaned = urlPathname.replace(/^\/+/, '');
    if (cleaned === '' || cleaned.includes('..') || cleaned.includes('\0')) return null;
    mapped = cleaned;
  }
  const abs = path.normalize(path.join(PUBLIC_DIR, mapped));
  if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== path.join(PUBLIC_DIR, 'index.html')) {
    return null;
  }
  return abs;
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function handleTestMessage(req, res) {
  readJsonBody(req).then((body) => {
    const text = typeof body.text === 'string' ? body.text : '';
    const incomingState = body.state && typeof body.state === 'object' ? body.state : createInitialState();
    const { state } = processUserMessage(incomingState, text);
    const clean = sanitizeState(state);
    sendJson(res, 200, {
      ok: true,
      purpose: clean.purpose,
      message: clean.message,
      contactName: clean.contactName,
      phoneNumber: clean.phoneNumber,
      requestedDate: clean.requestedDate,
      requestedTime: clean.requestedTime,
      callerName: clean.callerName,
      collectionMode: clean.collectionMode,
      state: clean,
    });
  }).catch(() => {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
  });
}

function requestHandler(req, res) {
  const method = req.method || 'GET';
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  const pathname = url.pathname;

  if (pathname === '/health') {
    if (method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }
    return sendJson(res, 200, { ok: true, service: 'victor-ai-assistant' });
  }

  if (pathname === '/api/elevenlabs/status') {
    if (method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }
    // Phase 4: nur Diagnose, keine Secrets, keine Live-Verbindung.
    return sendJson(res, 200, getPublicStatus());
  }

  if (pathname === '/api/twilio/status') {
    if (method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }
    // Nur Diagnose, keine Secrets/Rufnummern, keine Live-Verbindung.
    return sendJson(res, 200, getTwilioPublicStatus());
  }

  if (pathname === '/api/test/message') {
    if (method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }
    return handleTestMessage(req, res);
  }

  if (method !== 'GET') {
    return sendJson(res, 404, { ok: false, error: 'Not Found' });
  }

  const filePath = resolveSafeFile(pathname);
  if (!filePath) {
    return sendJson(res, 404, { ok: false, error: 'Not Found' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(requestHandler);
}

function getPort() {
  const parsed = Number.parseInt(process.env.PORT || '5051', 10);
  return Number.isSafeInteger(parsed) ? parsed : 5051;
}

if (require.main === module) {
  const server = createServer();
  const port = getPort();
  server.listen(port, () => {
    console.log(`victor-ai-assistant listening on http://localhost:${port}`);
  });
}

module.exports = { createServer, requestHandler, getPort };
