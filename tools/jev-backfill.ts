/**
 * Backfill evaluasi Jev (Phase 13) — OFFLINE, aman diulang.
 *
 *   bun run jev:backfill -- <sessionId> [--db <path>] [--contracts ...] [--json]
 *
 * Alur: rekaman → fitur/scanner deterministik → input hash kandidat → periksa
 * cache → ambil HANYA yang hilang → persist. Rekaman pasar lebih dulu, Jev
 * menyusul, tanpa kehilangan validitas eksperimen.
 */
import {
  buildJevInput,
  collectJevEvaluations,
  jevInputHash,
  type BtcContext,
  type EvaluatorName,
} from "@crypastra/core";
import { realJevConfigFromEnv, RealJevAdapter } from "@crypastra/adapters";
import { openDatabase } from "../apps/server/src/db/database.js";
import { FeatureSnapshotRepository } from "../apps/server/src/repositories/feature-snapshot-repository.js";
import { ScannerResultRepository } from "../apps/server/src/repositories/scanner-result-repository.js";
import { JevEvaluationRepository } from "../apps/server/src/repositories/jev-evaluation-repository.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const json = args.includes("--json");
const sessionId = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--db");
if (sessionId === undefined) {
  console.error("Pemakaian: bun run jev:backfill -- <sessionId> [--db <path>] [--json]");
  process.exit(1);
}

const config = realJevConfigFromEnv();
if (config === null) {
  console.log("jev:backfill DILEWATI: CRYPASTRA_JEV_BASE_URL / CRYPASTRA_JEV_API_KEY belum diisi.");
  process.exit(0);
}

const connection = openDatabase({
  path: flag("--db") ?? process.env.CRYPASTRA_DB_PATH ?? "data/research.db",
  runMigrations: true,
});
const snapshots = new FeatureSnapshotRepository(connection).list({ interval: "5m" });
const scannerRows = new ScannerResultRepository(connection)
  .list({ interval: "5m" })
  .filter((row) => row.result.status === "candidate" && row.result.signal !== "neutral");
const btcSnapshots = snapshots.filter((row) => row.contract === "BTC_USDT").sort((a, b) => a.t - b.t);
const store = new JevEvaluationRepository(connection);
const port = new RealJevAdapter(config);
const evaluators: EvaluatorName[] = ["trend_alignment", "momentum_sustainability", "reversal_risk"];

const totals = { candidates: 0, complete: 0, missing: 0, collected: 0, failed: 0, remaining: 0, skipped: 0 };
void sessionId;

for (const scannerRow of scannerRows) {
  const signal = scannerRow.result.signal;
  if (signal !== "long" && signal !== "short") continue;
  const feature = snapshots.find(
    (row) => row.contract === scannerRow.contract && row.t === scannerRow.result.candleCloseTimeMs - 300_000,
  );
  if (feature === undefined) continue;
  totals.candidates += 1;

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
    features: feature.features, scanner: scannerRow.result, btcContext, direction: signal,
  });
  const inputHash = jevInputHash(jevInput);

  // Aman diulang: evaluasi yang sudah tercache dilewati.
  const alreadyComplete = evaluators.every(
    (evaluator) =>
      store.find({
        inputHash, evaluator,
        evaluatorVersion: "jev-eval-v1", promptVersion: "jev-prompt-v1", schemaVersion: "jev-schema-v1",
        provider: port.provider, model: port.model,
      }) !== null,
  );
  if (alreadyComplete) {
    totals.complete += 1;
    totals.skipped += 1;
    continue;
  }
  totals.missing += 1;
  const counters = await collectJevEvaluations(
    { input: jevInput, inputHash },
    { port, store, evaluators, timeoutMs: config.timeoutMs },
  );
  totals.collected += counters.successes;
  totals.failed += counters.invalid + counters.unavailable;
  console.log(
    `[backfill] ${scannerRow.contract} ${scannerRow.result.candleCloseTimeMs} success=${counters.successes} invalid=${counters.invalid} unavailable=${counters.unavailable}`,
  );
}
totals.remaining = Math.max(0, totals.missing * evaluators.length - totals.collected - totals.failed);

if (json) {
  console.log(JSON.stringify(totals, null, 2));
} else {
  console.log(`Kandidat=${totals.candidates} sudahLengkap=${totals.complete} belumLengkap=${totals.missing}`);
  console.log(`Terkumpul=${totals.collected} gagal=${totals.failed} sisa=${totals.remaining}`);
}
connection.close();
