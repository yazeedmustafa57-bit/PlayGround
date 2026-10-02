'use strict';

// Dashboard: links Chat, mitte Prompt+Call, rechts Settings, unten Live-Transkript.
// Nur same-origin fetch + WS /dashboard-stream. Keine Keys im Browser.

(function () {
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function addMsg(box, who, text) {
    box.appendChild(el('div', 'msg ' + (who === 'ich' ? 'user' : 'victor'), text));
    box.scrollTop = box.scrollHeight;
  }

  function renderTranscript(box, transcript) {
    box.innerHTML = '';
    for (const e of transcript || []) {
      const who = e.speaker === 'caller' ? 'Gesprächspartner' : 'Victor';
      box.appendChild(el('div', 'msg ' + (e.speaker === 'caller' ? 'user' : 'victor'), `${who}: ${e.text}`));
    }
    box.scrollTop = box.scrollHeight;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  async function loadSettings() {
    const box = $('settings');
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      const s = data.settings || {};
      box.innerHTML = '';
      const rows = [
        ['Agent', s.agentName],
        ['Sprache', s.agentLanguage],
        ['Audio', s.audioFormat],
        ['Dialog', 'ElevenLabs Conversational AI'],
        ['ElevenLabs STT', (s.elevenlabs && s.elevenlabs.sttModel) || '–'],
        ['ElevenLabs TTS', (s.elevenlabs && s.elevenlabs.ttsModel) || '–'],
        ['Twilio', s.twilio && s.twilio.configured ? 'konfiguriert' : 'Simulation'],
      ];
      const ul = el('ul', 'list');
      for (const [k, v] of rows) {
        const li = el('li');
        li.appendChild(el('span', null, k));
        li.appendChild(el('span', 'muted', String(v)));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    } catch {
      box.textContent = 'Einstellungen nicht erreichbar.';
    }
  }

  async function refreshCalls(selectedId) {
    const sel = $('call-select');
    try {
      const res = await fetch('/api/calls');
      const data = await res.json();
      const calls = (data && data.calls) || [];
      const cur = selectedId || sel.value;
      sel.innerHTML = '';
      sel.appendChild(el('option', null, '– Anruf wählen –'));
      sel.firstChild.value = '';
      for (const c of calls) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = `${c.to} · ${c.status}${c.simulated ? ' (Sim)' : ''}`;
        sel.appendChild(o);
      }
      if (cur) sel.value = cur;
      if (sel.value) loadTranscript(sel.value);
    } catch { /* ignore */ }
  }

  async function loadTranscript(callId) {
    if (!callId) return;
    try {
      const res = await fetch(`/api/call/${encodeURIComponent(callId)}/transcript`);
      const data = await res.json();
      renderTranscript($('transcript'), data.transcript);
    } catch { /* ignore */ }
  }

  function connectLive() {
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/dashboard-stream`);
    } catch { return; }
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'transcript' && msg.callId === $('call-select').value) {
        const box = $('transcript');
        const who = msg.entry.speaker === 'caller' ? 'Gesprächspartner' : 'Victor';
        box.appendChild(el('div', 'msg ' + (msg.entry.speaker === 'caller' ? 'user' : 'victor'), `${who}: ${msg.entry.text}`));
        box.scrollTop = box.scrollHeight;
      }
      if (msg.type === 'call-status' || msg.type === 'transcript') refreshCalls($('call-select').value);
    };
  }

  function init() {
    if (!$('chat-form')) return;
    loadSettings();
    refreshCalls();
    connectLive();

    $('chat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('chat-input').value.trim();
      if (!text) return;
      $('chat-input').value = '';
      addMsg($('chat-log'), 'ich', text);
      try {
        const plan = await postJSON('/api/chat/instruct', { instruction: text });
        $('prompt').value = text;
        if (plan.to) $('to').value = plan.to;
        $('plan-box').textContent =
          `Ziel: ${plan.goal || '–'}\nNummer: ${plan.to || '(fehlt – bitte ergänzen)'}\nQuelle: ${plan.source}`;
        addMsg($('chat-log'), 'victor',
          plan.to ? `Verstanden: Anruf an ${plan.to} – „${plan.goal}“. Bereit für „Anruf starten“.`
            : 'Verstanden, aber Zielnummer fehlt – bitte Nummer ins Feld „Zielnummer“ eintragen.');
      } catch (err) {
        addMsg($('chat-log'), 'victor', `Fehler: ${err.message}`);
      }
    });

    $('call-btn').addEventListener('click', async () => {
      const instruction = $('prompt').value.trim();
      const to = $('to').value.trim();
      if (!instruction && !to) {
        $('call-status').textContent = 'Bitte zuerst eine Anweisung schreiben.';
        return;
      }
      $('call-status').textContent = 'Starte Anruf …';
      addMsg($('chat-log'), 'ich', `Anruf starten: ${to || '(Nummer aus Text)'} – ${instruction}`);
      try {
        const data = await postJSON('/api/call/start', { instruction, to });
        const c = data.call;
        $('call-status').textContent =
          `Anruf ${c.simulated ? '(Simulation, kein Netz) ' : ''}gestartet: ${c.id} → ${c.to} [${c.status}]`;
        addMsg($('chat-log'), 'victor',
          `Anruf ${c.simulated ? 'simuliert' : 'gestartet'} an ${c.to}. Live-Transkript unten.`);
        await refreshCalls(c.id);
        $('call-select').value = c.id;
        loadTranscript(c.id);
      } catch (err) {
        $('call-status').textContent = `Fehler: ${err.message}`;
        addMsg($('chat-log'), 'victor', `Anruf nicht möglich: ${err.message}`);
      }
    });

    $('refresh-btn').addEventListener('click', () => refreshCalls());
    $('call-select').addEventListener('change', () => loadTranscript($('call-select').value));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
