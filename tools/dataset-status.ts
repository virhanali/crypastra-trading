/**
 * Status & kualitas dataset (Phase 13.1) — OFFLINE, tanpa jaringan.
 *
 *   bun run dataset:status [--session <id>] [--db <path>] [--json] [--full]
 *
 * Mode DEFAULT (basic) sengaja MURAH: hanya agregat SQL berindeks +
 * query candle-only (ratusan baris). Tidak memuat jutaan observasi ke
 * memori, tidak membangun pipeline fitur/scanner/dataset. Target: selesai
 * dalam hitungan detik-menit di DB 1.5GB, bukan >20 menit.
 *
 * Mode --full menjalankan pipeline analitik lengkap (DatasetBuilder,
 * bucket probabilitas, class balance) seperti perilaku lama — lambat pada
 * DB besar, hanya bila dibutuhkan.
 */
import { analyzeCandleGaps, LABEL_HORIZONS, OUTCOME_LABEL_VERSION } from "@crypastra/core";
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
const full = process.argv.includes("--full");

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

const observations = new MarketObservationRepository(connection);

// ── Hitungan per (contract, kind): memakai indeks (session_id, kind, seq)
// sehingga hanya range-scan entri indeks (tanpa memuat payload JSON). ──
const counts = connection.sqlite
  .query(
    "SELECT contract, kind, count(*) as n FROM market_observations WHERE session_id = ? GROUP BY contract, kind",
  )
  .all(sessionId) as Array<{ contract: string; kind: string; n: number }>;
const total = counts.reduce((sum, row) => sum + row.n, 0);
const byKind: Record<string, number> = {};
for (const row of counts) {
  byKind[row.kind] = (byKind[row.kind] ?? 0) + row.n;
}
const contracts = [...new Set(counts.map((row) => row.contract))].sort();

// ── Candle-only query (ratusan baris): analisis gap per kontrak. ──
const candleRows = connection.sqlite
  .query(
    "SELECT contract, data_json as dataJson FROM market_observations WHERE session_id = ? AND kind = 'candle'",
  )
  .all(sessionId) as Array<{ contract: string; dataJson: string }>;
const closedByContract = new Map<string, number[]>();
for (const row of candleRows) {
  const candle = JSON.parse(row.dataJson) as { closed?: boolean; openTimeSeconds?: number };
  if (candle.closed === true && typeof candle.openTimeSeconds === "number") {
    const list = closedByContract.get(row.contract) ?? [];
    list.push(candle.openTimeSeconds);
    closedByContract.set(row.contract, list);
  }
}
const perContract = contracts.map((contract) => {
  const analysis = analyzeCandleGaps(closedByContract.get(contract) ?? [], 300);
  const funding = counts.find((row) => row.contract === contract && row.kind === "funding")?.n ?? 0;
  const times = [...(closedByContract.get(contract) ?? [])].sort((a, b) => a - b);
  return {
    contract,
    closedCandles5m: analysis.closedCandles,
    gapCount: analysis.gapCount,
    largestGapCandles: analysis.largestGapCandles,
    lastGapAtMs: analysis.lastGapAtSeconds === null ? null : analysis.lastGapAtSeconds * 1000,
    consecutiveClosedCandles: analysis.consecutiveTrailing,
    // Kesiapan riset JUJUR: 200 candle terakhir harus berurutan tanpa celah.
    ema200: analysis.ema200Ready ? "READY" : "NOT_READY",
    fundingObservations: funding,
    fundingCoverage: funding > 0 ? "present" : "absent",
    firstCandleMs: times[0] === undefined ? null : times[0] * 1000,
    lastCandleMs: times.length === 0 ? null : times[times.length - 1]! * 1000,
  };
});

// ── Estimasi storage (D): sampel kecil untuk rata-rata byte/baris. ──
const sample = connection.sqlite
  .query(
    "SELECT kind, avg(length(data_json)) as avgBytes, count(*) as n FROM (SELECT kind, data_json FROM market_observations WHERE session_id = ? LIMIT 2000) GROUP BY kind",
  )
  .all(sessionId) as Array<{ kind: string; avgBytes: number; n: number }>;
const avgByKind = new Map(sample.map((row) => [row.kind, row.avgBytes ?? 0]));
let estimatedBytes = 0;
const storageByKind: Record<string, { rows: number; estimatedBytes: number }> = {};
for (const [kind, n] of Object.entries(byKind)) {
  const bytes = Math.round(n * (avgByKind.get(kind) ?? 0));
  storageByKind[kind] = { rows: n, estimatedBytes: bytes };
  estimatedBytes += bytes;
}
const sessionMeta = session.metadata as Record<string, unknown>;
const lastObserved = connection.sqlite
  .query("SELECT max(observed_at_ms) as lastMs FROM market_observations WHERE session_id = ?")
  .get(sessionId) as { lastMs: number | null };
