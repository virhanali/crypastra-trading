/**
 * Analisis keputusan (Phase 10) — OPSIONAL, tanpa order, tanpa klaim PnL.
 *
 *   bun run analyze:decisions -- <sessionId> [--db <path>] [--equity 1000] [--json]
 *
 * Menjalankan FeatureEngine → Scanner → Decision/Risk Engine atas candle
 * TERTUTUP dari rekaman, memakai keadaan akun paper yang DETERMINISTIK dan tetap
 * (keputusan Phase 10 tidak mengeksekusi, jadi akun tidak berubah).
 *
 * Kutipan eksekusi diambil dari observasi `quote` yang direkam bila ada;
 * kalau tidak ada, harga tutup candle dipakai sebagai acuan dan itu DILAPORKAN.
 */
import { Decimal, type Candle, type ContractSpec } from "@crypastra/core";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { DecisionService } from "../apps/server/src/decision/decision-service.js";
import { openDatabase } from "../apps/server/src/db/database.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { MarketObservationRepository } from "../apps/server/src/repositories/market-observation-repository.js";

interface Arguments {
  sessionId: string;
  dbPath: string | undefined;
  equity: string;
  json: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  const positional: string[] = [];
  let dbPath: string | undefined;
  let equity = "1000";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      dbPath = argv[index + 1];
      index += 1;
    } else if (arg === "--equity") {
      equity = argv[index + 1] ?? "1000";
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg !== undefined && !arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  const sessionId = positional[0];
  if (sessionId === undefined) {
    throw new Error(
      "Pemakaian: bun run analyze:decisions -- <sessionId> [--db <path>] [--equity 1000] [--json]",
    );
  }
  return { sessionId, dbPath, equity, json };
}

const args = parseArguments(process.argv.slice(2));
const connection = openDatabase({
  path: args.dbPath ?? process.env.CRYPASTRA_DB_PATH ?? "data/crypastra.db",
  runMigrations: true,
});

const contracts = new ContractRepository(connection);
const rows = new MarketObservationRepository(connection).list(args.sessionId, { limit: 1_000_000 });
if (rows.length === 0) {
  console.error(`Sesi ${args.sessionId} tidak punya observasi di DB ini.`);
  process.exit(1);
}

// Kutipan per (contract, observedAtMs) dari rekaman; hanya bila direkam.
const quotes = new Map<string, { bid: string; ask: string }>();
for (const row of rows) {
  const observation = row.observation;
  if (observation.kind === "quote" && observation.bestBid !== null && observation.bestAsk !== null) {
    quotes.set(`${observation.contract}:${observation.observedAtMs}`, {
      bid: observation.bestBid,
      ask: observation.bestAsk,
    });
  }
}

const decisions = new DecisionService({
  connection,
  clock: { nowMs: () => 0 },
  persist: false,
});

let syntheticReferences = 0;
let skippedUnknownContract = 0;

// Akun paper deterministik dan TETAP: keputusan tidak mengeksekusi order.
const accountFor = (accountId: string) => ({
  accountId,
  walletBalance: args.equity,
  equity: args.equity,
  availableBalance: args.equity,
  positionMargin: "0",
  reservedMargin: "0",
  openPositionCount: 0,
  openPositions: [],
});

const analytics = new AnalyticsService({
  connection,
  clock: { nowMs: () => 0 },
  persist: false,
});

analytics.setScannerResultHandler(({ snapshot, result }) => {
  const spec: ContractSpec | null = contracts.find(result.contract);
  if (spec === null) {
    skippedUnknownContract += 1;
    return;
  }
  const recorded = quotes.get(`${result.contract}:${snapshot.candleCloseTimeMs - 300_000}`);
  let bid: string;
  let ask: string;
  if (recorded === undefined) {
    // Tidak ada kutipan terekam: harga tutup dipakai sebagai acuan sintetis.
    syntheticReferences += 1;
    const close = new Decimal(snapshot.close);
    bid = close.toString();
    ask = close.toString();
  } else {
    bid = recorded.bid;
    ask = recorded.ask;
  }
  decisions.evaluate({
    contract: result.contract,
    timeframe: result.timeframe,
    candleCloseTimeMs: result.candleCloseTimeMs,
    accountId: "analyze-paper",
    features: snapshot,
    scanner: result,
    spec,
    market: { bestBid: bid, bestAsk: ask, markPrice: snapshot.close, sourceTimestampMs: null },
    account: accountFor("analyze-paper"),
  });
});

