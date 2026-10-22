# victor-ai-assistant — KI-Telefonassistent (ausgehende Anrufe per Text-Chat)

Web-Dashboard, in dem du per **Text-Chat** Anweisungen gibst, z. B.:

- „Rufe bei Dr. Müller an und vereinbare einen Termin für nächste Woche Dienstag.“
- „Rufe meinen Arbeitgeber an und informiere, dass ich diese Woche krank bin.“

Die Sprach-KI und Dialoglogik laufen über **ElevenLabs**. Die Telefonie nutzt den
bereits bei ElevenLabs importierten **Zadarma-SIP-Trunk** (`+4944168304115`,
Label „Zadarma DE“). Twilio wurde bewusst entfernt; ein zweites Gateway oder
separate Zadarma-Zugangsdaten im Backend sind nicht nötig. Echte Anrufe werden
nur nach ausdrücklicher Bestätigung und erfolgreicher Live-Prüfung ausgelöst.

## Technischer Stack

- **Telefonie**: ElevenLabs SIP-Trunk (Zadarma-Nummer), native Outbound-API
  `POST /v1/convai/sip-trunk/outbound-call`; kein Twilio, kein Zusatz-Gateway.
- **ElevenLabs Sprache + Dialog**:
  - Conversational AI Agent (Gesprächslogik, ASR, TTS, Turn-Taking)
  - Alternativ-Bausteine: Scribe v2 Realtime (Audio → Text), Flash v2.5 (Text → Audio)
- **Kein externes LLM**: bewusst ohne ChatGPT – der ElevenLabs-Agent ist die Dialoglogik.
- **Backend**: Node.js + Express + `ws`
- **Frontend**: `public/dashboard.html` (Chat + Prompt + Einstellungen + Transkript), `public/journal.html` (Anruf-Journal)

## Projektstruktur

```
victor-ai-assistant/
├── src/
│   ├── server.js                 # Express + WS (HTTP, Dashboard, Media-Stream)
│   ├── app-config.js             # Agent-/Audio-/LLM-Settings (öffentlich, secret-frei)
│   ├── instruction.js              # Lokale Anweisungs-Erkennung (ohne Netz, ohne LLM)
│   ├── elevenlabs-rt.js          # Scribe v2 Realtime + Flash v2.5 (ulaw_8000)
│   ├── elevenlabs-config.js      # ElevenLabs-Keys nur aus .env
│   ├── telephony-config.js       # SIP-Trunk: Live-Prüfung + Outbound-Anruf
│   ├── phone-number.js           # Telefonnummer-Normalisierung (E.164)
│   ├── media-stream.js           # Provider-neutrales Media-Stream-Framing
│   ├── outbound-orchestrator.js  # Chat → Anruf → Transkript (In-Memory, Dashboard-WS)
│   ├── bridge.js                 # Conversational-AI-Bridge (Bestand, Mock-getestet)
│   ├── call-controller.js        # Lokale Auftragserkennung (Fallback ohne LLM)
│   ├── call-purpose.js / call-briefing.js / call-greeting.js
│   └── personal-data-policy.js
├── public/
│   ├── dashboard.html / dashboard.js / dashboard.css  # Haupt-Dashboard
│   ├── index.html / chat.html / eleven-chat.html / call.html / journal.html / setup.html
│   └── style.css / chat.js / journal.js
├── test/                         # 146 Tests, nur Bordmittel + lokale Module
├── .env.example / package.json / README.md
```

## Ablauf im Code

1. `POST /api/chat/instruct` – lokale Erkennung versteht die Anweisung,
   extrahiert Zielnummer + Gesprächsziel (deterministisch, kein Netz).
2. `POST /api/call/start` – legt eine Anruf-Session an (Nummern werden nach
   E.164 normiert). Ohne Telefonie-Konfiguration bleibt der Status
   `telephony-unavailable`. Mit Konfiguration liefert der erste Aufruf
   `confirmation-required`; erst `confirm: true` prüft die Nummer live und
   startet den Anruf über den SIP-Trunk.
3. `/media-stream` (WS): eingehendes Telefonie-Audio (mulaw_8000) →
   `live-bridge.js` → ElevenLabs Conversational AI Agent
   (`wss://…/convai/conversation`, Signed-URL, `first_message` + Briefing).
4. Agent-Audio → Format aus Initiation-Metadaten (PCM→mulaw-Wandlung in
   `audio-codec.js`) → zurück an das Telefonie-Gateway. Transkripte live ins
   Dashboard. Beim nativen SIP-Trunk übernimmt ElevenLabs Signalisierung und
   Medien direkt; `/media-stream` bleibt für provider-neutrales Framing nutzbar.

Kein Token-Streaming nötig: Der Agent spricht in Echtzeit, Victor braucht kein
externes LLM als Zwischenschicht.

## Telefonie über den ElevenLabs-SIP-Trunk

Die Zadarma-Nummer ist bereits bei ElevenLabs importiert und dem Agenten
„Victor Telefon“ zugeordnet. Genutzt wird genau diese bestehende Verbindung:

