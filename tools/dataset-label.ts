/**
 * Pelabelan hasil OFFLINE (Phase 13).
 *
 *   bun run dataset:label -- <sessionId> [--db <path>] [--json]
 *
 * Menurunkan label masa depan (`outcome-label-v1`) untuk setiap kandidat scanner
 * pada sebuah rekaman. Idempoten: kandidat yang sudah berlabel dilewati.
 * Label TIDAK pernah dikirim ke Jev.
 */
import { OUTCOME_LABEL_VERSION } from "@crypastra/core";
import { openDatabase } from "../apps/server/src/db/database.js";
import { OutcomeLabeler } from "../apps/server/src/research/outcome-labeler.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const json = args.includes("--json");
const sessionId = flag("--session") ?? args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--db");
if (sessionId === undefined) {
  console.error("Pemakaian: bun run dataset:label -- <sessionId> [--db <path>] [--json]");
  process.exit(1);
}

const connection = openDatabase({
  path: flag("--db") ?? process.env.CRYPASTRA_DB_PATH ?? "data/research.db",
  runMigrations: true,
});
const result = new OutcomeLabeler(connection).labelSession(sessionId, { nowMs: 0 });
const report = { sessionId, labelVersion: OUTCOME_LABEL_VERSION, ...result };

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Sesi          : ${sessionId}`);
  console.log(`Versi label   : ${OUTCOME_LABEL_VERSION}`);
  console.log(`Kandidat      : ${result.candidates}`);
  console.log(`Berlabel      : ${result.labeled} (lengkap) + ${result.incomplete} (incomplete)`);
  console.log(`Sudah berlabel: ${result.alreadyLabeled}`);
}
connection.close();
