/**
 * Evaluasi baseline (Phase 11) — OPSIONAL, PAPER ONLY, tanpa klaim signifikansi.
 *
 *   bun run evaluate:baseline -- <sessionId> [--db <path>] [--account <id>] [--equity 1000]
 *                                   [--execution on|off] [--json]
 *
 * Menjalankan replay otonom atas rekaman: candle → fitur → scanner → keputusan
 * → eksekusi PAPER (opsional) → trade record → metrik. Tidak ada endpoint
 * privat Gate dan tidak ada kredensial exchange.
 */
import {
  EVALUATION_VERSION,
  EXECUTION_VERSION,
  evaluateTrades,
  experimentHash,
  DEFAULT_FEATURE_CONFIG,
  DEFAULT_SCANNER_CONFIG,
  DEFAULT_RISK_POLICY,
  scannerConfigHash,
  riskPolicyHash,
  FEATURE_VERSION,
  SCANNER_VERSION,
  DECISION_VERSION,
  type BaselineExperiment,
} from "@crypastra/core";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../apps/server/src/decision/decision-service.js";
import { TradeExecutionService } from "../apps/server/src/execution/trade-execution-service.js";
import { AutonomousTradeTracker } from "../apps/server/src/execution/autonomous-trade-tracker.js";
import { openDatabase } from "../apps/server/src/db/database.js";
import { TradeRecordRepository } from "../apps/server/src/repositories/trade-record-repository.js";
import { DecisionExecutionRepository } from "../apps/server/src/repositories/decision-execution-repository.js";
import { ReplayService } from "../apps/server/src/services/replay-service.js";

interface Args {
  sessionId: string;
  dbPath: string | undefined;
  accountId: string | undefined;
  equity: string;
  execution: "on" | "off";
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let dbPath: string | undefined;
  let accountId: string | undefined;
  let equity = "1000";
  let execution: "on" | "off" = "on";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") { dbPath = argv[index + 1]; index += 1; }
    else if (arg === "--account") { accountId = argv[index + 1]; index += 1; }
    else if (arg === "--equity") { equity = argv[index + 1] ?? "1000"; index += 1; }
    else if (arg === "--execution") { execution = argv[index + 1] === "off" ? "off" : "on"; index += 1; }
    else if (arg === "--json") { json = true; }
    else if (arg !== undefined && !arg.startsWith("--")) { positional.push(arg); }
  }
  const sessionId = positional[0];
  if (sessionId === undefined) {
    throw new Error("Pemakaian: bun run evaluate:baseline -- <sessionId> [--db <path>] [--account <id>] [--equity 1000] [--execution on|off] [--json]");
  }
  return { sessionId, dbPath, accountId, equity, execution, json };
}

const args = parseArgs(process.argv.slice(2));
const connection = openDatabase({
  path: args.dbPath ?? process.env.CRYPASTRA_DB_PATH ?? "data/crypastra.db",
  runMigrations: true,
});

const sessions = connection.sqlite
  .query("SELECT id, contracts_json FROM market_recording_sessions ORDER BY started_at DESC")
  .all() as Array<{ id: string; contracts_json: string }>;
if (!sessions.some((row) => row.id === args.sessionId)) {
  console.error(`Sesi ${args.sessionId} tidak ditemukan di DB ini.`);
  process.exit(1);
}

const accountRow = args.accountId === undefined
  ? (connection.sqlite.query("SELECT id FROM accounts ORDER BY created_at LIMIT 1").get() as { id: string } | null)
  : { id: args.accountId };
if (accountRow === null) {
  console.error("Tidak ada akun di DB ini; sediakan --account.");
  process.exit(1);
}
const accountId = accountRow.id;

const clock = { nowMs: () => 0 };
const analytics = new AnalyticsService({ connection, clock, persist: true });
const decisions = new DecisionService({ connection, clock, persist: true });
const executionEnabled = args.execution === "on";
const execution = new TradeExecutionService({ connection, accountId, enabled: executionEnabled });
const tracker = new AutonomousTradeTracker({ connection, clock });

const service = new ReplayService({ target: connection, analytics, decisions, execution, tracker });
const result = service.run({ sessionId: args.sessionId, accountId });

