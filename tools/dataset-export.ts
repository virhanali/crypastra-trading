/**
 * Ekspor dataset riset (Phase 13) — OFFLINE, deterministik.
 *
 *   bun run dataset:export -- <sessionId> [--db <path>] [--out <file>] [--json]
 *
 * Menghasilkan JSONL (default) berisi konteks kandidat, probabilitas Jev, hasil
 * perlakuan, dan label masa depan. TIDAK memuat rahasia, akun, atau id DB.
 * Urutan kanonik → dua ekspor menghasilkan hash identik.
 */
import { buildDatasetDigest, datasetToJsonl } from "@crypastra/core";
import { openDatabase } from "../apps/server/src/db/database.js";
import { DatasetBuilder } from "../apps/server/src/research/dataset-builder.js";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const json = args.includes("--json");
const sessionId = flag("--session") ?? args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--db" && args[args.indexOf(arg) - 1] !== "--out");
if (sessionId === undefined) {
  console.error("Pemakaian: bun run dataset:export -- <sessionId> [--db <path>] [--out <file>] [--json]");
  process.exit(1);
}

const connection = openDatabase({
  path: flag("--db") ?? process.env.CRYPASTRA_DB_PATH ?? "data/research.db",
  runMigrations: true,
});
const built = new DatasetBuilder(connection).build(sessionId);
const digest = buildDatasetDigest(built.rows);
const jsonl = datasetToJsonl(built.rows);
const out = flag("--out");
if (out !== undefined) {
  writeFileSync(out, jsonl + "\n", "utf8");
}

const report = {
  sessionId,
  datasetVersion: built.rows[0]?.datasetVersion ?? "dataset-v1",
  candidates: built.candidates,
  missingSnapshots: built.missingSnapshots,
  rows: digest.rowCount,
  datasetHash: digest.combinedHash,
  contractDistribution: digest.contractDistribution,
  directionDistribution: digest.directionDistribution,
  treatmentDistribution: digest.treatmentDistribution,
  labelStatusDistribution: digest.labelStatusDistribution,
  output: out ?? null,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (out === undefined) {
  console.log(jsonl);
} else {
  console.log(`Sesi        : ${sessionId}`);
  console.log(`Baris       : ${report.rows} (kandidat=${report.candidates})`);
  console.log(`Hash dataset: ${report.datasetHash}`);
  console.log(`Kontrak     : ${JSON.stringify(report.contractDistribution)}`);
  console.log(`Arah        : ${JSON.stringify(report.directionDistribution)}`);
  console.log(`Perlakuan   : ${JSON.stringify(report.treatmentDistribution)}`);
  console.log(`Label       : ${JSON.stringify(report.labelStatusDistribution)}`);
  console.log(`Ditulis ke  : ${out}`);
}
connection.close();
