import {
  type AccountValuation,
  type ContractSpec,
  type Decimal,
  type Direction,
  type MarkSnapshot,
} from "@crypastra/core";
import { z } from "zod";
import { encodeDecimalString, encodeMoney } from "../db/decimal-codec.js";
import type { AccountRecord } from "../repositories/account-repository.js";
import type { FillRecord } from "../repositories/fill-repository.js";
import type { LedgerRecord } from "../repositories/ledger-repository.js";
import type { OrderRecord } from "../repositories/order-repository.js";
import type { PositionRecord } from "../repositories/position-repository.js";
import type { DomainEventRecord } from "../repositories/domain-event-repository.js";

/**
 * DTO publik + serialisasi.
 *
 * ATURAN KERAS: SEMUA nilai finansial keluar sebagai STRING. Tidak ada Decimal
 * yang diserahkan ke JSON.stringify, tidak ada `Number()`. `encodeMoney` untuk
 * uang (kanonik 8 dp) dan `encodeDecimalString` untuk harga/rate (nilai eksak).
 * Ditegakkan tests/phase5-money-serialization.test.ts.
 */

// ── Skema permintaan ─────────────────────────────────────────────

const CommandId = z.string().trim().min(1).max(200);

/**
 * Cacah kontrak: string desimal positif (mis. "1", "1.25").
 *
 * Validasi di sini HANYA sintaktis. Apakah komponen pecahan boleh adalah
 * aturan KONTRAK: `ContractSpec.enableDecimal=false` menolak pecahan, `true`
 * menerimanya (`assertValidSize` di OrderService). Karena itu DTO tidak boleh
 * menolak desimal lebih awal — kalau tidak, kontrak desimal mustahil dipakai.
 *
 * Koersi terjadi di zod (bukan di kode kita), setelah bentuknya divalidasi
 * ketat, jadi tidak ada perubahan nilai finansial yang diam-diam.
 */
const ContractCount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "size harus cacah kontrak desimal positif (string)")
  .transform((value, ctx) => {
    const parsed = z.coerce.number().finite().positive().safeParse(value);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "size harus cacah kontrak desimal positif" });
      return z.NEVER;
    }
    return parsed.data;
  });

/** Harga/rate datang sebagai string desimal; tidak ada koersi ke number. */
const DecimalString = z.string().trim().regex(/^-?\d+(\.\d+)?$/, "harus berupa string desimal");
const OptionalDecimalString = DecimalString.nullish();

export const AccountIdParam = z.object({ accountId: z.string().trim().min(1).max(200) });

export const CreateAccountRequestSchema = z
  .object({
    commandId: CommandId,
    name: z.string().trim().min(1).max(200),
    mode: z.enum(["live", "simulation", "replay"]).default("simulation"),
    baseCurrency: z.string().trim().min(1).max(20).default("USDT"),
    initialBalance: DecimalString,
  })
  .strict();
export type CreateAccountRequest = z.infer<typeof CreateAccountRequestSchema>;

