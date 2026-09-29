'use strict';

// Phase 3 – Chat ruft nur den lokalen Test-Endpunkt (same origin).
// Keine externen Dienste, keine KI-Antwort, nur erkannter Zustand.
(function () {
  let localState = null;

  function appendMessage(box, text, kind) {
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function formatReply(data) {
    if (!data || !data.ok) return 'Lokaler Fehler: ungültige Antwort.';
    if (data.purpose) {
      let line = `Auftrag erkannt: ${data.purpose}`;
      if (data.contactName) line += ` · Kontakt: ${data.contactName}`;
      if (data.phoneNumber) line += ` · Nummer: ${data.phoneNumber}`;
      if (data.requestedDate || data.requestedTime) {
        line += ` · Wann: ${[data.requestedDate, data.requestedTime].filter(Boolean).join(' ')}`;
      }
      if (data.message) line += ` · Nachricht: „${data.message}“`;
      else if (data.collectionMode === 'collecting_contact') line += ' · (Kontakt fehlt noch)';
      else if (data.collectionMode === 'collecting_message') line += ' · (Nachricht fehlt noch)';
      return line + ' [lokal, keine KI]';
    }
    if (data.contactName || data.phoneNumber) {
      return `Verstanden (lokal): Kontakt ${data.contactName || ''} ${data.phoneNumber || ''}`.trim() + ' · Zweck noch offen. [lokal]';
    }
    return 'Verstanden (lokal): Zweck noch unklar – bitte Auftrag konkretisieren. [lokal, keine KI]';
  }

  async function sendText(box, stateView, text) {
    appendMessage(box, text, 'user');
    try {
      const res = await fetch('/api/test/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, state: localState }),
      });
      const data = await res.json();
      if (data && data.state) localState = data.state;
      appendMessage(box, formatReply(data), 'victor');
      if (stateView) stateView.textContent = JSON.stringify(data.state || data, null, 2);
    } catch (err) {
      appendMessage(box, 'Lokaler Test-Endpunkt nicht erreichbar.', 'victor');
    }
  }

  function init() {
    const box = document.getElementById('messages');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const stateView = document.getElementById('state-view');
    if (!box || !form || !input) return;
    appendMessage(box, 'Hallo, ich bin Victor (lokaler Entwicklungsmodus, keine KI).', 'victor');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendText(box, stateView, text);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
