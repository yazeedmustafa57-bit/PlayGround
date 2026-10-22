'use strict';

// Journal: zeigt echte Anruf-Sessions aus /api/calls (In-Memory).
// Kein Fake-Verlauf: ohne Sessions bleibt die Liste leer.

(function () {
  const $ = (id) => document.getElementById(id);

  function addRow(call) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    const right = document.createElement('span');
    const label = call.simulated ? 'Kein Anruf' : 'Echt';
    left.textContent = `${call.to} · ${call.status} · ${label}`;
    right.className = 'muted';
    const errorText = call.errorText ? `${call.errorText} (${call.error})` : call.error;
    right.textContent = [call.provider, errorText, new Date(call.createdAt).toLocaleString('de-DE')]
      .filter(Boolean).join(' · ');
    li.appendChild(left);
    li.appendChild(right);
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => loadTranscript(call.id));
    return li;
  }

  async function loadTranscript(callId) {
    const box = $('journal-transcript');
    box.innerHTML = '';
    try {
      const res = await fetch(`/api/call/${encodeURIComponent(callId)}/transcript`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const statusLine = document.createElement('div');
      statusLine.className = 'muted small';
      const errorText = data.errorText ? `${data.errorText} (${data.error})` : data.error;
      statusLine.textContent = `Status: ${data.status || 'unbekannt'}${data.error ? ' · Fehler: ' + errorText : ''}${data.transcriptSyncError ? ' · Sync: ' + data.transcriptSyncError : ''}`;
      box.appendChild(statusLine);
      for (const entry of data.transcript || []) {
        const div = document.createElement('div');
        const who = entry.speaker === 'caller' ? 'Gesprächspartner' : 'Victor';
        div.className = 'msg ' + (entry.speaker === 'caller' ? 'user' : 'victor');
        div.textContent = `${who}: ${entry.text}`;
        box.appendChild(div);
      }
      if (box.children.length <= 1) box.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Kein Transkript vorhanden.' }));
    } catch (err) {
      box.textContent = `Transkript nicht verfügbar: ${err.message}`;
    }
  }

  async function refresh() {
    const list = $('journal-list');
    const empty = $('journal-empty');
    try {
      const res = await fetch('/api/calls');
      const data = await res.json();
      const calls = (data && data.calls) || [];
      list.innerHTML = '';
      for (const call of calls) list.appendChild(addRow(call));
      empty.hidden = calls.length > 0;
    } catch {
      list.innerHTML = '<li><span>Journal nicht erreichbar</span><span class="muted">Server nicht verfügbar</span></li>';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('journal-refresh');
    if (btn) btn.addEventListener('click', refresh);
    refresh();
  });
})();
