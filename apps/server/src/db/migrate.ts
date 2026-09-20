/**
 * Jalur eksekusi migrasi.
 *
 *   bun run db:migrate                 # pakai CRYPASTRA_DB_PATH atau data/crypastra.db
 *   CRYPASTRA_DB_PATH=/tmp/x.db bun run db:migrate
 *
 * Idempoten: migrasi yang sudah diterapkan dilacak di tabel `__drizzle_migrations`
 * oleh migrator Drizzle, jadi menjalankan ulang tidak mengubah skema/data.
 */
import { openDatabase } from "./database.js";
import { integrityReport } from "../repositories/integrity.js";

const connection = openDatabase({ runMigrations: true });

try {
  const report = integrityReport(connection);
  console.log(`migrasi selesai: ${connection.path}`);
  console.log(
    `tabel=${report.tableCount} akun=${report.accountCount} entri_ledger=${report.ledgerCount}`,
  );
  if (report.mismatches.length > 0) {
    console.error("INTEGRITY_ERROR:", JSON.stringify(report.mismatches, null, 2));
    process.exitCode = 1;
  }
} finally {
  connection.close();
}
