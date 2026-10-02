# victor-ai-assistant — KI-Telefonassistent (ausgehende Anrufe per Text-Chat)

Web-Dashboard, in dem du per **Text-Chat** Anweisungen gibst, z. B.:

- „Rufe bei Dr. Müller an und vereinbare einen Termin für nächste Woche Dienstag.“
- „Rufe meinen Arbeitgeber an und informiere, dass ich diese Woche krank bin.“

Der Assistent führt den Anruf selbstständig über **Twilio** aus, spricht mit
**ElevenLabs** und zeigt den Gesprächsverlauf live im Chat.

## Technischer Stack

- **Twilio**: ausgehende Anrufe, Media Streams (WebSocket, `ulaw_8000`, 8 kHz mono)
- **ElevenLabs Sprache + Dialog**:
  - Conversational AI Agent (Gesprächslogik, ASR, TTS, Turn-Taking)
  - Alternativ-Bausteine: Scribe v2 Realtime (Audio → Text), Flash v2.5 (Text → Audio)
- **Kein externes LLM**: bewusst ohne ChatGPT – der ElevenLabs-Agent ist die Dialoglogik.
- **Backend**: Node.js + Express + `ws`
- **Frontend**: `public/dashboard.html` (Chat + Prompt + Einstellungen + Live-Transkript)

## Projektstruktur

```
victor-ai-assistant/
├── src/
│   ├── server.js                 # Express + WS (HTTP, Dashboard, Voice-Webhooks, Media-Stream)
│   ├── app-config.js             # Agent-/Audio-/LLM-Settings (öffentlich, secret-frei)
│   ├── instruction.js              # Lokale Anweisungs-Erkennung (ohne Netz, ohne LLM)
│   ├── elevenlabs-rt.js          # Scribe v2 Realtime + Flash v2.5 (ulaw_8000)
│   ├── elevenlabs-config.js      # ElevenLabs-Keys nur aus .env
│   ├── twilio-voice.js           # Ausgehende Anrufe + TwiML (KI-Vorstellung + <Stream>)
│   ├── twilio-config.js          # Twilio-Creds nur aus .env
│   ├── twilio-media.js           # Media-Stream-Parser/Builder
│   ├── outbound-orchestrator.js  # Chat → Anruf → Transkript (In-Memory, Dashboard-WS)
│   ├── bridge.js                 # Conversational-AI-Bridge (Bestand, Mock-getestet)
│   ├── call-controller.js        # Lokale Auftragserkennung (Fallback ohne LLM)
│   ├── call-purpose.js / call-briefing.js / call-greeting.js
│   └── personal-data-policy.js
├── public/
│   ├── dashboard.html / dashboard.js / dashboard.css  # Haupt-Dashboard
│   ├── index.html / chat.html / eleven-chat.html / call.html / journal.html / setup.html
│   └── style.css / chat.js
├── test/                         # 76 Tests, nur Bordmittel + lokale Module
├── .env.example / package.json / README.md
```

## Ablauf im Code

1. `POST /api/chat/instruct` – lokale Erkennung versteht die Anweisung,
   extrahiert Zielnummer + Gesprächsziel (deterministisch, kein Netz).
2. `POST /api/call/start` – Twilio startet den ausgehenden Anruf (`twilio-voice.js`,
   Nummern werden automatisch nach E.164 normiert).
3. Twilio `POST /voice/outgoing` liefert TwiML mit **nur** `<Stream>` –
   kein `<Say>`, damit ausschließlich der ElevenLabs-Agent (Helmut) zu hören ist.
4. `/media-stream` (WS): Twilio-Audio (mulaw_8000) → `live-bridge.js` →
   ElevenLabs Conversational AI Agent (`wss://…/convai/conversation`,
   Signed-URL, `first_message` + Briefing als `user_message`).
5. Agent-Audio → Format aus Initiation-Metadaten (PCM→mulaw-Wandlung in
   `audio-codec.js`) → zurück an Twilio. Transkripte live ins Dashboard.

Kein Token-Streaming nötig: Der Agent spricht in Echtzeit, Victor braucht kein
externes LLM als Zwischenschicht.

## .env / Startanleitung

```bash
cd victor-ai-assistant
cp .env.example .env   # dann Keys eintragen (.env nie committen)
npm install
npm test               # 76 Tests, kein Netz, keine Secrets
npm start              # http://localhost:5051 (Default ohne PORT)
PORT=3000 npm start    # so startet das Deployment (start.sh) den Server
```

Dashboard: `http://localhost:<PORT>/dashboard` (lokal 5051, im Deployment 3000).

Benötigte Variablen (siehe `.env.example`): `PORT`, `PUBLIC_BASE_URL`
(für Twilio erreichbar, z. B. Tunnel-URL), `AGENT_NAME`, `AGENT_LANGUAGE`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_VOICE_ID`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
Kein LLM-Key nötig.

Ohne Credentials läuft alles als **Simulation** (kein Netz, kein Anruf, kein
Fake-Erfolg – als `simulated:true` gekennzeichnet).

## Dashboard

- **Links**: Chat-Verlauf (Anweisungen + Antworten + Transkript-Hinweise)
- **Mitte**: Prompt-/Anweisungsfeld + Zielnummer + Button „Anruf starten“
- **Rechts**: Einstellungen (Agent, Sprache, Audio, LLM, STT/TTS, Twilio-Status)
- **Unten**: Live-Transkript (WS `/dashboard-stream`, Fallback Refresh)

Nützliche Routen: `/health`, `/api/settings`, `/api/llm/status`,
`/api/elevenlabs/status`, `/api/twilio/status`, `/api/calls`.