export const DepositRequestSchema = z
  .object({
    commandId: CommandId,
    amount: DecimalString,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type DepositRequest = z.infer<typeof DepositRequestSchema>;

export const WithdrawRequestSchema = z
  .object({
    commandId: CommandId,
    amount: DecimalString,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;

export const ResetRequestSchema = z
  .object({
    commandId: CommandId,
    /** Saldo target setelah reseed. */
    balance: DecimalString,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ResetRequest = z.infer<typeof ResetRequestSchema>;

export const SubmitOrderRequestSchema = z
  .object({
    commandId: CommandId,
    contract: z.string().trim().min(1),
    /** Mengikuti domain: buy = long, sell = short. */
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit"]),
    size: ContractCount,
    leverage: DecimalString,
    limitPrice: OptionalDecimalString,
    takeProfitPrice: OptionalDecimalString,
    stopLossPrice: OptionalDecimalString,
    timeInForce: z.enum(["gtc", "ioc", "fok", "post_only"]).optional(),
    reduceOnly: z.boolean().optional(),
  })
  .strict();
export type SubmitOrderRequest = z.infer<typeof SubmitOrderRequestSchema>;

export const CancelOrderRequestSchema = z
  .object({ commandId: CommandId, reason: z.string().trim().max(200).optional() })
  .strict();
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;

export const EvaluateOrderRequestSchema = z
  .object({
    commandId: CommandId,
    /**
     * Harga eksekusi eksplisit. Bila dihilangkan, server memakai puncak buku
     * dari MarketSnapshotProvider.
     */
    bidPrice: DecimalString.optional(),
    askPrice: DecimalString.optional(),
  })
  .strict();
export type EvaluateOrderRequest = z.infer<typeof EvaluateOrderRequestSchema>;

export const ClosePositionRequestSchema = z
  .object({
    commandId: CommandId,
    bidPrice: DecimalString.optional(),
    askPrice: DecimalString.optional(),
    reason: z.enum(["manual"]).optional(),
  })
  .strict();
export type ClosePositionRequest = z.infer<typeof ClosePositionRequestSchema>;

export const AmendProtectionRequestSchema = z
  .object({
    commandId: CommandId,
    takeProfitPrice: OptionalDecimalString,
    stopLossPrice: OptionalDecimalString,
  })
  .strict();
export type AmendProtectionRequest = z.infer<typeof AmendProtectionRequestSchema>;

export const SimulationMarketRequestSchema = z
  .object({
    contract: z.string().trim().min(1),
    markPrice: DecimalString,
    bidPrice: DecimalString,
    askPrice: DecimalString,
    /** Opsional: menyertakan observasi funding pada snapshot. */
    fundingRate: DecimalString.optional(),
    fundingTimestampMs: z.number().int().nonnegative().optional(),
    fundingIntervalSeconds: z.number().int().positive().optional(),
    /** Timestamp sumber; default = waktu server. */
    sourceTimestampMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SimulationMarketRequest = z.infer<typeof SimulationMarketRequestSchema>;

/** Kursor `seq` numerik (untuk ledger & event outbox), dipecah oleh zod. */
const SeqCursor = z
  .string()
  .regex(/^\d+$/, "kursor seq harus string digit")
  .transform((value, ctx) => {
    const parsed = z.coerce.number().int().nonnegative().safeParse(value);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "kursor seq harus bilangan bulat >= 0" });
      return z.NEVER;
    }
    return parsed.data;
  });

/** Paginasi berbasis `seq` (ledger, event outbox). */
export const SeqPaginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    after: SeqCursor.optional(),
  })
  .strict();
export type SeqPaginationQuery = z.infer<typeof SeqPaginationQuerySchema>;

/** Paginasi berbasis id string (fill, riwayat posisi), urutan stabil. */
export const IdPaginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    after: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type IdPaginationQuery = z.infer<typeof IdPaginationQuerySchema>;

export const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    status: z.string().trim().min(1).optional(),
  })
  .strict();
export type ListQuery = z.infer<typeof ListQuerySchema>;

// ── Serialisasi ──────────────────────────────────────────────────

export function serializeAccount(account: AccountRecord) {
  return {
    accountId: account.id,
    name: account.name,
    mode: account.mode,
    baseCurrency: account.baseCurrency,
    initialBalance: encodeMoney(account.initialBalance),
    createdAt: account.createdAt,
    resetAt: account.resetAt,
  };
}

export function serializeValuation(valuation: AccountValuation) {
  return {
    walletBalance: encodeMoney(valuation.walletBalance),
    unrealizedPnl: encodeMoney(valuation.unrealizedPnl),
    equity: encodeMoney(valuation.equity),
    availableBalance: encodeMoney(valuation.availableBalance),
    reservedMargin: encodeMoney(valuation.reservedMargin),
    positionMargin: encodeMoney(valuation.usedMargin),
    marginRatio: valuation.marginRatio === null ? null : encodeMoney(valuation.marginRatio),
  };
}

export function serializeContract(spec: ContractSpec) {
  return {
    contract: spec.contract,
    base: spec.base,
    quote: spec.quote,
    quantoMultiplier: encodeDecimalString(spec.quantoMultiplier),
    orderSizeMin: spec.orderSizeMin,
    orderSizeMax: spec.orderSizeMax,
    enableDecimal: spec.enableDecimal,
    priceTick: encodeDecimalString(spec.orderPriceRound),
    markPriceTick: encodeDecimalString(spec.markPriceRound),
    leverageMin: encodeDecimalString(spec.leverageMin),
    leverageMax: encodeDecimalString(spec.leverageMax),
    maintenanceRate: encodeDecimalString(spec.maintenanceRate),
    makerFeeRate: encodeDecimalString(spec.makerFeeRate),
    takerFeeRate: encodeDecimalString(spec.takerFeeRate),
    fundingIntervalSeconds: spec.fundingIntervalSeconds,
    status: spec.status,
  };
}

export function serializeOrder(order: OrderRecord) {
  return {
    id: order.id,
    accountId: order.accountId,
    contract: order.contract,
    side: order.side,
    type: order.type,
    timeInForce: order.timeInForce,
    size: String(order.size),
    price: order.price === null ? null : encodeDecimalString(order.price),
    reduceOnly: order.reduceOnly,
    leverage: encodeDecimalString(order.leverage),
    status: order.status,
    rejectReason: order.rejectReason,
    filledSize: String(order.filledSize),
    remainingSize: String(order.size - order.filledSize),
    avgFillPrice: order.avgFillPrice === null ? null : encodeDecimalString(order.avgFillPrice),
    reservedMargin: encodeMoney(order.reservedMargin),
    takeProfitPrice: order.tpPrice === null ? null : encodeDecimalString(order.tpPrice),
    stopLossPrice: order.slPrice === null ? null : encodeDecimalString(order.slPrice),
    createdAt: order.createdAtMs,
    updatedAt: order.updatedAtMs,
  };
}

export function serializePosition(
  position: PositionRecord,
  valuation: {
    markPrice: Decimal;
    unrealizedPnl: Decimal;
    maintenanceMargin: Decimal;
    liquidationPrice: Decimal | null;
    liquidationState: string;
  } | null,
  valuationStatus: "fresh" | "stale" | "unvalued",
) {
  return {
    id: position.id,
    accountId: position.accountId,
    contract: position.contract,
    side: position.direction,
    status: position.status,
    size: String(position.size),
    leverage: encodeDecimalString(position.leverage),
    entryPrice: encodeDecimalString(position.entryPrice),
    markPrice: valuation === null ? null : encodeDecimalString(valuation.markPrice),
    initialMargin: encodeMoney(position.initialMargin),
    maintenanceMargin: valuation === null ? null : encodeMoney(valuation.maintenanceMargin),
    unrealizedPnl: valuation === null ? null : encodeMoney(valuation.unrealizedPnl),
    realizedPnl: encodeMoney(position.realizedPnl),
    accumulatedFunding: encodeMoney(position.accumulatedFunding),
    feesPaid: encodeMoney(position.feesPaid),
    liquidationPrice:
      valuation === null
        ? position.liquidationPrice === null
          ? null
          : encodeDecimalString(position.liquidationPrice)
        : valuation.liquidationPrice === null
          ? null
          : encodeDecimalString(valuation.liquidationPrice),
    liquidationState: valuation?.liquidationState ?? null,
    takeProfitPrice: position.tpPrice === null ? null : encodeDecimalString(position.tpPrice),
    stopLossPrice: position.slPrice === null ? null : encodeDecimalString(position.slPrice),
    openedAt: position.openedAtMs,
    closedAt: position.closedAtMs,
    closeReason: position.closeReason,
    valuationStatus,
  };
}

export function serializeFill(fill: FillRecord) {
  return {
    id: fill.id,
    orderId: fill.orderId,
    positionId: fill.positionId,
    contract: fill.contract,
    side: fill.side,
    size: String(fill.size),
    price: encodeDecimalString(fill.price),
    liquidity: fill.liquidity,
    fee: encodeMoney(fill.fee),
    feeRate: encodeDecimalString(fill.feeRate),
    feeAsset: fill.feeAsset,
    realizedPnl: encodeMoney(fill.realizedPnl),
    isLiquidation: fill.isLiquidation,
    isTpSl: fill.isTpSl,
    timestamp: fill.tsMs,
  };
}

export function serializeLedgerEntry(entry: LedgerRecord) {
  return {
    seq: entry.seq,
    type: entry.type,
    amount: encodeMoney(entry.amount),
    balanceAfter: encodeMoney(entry.balanceAfter),
    marginDelta: encodeMoney(entry.marginDelta),
    reservedDelta: encodeMoney(entry.reservedDelta),
    reference: { type: entry.refType, id: entry.refId },
    timestamp: entry.tsMs,
  };
}

export function serializeDomainEvent(event: DomainEventRecord) {
  return {
    seq: event.seq,
    type: event.type,
    accountId: event.accountId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    timestamp: event.tsMs,
    data: event.data,
  };
}

export function serializeMark(mark: MarkSnapshot) {
  return {
    contract: mark.contract,
    markPrice: encodeDecimalString(mark.markPrice),
    observedAt: mark.observedAtMs,
    sourceTimestamp: mark.sourceTimestampMs,
    funding:
      mark.funding === null
        ? null
        : {
            fundingRate: encodeDecimalString(mark.funding.fundingRate),
            fundingTimestamp: mark.funding.fundingTimestampMs,
            intervalSeconds: mark.funding.intervalSeconds,
          },
  };
}

/** Paginasi kursor generik untuk daftar yang sudah terurut stabil. */
export function paginate<T>(
  items: readonly T[],
  limit: number,
  keyOf: (item: T) => string,
): { items: T[]; nextCursor: string | null } {
  if (items.length <= limit) {
    return { items: [...items], nextCursor: null };
  }
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: last === undefined ? null : keyOf(last),
  };
}

/** Arah posisi dari sisi order (untuk dokumentasi DTO). */
export function directionOfSide(side: "buy" | "sell"): Direction {
  return side === "buy" ? "long" : "short";
}
