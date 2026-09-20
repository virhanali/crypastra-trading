/**
 * Status & kualitas dataset (Phase 13) — OFFLINE, tanpa jaringan.
 *
 *   bun run dataset:status [--session <id>] [--db <path>] [--json]
 */
import { LABEL_HORIZONS, OUTCOME_LABEL_VERSION } from "@crypastra/core";
import { openDatabase } from "../apps/server/src/db/database.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../apps/server/src/repositories/market-observation-repository.js";
import { FeatureSnapshotRepository } from "../apps/server/src/repositories/feature-snapshot-repository.js";
import { JevEvaluationRepository } from "../apps/server/src/repositories/jev-evaluation-repository.js";
import { DatasetBuilder } from "../apps/server/src/research/dataset-builder.js";

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
const json = process.argv.includes("--json");

const connection = openDatabase({
  path: flag("--db", process.env.CRYPASTRA_DB_PATH ?? "data/research.db")!,
  runMigrations: true,
});
const sessions = new RecordingSessionRepository(connection);
const sessionId = flag("--session") ?? sessions.list(1)[0]?.id;
if (sessionId === undefined) {
  console.error("Tidak ada sesi rekaman di DB ini.");
  process.exit(1);
}
const session = sessions.find(sessionId);
if (session === null) {
  console.error(`Sesi ${sessionId} tidak ditemukan.`);
  process.exit(1);
}

const observations = new MarketObservationRepository(connection).list(sessionId, { limit: 1_000_000 });
const stats = new MarketObservationRepository(connection).stats(sessionId);
const contracts = [...new Set(observations.map((row) => row.observation.contract))].sort();
const snapshots = new FeatureSnapshotRepository(connection).list({ interval: "5m" });
const jev = new JevEvaluationRepository(connection);

const perContract = contracts.map((contract) => {
  const candles = observations
    .filter((row) => row.observation.contract === contract && row.observation.kind === "candle" && row.observation.closed)
    .map((row) => row.observation)
    .filter((observation) => observation.kind === "candle");
  const funding = observations.filter(
    (row) => row.observation.contract === contract && row.observation.kind === "funding",
  );
  const contractSnapshots = snapshots.filter((row) => row.contract === contract);
  const warmup = contractSnapshots.filter((row) => row.features.warmupComplete).length;
  const times = candles.map((candle) => candle.openTimeSeconds * 1000).sort((a, b) => a - b);
  return {
    contract,
    closedCandles5m: candles.length,
    ema200: candles.length >= 200 ? "READY" : "NOT_READY",
    postWarmupCandles: warmup,
    scannerCandidates: 0,
    jevCoverage: "0/0",
    fundingObservations: funding.length,
    fundingCoverage: funding.length > 0 ? "present" : "absent",
    firstCandleMs: times[0] ?? null,
    lastCandleMs: times.at(-1) ?? null,
    durationMs: stats.durationMs,
    gaps: times.length > 1 ? (times.at(-1)! - times[0]!) / 300_000 + 1 - times.length : 0,
  };
});

const dataset = new DatasetBuilder(connection).build(sessionId);
const candidates = dataset.rows;
for (const row of perContract) {
  row.scannerCandidates = candidates.filter((candidate) => candidate.contract === row.contract).length;
  const withJev = candidates.filter(
    (candidate) => candidate.contract === row.contract && candidate.candidateStatus === "complete",
  ).length;
  row.jevCoverage = `${withJev}/${row.scannerCandidates}`;
}

const coverage = {
  complete: candidates.filter((row) => row.candidateStatus === "complete").length,
  partial: candidates.filter((row) => row.candidateStatus === "partial").length,
  missing: candidates.filter((row) => row.candidateStatus === "missing").length,
  invalid: candidates.filter((row) => row.candidateStatus === "invalid").length,
  unavailable: candidates.filter((row) => row.candidateStatus === "unavailable").length,
};
const labelCoverage = LABEL_HORIZONS.map((horizon) => ({
  horizon,
  labeled: candidates.filter((row) =>
    row.labels?.horizonLabels.some((entry) => entry.horizon === horizon && entry.directionalReturn !== null),
  ).length,
}));
const labelStatus = {
  complete: candidates.filter((row) => row.labels?.status === "complete").length,
  incomplete: candidates.filter((row) => row.labels?.status === "incomplete").length,
  missing: candidates.filter((row) => row.labels === null).length,
};

