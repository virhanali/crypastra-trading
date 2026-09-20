import { z } from "zod";
import { Decimal } from "../money.js";
import { DecimalSchema, type ContractSpec } from "../contract.js";
import { assertValidPrice } from "./contract-math.js";
import { deriveAccount, maintenanceMarginFor, type AccountValuation } from "./margin.js";
import { unrealizedPnlFor } from "./pnl.js";
import { SimpleIsolatedLiquidationModel, type LiquidationModel } from "./liquidation.js";
import type { Direction } from "./types.js";

const ZERO = new Decimal(0);

/**
 * Valuasi mark-to-market. MURNI: tidak menyentuh DB, clock, atau jaringan.
 *
 * Pemisahan istilah (jangan pernah overload "balance"):
 *
 *   wallet_balance   = kas realisasi. Hanya berubah oleh deposit/withdrawal/fee/
 *                      funding/PnL realisasi. PnL belum realisasi TIDAK masuk sini.
 *   unrealized_pnl   = Σ PnL posisi terbuka pada MARK PRICE. Turunan, bukan saldo.
 *   equity           = wallet_balance + unrealized_pnl
 *   position_margin  = Σ margin awal posisi terbuka (terkunci)
 *   reserved_margin  = Σ reservasi order resting (terkunci)
 *   available_balance= floor8(wallet_balance − position_margin − reserved_margin)
 *
 * PENTING: `available_balance` TIDAK memasukkan unrealized PnL. Keuntungan yang
 * belum direalisasi bukan uang yang bisa dibelanjakan (kebijakan simulator,
 * lihat ADR 0008). Unrealized LOSS tetap memengaruhi `equity` dan `margin_ratio`,
 * dan itulah yang dipakai likuidasi.
 */

export const FundingObservationSchema = z
  .object({
    /** Rate periode berjalan, mis. "0.0001" atau "-0.00005". */
    fundingRate: DecimalSchema,
    /** Waktu settlement funding (epoch ms) yang diumumkan exchange. */
    fundingTimestampMs: z.number().int().nonnegative(),
    /** Panjang interval funding dalam detik (mis. 28800). */
    intervalSeconds: z.number().int().positive(),
  })
  .strict();

export type FundingObservation = z.infer<typeof FundingObservationSchema>;

export const MarkSnapshotSchema = z
  .object({
    contract: z.string().min(1),
    markPrice: DecimalSchema,
    /** Kapan snapshot ini diproses menurut Clock yang disuntik (epoch ms). */
    observedAtMs: z.number().int().nonnegative(),
    /** Timestamp dari sumber (exchange atau replay), epoch ms. */
    sourceTimestampMs: z.number().int().nonnegative(),
    /** Observasi funding; null bila tidak tersedia pada snapshot ini. */
    funding: FundingObservationSchema.nullable().default(null),
  })
  .strict();

export type MarkSnapshot = z.infer<typeof MarkSnapshotSchema>;

export function parseMarkSnapshot(value: unknown): MarkSnapshot {
  return MarkSnapshotSchema.parse(value);
}

export interface StalenessPolicy {
  /** Umur maksimum mark price yang masih dianggap segar (ms). */
  readonly maxStalenessMs: number;
}

export const DEFAULT_STALENESS_POLICY: StalenessPolicy = { maxStalenessMs: 5_000 };

export interface MarkFreshness {
  readonly ageMs: number;
  readonly stale: boolean;
}

/**
 * Umur dan kesegaran mark price.
 *
 * Timestamp sumber di MASA DEPAN (age negatif) diperlakukan stale: clock yang
 * tertinggal dari exchange membuat keputusan risiko tidak dapat dipercaya.
 */
export function markFreshness(
  snapshot: Pick<MarkSnapshot, "observedAtMs" | "sourceTimestampMs">,
  policy: StalenessPolicy = DEFAULT_STALENESS_POLICY,
): MarkFreshness {
  const ageMs = snapshot.observedAtMs - snapshot.sourceTimestampMs;
  return { ageMs, stale: ageMs < 0 || ageMs > policy.maxStalenessMs };
}

// ─────────────────────────────────────────────────────────────
// Valuasi posisi
// ─────────────────────────────────────────────────────────────

export type LiquidationState = "healthy" | "liquidatable" | "no_price";