1. **Konfiguration** (nur `.env`): `ELEVENLABS_API_KEY`,
   `ELEVENLABS_AGENT_ID`. Optional `ELEVENLABS_PHONE_NUMBER_ID` (`phnum_…`);
   fehlt sie, wird die dem Agenten zugeordnete SIP-Nummer read-only ermittelt
   (bei mehreren SIP-Nummern wird bewusst nicht geraten). Optional
   `ELEVENLABS_BASE_URL`. Zadarma-Zugangsdaten sind im Backend nicht nötig.
2. **Status**: `GET /api/telephony/status` prüft die Nummer read-only über
   `GET /v1/convai/phone-numbers/{id}` (60 s gecacht). `verified` ist nur
   `true`, wenn der Trunk SIP ist, einen Outbound-Trunk hat und die Nummer dem
   konfigurierten Agenten gehört. `outboundTrunk` fasst Ziel, Transport und
   Auth-Flag secret-frei zusammen. `GET /api/elevenlabs/status` prüft
   zusätzlich den Agenten live. Es werden keine Secrets ausgegeben.
3. **Anruf**: `POST /api/call/start` legt zunächst eine Session an. Erst mit
   `confirm: true` (Dashboard fragt nach) und verifizierter Nummer wird
   `POST /v1/convai/sip-trunk/outbound-call` aufgerufen. Status danach
   `dialing` (mit `callRef`/`conversationId`) oder `call-failed` /
   `telephony-unverified`.
4. **Transkript**: Nach dem Gespräch lädt `GET /api/call/:id/transcript` die
   Details über `GET /v1/convai/conversations/{id}` nach und übernimmt Status
   und echte Sprecherbeiträge. Ein SIP-Fehler (z. B. `sip-603`) wird sichtbar
   gespeichert, nie als Erfolg dargestellt.
5. **Inbound**: Anrufe auf `+4944168304115` beantwortet ElevenLabs direkt;
   dafür ist kein Webhook und kein Media-Gateway im Backend erforderlich.

**Troubleshooting:** Antwortet der Träger mit SIP `603 Decline`, ist die
Konfiguration bei ElevenLabs korrekt, aber Zadarma lehnt den ausgehenden INVITE
ab. Dashboard und Journal zeigen dann den Hinweis „CallerID, ausgehende
Freigabe/Guthaben oder Zielnummer prüfen“; das lässt sich nur im
Zadarma-/ElevenLabs-Konto klären, nicht im Backend.

Ohne Konfiguration bleibt es bei `telephony-unavailable` – kein Fake-Erfolg.
Tests laufen vollständig ohne Netz (injiziertes `fetch`).

## .env / Startanleitung

```bash
cd victor-ai-assistant
cp .env.example .env   # dann Keys eintragen (.env nie committen)
npm install
npm test               # 146 Tests, kein Netz, keine Secrets
npm start              # http://localhost:5051 (Default ohne PORT)
PORT=3000 npm start    # so startet das Deployment (start.sh) den Server
```

Dashboard: `http://localhost:<PORT>/dashboard` (lokal 5051, im Deployment 3000).

Benötigte Variablen (siehe `.env.example`): `PORT`, `PUBLIC_BASE_URL`
(optional, öffentliche Basis-URL des Deployments), `AGENT_NAME`,
`AGENT_LANGUAGE`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
`ELEVENLABS_PHONE_NUMBER_ID` (optional), `ELEVENLABS_VOICE_ID`. Separate
Zadarma-Zugangsdaten und ein LLM-Key sind nicht nötig.

Ohne Telefonie-Konfiguration wird **kein Anruf gestartet** (kein Netz, kein
Fake-Erfolg). Sessions werden mit Status `telephony-unavailable` angelegt und
bleiben als `simulated:true` gekennzeichnet. Auch mit Konfiguration wird nie
automatisch gewählt: ohne `confirm: true` bleibt es bei `confirmation-required`.

## Evaluation (ElevenLabs Agent Testing, textbasiert)

8 synthetische Simulationstests prüfen Verhalten (keine Echtdaten, keine
Telefonie, kein Audio). Nur Text-LLM-Kontingent, keine Telefonminuten:

```bash
npm run eval                 # benötigt .env (API-Key + Agent-ID)
npm run eval -- --only vollstaendiger-name --repeat 2
```

Report: `_test-results/victor-evaluation.md`. `npm test` startet die
Evaluation bewusst **nicht** (kostenpflichtig).

## Dashboard

- **Links**: Chat-Verlauf (Anweisungen + Antworten + Transkript-Hinweise)
- **Mitte**: Prompt-/Anweisungsfeld + Zielnummer + Button „Anruf starten“
- **Rechts**: Einstellungen (Agent, Sprache, Audio, LLM, STT/TTS, Telefonie-Status)
- **Unten**: Transkript (native SIP-Anrufe: Nachladen per „Aktualisieren“;
  WS `/dashboard-stream` nur für den Media-Stream-Pfad)
- **Journal**: echte Anruf-Sessions aus `/api/calls`, inkl. Status/Fehler und
  Transkript beim Anklicken (In-Memory, kein Fake-Verlauf)

Nützliche Routen: `/health`, `/api/settings`, `/api/llm/status`,
`/api/elevenlabs/status`, `/api/telephony/status`, `/api/calls`.
