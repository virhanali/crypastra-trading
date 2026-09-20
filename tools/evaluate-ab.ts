/**
 * A/B harness (Phase 12) — CONTROL vs JEV TREATMENT, PAPER ONLY.
 *
 *   bun run evaluate:ab -- <sessionId> [--db <path>] [--account <id>] [--equity 1000]
 *                            [--json] [--debug]
 *
 * Kedua arm memakai rekaman, urutan observasi, wallet awal, scanner, risk,
 * eksekusi, dan evaluasi yang SAMA; hanya perlakuan yang berbeda. Setiap arm
 * memakai DB terisolasi.
 *
 * Laporan bersifat DESKRIPTIF: tidak ada skor tunggal "Jev bagus".
 */
import {
  DEFAULT_JEV_VETO_CONFIG,
  EVALUATION_VERSION,
  EXECUTION_VERSION,
  JEV_EVALUATOR_VERSION,
  JEV_PROMPT_VERSION,
  JEV_SCHEMA_VERSION,
  buildJevInput,
  collectJevEvaluations,
  evaluateTrades,
  experimentHash,
  jevInputHash,
  jevVetoConfigHash,
  scannerConfigHash,
  riskPolicyHash,
  DEFAULT_SCANNER_CONFIG,
  DEFAULT_RISK_POLICY,
  FEATURE_VERSION,
  SCANNER_VERSION,
  DECISION_VERSION,
  NoTreatment,
  JevTreatment,
  type BtcContext,
  type BaselineExperiment,
  type TradeRecord,
} from "@crypastra/core";
import { DeterministicFakeJevAdapter } from "@crypastra/adapters";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../apps/server/src/decision/decision-service.js";
import { TradeExecutionService } from "../apps/server/src/execution/trade-execution-service.js";
import { AutonomousTradeTracker } from "../apps/server/src/execution/autonomous-trade-tracker.js";
import { openDatabase } from "../apps/server/src/db/database.js";
import { FeatureSnapshotRepository } from "../apps/server/src/repositories/feature-snapshot-repository.js";
import { ScannerResultRepository } from "../apps/server/src/repositories/scanner-result-repository.js";
import { JevEvaluationRepository } from "../apps/server/src/repositories/jev-evaluation-repository.js";
import { TreatmentResultRepository } from "../apps/server/src/repositories/treatment-result-repository.js";
import { TradeRecordRepository } from "../apps/server/src/repositories/trade-record-repository.js";
import { DecisionRepository } from "../apps/server/src/repositories/decision-repository.js";
import { ReplayService } from "../apps/server/src/services/replay-service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Args {
  sessionId: string;
  dbPath: string | undefined;
  accountId: string;
  equity: string;
  json: boolean;
  debug: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let dbPath: string | undefined;
  let accountId = "acct-ab";
  let equity = "1000";
  let json = false;
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") { dbPath = argv[index + 1]; index += 1; }
    else if (arg === "--account") { accountId = argv[index + 1] ?? accountId; index += 1; }
    else if (arg === "--equity") { equity = argv[index + 1] ?? equity; index += 1; }
    else if (arg === "--json") { json = true; }
    else if (arg === "--debug") { debug = true; }
    else if (arg !== undefined && !arg.startsWith("--")) { positional.push(arg); }
  }
  const sessionId = positional[0];
  if (sessionId === undefined) {
    throw new Error("Pemakaian: bun run evaluate:ab -- <sessionId> [--db <path>] [--account <id>] [--equity 1000] [--json] [--debug]");
  }
  return { sessionId, dbPath, accountId, equity, json, debug };
}

const args = parseArgs(process.argv.slice(2));
const source = openDatabase({
  path: args.dbPath ?? process.env.CRYPASTRA_DB_PATH ?? "data/crypastra.db",
  runMigrations: true,
});

const sessionExists = source.sqlite
  .query("SELECT count(*) AS n FROM market_recording_sessions WHERE id = ?")
  .get(args.sessionId) as { n: number };
if (sessionExists.n === 0) {
  console.error(`Sesi ${args.sessionId} tidak ditemukan di DB ini.`);
  process.exit(1);
}
const workDir = mkdtempSync(join(tmpdir(), "crypastra-ab-"));
const controlPath = join(workDir, "control.db");
const treatmentPath = join(workDir, "treatment.db");

