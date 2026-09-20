import {
  Decimal,
  MONEY_DP,
  WALLET_MOVING_TYPES,
  roundHalfUp,
  type LedgerEntryType,
} from "@crypastra/core";
import { and, asc, eq, gt } from "drizzle-orm";
import { decodeMoney, encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { NotFoundError, ValidationError } from "../db/errors.js";
import { accountBalances, accounts, ledger } from "../db/schema.js";

const ZERO = new Decimal(0);

export interface CachedBalances {
  readonly accountId: string;
  readonly walletBalance: Decimal;
  readonly usedMargin: Decimal;
  readonly reservedMargin: Decimal;
  /** Kumulatif PnL realisasi. Positif = untung. */
  readonly realizedPnl: Decimal;
  /** Kumulatif BIAYA fee. Positif = trader membayar; rebate maker menurunkannya. */
  readonly feesPaid: Decimal;
  /** Kumulatif BIAYA funding. Positif = trader membayar. */
  readonly fundingPaid: Decimal;
  readonly updatedAt: number;
}

export interface LedgerRecord {
  readonly seq: number;
  readonly accountId: string;
  readonly tsMs: number;
  readonly type: LedgerEntryType;
  readonly amount: Decimal;
  readonly marginDelta: Decimal;
  readonly reservedDelta: Decimal;
  readonly balanceAfter: Decimal;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly idempotencyKey: string;
  readonly meta: Record<string, unknown>;
}

export interface AppendLedgerInput {
  readonly accountId: string;
  readonly tsMs: number;
  readonly type: LedgerEntryType;
  /** Delta wallet_balance. Default 0. */
  readonly amount?: Decimal | string;
  /** Delta used_margin. Default 0. Hanya untuk tipe margin_*. */
  readonly marginDelta?: Decimal | string;
  /** Delta reserved_margin. Default 0. */
  readonly reservedDelta?: Decimal | string;
  readonly refType?: string | null;
  readonly refId?: string | null;
  /** Wajib. Kunci idempotensi; submit ulang tidak boleh mengubah saldo. */
  readonly idempotencyKey: string;
  readonly meta?: Record<string, unknown>;
}

export interface AppendLedgerResult {
  readonly entry: LedgerRecord;
  readonly balances: CachedBalances;
  /** true = entri sudah ada; TIDAK ada mutasi finansial yang diulang. */
  readonly duplicate: boolean;
}

export interface BalanceMismatch {
  readonly seq: number;
  readonly expected: string;
  readonly actual: string;
}

export interface VerifiedBalances {
  /** Saldo hasil turunan ledger (bukan cache). */
  readonly balances: CachedBalances;
  /** Ketidakcocokan di dalam rantai ledger (`balance_after` vs hasil hitung). */
  readonly chainMismatch: BalanceMismatch | null;
  /** Apakah cache `account_balances` sama dengan hasil turunan ledger. */
  readonly cacheMatches: boolean;
  readonly entryCount: number;
}

interface AccountHeader {
  readonly initialBalance: Decimal;
  readonly createdAt: number;
}

/**
 * LedgerRepository — pemilik tunggal tabel `ledger` dan cache `account_balances`.
 *
 * Kontrak:
 *  - `ledger` append-only. Tidak ada UPDATE/DELETE, ditegakkan juga di level DB
 *    (trigger di migrasi 0001).
 *  - Setiap append TUNGGAL: entri ledger + update cache dalam satu transaksi.
 *  - `idempotencyKey` unik. Submit ulang mengembalikan entri lama, saldo tak berubah.
 *  - `rebuildBalances` menurunkan saldo dari ledger, bukan dari cache.
 */
export class LedgerRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  append(input: AppendLedgerInput): AppendLedgerResult {
    const amount = toDecimal(input.amount, "amount");
    const marginDelta = toDecimal(input.marginDelta, "marginDelta");
    const reservedDelta = toDecimal(input.reservedDelta, "reservedDelta");

    if (input.idempotencyKey.trim() === "") {
      throw new ValidationError("idempotencyKey wajib diisi");
    }
    if (!Number.isInteger(input.tsMs) || input.tsMs < 0) {
      throw new ValidationError(`tsMs harus epoch milidetik integer, dapat: ${input.tsMs}`);
    }
    if (!WALLET_MOVING_TYPES.includes(input.type) && !amount.isZero()) {
      // Menjaga invariant 1: Σ amount (tipe penggerak wallet) == wallet_balance.
      throw new ValidationError(
        `Tipe ${input.type} tidak boleh mengubah wallet_balance, tapi amount=${amount.toString()}`,
      );
    }
    if (
      !marginDelta.isZero() &&
      input.type !== "margin_lock" &&
      input.type !== "margin_release"
    ) {
      throw new ValidationError(
        `marginDelta hanya untuk margin_lock/margin_release, bukan ${input.type}`,
      );
    }

    return this.#conn.transaction(() => {
      const account = this.#accountHeader(input.accountId);
      if (account === null) {
        throw new NotFoundError(`Akun tidak ditemukan: ${input.accountId}`);
      }

      // Idempotensi dicek di dalam transaksi IMMEDIATE: tidak ada balapan baca-tulis.
      const existing = this.#conn.db
        .select()
        .from(ledger)
        .where(eq(ledger.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing !== undefined) {
        return {
          entry: mapLedgerRow(existing),
          balances: this.#readBalances(input.accountId, account.initialBalance),
          duplicate: true,
        };
      }

      const current = this.#readBalances(input.accountId, account.initialBalance);
      const walletMoving = WALLET_MOVING_TYPES.includes(input.type);

      const balances: CachedBalances = {
        accountId: input.accountId,
        walletBalance: walletMoving
          ? roundHalfUp(current.walletBalance.plus(amount), MONEY_DP)
          : current.walletBalance,
        usedMargin: roundHalfUp(current.usedMargin.plus(marginDelta), MONEY_DP),
        reservedMargin: roundHalfUp(current.reservedMargin.plus(reservedDelta), MONEY_DP),
        realizedPnl:
          input.type === "pnl_realized"
            ? roundHalfUp(current.realizedPnl.plus(amount), MONEY_DP)
            : current.realizedPnl,
        feesPaid:
          input.type === "fee"
            ? roundHalfUp(current.feesPaid.minus(amount), MONEY_DP)
            : current.feesPaid,
        fundingPaid:
          input.type === "funding"
            ? roundHalfUp(current.fundingPaid.minus(amount), MONEY_DP)
            : current.fundingPaid,
        updatedAt: input.tsMs,
      };

      const inserted = this.#conn.db
        .insert(ledger)
        .values({
          accountId: input.accountId,
          ts: input.tsMs,
          type: input.type,
          amount: encodeMoney(amount),
          marginDelta: encodeMoney(marginDelta),
          reservedDelta: encodeMoney(reservedDelta),
          balanceAfter: encodeMoney(balances.walletBalance),
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          idempotencyKey: input.idempotencyKey,
          metaJson: JSON.stringify(input.meta ?? {}),
        })
        .returning()
        .get();

      this.#writeBalances(balances);

      return { entry: mapLedgerRow(inserted), balances, duplicate: false };
    });
  }

  list(accountId: string, options: { afterSeq?: number; limit?: number } = {}): LedgerRecord[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 1000;
    return this.#conn.db
      .select()
      .from(ledger)
      .where(
        afterSeq > 0
          ? and(eq(ledger.accountId, accountId), gt(ledger.seq, afterSeq))
          : eq(ledger.accountId, accountId),
      )
      .orderBy(asc(ledger.seq))
      .limit(limit)
      .all()
      .map(mapLedgerRow);
  }

  balances(accountId: string): CachedBalances {
    const account = this.#requireAccountHeader(accountId);
    return this.#readBalances(accountId, account.initialBalance);
  }

  /** Hitung saldo dari ledger TANPA menulis apa pun. Untuk pemeriksaan integritas. */
  verifyBalances(accountId: string): VerifiedBalances {
    return this.#computeBalances(accountId);
  }

  /**
   * Turunkan saldo dari ledger dan PERBAIKI cache.
   * Tidak membaca cache sama sekali — hanya `accounts.initial_balance` sebagai
   * titik awal. Deterministik: ledger yang sama selalu menghasilkan saldo sama.
   */
  rebuildBalances(accountId: string): VerifiedBalances {
    return this.#conn.transaction(() => {
      const result = this.#computeBalances(accountId);
      this.#writeBalances(result.balances);
      return result;
    });
  }

  #computeBalances(accountId: string): VerifiedBalances {
    const account = this.#requireAccountHeader(accountId);
    const rows = this.#conn.db
      .select()
      .from(ledger)
      .where(eq(ledger.accountId, accountId))
      .orderBy(asc(ledger.seq))
      .all();

    let wallet = new Decimal(account.initialBalance);
    let usedMargin = ZERO;
    let reservedMargin = ZERO;
    let realizedPnl = ZERO;
    let feesPaid = ZERO;
    let fundingPaid = ZERO;
    let chainMismatch: BalanceMismatch | null = null;

    for (const row of rows) {
      const amount = decodeMoney(row.amount);
      if (WALLET_MOVING_TYPES.includes(row.type)) {
        wallet = roundHalfUp(wallet.plus(amount), MONEY_DP);
      }
      usedMargin = roundHalfUp(usedMargin.plus(decodeMoney(row.marginDelta)), MONEY_DP);
      reservedMargin = roundHalfUp(reservedMargin.plus(decodeMoney(row.reservedDelta)), MONEY_DP);
      if (row.type === "pnl_realized") {
        realizedPnl = roundHalfUp(realizedPnl.plus(amount), MONEY_DP);
      }
      if (row.type === "fee") {
        feesPaid = roundHalfUp(feesPaid.minus(amount), MONEY_DP);
      }
      if (row.type === "funding") {
        fundingPaid = roundHalfUp(fundingPaid.minus(amount), MONEY_DP);
      }

      const recorded = decodeMoney(row.balanceAfter);
      if (chainMismatch === null && !wallet.eq(recorded)) {
        chainMismatch = {
          seq: row.seq,
          expected: recorded.toString(),
          actual: wallet.toString(),
        };
      }
    }

    const balances: CachedBalances = {
      accountId,
      walletBalance: wallet,
      usedMargin,
      reservedMargin,
      realizedPnl,
      feesPaid,
      fundingPaid,
      updatedAt: rows.at(-1)?.ts ?? account.createdAt,
    };

    const cached = this.#readBalances(accountId, account.initialBalance);
    const cacheMatches =
      cached.walletBalance.eq(balances.walletBalance) &&
      cached.usedMargin.eq(balances.usedMargin) &&
      cached.reservedMargin.eq(balances.reservedMargin) &&
      cached.realizedPnl.eq(balances.realizedPnl) &&
      cached.feesPaid.eq(balances.feesPaid) &&
      cached.fundingPaid.eq(balances.fundingPaid);

    return { balances, chainMismatch, cacheMatches, entryCount: rows.length };
  }

  #writeBalances(balances: CachedBalances): void {
    this.#conn.db
      .update(accountBalances)
      .set({
        walletBalance: encodeMoney(balances.walletBalance),
        usedMargin: encodeMoney(balances.usedMargin),
        reservedMargin: encodeMoney(balances.reservedMargin),
        realizedPnl: encodeMoney(balances.realizedPnl),
        feesPaid: encodeMoney(balances.feesPaid),
        fundingPaid: encodeMoney(balances.fundingPaid),
        updatedAt: balances.updatedAt,
      })
      .where(eq(accountBalances.accountId, balances.accountId))
      .run();
  }

  #requireAccountHeader(accountId: string): AccountHeader {
    const account = this.#accountHeader(accountId);
    if (account === null) {
      throw new NotFoundError(`Akun tidak ditemukan: ${accountId}`);
    }
    return account;
  }

  #accountHeader(accountId: string): AccountHeader | null {
    const row = this.#conn.db
      .select({
        initialBalance: accounts.initialBalance,
        createdAt: accounts.createdAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();
    return row === undefined
      ? null
      : { initialBalance: decodeMoney(row.initialBalance), createdAt: row.createdAt };
  }

  /**
   * Baca cache; bila belum ada, bentuk dari initial_balance.
   * Cache adalah turunan, jadi ketiadaannya pulih sendiri, bukan error.
   */
  #readBalances(accountId: string, initialBalance: Decimal): CachedBalances {
    const row = this.#conn.db
      .select()
      .from(accountBalances)
      .where(eq(accountBalances.accountId, accountId))
      .get();
    if (row !== undefined) {
      return mapBalanceRow(row);
    }
    return {
      accountId,
      walletBalance: initialBalance,
      usedMargin: ZERO,
      reservedMargin: ZERO,
      realizedPnl: ZERO,
      feesPaid: ZERO,
      fundingPaid: ZERO,
      updatedAt: 0,
    };
  }
}

function toDecimal(value: Decimal | string | undefined, label: string): Decimal {
  if (value === undefined) {
    return ZERO;
  }
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  if (!decimal.isFinite()) {
    throw new ValidationError(`${label} harus nilai desimal berhingga`);
  }
  return decimal;
}

function mapLedgerRow(row: typeof ledger.$inferSelect): LedgerRecord {
  return {
    seq: row.seq,
    accountId: row.accountId,
    tsMs: row.ts,
    type: row.type,
    amount: decodeMoney(row.amount),
    marginDelta: decodeMoney(row.marginDelta),
    reservedDelta: decodeMoney(row.reservedDelta),
    balanceAfter: decodeMoney(row.balanceAfter),
    refType: row.refType,
    refId: row.refId,
    idempotencyKey: row.idempotencyKey,
    meta: parseMeta(row.metaJson),
  };
}

function mapBalanceRow(row: typeof accountBalances.$inferSelect): CachedBalances {
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

function parseMeta(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("meta_json ledger harus berupa objek JSON");
  }
  return parsed as Record<string, unknown>;
}
