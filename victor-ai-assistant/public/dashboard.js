'use strict';

// Dashboard: links Chat, mitte Prompt+Call, rechts Settings, unten Transkript.
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

  function setTelephonyBadge(t) {
    const badge = $('telephony-badge');
    if (!badge) return;
    badge.classList.remove('ok', 'off', 'sim');
    if (!t || !t.configured) {
      badge.textContent = 'Telefonie nicht eingerichtet';
      badge.classList.add('sim');
    } else if (t.verified) {
      badge.textContent = `SIP-Trunk verifiziert${t.phoneNumber ? ' · ' + t.phoneNumber : ''}`;
      badge.classList.add('ok');
    } else {
      badge.textContent = `Telefonie konfiguriert, nicht verifiziert${t.verificationError ? ' (' + t.verificationError + ')' : ''}`;
      badge.classList.add('off');
    }
  }

  async function loadSettings() {
    const box = $('settings');
    try {
      const [settingsRes, telephonyRes, elevenRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/telephony/status'),
        fetch('/api/elevenlabs/status'),
      ]);
      const settings = (await settingsRes.json()).settings || {};
      const t = await telephonyRes.json().catch(() => ({}));
      const e = await elevenRes.json().catch(() => ({}));
      setTelephonyBadge(t);

      const telephonyState = !t.configured
        ? 'nicht eingerichtet'
        : (t.verified ? `verifiziert${t.phoneNumber ? ' · ' + t.phoneNumber : ''}` : `nicht verifiziert${t.verificationError ? ' · ' + t.verificationError : ''}`);
      const elevenState = !e.configured
        ? 'nicht eingerichtet'
        : (e.verified ? `verifiziert${e.agentName ? ' · ' + e.agentName : ''}` : `nicht verifiziert${e.verificationError ? ' · ' + e.verificationError : ''}`);

      box.innerHTML = '';
      const rows = [
        ['Agent', settings.agentName],
        ['Sprache', settings.agentLanguage],
        ['Audio', settings.audioFormat],
        ['Dialog', 'ElevenLabs Conversational AI'],
        ['ElevenLabs', elevenState],
        ['ElevenLabs STT', (settings.elevenlabs && settings.elevenlabs.sttModel) || '–'],
        ['ElevenLabs TTS', (settings.elevenlabs && settings.elevenlabs.ttsModel) || '–'],
        ['Telefonie', telephonyState],
        ['Provider', t.provider || '–'],
      ];
      if (t.outboundTrunk) {
        rows.push(['SIP ausgehend', t.outboundTrunk.hasOutboundTrunk ? 'vorhanden' : 'fehlt']);
        rows.push(['SIP-Ziel', t.outboundTrunk.address || '–']);
        rows.push(['SIP-Transport', t.outboundTrunk.transport || '–']);
        rows.push(['SIP-Auth', t.outboundTrunk.hasAuthCredentials ? 'Zugangsdaten hinterlegt' : 'ohne Zugangsdaten/IP']);
      }
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

  function callResultText(c) {
    const detail = c.errorText || c.error;
    const suffix = detail ? ` (${detail})` : '';
    switch (c.status) {
      case 'dialing':
        return `Anruf ausgelöst an ${c.to}${suffix}. Ob Zadarma den Anruf annimmt, zeigt der aktualisierte Status; das Transkript wird nach dem Gespräch geladen.`;
      case 'confirmation-required':
        return 'Anruf noch nicht gestartet – Bestätigung erforderlich.';
      case 'telephony-unverified':
        return `Anruf nicht gestartet: Telefonie ist nicht verifiziert${suffix}.`;
      case 'call-failed':
        return `Anruf an ${c.to} fehlgeschlagen${suffix}.`;
      case 'telephony-unavailable':
        return `Anruf nicht gestartet: Kein Telefonie-Backend konfiguriert. Ziel: ${c.to}.`;
      default:
        return `Anrufstatus: ${c.status || 'unbekannt'}${suffix}.`;
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
        o.textContent = `${c.to} · ${c.status}${c.simulated ? ' (kein Anruf)' : ''}`;
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
      if (data.error || data.transcriptSyncError) {
        const errorText = data.errorText ? `${data.errorText} (${data.error})` : data.error;
        const note = data.error
          ? `Status: ${data.status || 'unbekannt'} · Fehler: ${errorText}`
          : `Transkript-Sync: ${data.transcriptSyncError}`;
        $('transcript').appendChild(el('div', 'muted small', note));
      }
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
        let data = await postJSON('/api/call/start', { instruction, to });
        if (data.confirmationRequired) {
          const approved = window.confirm(`Echten Anruf an ${data.call.to} starten?`);
          if (!approved) {
            $('call-status').textContent = 'Anruf abgebrochen – keine Bestätigung.';
            addMsg($('chat-log'), 'victor', 'Anruf abgebrochen (keine Bestätigung).');
            return;
          }
          data = await postJSON('/api/call/start', { instruction, to, confirm: true });
        }
        const c = data.call;
        const resultText = callResultText(c);
        $('call-status').textContent = `${c.id} → ${c.to} [${c.status}] ${resultText}`;
        addMsg($('chat-log'), 'victor', resultText);
        if (c.status === 'confirmation-required' || c.status === 'telephony-unverified' || c.status === 'call-failed') {
          loadSettings();
        }
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