/**
 * Salin SELURUH DB sumber ke DB arm.
 *
 * Menyalin utuh (bukan menyeed tabel satu per satu) menjamin kedua arm mulai
 * dari keadaan yang IDENTIK — rekaman, kontrak, akun, dan saldo — tanpa
 * bergantung pada bentuk tabel internal.
 */
function seedArm(targetPath: string): void {
  source.sqlite.run("VACUUM INTO ?", [targetPath]);
}

seedArm(controlPath);
seedArm(treatmentPath);

const clock = { nowMs: () => 0 };

function runArm(path: string, mode: "control" | "treatment") {
  const connection = openDatabase({ path, runMigrations: true });
  const analytics = new AnalyticsService({ connection, clock, persist: true });
  const decisions = new DecisionService({ connection, clock, persist: true });
  const execution = new TradeExecutionService({ connection, accountId: args.accountId, enabled: true });
  const tracker = new AutonomousTradeTracker({ connection, clock });
  const treatments = new TreatmentResultRepository(connection);
  const treatment =
    mode === "control"
      ? new NoTreatment()
      : new JevTreatment({
          store: new JevEvaluationRepository(connection),
          config: DEFAULT_JEV_VETO_CONFIG,
          provider: "fake",
          model: "deterministic-v1",
        });

  const service = new ReplayService({
    target: connection,
    analytics,
    decisions,
    execution,
    tracker,
    treatment,
    onTreatment: (result) => treatments.insertIfAbsent(result, 0),
  });
  const result = service.run({ sessionId: args.sessionId, accountId: args.accountId });
  const records = new TradeRecordRepository(connection).list({ accountId: args.accountId });
  const metrics = evaluateTrades({ trades: records, startingEquity: args.equity, evaluationVersion: EVALUATION_VERSION });
  const treatmentResults = treatments.list();
  const decisionCount = new DecisionRepository(connection).count();
  connection.close();
  return { result, records, metrics, treatmentResults, decisionCount };
}

// ── Arm A: CONTROL ──────────────────────────────────────────────
const control = runArm(controlPath, "control");

// ── Collect: evaluasi Jev untuk seluruh kandidat CONTROL ────────
// Kandidat dibaca dari artefak CONTROL (fitur + scanner), jadi evaluasi diambil
// untuk kandidat yang SAMA sebelum arm treatment dijalankan (§29).
// Artefak fitur/scanner dibaca dari arm CONTROL (sudah selesai berjalan),
// bukan dari arm treatment yang belum dijalankan.
const artifactConnection = openDatabase({ path: controlPath, runMigrations: true });
const snapshots = new FeatureSnapshotRepository(artifactConnection).list({ interval: "5m" });
const scannerRows = new ScannerResultRepository(artifactConnection).list({ interval: "5m" });
artifactConnection.close();
const btcSnapshots = snapshots
  .filter((row) => row.contract === "BTC_USDT")
  .sort((a, b) => a.t - b.t);

const fake = new DeterministicFakeJevAdapter();
const collectConnection = openDatabase({ path: treatmentPath, runMigrations: true });
const store = new JevEvaluationRepository(collectConnection);
const usage = {
  requests: 0, cacheHits: 0, cacheMisses: 0, successes: 0,
  invalid: 0, unavailable: 0, errors: 0, inputTokens: 0, outputTokens: 0,
};
const evaluators = ["trend_alignment", "momentum_sustainability", "reversal_risk"] as const;