for (const row of rows) {
  const observation = row.observation;
  if (observation.kind !== "candle" || !observation.closed) {
    continue;
  }
  const candle: Candle = {
    contract: observation.contract,
    interval: observation.interval,
    openTimeSeconds: observation.openTimeSeconds,
    o: observation.open,
    h: observation.high,
    l: observation.low,
    c: observation.close,
    v: observation.volume,
    sum: "0",
    windowClosed: true,
  };
  analytics.onClosedCandle(candle);
}

const counters = decisions.counters();
const approved = decisions.decisions().filter((decision) => decision.action === "trade");

function average(values: readonly Decimal[]): string {
  if (values.length === 0) return "0";
  return values
    .reduce((sum, value) => sum.plus(value), new Decimal(0))
    .div(values.length)
    .toString();
}

const report = {
  sessionId: args.sessionId,
  equity: args.equity,
  observations: rows.length,
  syntheticReferences,
  skippedUnknownContract,
  scannerEvaluated: analytics.counters().scannerCandidates + analytics.counters().scannerSkips,
  evaluated: counters.decisionsEvaluated,
  approved: counters.approved,
  skipped: counters.skipped,
  longApproved: counters.longApproved,
  shortApproved: counters.shortApproved,
  sizeCapped: counters.sizeCapped,
  marginRejected: counters.marginRejected,
  positionLimitRejected: counters.positionLimitRejected,
  errors: counters.errors,
  averagePlannedRisk: average(approved.map((d) => new Decimal(d.tradePlan!.riskAmount))),
  averagePlannedNotional: average(approved.map((d) => new Decimal(d.tradePlan!.notional))),
  averageLeverage: average(approved.map((d) => new Decimal(d.tradePlan!.leverage))),
  reasonCodeDistribution: counters.skipByReason,
  decisionHash: decisions.digest().combinedHash,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Sesi                : ${report.sessionId}`);
  console.log(`Equity paper        : ${report.equity}`);
  console.log(`Observasi           : ${report.observations}`);
  console.log(`Dievaluasi          : ${report.evaluated}`);
  console.log(`  disetujui         : ${report.approved} (long=${report.longApproved} short=${report.shortApproved})`);
  console.log(`  dilewati          : ${report.skipped}`);
  console.log(`  size di-cap       : ${report.sizeCapped}`);
  console.log(`  margin ditolak    : ${report.marginRejected}`);
  console.log(`  batas posisi      : ${report.positionLimitRejected}`);
  console.log(`Error               : ${report.errors}`);
  console.log(`Rata-rata risiko    : ${report.averagePlannedRisk}`);
  console.log(`Rata-rata notional  : ${report.averagePlannedNotional}`);
  console.log(`Rata-rata leverage  : ${report.averageLeverage}`);
  console.log(`Hash keputusan      : ${report.decisionHash}`);
  if (report.syntheticReferences > 0) {
    console.log(
      `Catatan             : ${report.syntheticReferences} keputusan memakai harga tutup candle sebagai acuan (tidak ada kutipan terekam)`,
    );
  }
  if (report.skippedUnknownContract > 0) {
    console.log(`Catatan             : ${report.skippedUnknownContract} kontrak tidak dikenal di DB, dilewati`);
  }
  console.log("Distribusi reasonCode:");
  for (const [code, count] of Object.entries(report.reasonCodeDistribution).sort()) {
    console.log(`  ${code.padEnd(30)} ${count}`);
  }
}

connection.close();
