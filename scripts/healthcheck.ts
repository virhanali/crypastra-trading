/**
 * Health mechanism (bagian I): dipanggil dari HOST via `docker exec`, bukan
 * HTTP endpoint (recorder tidak membuka port). Exit 0 sehat, exit 1 tidak.
 *
 * Sehat berarti LEBIH dari "proses hidup":
 *   1. DB bisa dibuka (file readable, bukan corrupt).
 *   2. Ada sesi recording berstatus "recording".
 *   3. Observasi terbaru sesi itu tidak basi (default < 120s).
 *
 *   bun run scripts/healthcheck.ts [--max-staleness-ms 120000]
 */
import { Database } from "bun:sqlite";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const dbPath = process.env.CRYPASTRA_DB_PATH ?? "data/research.db";
const maxStalenessMs = Number.parseInt(flag("--max-staleness-ms", "120000"), 10);

function fail(reason: string): never {
  console.error(`UNHEALTHY: ${reason}`);
  process.exit(1);
}

let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch (error) {
  fail(`tidak bisa membuka DB ${dbPath}: ${(error as Error).message}`);
}

let session: { id: string; status: string; startedAt: number } | null;
try {
  session = db
    .query(
      "SELECT id, status, started_at as startedAt FROM market_recording_sessions WHERE status = 'recording' ORDER BY rowid DESC LIMIT 1",
    )
    .get() as typeof session;
} catch (error) {
  fail(`query sesi gagal (skema belum bermigrasi?): ${(error as Error).message}`);
}

if (session === null) {
  fail("tidak ada sesi recording aktif");
}

// ORDER BY ... LIMIT 1 (bukan max()): memakai indeks
// market_observations_session_observed_idx (migrasi 0013), O(log n).
// max() full-scan memblokir puluhan detik pada DB jutaan baris sehingga
// healthcheck timeout dan container salah dilaporkan unhealthy.
const lastObservation = db
  .query("SELECT observed_at_ms as lastMs FROM market_observations WHERE session_id = ? ORDER BY observed_at_ms DESC LIMIT 1")
  .get(session.id) as { lastMs: number | null } | undefined;

if (lastObservation?.lastMs == null) {
  fail(`sesi ${session.id} aktif tapi belum ada observasi sama sekali`);
}

const staleness = Date.now() - lastObservation.lastMs;
if (staleness > maxStalenessMs) {
  fail(
    `observasi terakhir sesi ${session.id} basi ${Math.round(staleness / 1000)}s ` +
      `(> ${Math.round(maxStalenessMs / 1000)}s) — recorder mungkin macet/disconnect`,
  );
}

console.log(
  `HEALTHY: sesi ${session.id} aktif, observasi terakhir ${Math.round(staleness / 1000)}s lalu`,
);
db.close();
process.exit(0);
