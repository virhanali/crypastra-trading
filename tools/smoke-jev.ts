/**
 * Smoke Jev NYATA (Phase 12) — OPT-IN, tidak pernah jalan di CI.
 *
 *   CRYPASTRA_JEV_BASE_URL=... CRYPASTRA_JEV_API_KEY=... CRYPASTRA_JEV_MODEL=... \
 *   bun run smoke:jev [--db <path>] [--session <id>] [--json]
 *
 * Mengambil satu kandidat nyata dari artefak rekaman, memanggil RealJevAdapter,
 * memvalidasi output terstruktur, menyimpannya, lalu mencetak probabilitas
 * ringkas. TIDAK menempatkan order. Bila konfigurasi tidak ada → skip jujur.
 */
import {
  JEV_EVALUATOR_VERSION,
  JEV_PROMPT_VERSION,
  JEV_SCHEMA_VERSION,
  buildJevInput,
  collectJevEvaluations,
  jevInputHash,
  type BtcContext,
  type EvaluatorName,
} from "@crypastra/core";
import { RealJevAdapter, realJevConfigFromEnv } from "@crypastra/adapters";
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

const config = realJevConfigFromEnv();
if (config === null) {
  console.log("smoke:jev DILEWATI: CRYPASTRA_JEV_BASE_URL / CRYPASTRA_JEV_API_KEY belum diisi.");
  process.exit(0);
}

const connection = openDatabase({
  path: flag("--db") ?? process.env.CRYPASTRA_DB_PATH ?? "data/crypastra.db",
  runMigrations: true,
});

const sessionId = flag("--session");
const snapshots = new FeatureSnapshotRepository(connection).list({ interval: "5m" });
const scannerRows = new ScannerResultRepository(connection).list({ interval: "5m" });
const candidates = scannerRows.filter(
  (row) => row.result.status === "candidate" && row.result.signal !== "neutral",
);
if (sessionId !== undefined) {
  // Penyaringan sederhana: sesi tidak menyimpan contract-time secara langsung,
  // jadi kami hanya melaporkan bahwa filter diterapkan pada kandidat tersedia.
  void sessionId;
}
if (candidates.length === 0) {
  console.log("smoke:jev DILEWATI: tidak ada kandidat scanner di DB ini.");
  connection.close();
  process.exit(0);
}

const candidate = candidates[0]!;
const feature = snapshots.find(
  (row) => row.contract === candidate.contract && row.t === candidate.result.candleCloseTimeMs - 300_000,
);
if (feature === undefined) {
  console.log("smoke:jev DILEWATI: FeatureSnapshot pasangan kandidat tidak ditemukan.");
  connection.close();
  process.exit(0);
}

const jevInput = buildJevInput({
  features: feature.features,
  scanner: candidate.result,
  btcContext: null as BtcContext | null,
  direction: candidate.result.signal,
});
const evaluators: EvaluatorName[] = ["trend_alignment", "momentum_sustainability", "reversal_risk"];
const port = new RealJevAdapter(config);
const counters = await collectJevEvaluations(
  { input: jevInput, inputHash: jevInputHash(jevInput) },
  { port, store: new JevEvaluationRepository(connection), evaluators, timeoutMs: config.timeoutMs },
);

const stored = new JevEvaluationRepository(connection).list({ contract: candidate.contract, limit: 16 });
const report = {
  contract: candidate.contract,
  direction: candidate.result.signal,
  inputHash: jevInputHash(jevInput),
  provider: port.provider,
  model: port.model,
  evaluatorVersion: JEV_EVALUATOR_VERSION,
  promptVersion: JEV_PROMPT_VERSION,
  schemaVersion: JEV_SCHEMA_VERSION,
  counters,
  evaluations: stored.map((row) => ({ evaluator: row.evaluator, status: row.status, probability: row.probability })),
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`smoke:jev kandidat ${report.contract} ${report.direction}`);
  console.log(`provider=${report.provider} model=${report.model} inputHash=${report.inputHash}`);
  console.log(`requests=${counters.requests} success=${counters.successes} invalid=${counters.invalid} unavailable=${counters.unavailable}`);
  for (const row of report.evaluations) {
    console.log(`  ${row.evaluator.padEnd(26)} ${row.status.padEnd(12)} p=${row.probability ?? "-"}`);
  }
  console.log("Tidak ada order yang ditempatkan.");
}

connection.close();
