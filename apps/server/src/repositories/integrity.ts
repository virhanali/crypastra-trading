import { encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { accounts } from "../db/schema.js";
import { AccountRepository } from "./account-repository.js";
import { LedgerRepository, type BalanceMismatch } from "./ledger-repository.js";

export interface AccountIntegrity {
  readonly accountId: string;
  readonly ledgerEntries: number;
  readonly walletBalance: string;
  readonly cachedWalletBalance: string | null;
  readonly mismatch: BalanceMismatch | null;
  readonly cacheMatches: boolean;
}

export interface IntegrityReport {
  readonly tableCount: number;
  readonly accountCount: number;
  readonly ledgerCount: number;
  readonly mismatches: readonly AccountIntegrity[];
}

/**
 * Pemeriksaan integritas read-only: bandingkan cache `account_balances`
 * dengan hasil turunan ledger, dan periksa konsistensi rantai `balance_after`.
 * Tidak menulis apa pun.
 *
 * Dipakai saat boot (CLI migrasi) dan di test. Kalau ada masalah, konsumen
 * harus memperlakukan saldo sebagai tidak dapat dipercaya dan menjalankan
 * `rebuildBalances`, bukan menyajikan angka karangan.
 */
export function integrityReport(connection: DatabaseConnection): IntegrityReport {
  const ledgerRepo = new LedgerRepository(connection);
  const accountRepo = new AccountRepository(connection);
  const accountRows = connection.db.select({ id: accounts.id }).from(accounts).all();
  const mismatches: AccountIntegrity[] = [];
  let ledgerCount = 0;

  for (const account of accountRows) {
    const verified = ledgerRepo.verifyBalances(account.id);
    ledgerCount += verified.entryCount;
    const cached = accountRepo.getCachedBalances(account.id);

    if (verified.chainMismatch !== null || !verified.cacheMatches) {
      mismatches.push({
        accountId: account.id,
        ledgerEntries: verified.entryCount,
        walletBalance: encodeMoney(verified.balances.walletBalance),
        cachedWalletBalance: cached === null ? null : encodeMoney(cached.walletBalance),
        mismatch: verified.chainMismatch,
        cacheMatches: verified.cacheMatches,
      });
    }
  }

  return {
    tableCount: countTables(connection),
    accountCount: accountRows.length,
    ledgerCount,
    mismatches,
  };
}

function countTables(connection: DatabaseConnection): number {
  const rows = connection.sqlite
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all() as Array<{ name: string }>;
  return rows.length;
}
