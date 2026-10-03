'use strict';

// Victor Professional Evaluation Runner (textbasiert, kein Twilio, kein Audio).
//
// Ablauf: prüft Credentials -> legt die 8 Simulationstests einmalig an
// (vorhandene Test-IDs werden wiederverwendet) -> führt die Suite per
// runTests aus -> schreibt Markdown-Report nach _test-results/.
// Verbraucht ausschließlich Text-LLM-Kontingent (Agent + Sim-User + Evaluator),
// KEINE Audio-Minuten, KEIN Twilio. Ohne .env bricht das Script sauber ab.
//
// Nutzung: npm run eval [-- --repeat 2 --only vollstaendiger-name]

const fs = require('node:fs');
const path = require('node:path');

const { SCENARIOS } = require('../test/eval/scenarios');

const DEFAULT_REPEAT = 1;
const DEFAULT_MAX_TURNS = 8;

function loadEnv() {
  try {
    require('dotenv').config();
  } catch {
    /* dotenv optional */
  }
}

function parseArgs(argv) {
  const out = { repeat: DEFAULT_REPEAT, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeat' && argv[i + 1]) out.repeat = Math.max(1, Math.min(20, Number.parseInt(argv[i + 1], 10) || DEFAULT_REPEAT));
    if (argv[i] === '--only' && argv[i + 1]) out.only = argv[i + 1];
  }
  return out;
}

function buildClient() {
  // Repo-SDK statt eigenem HTTP-Client (verifiziert: tests.create + agents.runTests vorhanden).
  const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
  return new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
}

async function findExistingTests(client) {
  // Bereits angelegte Suite-Tests wiederverwenden statt zu duplizieren.
  try {
    const res = await client.conversationalAi.tests.list({ pageSize: 100 });
    const items = res.tests || res.data || [];
    const byName = new Map();
    for (const t of (Array.isArray(items) ? items : [])) {
      if (t && t.name) byName.set(t.name, t.id || t.test_id);
    }
    return byName;
  } catch {
    return new Map();
  }
}

// Hinweis: simulated_user_model/evaluation_model werden NICHT gesetzt –
// die API lehnt explizite Werte derzeit ab (422), Server-Defaults gelten.
async function ensureTest(client, scenario) {
  const body = {
    type: 'simulation',
    name: scenario.name,
    simulationScenario: scenario.simulationScenario,
    successConditions: scenario.successConditions,
    simulationMaxTurns: scenario.maxTurns || DEFAULT_MAX_TURNS,
    dynamicVariables: scenario.dynamicVariables,
    conversationInitiationSource: 'twilio',
  };
  const res = await client.conversationalAi.tests.create(body);
  return res.id || res.test_id;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCompletion(client, invocationId, timeoutMs) {
  // Läufe sind asynchron: pollen, bis alle Runs terminal sind (kein Rate-Limit).
  const started = Date.now();
  for (;;) {
    const det = await client.conversationalAi.tests.invocations.get(invocationId);
    const runs = det.testRuns || det.test_runs || [];
    if (runs.length > 0 && runs.every((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'cancelled')) {
      return runs;
    }
    if (Date.now() - started > timeoutMs) throw new Error('Timeout beim Warten auf Test-Runs');
    await sleep(15000);
  }
}

function renderReport({ results, creditsTotal, agentName }) {
  const passed = results.filter((r) => r.status === 'passed').length;
  const lines = [];
  lines.push('# Victor Professional Evaluation');
  lines.push('');
  lines.push(`- Agent: ${agentName}`);
  lines.push(`- Datum: ${new Date().toISOString()}`);
  lines.push(`- Tests: ${results.length}`);
  lines.push(`- Bestanden: ${passed}`);
  lines.push(`- Fehlgeschlagen: ${results.length - passed}`);
  lines.push(`- Credits (Summe, soweit geliefert): ${creditsTotal == null ? 'nicht geliefert' : creditsTotal}`);
  lines.push('- Twilio-Anruf durchgeführt: nein (reine Text-Simulation, kein Audio, keine Telefonie).');
  lines.push('- Produktionsänderungen: keine.');
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.status === 'passed' ? 'PASS' : 'FAIL'} – ${r.name}`);
    lines.push(`- Status: ${r.status}`);
    if (r.reason) lines.push(`- Grund: ${r.reason}`);
    if (r.violated && r.violated.length) lines.push(`- Verletzte Kriterien: ${r.violated.join('; ')}`);
    if (r.credits != null) lines.push(`- Credits: ${r.credits}`);
    if (r.transcript) lines.push(`- Transkript (Auszug):\n${r.transcript}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  loadEnv();
  const agentId = process.env.ELEVENLABS_AGENT_ID || '';
  if (!process.env.ELEVENLABS_API_KEY || !agentId) {
    console.error(
      'Abbruch: ELEVENLABS_API_KEY und ELEVENLABS_AGENT_ID erforderlich (.env fehlt oder unvollständig). ' +
      'Es wurde kein Evaluation-Run gestartet, keine Kosten entstanden.'
    );
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const selected = args.only ? SCENARIOS.filter((s) => s.key === args.only) : SCENARIOS;
  if (selected.length === 0) {
    console.error(`Abbruch: kein Szenario mit Schlüssel "${args.only}" gefunden.`);
    process.exitCode = 2;
    return;
  }
  const client = buildClient();
  const existing = await findExistingTests(client);
  const testIds = [];
  for (const s of selected) {
    let id = existing.get(s.name) || null;
    if (!id) {
      id = await ensureTest(client, s);
      existing.set(s.name, id);
    }
    testIds.push({ key: s.key, name: s.name, test_id: id });
  }
  const invocation = await client.conversationalAi.agents.runTests(agentId, {
    tests: testIds.map((t) => ({ testId: t.test_id })),
    repeatCount: args.repeat,
  });
  const invocationId = invocation.id || invocation.invocation_id || invocation.invocationId;
  // Runs sind asynchron: auf Abschluss warten statt Pending als FAIL zu werten.
  const runs = await waitForCompletion(client, invocationId, 10 * 60 * 1000);
  const results = [];
  let creditsTotal = 0;
  let creditsKnown = false;
  for (const run of runs) {
    const name = run.testName || run.test_name || run.testId || run.test_id || '?';
    const status = run.status === 'passed' ? 'passed' : 'failed';
    const credits = run.creditsUsed ?? run.credits_used ?? null;
    if (typeof credits === 'number') {
      creditsKnown = true;
      creditsTotal += credits;
    }
    const cond = run.conditionResult || run.condition_result || null;
    const rationale = cond && cond.rationale ? JSON.stringify(cond.rationale).slice(0, 600) : null;
    const transcript = (run.agentResponses || run.agent_responses || [])
      .map((t) => `[${t.role}]: ${String(t.message || '').slice(0, 200)}`)
      .join('\n');
    results.push({ name, status, reason: rationale, violated: [], credits, transcript });
  }
  const outDir = path.join(__dirname, '..', '_test-results');
  fs.mkdirSync(outDir, { recursive: true });
  const report = renderReport({
    results,
    creditsTotal: creditsKnown ? creditsTotal : null,
    agentName: 'Victor Telefon',
  });
  const outFile = path.join(outDir, 'victor-evaluation.md');
  fs.writeFileSync(outFile, report);
  console.log(report);
  console.log(`\nReport: ${outFile}`);
  if (results.some((r) => r.status !== 'passed')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Evaluation fehlgeschlagen:', String((err && err.message) || err).slice(0, 300));
  process.exitCode = 1;
});
