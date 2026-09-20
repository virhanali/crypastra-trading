import { z } from "zod";
import { Decimal, roundHalfUp, MONEY_DP } from "../money.js";

export const LedgerEntryTypeSchema = z.enum([
  "deposit",
  "withdrawal",
  "reset",
  "pnl_realized",
  "fee",
  "funding",
  "margin_lock",
  "margin_release",
  "liquidation_loss",
  "adjustment",
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

/** Semua tipe ini menggerakkan wallet_balance. margin_* hanya menggerakkan meta. */
export const WALLET_MOVING_TYPES: readonly LedgerEntryType[] = [
  "deposit",
  "withdrawal",
  "reset",
  "pnl_realized",
  "fee",
  "funding",
  "liquidation_loss",
  "adjustment",
];

export interface LedgerEntry {
  readonly seq: number;
  readonly accountId: string;
  readonly tsMs: number;
  readonly type: LedgerEntryType;
  /** Signed, dalam base currency. Positif = saldo bertambah. */
  readonly amount: string;
  readonly balanceAfter: string;
  readonly refType: "order" | "fill" | "position" | "funding_tick" | "admin" | null;
  readonly refId: string | null;
  readonly idempotencyKey: string;
  readonly meta: Record<string, unknown>;
}

export interface AppendInput {
  accountId: string;
  tsMs: number;
  type: LedgerEntryType;
  amount: Decimal.Value;
  refType?: LedgerEntry["refType"];
  refId?: string | null;
  idempotencyKey: string;
  meta?: Record<string, unknown>;
}

export interface AppendResult {
  readonly entry: LedgerEntry;
  readonly duplicate: boolean;
}

export interface RebuildResult {
  readonly walletBalance: Decimal;
  readonly usedMargin: Decimal;
  readonly mismatchSeq: number | null;
}

/**
 * Ledger append-only in-memory. Ini model referensi untuk akuntansi; versi
 * persisten (Phase 1) menulis baris yang sama ke SQLite tanpa UPDATE/DELETE.
 * Tidak ada operasi yang membalik entri: koreksi = entri `adjustment` baru.
 */
export class Ledger {
  readonly #initialBalance: Decimal;
  readonly #entries: LedgerEntry[] = [];
  #wallet: Decimal;
  #usedMargin = new Decimal(0);

  constructor(initialBalance: Decimal.Value) {
    this.#initialBalance = new Decimal(initialBalance);
    this.#wallet = new Decimal(initialBalance);
  }

  get walletBalance(): Decimal {
    return this.#wallet;
  }

  get usedMargin(): Decimal {
    return this.#usedMargin;
  }

  get initialBalance(): Decimal {
    return this.#initialBalance;
  }

  get entries(): readonly LedgerEntry[] {
    return this.#entries;
  }

  append(input: AppendInput): AppendResult {
    const existing = this.#entries.find((e) => e.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) {
      return { entry: existing, duplicate: true };
    }

    const amount = roundHalfUp(input.amount, MONEY_DP);
    if (WALLET_MOVING_TYPES.includes(input.type)) {
      this.#wallet = roundHalfUp(this.#wallet.plus(amount), MONEY_DP);
    }
    this.#applyMarginDelta(input.type, input.meta);

    const entry: LedgerEntry = {
      seq: this.#entries.length + 1,
      accountId: input.accountId,
      tsMs: input.tsMs,
      type: input.type,
      amount: amount.toFixed(MONEY_DP),
      balanceAfter: this.#wallet.toFixed(MONEY_DP),
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey,
      meta: input.meta ?? {},
    };
    this.#entries.push(entry);

    return { entry, duplicate: false };
  }

  #applyMarginDelta(type: LedgerEntryType, meta: Record<string, unknown> | undefined): void {
    const delta = meta?.marginDelta;
    if (typeof delta !== "string") {
      return;
    }
    if (type === "margin_lock") {
      this.#usedMargin = roundHalfUp(this.#usedMargin.plus(delta), MONEY_DP);
    } else if (type === "margin_release") {
      this.#usedMargin = roundHalfUp(this.#usedMargin.minus(delta), MONEY_DP);
    }
  }

  /**
   * Rebuild saldo dari ledger dan bandingkan dengan catatan `balanceAfter`.
   * Jalankan saat boot dan di test. Lihat docs/ACCOUNTING.md §9.
   */
  rebuild(): RebuildResult {
    let wallet = new Decimal(this.#initialBalance);
    let margin = new Decimal(0);

    for (const entry of this.#entries) {
      if (WALLET_MOVING_TYPES.includes(entry.type)) {
        wallet = roundHalfUp(wallet.plus(entry.amount), MONEY_DP);
      }
      const delta = entry.meta.marginDelta;
      if (typeof delta === "string") {
        if (entry.type === "margin_lock") {
          margin = roundHalfUp(margin.plus(delta), MONEY_DP);
        } else if (entry.type === "margin_release") {
          margin = roundHalfUp(margin.minus(delta), MONEY_DP);
        }
      }
      if (!wallet.eq(entry.balanceAfter)) {
        return { walletBalance: wallet, usedMargin: margin, mismatchSeq: entry.seq };
      }
    }

    if (!margin.eq(this.#usedMargin)) {
      return { walletBalance: wallet, usedMargin: margin, mismatchSeq: this.#entries.length };
    }

    return { walletBalance: wallet, usedMargin: margin, mismatchSeq: null };
  }
}