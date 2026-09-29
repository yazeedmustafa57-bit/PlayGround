# victor-ai-assistant

Lokaler Echtzeit-KI-Sprachassistent **Victor** – Backend, Weboberfläche,
Gesprächslogik und Integrations-Scaffolding. Alles läuft lokal und
deterministisch; externe Dienste sind vorbereitet, aber nicht aktiv.

## Architektur (Zielbild)

```
Twilio Media Stream
  ↓
Node.js „bridge.js“ (diese Codebasis, Audio-agnostisch)
  ↓
ElevenLabs Conversational AI WebSocket (Audio ↔ Audio)
  ↓
Node.js „bridge.js“
  ↓
Twilio Media Stream / Web-Audio-Client
```

- **ElevenLabs** übernimmt später Echtzeit-ASR, LLM/Gesprächslogik, TTS, Turn-Taking.
  Aktuell: Bridge mit `conversation_initiation_client_data`,
  `conversation_config_override.agent.first_message`, `user_message`-Briefing –
  getestet mit Mock-WebSocket, **kein Live-Call**.
- **Twilio** liefert später Anrufe + Media Streams.
  Aktuell: `twilio-config.js` + `twilio-media.js` als reines Scaffolding
  (Parser/Builder, kein SDK, kein Netzwerk).
- **Node.js** dient als Bridge und Steuerung (nur Bordmittel, keine Dependencies).

## API-Schlüssel

- Ausschließlich über `.env` (nie im Code, nie in Logs, nie in Antworten).
- Vorlage: `.env.example` (`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `PORT`).
- `.env` wird nicht committed (siehe `.gitignore`).

```bash
cp .env.example .env
```

## Lokale Entwicklung

```bash
npm install   # keine Dependencies, nur Integritätsprüfung
npm test      # alle Tests, nur Node-Bordmittel
npm start     # http://localhost:5051 (nur lokal, kein Tunnel)
```

Diagnose (lokal, ohne Secrets):

- `GET /health` → `{"ok":true,"service":"victor-ai-assistant"}`
- `GET /api/elevenlabs/status` → Konfigurationsstatus
- `GET /api/twilio/status` → Konfigurationsstatus
- `POST /api/test/message` → lokale Auftragserkennung `{text, state?}`

## Status

Alle Phasen 1–4 umgesetzt und getestet; Twilio-Scaffolding, Security-Headers
und Doku ergänzt. Keine externen Aufrufe, keine Tunnel, keine echten Anrufe.
Echte ElevenLabs-/Twilio-Verbindungen erfordern ausschließlich `.env`-Werte
und eine explizite Freigabe.