const endMs = session.endedAtMs ?? lastObserved.lastMs ?? session.startedAtMs;
const durationMs = Math.max(1, endMs - session.startedAtMs);
const obsPerSecond = total / (durationMs / 1000);
const projectedBytesPerDay = Math.round((estimatedBytes / (durationMs / 1000)) * 86_400);

const basicReport = {
  mode: "basic",
  sessionId,
  status: session.status,
  policy: sessionMeta["recordingPolicy"] ?? "full",
  policyVersion: sessionMeta["recordingPolicyVersion"] ?? 1,
  durationMs,
  observations: { total, byKind },
  storage: { estimatedBytes, byKind: storageByKind },
  rate: {
    observationsPerSecond: Math.round(obsPerSecond * 100) / 100,
    projectedBytesPerDay,
    projectedGbPerDay: Math.round((projectedBytesPerDay / 1_073_741_824) * 100) / 100,
  },
  perContract,
  note: "Angka storage adalah ESTIMASI dari sampel 2000 baris. Kandidat/label/bucket probabilitas hanya di --full.",
};

if (!full) {
  if (json) {
    console.log(JSON.stringify(basicReport, null, 2));
  } else {
    console.log(`Sesi         : ${sessionId} (${session.status})`);
    console.log(`Policy       : ${String(basicReport.policy)} v${String(basicReport.policyVersion)}`);
    console.log(`Durasi       : ${Math.round(durationMs / 1000)}s   ~bytes=${estimatedBytes}`);
    console.log(`Observasi    : ${total} ${JSON.stringify(byKind)}`);
    console.log(
      `Rate         : ${basicReport.rate.observationsPerSecond}/s   proyeksi ~${basicReport.rate.projectedGbPerDay} GB/hari`,
    );
    console.log("Per kontrak (gap-aware):");
    for (const row of perContract) {
      console.log(
        `  ${row.contract.padEnd(12)} candle5m=${String(row.closedCandles5m).padEnd(5)} ` +
          `konsekutif=${String(row.consecutiveClosedCandles).padEnd(5)} EMA200=${row.ema200.padEnd(10)} ` +
          `gap=${row.gapCount} (terbesar ${row.largestGapCandles}) funding=${row.fundingCoverage}`,
      );
    }
    console.log("Catatan: laporan BASIC; kandidat/label/bucket hanya di --full. Storage = estimasi sampel.");
  }
  connection.close();
  process.exit(0);
}

// ── Mode --full: pipeline analitik lengkap (perilaku lama, LAMBAT). ──
const fullObservations = new MarketObservationRepository(connection).list(sessionId, { limit: 1_000_000 });
const snapshots = new FeatureSnapshotRepository(connection).list({ interval: "5m" });
const jev = new JevEvaluationRepository(connection);

const dataset = new DatasetBuilder(connection).build(sessionId);
const candidates = dataset.rows;
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

const fullReport = {
  ...basicReport,
  mode: "full",
  contracts,
  observationRowsLoaded: fullObservations.length,
  bytes: 0,
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
  console.log(JSON.stringify(fullReport, null, 2));
} else {
  console.log(`Sesi         : ${sessionId} (${session.status}) [FULL]`);
  console.log(`Observasi    : ${total} (dimuat ${fullObservations.length}) ${JSON.stringify(byKind)}`);
  console.log(`Kandidat     : ${candidates.length}`);
  console.log(`Jev coverage : complete=${coverage.complete} partial=${coverage.partial} missing=${coverage.missing} invalid=${coverage.invalid} unavailable=${coverage.unavailable}`);
  console.log(`Label        : ${OUTCOME_LABEL_VERSION} complete=${labelStatus.complete} incomplete=${labelStatus.incomplete} missing=${labelStatus.missing}`);
  console.log("Per kontrak:");
  for (const row of perContract) {
    const rowCandidates = candidates.filter((candidate) => candidate.contract === row.contract).length;
    console.log(
      `  ${row.contract.padEnd(12)} candle5m=${String(row.closedCandles5m).padEnd(5)} EMA200=${row.ema200.padEnd(10)} ` +
        `konsekutif=${row.consecutiveClosedCandles} kandidat=${rowCandidates} funding=${row.fundingCoverage} gaps=${row.gapCount}`,
    );
  }
  console.log(`Class balance (h1): ${JSON.stringify(classBalance)}`);
  console.log("Bucket probabilitas (trend_alignment):");
  for (const bucket of fullReport.probabilityBuckets.trend_alignment) {
    if (bucket.count > 0) console.log(`  ${bucket.bucket.padEnd(6)} ${bucket.count}`);
  }
  console.log("Catatan: laporan ini DESKRIPTIF; tidak ada rekomendasi ambang atau klaim kalibrasi.");
}

connection.close();