for (const scannerRow of scannerRows) {
  if (scannerRow.result.status !== "candidate" || scannerRow.result.signal === "neutral") continue;
  const feature = snapshots.find(
    (row) => row.contract === scannerRow.contract && row.t === scannerRow.result.candleCloseTimeMs - 300_000,
  );
  if (feature === undefined) continue;
  const btcRow = [...btcSnapshots].reverse().find((row) => row.t <= feature.t);
  const btcContext: BtcContext | null =
    scannerRow.contract === "BTC_USDT" || btcRow === undefined
      ? null
      : {
          contract: "BTC_USDT",
          trendStructure: btcRow.features.trendStructure,
          return1: btcRow.features.return1,
          return12: btcRow.features.return12,
          atrPercent: btcRow.features.atrPercent,
          close: btcRow.features.close,
        };
  const jevInput = buildJevInput({
    features: feature.features,
    scanner: scannerRow.result,
    btcContext,
    direction: scannerRow.result.signal,
  });
  const counters = await collectJevEvaluations(
    { input: jevInput, inputHash: jevInputHash(jevInput) },
    { port: fake, store, evaluators: [...evaluators], timeoutMs: 0, clock: { nowMs: () => 0 } },
  );
  for (const key of Object.keys(usage) as Array<keyof typeof usage>) {
    usage[key] += counters[key];
  }
}
collectConnection.close();

// ── Arm B: TREATMENT (evaluasi dari cache; tanpa jaringan) ──────
const treatment = runArm(treatmentPath, "treatment");

// ── Analisis matched-trade ──────────────────────────────────────
type Classification = "allowed" | "vetoed" | "unavailable";
const classificationByKey = new Map<string, Classification>();
for (const row of treatment.treatmentResults) {
  const key = `${row.contract}:${row.candleCloseTimeMs}:${row.direction}`;
  const current = classificationByKey.get(key);
  const next: Classification =
    row.status === "allow" ? "allowed" : row.status === "veto" ? "vetoed" : "unavailable";
  // "vetoed" lebih informatif daripada "unavailable" bila ada beberapa baris.
  if (current === undefined || next === "vetoed") {
    classificationByKey.set(key, next);
  }
}

const baselineTradesByKey = new Map<string, TradeRecord>();
for (const record of control.records) {
  const key = `${record.contract}:${record.entryTimeMs}:${record.side}`;
  baselineTradesByKey.set(key, record);
}
void baselineTradesByKey;

function rOf(record: TradeRecord): number {
  return record.rMultiple === null ? 0 : Number(record.rMultiple);
}

const matched = { allowed: 0, vetoed: 0, unavailable: 0 };
const vetoed = { winners: 0, losers: 0, breakeven: 0, totalR: 0, count: 0 };
for (const record of control.records) {
  const decisionKey = `${record.contract}:${record.decisionTimeMs}:${record.side}`;
  const classification = classificationByKey.get(decisionKey) ?? "unavailable";
  matched[classification] += 1;
  if (classification === "vetoed") {
    vetoed.count += 1;
    vetoed.totalR += rOf(record);
    const net = Number(record.netPnl);
    if (net > 0) vetoed.winners += 1;
    else if (net < 0) vetoed.losers += 1;
    else vetoed.breakeven += 1;
  }
}

const vetoReasons: Record<string, number> = {};
for (const row of treatment.treatmentResults) {
  for (const reason of row.reasons) {
    vetoReasons[reason] = (vetoReasons[reason] ?? 0) + 1;
  }
}

function experiment(arm: "none" | "jev"): BaselineExperiment {
  return {
    recordingSession: args.sessionId,
    startingAccountState: `wallet=${args.equity};positions=0`,
    featureVersion: FEATURE_VERSION,
    scannerVersion: SCANNER_VERSION,
    scannerConfigHash: scannerConfigHash(DEFAULT_SCANNER_CONFIG),
    decisionVersion: DECISION_VERSION,
    riskPolicyHash: riskPolicyHash(DEFAULT_RISK_POLICY),
    executionVersion: EXECUTION_VERSION,
    evaluationVersion: EVALUATION_VERSION,
    execution: arm === "none" ? "on|treatment=none" : `on|treatment=jev:${jevVetoConfigHash(DEFAULT_JEV_VETO_CONFIG)}`,
  };
}

function sideBySide(label: string, key: keyof typeof control.metrics) {
  return { metric: label, control: control.metrics[key], treatment: treatment.metrics[key] };
}