function balance(target: (row: (typeof candidates)[number]) => 0 | 1 | null) {
  let positive = 0;
  let negative = 0;
  for (const row of candidates) {
    const value = target(row);
    if (value === 1) positive += 1;
    else if (value === 0) negative += 1;
  }
  return { positive, negative };
}
const classBalance = {
  trendTarget_h1: balance((row) => row.labels?.horizonLabels.find((e) => e.horizon === 1)?.trendTarget ?? null),
  momentumTarget_h1: balance((row) => row.labels?.horizonLabels.find((e) => e.horizon === 1)?.momentumTarget ?? null),
  reversalTarget_h1: balance((row) => row.labels?.horizonLabels.find((e) => e.horizon === 1)?.reversalTarget ?? null),
};

function buckets(evaluator: string) {
  const result = Array.from({ length: 10 }, (_, index) => ({ bucket: `${index / 10}-${(index + 1) / 10}`, count: 0, positiveRate: null as string | null }));
  const rows = jev.list({ limit: 100_000 }).filter((row) => row.evaluator === evaluator && row.probability !== null);
  for (const row of rows) {
    const value = Number(row.probability);
    const index = Math.min(9, Math.max(0, Math.floor(value * 10)));
    result[index]!.count += 1;
  }
  return result;
}

const report = {
  sessionId,
  status: session.status,
  durationMs: stats.durationMs,
  contracts,
  observations: { total: stats.total, byKind: stats.byKind },
  bytes: stats.bytes,
  perContract,
  candidates: candidates.length,
  jevCoverage: coverage,
  labelCoverage,
  labelStatus,
  labelVersion: OUTCOME_LABEL_VERSION,
  classBalance,
  probabilityBuckets: {
    trend_alignment: buckets("trend_alignment"),
    reversal_risk: buckets("reversal_risk"),
  },
  datasetHash: null as string | null,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Sesi         : ${sessionId} (${session.status})`);
  console.log(`Durasi       : ${Math.round(report.durationMs / 1000)}s   bytes=${stats.bytes}`);
  console.log(`Observasi    : ${stats.total} ${JSON.stringify(stats.byKind)}`);
  console.log(`Kandidat     : ${candidates.length}`);
  console.log(`Jev coverage : complete=${coverage.complete} partial=${coverage.partial} missing=${coverage.missing} invalid=${coverage.invalid} unavailable=${coverage.unavailable}`);
  console.log(`Label        : ${OUTCOME_LABEL_VERSION} complete=${labelStatus.complete} incomplete=${labelStatus.incomplete} missing=${labelStatus.missing}`);
  console.log("Per kontrak:");
  for (const row of perContract) {
    console.log(
      `  ${row.contract.padEnd(12)} candle5m=${String(row.closedCandles5m).padEnd(5)} EMA200=${row.ema200.padEnd(10)} ` +
        `post-warmup=${String(row.postWarmupCandles).padEnd(4)} kandidat=${String(row.scannerCandidates).padEnd(4)} ` +
        `jev=${row.jevCoverage.padEnd(7)} funding=${row.fundingCoverage} gaps=${row.gaps}`,
    );
  }
  console.log(`Class balance (h1): ${JSON.stringify(classBalance)}`);
  console.log("Bucket probabilitas (trend_alignment):");
  for (const bucket of report.probabilityBuckets.trend_alignment) {
    if (bucket.count > 0) console.log(`  ${bucket.bucket.padEnd(6)} ${bucket.count}`);
  }
  console.log("Catatan: laporan ini DESKRIPTIF; tidak ada rekomendasi ambang atau klaim kalibrasi.");
}

connection.close();
