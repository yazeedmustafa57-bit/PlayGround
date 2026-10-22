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
| `ELEVENLABS_PHONE_NUMBER_ID` (optional) | ElevenLabs-Dashboard → Phone Numbers → „Zadarma DE“ → ID (`phnum_…`); fehlt sie, wird automatisch ermittelt |
| `ELEVENLABS_VOICE_ID` | ElevenLabs-Dashboard → Voices → Helmut-Stimme → Voice-ID |
| `PUBLIC_BASE_URL` | Aktuelle öffentliche Tunnel-URL (ändert sich pro Deployment) |
| `PRINCIPAL_FULL_NAME` u. a. `PRINCIPAL_*` | Eigene Profildaten (siehe `.env.example`) |

`.env` steht in `.gitignore` und wird NIE committed. `.env.example`
enthält nur leere Platzhalter.

## 4. Telefonie-Konfiguration

- Telefonie läuft über den bereits bei ElevenLabs importierten
  **Zadarma-SIP-Trunk** (`+4944168304115`). Twilio wird bewusst nicht verwendet;
  ein zweites Gateway oder separate Zadarma-Zugangsdaten sind nicht nötig.
- Benötigt werden nur `ELEVENLABS_API_KEY` und `ELEVENLABS_AGENT_ID`.
  `ELEVENLABS_PHONE_NUMBER_ID` ist optional und wird sonst automatisch aus dem
  Agenten ermittelt.
- `GET /api/elevenlabs/status` prüft den Agenten live, `GET /api/telephony/status`
  prüft die Nummer live (beides read-only, 60 s gecacht).
- `GET /api/call/:id/transcript` lädt bei nativen SIP-Anrufen das echte
  Transkript nach Gesprächsende über `GET /v1/convai/conversations/{id}` nach.
- SIP `603 Decline` beim ausgehenden INVITE ist ein Zadarma-seitiges Problem
  (ausgehende Rufnummer/Caller-ID/Tarif) und keine Backend-Fehlkonfiguration.
- `POST /api/call/start` startet einen echten Anruf erst mit `confirm: true`
  und verifizierter Nummer; sonst `confirmation-required` bzw.
  `telephony-unverified`. Ohne Konfiguration bleibt es bei
  `telephony-unavailable` (kein Fake-Erfolg).
- `/media-stream` bleibt als provider-neutraler Eingang (8 kHz mulaw, base64)
  für künftige Gateways erhalten; für den nativen SIP-Trunk nicht erforderlich.
- `PUBLIC_BASE_URL` bleibt optional für die öffentliche Basis-URL.

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
