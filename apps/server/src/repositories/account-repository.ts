import { Decimal } from "@crypastra/core";
import { asc, eq } from "drizzle-orm";
import { decodeMoney, encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { NotFoundError, ValidationError } from "../db/errors.js";
import { accountBalances, accounts, type AccountMode } from "../db/schema.js";
import { newId } from "./ids.js";
import type { CachedBalances } from "./ledger-repository.js";

export interface AccountRecord {
  readonly id: string;
  readonly name: string;
  readonly mode: AccountMode;
  readonly baseCurrency: string;
  readonly initialBalance: Decimal;
  readonly createdAt: number;
  readonly resetAt: number | null;
}

export interface CreateAccountInput {
  readonly name: string;
  readonly mode: AccountMode;
  readonly baseCurrency?: string;
  readonly initialBalance: Decimal | string;
  readonly createdAtMs: number;
  readonly id?: string;
}

/**
 * AccountRepository — akun paper, dan seed cache `account_balances`.
 *
 * Cache di-seed sama dengan `initial_balance` supaya akun baru langsung
 * konsisten dengan ledger kosong (invariant 1), tanpa perlu rebuild dulu.
 */
export class AccountRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  create(input: CreateAccountInput): AccountRecord {
    const id = input.id ?? newId();
    const initialBalance = input.initialBalance instanceof Decimal
      ? input.initialBalance
      : new Decimal(input.initialBalance);

    if (!initialBalance.isFinite() || initialBalance.isNegative()) {
      throw new ValidationError(
        `initialBalance harus desimal berhingga dan tidak negatif: ${initialBalance.toString()}`,
      );
    }
    if (input.name.trim() === "") {
      throw new ValidationError("name akun wajib diisi");
    }

    return this.#conn.transaction(() => {
      this.#conn.db
        .insert(accounts)
        .values({
          id,
          name: input.name,
          mode: input.mode,
          baseCurrency: input.baseCurrency ?? "USDT",
          initialBalance: encodeMoney(initialBalance),
          createdAt: input.createdAtMs,
          resetAt: null,
        })
        .run();

      const zero = encodeMoney(new Decimal(0));
      this.#conn.db
        .insert(accountBalances)
        .values({
          accountId: id,
          walletBalance: encodeMoney(initialBalance),
          usedMargin: zero,
          reservedMargin: zero,
          realizedPnl: zero,
          feesPaid: zero,
          fundingPaid: zero,
          updatedAt: input.createdAtMs,
        })
        .run();

      return {
        id,
        name: input.name,
        mode: input.mode,
        baseCurrency: input.baseCurrency ?? "USDT",
        initialBalance,
        createdAt: input.createdAtMs,
        resetAt: null,
      };
    });
  }

  find(id: string): AccountRecord | null {
    const row = this.#conn.db.select().from(accounts).where(eq(accounts.id, id)).get();
    return row === undefined ? null : mapAccountRow(row);
  }

  require(id: string): AccountRecord {
    const account = this.find(id);
    if (account === null) {
      throw new NotFoundError(`Akun tidak ditemukan: ${id}`);
    }
    return account;
  }

  list(): AccountRecord[] {
    return this.#conn.db.select().from(accounts).orderBy(asc(accounts.createdAt)).all().map(mapAccountRow);
  }

  /** Cache saldo apa adanya (tanpa rebuild). Bisa null bila cache belum ada. */
  getCachedBalances(id: string): CachedBalances | null {
    const row = this.#conn.db
      .select()
      .from(accountBalances)
      .where(eq(accountBalances.accountId, id))
      .get();
    if (row === undefined) {
      return null;
    }
    return {
      accountId: row.accountId,
      walletBalance: decodeMoney(row.walletBalance),
      usedMargin: decodeMoney(row.usedMargin),
      reservedMargin: decodeMoney(row.reservedMargin),
      realizedPnl: decodeMoney(row.realizedPnl),
      feesPaid: decodeMoney(row.feesPaid),
      fundingPaid: decodeMoney(row.fundingPaid),
      updatedAt: row.updatedAt,
    };
  }

  markReset(id: string, resetAtMs: number): void {
    this.#conn.db.update(accounts).set({ resetAt: resetAtMs }).where(eq(accounts.id, id)).run();
  }

  count(): number {
    return this.#conn.db.select({ id: accounts.id }).from(accounts).all().length;
  }
}

function mapAccountRow(row: typeof accounts.$inferSelect): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    baseCurrency: row.baseCurrency,
    initialBalance: decodeMoney(row.initialBalance),
    createdAt: row.createdAt,
    resetAt: row.resetAt,
  };
}
