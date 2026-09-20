/**
 * Analisis rekaman (Phase 9) — OPSIONAL, tanpa order, tanpa klaim PnL.
 *
 *   bun run analyze:recording -- <sessionId> [--db <path>] [--json]
 *
 * Memuat candle 5m TERTUTUP dari rekaman, menjalankan FeatureEngine dan
 * Scanner yang SAMA seperti live, lalu mencetak ringkasan. Tidak menyentuh
 * wallet, tidak menempatkan order, dan tidak menghitung hasil masa depan.
 */
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import { openDatabase } from "../apps/server/src/db/database.js";
import { MarketObservationRepository } from "../apps/server/src/repositories/market-observation-repository.js";

interface Arguments {
  sessionId: string;
  dbPath: string | undefined;
  json: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  const positional: string[] = [];
  let dbPath: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      dbPath = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg !== undefined && !arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  const sessionId = positional[0];
  if (sessionId === undefined) {
    throw new Error("Pemakaian: bun run analyze:recording -- <sessionId> [--db <path>] [--json]");
  }
  return { sessionId, dbPath, json };
}

const args = parseArguments(process.argv.slice(2));
const connection = openDatabase({
  path: args.dbPath ?? process.env.CRYPASTRA_DB_PATH ?? "data/crypastra.db",
  runMigrations: true,
});

const observations = new MarketObservationRepository(connection).list(args.sessionId, {
  limit: 1_000_000,
});

if (observations.length === 0) {
  console.error(`Sesi ${args.sessionId} tidak punya observasi di DB ini.`);
  process.exit(1);
}

const analytics = new AnalyticsService({
  connection,
  clock: { nowMs: () => 0 },
  persist: false,
});

let lastObservedAtMs = 0;
for (const row of observations) {
  const observation = row.observation;
  lastObservedAtMs = observation.observedAtMs;
  if (observation.kind !== "candle" || !observation.closed) {
    continue;
  }
  analytics.onClosedCandle({
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
  });
}

const counters = analytics.counters();
const digest = analytics.digest();
const snapshots = analytics.snapshots();
const results = analytics.results();
const lastSnapshot = snapshots.at(-1) ?? null;

const report = {
  sessionId: args.sessionId,
  observations: observations.length,
  lastObservedAtMs,
  contracts: [...new Set(snapshots.map((snapshot) => snapshot.contract))].sort(),
  candlesProcessed: counters.candlesProcessed,
  otherIntervalCandles: counters.otherIntervalCandles,
  duplicateCandles: counters.duplicateCandles,
  outOfOrderCandles: counters.outOfOrderCandles,
  warmupSkips: counters.warmupSkips,
  featureSnapshots: counters.featureSnapshotsProduced,
  featureSnapshotsPersisted: counters.featureSnapshotsPersisted,
  scannerCandidates: counters.scannerCandidates,
  scannerSkips: counters.scannerSkips,
  longSignals: counters.longSignals,
  shortSignals: counters.shortSignals,
  neutralSignals: counters.neutralSignals,
  errors: counters.errors,
  reasonCodeDistribution: digest.reasonCodeCounts,
  lastSnapshot,
  researchHash: digest.combinedHash,
  featureVersion: snapshots[0]?.featureVersion ?? null,
  scannerVersion: results[0]?.scannerVersion ?? null,
  scannerConfigHash: analytics.scannerConfigHashValue,
  historyNote:
    counters.warmupSkips > 0
      ? "Sebagian candle di bawah warmup; sinyal hanya muncul setelah syarat riwayat terpenuhi."
      : null,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Sesi               : ${report.sessionId}`);
  console.log(`Observasi          : ${report.observations}`);
  console.log(`Kontrak            : ${report.contracts.join(", ") || "(tidak ada)"}`);
  console.log(`Candle 5m diproses : ${report.candlesProcessed}`);
  console.log(`  interval lain    : ${report.otherIntervalCandles}`);
  console.log(`  duplikat         : ${report.duplicateCandles}`);
  console.log(`  out-of-order     : ${report.outOfOrderCandles}`);
  console.log(`Warmup skip        : ${report.warmupSkips}`);
  console.log(`FeatureSnapshot    : ${report.featureSnapshots} (dihasilkan, tidak dipersist di alat ini)`);
  console.log(`Scanner kandidat   : ${report.scannerCandidates}`);
  console.log(`Scanner skip       : ${report.scannerSkips}`);
  console.log(`Sinyal             : long=${report.longSignals} short=${report.shortSignals} neutral=${report.neutralSignals}`);
  console.log(`Error analitik     : ${report.errors}`);
  console.log(`Hash riset         : ${report.researchHash}`);
  console.log(`featureVersion     : ${report.featureVersion ?? "(tidak ada snapshot)"}`);
  console.log(`scannerVersion     : ${report.scannerVersion ?? "(tidak ada hasil)"}`);
  console.log(`scannerConfigHash  : ${report.scannerConfigHash}`);
  console.log("Distribusi reasonCode:");
  for (const [code, count] of Object.entries(report.reasonCodeDistribution).sort()) {
    console.log(`  ${code.padEnd(24)} ${count}`);
  }
  if (report.historyNote !== null) {
    console.log(`Catatan            : ${report.historyNote}`);
  }
}

connection.close();
