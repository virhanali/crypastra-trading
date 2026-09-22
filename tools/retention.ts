/**
 * Laporan retensi DRY-RUN (Phase 13.1 §E) — OFFLINE, tanpa jaringan.
 *
 *   bun run retention [--db <path>] [--json] [--delete <sessionId> --yes]
 *
 * Default: hanya MELAPORKAN. Tidak ada penghapusan otomatis, tidak ada
 * penghapusan diam-diam. Flag --delete saat ini DITOLAK eksplisit karena
 * jalur purge (docs/REPLAY.md §Retensi) belum diimplementasikan dan trigger
 * append-only database menolak DELETE — kegagalan fail-closed, bukan
 * penghapusan setengah jalan.
 *
 * Untuk tiap sesi dilaporkan:
 * - status, policy, durasi, jumlah observasi, estimasi byte
 * - apakah sesi punya riwayat candle UNIK (tidak tercakup sesi lain)
 * - apakah (contract, t) sesi dirujuk feature/scanner/jev/treatment/label
 */
import { openDatabase } from "../apps/server/src/db/database.js";
import { RecordingSessionRepository } from "../apps/server/src/repositories/market-observation-repository.js";

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
const json = process.argv.includes("--json");
const deleteId = flag("--delete");

if (deleteId !== undefined && !process.argv.includes("--yes")) {
  console.error("Menolak: penghapusan butuh --delete <id> --yes eksplisit. Tanpa --yes, ini dry-run.");
  process.exit(2);
}
if (deleteId !== undefined) {
  console.error(
    `Menolak menghapus sesi ${deleteId}: jalur purge belum diimplementasikan ` +
      `(docs/REPLAY.md §Retensi) dan trigger append-only database menolak DELETE. ` +
      "Tidak ada yang dihapus.",
  );
  process.exit(3);
}

const connection = openDatabase({
  path: flag("--db", process.env.CRYPASTRA_DB_PATH ?? "data/research.db")!,
  runMigrations: true,
});
const sessions = new RecordingSessionRepository(connection);
const list = sessions.list(500);

interface SessionReport {
  id: string;
  status: string;
  policy: string;
  contracts: readonly string[];
  observations: number;
  estimatedBytes: number;
  uniqueCandles: number;
  referencedBy: Record<string, number>;
  deletable: boolean;
  reason: string;
}

const reports: SessionReport[] = [];

// Kunci candle tertutup SEMUA sesi dalam sekali jalan (candle-only, kecil):
// unik = kunci yang hitungannya tepat 1 di seluruh DB dan milik sesi ini.
const allCandleRows = connection.sqlite
  .query("SELECT session_id as sessionId, contract, data_json as dataJson FROM market_observations WHERE kind = 'candle'")
  .all() as Array<{ sessionId: string; contract: string; dataJson: string }>;
const keyCounts = new Map<string, number>();
const keysBySession = new Map<string, Map<string, number>>();
for (const row of allCandleRows) {
  const candle = JSON.parse(row.dataJson) as { closed?: boolean; openTimeSeconds?: number };
  if (candle.closed !== true || typeof candle.openTimeSeconds !== "number") continue;
  const key = `${row.contract}:${candle.openTimeSeconds}`;
  keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  const perSession = keysBySession.get(row.sessionId) ?? new Map<string, number>();
  perSession.set(key, candle.openTimeSeconds);
  keysBySession.set(row.sessionId, perSession);
}

for (const session of list) {
  const obs = connection.sqlite
    .query("SELECT count(*) as n FROM market_observations WHERE session_id = ?")
    .get(session.id) as { n: number };

  // Estimasi byte via sampel (hindari sum() full-scan pada sesi jutaan baris).
  const sample = connection.sqlite
    .query("SELECT avg(length(data_json)) as avg FROM (SELECT data_json FROM market_observations WHERE session_id = ? LIMIT 500)")
    .get(session.id) as { avg: number | null };
  const estimatedBytes = Math.round(obs.n * (sample.avg ?? 0));

  const ownKeys = keysBySession.get(session.id) ?? new Map<string, number>();
  let uniqueCandles = 0;
  const referencedBy: Record<string, number> = {
    featureSnapshots: 0,
    scannerResults: 0,
    jevEvaluations: 0,
    treatmentResults: 0,
    outcomeLabels: 0,
  };
  for (const [key, tSeconds] of ownKeys) {
    if (keyCounts.get(key) === 1) uniqueCandles += 1;
    const contract = key.slice(0, key.lastIndexOf(":"));
    const tMs = tSeconds * 1000;
    // Rujukan (contract, t) di tabel turunan — semuanya berindeks (contract, t).
    // t turunan memakai MILISECOND (candleCloseTimeMs / feature t); cocokkan keduanya.
    for (const [table, outKey] of [
      ["feature_snapshots", "featureSnapshots"],
      ["scanner_results", "scannerResults"],
      ["jev_evaluations", "jevEvaluations"],
      ["treatment_results", "treatmentResults"],
      ["candidate_outcome_labels", "outcomeLabels"],
    ] as const) {
      const ref = connection.sqlite
        .query(`SELECT count(*) as n FROM ${table} WHERE contract = ? AND (t = ? OR t = ?)`)
        .get(contract, tMs, tSeconds) as { n: number };
      referencedBy[outKey]! += ref.n;
    }
  }

  const totalRefs = Object.values(referencedBy).reduce((a, b) => a + b, 0);
  const meta = session.metadata as Record<string, unknown>;
  const deletable = session.status !== "recording" && uniqueCandles === 0 && totalRefs === 0;
  const reason =
    session.status === "recording"
      ? "sesi masih recording (jangan hapus sesi aktif)"
      : uniqueCandles > 0
        ? `${uniqueCandles} candle unik tidak tercakup sesi lain`
        : totalRefs > 0
          ? `${totalRefs} baris turunan (feature/scanner/jev/label) merujuk waktu sesi ini`
          : "tidak dirujuk apa pun";
  reports.push({
    id: session.id,
    status: session.status,
    policy: String(meta["recordingPolicy"] ?? "full"),
    contracts: session.contracts,
    observations: obs.n,
    estimatedBytes,
    uniqueCandles,
    referencedBy,
    deletable,
    reason,
  });
}

if (json) {
  console.log(JSON.stringify({ sessions: reports }, null, 2));
} else {
  console.log("RETENTION DRY-RUN — tidak ada yang dihapus.");
  for (const report of reports) {
    console.log(
      `  ${report.id.slice(0, 8)} ${report.status.padEnd(10)} policy=${report.policy.padEnd(15)} ` +
        `obs=${report.observations} ~bytes=${report.estimatedBytes} unik=${report.uniqueCandles} ` +
        `ref=${Object.values(report.referencedBy).reduce((a, b) => a + b, 0)} ` +
        `hapus?=${report.deletable ? "YA" : "TIDAK"} (${report.reason})`,
    );
  }
}

connection.close();