const records = new TradeRecordRepository(connection).list({ accountId });
const metrics = evaluateTrades({ trades: records, startingEquity: args.equity, evaluationVersion: EVALUATION_VERSION });
const execCounters = execution.counters();
const executions = new DecisionExecutionRepository(connection).list({ accountId });

const experiment: BaselineExperiment = {
  recordingSession: args.sessionId,
  startingAccountState: `wallet=${args.equity};positions=0`,
  featureVersion: FEATURE_VERSION,
  scannerVersion: SCANNER_VERSION,
  scannerConfigHash: scannerConfigHash(DEFAULT_SCANNER_CONFIG),
  decisionVersion: DECISION_VERSION,
  riskPolicyHash: riskPolicyHash(DEFAULT_RISK_POLICY),
  executionVersion: EXECUTION_VERSION,
  evaluationVersion: EVALUATION_VERSION,
  execution: args.execution,
};
void DEFAULT_FEATURE_CONFIG;

const report = {
  recording: args.sessionId,
  accountId,
  experimentHash: experimentHash(experiment),
  experiment,
  decisions: decisions.counters().decisionsEvaluated,
  approved: decisions.counters().approved,
  executed: execCounters.executionFilled,
  rejected: execCounters.executionRejected,
  failed: execCounters.executionFailed,
  skipped: execCounters.executionRefused,
  duplicates: execCounters.executionDuplicates,
  executionStatuses: executions.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {}),
  tradeCount: metrics.tradeCount,
  wins: metrics.wins,
  losses: metrics.losses,
  winRate: metrics.winRate,
  netPnl: metrics.netPnl,
  grossProfit: metrics.grossProfit,
  grossLoss: metrics.grossLoss,
  expectancyPerTrade: metrics.expectancyPerTrade,
  profitFactor: metrics.profitFactor,
  maxDrawdown: metrics.maxDrawdown,
  maxDrawdownPct: metrics.maxDrawdownPct,
  averageR: metrics.averageR,
  totalR: metrics.totalR,
  longTrades: metrics.longTrades,
  shortTrades: metrics.shortTrades,
  tpExits: metrics.tpExits,
  slExits: metrics.slExits,
  liquidationExits: metrics.liquidationExits,
  manualExits: metrics.manualExits,
  averageMae: metrics.averageMae,
  averageMfe: metrics.averageMfe,
  economicHashes: result.hashes,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Recording        : ${report.recording}`);
  console.log(`Experiment hash  : ${report.experimentHash}`);
  console.log(`Eksekusi         : ${args.execution}`);
  console.log(`Keputusan        : ${report.decisions} (disetujui ${report.approved})`);
  console.log(`Eksekusi         : filled=${report.executed} rejected=${report.rejected} failed=${report.failed} skipped=${report.skipped} duplikat=${report.duplicates}`);
  console.log(`Trades           : ${report.tradeCount} (long ${report.longTrades}, short ${report.shortTrades})`);
  console.log(`Wins/Losses      : ${report.wins}/${report.losses}  winRate=${report.winRate ?? "-"}`);
  console.log(`Net PnL          : ${report.netPnl}`);
  console.log(`Gross P/L        : ${report.grossProfit} / ${report.grossLoss}`);
  console.log(`Expectancy/trade : ${report.expectancyPerTrade ?? "-"}`);
  console.log(`Profit factor    : ${report.profitFactor ?? "n/a (tanpa kerugian)"}`);
  console.log(`Max drawdown     : ${report.maxDrawdown} (${report.maxDrawdownPct ?? "0"}%)`);
  console.log(`Average R        : ${report.averageR ?? "-"}  totalR=${report.totalR}`);
  console.log(`Exit TP/SL/liq/manual: ${report.tpExits}/${report.slExits}/${report.liquidationExits}/${report.manualExits}`);
  console.log(`MAE/MFE rata-rata: ${report.averageMae ?? "-"} / ${report.averageMfe ?? "-"}`);
  console.log(`Hash ekonomi     : ${JSON.stringify(report.economicHashes)}`);
  console.log("Catatan: metrik ini DESKRIPTIF untuk baseline, bukan klaim signifikansi statistik.");
}

connection.close();