const report = {
  recording: args.sessionId,
  accountId: args.accountId,
  experimentHash: {
    control: experimentHash(experiment("none")),
    treatment: experimentHash(experiment("jev")),
  },
  treatmentIdentity: {
    evaluatorVersion: JEV_EVALUATOR_VERSION,
    promptVersion: JEV_PROMPT_VERSION,
    schemaVersion: JEV_SCHEMA_VERSION,
    vetoConfigHash: jevVetoConfigHash(DEFAULT_JEV_VETO_CONFIG),
    provider: "fake",
    model: "deterministic-v1",
  },
  candidates: {
    controlDecisions: control.decisionCount,
    controlTrades: control.records.length,
    treatmentResults: treatment.treatmentResults.length,
    allowed: treatment.treatmentResults.filter((row) => row.status === "allow").length,
    vetoed: treatment.treatmentResults.filter((row) => row.status === "veto").length,
    unavailable: treatment.treatmentResults.filter((row) => row.status === "unavailable" || row.status === "invalid").length,
    treatmentDecisions: treatment.decisionCount,
    treatmentTrades: treatment.records.length,
  },
  usage,
  vetoReasons,
  metrics: [
    sideBySide("tradeCount", "tradeCount"),
    sideBySide("winRate", "winRate"),
    sideBySide("netPnl", "netPnl"),
    sideBySide("expectancyPerTrade", "expectancyPerTrade"),
    sideBySide("expectancyR", "expectancyR"),
    sideBySide("profitFactor", "profitFactor"),
    sideBySide("maxDrawdown", "maxDrawdown"),
    sideBySide("maxDrawdownPct", "maxDrawdownPct"),
    sideBySide("averageR", "averageR"),
    sideBySide("averageMAE", "averageMae"),
    sideBySide("averageMFE", "averageMfe"),
  ],
  delta: {
    tradeCount: treatment.metrics.tradeCount - control.metrics.tradeCount,
    netPnl: String(Number(treatment.metrics.netPnl) - Number(control.metrics.netPnl)),
    tradesRemovedByTreatment: control.records.length - treatment.records.length,
  },
  matchedTrades: { ...matched, ...vetoed },
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Recording        : ${report.recording}`);
  console.log(`CONTROL exp hash : ${report.experimentHash.control}`);
  console.log(`TREATMENT exp    : ${report.experimentHash.treatment}`);
  console.log(`Kandidat         : kontrol=${report.candidates.controlDecisions} keputusan, ${report.candidates.controlTrades} trade`);
  console.log(`                   treatment=${report.candidates.treatmentResults} evaluasi (allow ${report.candidates.allowed} / veto ${report.candidates.vetoed} / unavailable ${report.candidates.unavailable})`);
  console.log(`                   treatment=${report.candidates.treatmentDecisions} keputusan, ${report.candidates.treatmentTrades} trade`);
  console.log(`Jev usage        : requests=${usage.requests} cacheHits=${usage.cacheHits} cacheMisses=${usage.cacheMisses} success=${usage.successes} invalid=${usage.invalid} unavailable=${usage.unavailable}`);
  console.log("Metrik (CONTROL vs TREATMENT):");
  for (const row of report.metrics) {
    console.log(`  ${row.metric.padEnd(20)} ${String(row.control ?? "-").padEnd(24)} ${String(row.treatment ?? "-")}`);
  }
  console.log(`Trades dihapus   : ${report.delta.tradesRemovedByTreatment}`);
  console.log(`Delta netPnl     : ${report.delta.netPnl}`);
  console.log(`Matched trades   : allowed=${matched.allowed} vetoed=${matched.vetoed} unavailable=${matched.unavailable}`);
  console.log(`Vetoed outcomes  : winners=${vetoed.winners} losers=${vetoed.losers} breakeven=${vetoed.breakeven} totalR=${vetoed.totalR}`);
  console.log("Veto reasons:");
  for (const [code, count] of Object.entries(vetoReasons).sort()) {
    console.log(`  ${code.padEnd(34)} ${count}`);
  }
  console.log("Catatan: perbedaan ini DESKRIPTIF, bukan klaim kausal/statistik.");
  if (args.debug) {
    console.log("DEBUG: treatmentResults=" + JSON.stringify(treatment.treatmentResults.map((row) => [row.contract, row.candleCloseTimeMs, row.status, row.reasons])));
  }
}

source.close();
rmSync(workDir, { recursive: true, force: true });