export interface PositionValuationInput {
  readonly spec: ContractSpec;
  readonly position: {
    readonly id: string;
    readonly direction: Direction;
    readonly size: number;
    readonly entryPrice: Decimal.Value;
    readonly leverage: Decimal.Value;
    readonly initialMargin: Decimal.Value;
    readonly accumulatedFunding: Decimal.Value;
    readonly feesPaid: Decimal.Value;
  };
  readonly markPrice: Decimal.Value;
  readonly model?: LiquidationModel;
}

export interface PositionValuation {
  readonly positionId: string;
  readonly contract: string;
  readonly direction: Direction;
  readonly size: number;
  readonly entryPrice: Decimal;
  readonly markPrice: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly initialMargin: Decimal;
  readonly maintenanceMargin: Decimal;
  /** Harga likuidasi model, null bila model tidak menghasilkan harga. */
  readonly liquidationPrice: Decimal | null;
  readonly liquidationState: LiquidationState;
  readonly positionEquity: Decimal;
}

export function valuatePosition(input: PositionValuationInput): PositionValuation {
  const { spec, position } = input;
  const mark = assertValidPrice(input.markPrice, "Mark price");
  const model = input.model ?? new SimpleIsolatedLiquidationModel();

  const unrealizedPnl = unrealizedPnlFor(
    spec,
    position.direction,
    position.size,
    position.entryPrice,
    mark,
  );
  const initialMargin = new Decimal(position.initialMargin);
  const maintenanceMargin = maintenanceMarginFor(spec, position.size, mark);

  const liquidationInput = {
    spec,
    direction: position.direction,
    size: position.size,
    entryPrice: position.entryPrice,
    leverage: position.leverage,
  };
  const priceResult = model.calculateLiquidationPrice(liquidationInput);
  const evaluation = model.evaluate({
    ...liquidationInput,
    markPrice: mark,
    fundingPaid: position.accumulatedFunding,
    feesPaid: position.feesPaid,
  });

  return {
    positionId: position.id,
    contract: spec.contract,
    direction: position.direction,
    size: position.size,
    entryPrice: new Decimal(position.entryPrice),
    markPrice: mark,
    unrealizedPnl,
    initialMargin,
    maintenanceMargin,
    liquidationPrice: priceResult.kind === "price" ? priceResult.price : null,
    liquidationState: evaluation.liquidated
      ? "liquidatable"
      : priceResult.kind === "price"
        ? "healthy"
        : "no_price",
    positionEquity: evaluation.positionEquity,
  };
}

// ─────────────────────────────────────────────────────────────
// Valuasi akun
// ─────────────────────────────────────────────────────────────

export interface AccountValuationInput {
  /**
   * `positionMargin` = Σ margin awal posisi terbuka. Di tipe `AccountValuation`
   * Phase 2 field ini bernama `usedMargin`; keduanya hal yang sama.
   */
  readonly walletBalance: Decimal.Value;
  readonly positionMargin: Decimal.Value;
  readonly reservedMargin: Decimal.Value;
}

/**
 * Nilai akun dari kas + margin terkunci + PnL belum realisasi pada mark price.
 *
 * Delegasi ke `deriveAccount` (Phase 2) supaya hanya ada SATU implementasi
 * aritmatika akun:
 *
 *   equity            = wallet_balance + unrealized_pnl
 *   available_balance = floor8(wallet − position_margin − reserved_margin)
 *   margin_ratio      = position_margin / equity
 *
 * Unrealized PnL TIDAK masuk `available_balance` (kebijakan simulator, ADR 0008):
 * keuntungan belum realisasi bukan uang yang bisa dibelanjakan. Unrealized loss
 * tetap menurunkan `equity` dan menaikkan `margin_ratio`, dan itulah dasar
 * likuidasi.
 */
export function valuateAccount(
  account: AccountValuationInput,
  unrealizedPnl: Decimal.Value,
): AccountValuation {
  return deriveAccount(
    {
      walletBalance: account.walletBalance,
      usedMargin: account.positionMargin,
      reservedMargin: account.reservedMargin,
    },
    unrealizedPnl,
  );
}

/** Σ PnL belum realisasi dari beberapa valuasi posisi. */
export function totalUnrealized(positions: readonly Pick<PositionValuation, "unrealizedPnl">[]): Decimal {
  return positions.reduce((sum, position) => sum.plus(position.unrealizedPnl), ZERO);
}
