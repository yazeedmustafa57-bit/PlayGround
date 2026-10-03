# VICTOR-RESTORE — Wiederherstellung aus GitHub

Diese Datei beschreibt, wie Victor nach Verlust der Arbeitsumgebung
vollständig aus dem privaten GitHub-Repository wiederhergestellt wird.
Enthält KEINE Secrets — alle Zugangsdaten kommen aus einem separaten,
sicheren Secret-Speicher.

## 1. Repository klonen

```bash
git clone <privates-victor-repo> victor-ai-assistant
cd victor-ai-assistant
```

## 2. Dependencies installieren

```bash
npm install
```

## 3. Environment-Variablen (`.env`)

```bash
cp .env.example .env
```

Danach in `.env` die echten Werte aus dem Secret-Speicher eintragen:

| Variable | Quelle |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs-Dashboard → API-Keys |
| `ELEVENLABS_AGENT_ID` | ElevenLabs-Dashboard → Agents → „Victor Telefon“ → Agent-ID |
| `ELEVENLABS_VOICE_ID` | ElevenLabs-Dashboard → Voices → Helmut-Stimme → Voice-ID |
| `TWILIO_ACCOUNT_SID` | Twilio-Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio-Console → Account Info |
| `TWILIO_PHONE_NUMBER` | Twilio-Console → Gekaufte Nummer (E.164-Format) |
| `PUBLIC_BASE_URL` | Aktuelle öffentliche Tunnel-URL (ändert sich pro Deployment) |
| `PRINCIPAL_FULL_NAME` u. a. `PRINCIPAL_*` | Eigene Profildaten (siehe `.env.example`) |

`.env` steht in `.gitignore` und wird NIE committed. `.env.example`
enthält nur leere Platzhalter.

## 4. Twilio-Konfiguration

- Absendernummer = `TWILIO_PHONE_NUMBER` (muss Voice-fähig sein).
- Voice-Webhooks zeigen auf `<PUBLIC_BASE_URL>/voice/outgoing` bzw.
  `/voice/status` (siehe `src/twilio-voice.js`, keine Console-Änderung nötig,
  solange `PUBLIC_BASE_URL` aktuell ist).
- Deutschland Low-Risk-Voice muss in den Geo Permissions aktiv sein.

## 5. Startbefehl

```bash
npm start
# Dashboard: http://localhost:<PORT>/dashboard (lokal 5051, Deployment 3000)
```

## 6. Testbefehl

```bash
npm test            # lokale Suite, credential-frei, kein Netz, keine Kosten
npm run eval        # ElevenLabs-Text-Evaluation (Achtung: verbraucht LLM-Credits)
```

## 7. Restore-Reihenfolge

1. Klonen → 2. `npm install` → 3. `.env` aus Secret-Speicher befüllen →
4. `npm test` (muss grün sein) → 5. `npm start` →
6. `/health` + `/api/settings` prüfen (nur Booleans, keine Secrets) →
7. Agent-/Voice-/Modell-Stand per Dashboard gegen diese Doku abgleichen.

## 8. Dateien, die NIEMALS Secrets enthalten dürfen

`src/`, `public/`, `test/`, `scripts/`, `README.md`, diese Datei,
`.env.example`, Logs, Reports. Secrets existieren ausschließlich in der
lokalen `.env` (0600, git-ignoriert).
