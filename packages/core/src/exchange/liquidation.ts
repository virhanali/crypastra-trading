import { InvalidSizeError } from "../errors.js";
import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import {
  assertValidLeverage,
  assertValidMaintenanceRate,
  assertValidPrice,
  baseQuantityFor,
  directionSign,
} from "./contract-math.js";
import { maintenanceMarginFor } from "./margin.js";
import { quantizeLiquidationPrice, roundMarginUp, roundMoneyNeutral } from "./rounding.js";
import type { Direction } from "./types.js";

/**
 * Likuidasi berada di belakang batas MODEL eksplisit.
 *
 * PENTING (A6): perilaku likuidasi Gate.io BELUM terverifikasi. Formula di sini
 * adalah model simulator internal, BUKAN replika Gate.io, dan tidak boleh
 * disebut sebagai "formula likuidasi Gate.io". Lihat ADR 0006.
 */

export interface IsolatedLiquidationInput {
  readonly spec: ContractSpec;
  readonly direction: Direction;
  readonly size: number;
  readonly entryPrice: Decimal.Value;
  readonly leverage: Decimal.Value;
}

/** Keadaan posisi yang sah tapi degenerate: tidak ada harga likuidasi bermakna. */
export type NoLiquidationReason =
  /** Initial margin ≤ maintenance margin: posisi sudah melanggar maintenance sejak dibuka. */
  | "initial_margin_not_above_maintenance";

export type LiquidationPriceResult =
  | {
      readonly kind: "price";
      readonly price: Decimal;
      /** Jarak harga per unit base asset antara entry dan likuidasi. */
      readonly distancePerUnit: Decimal;
    }
  | { readonly kind: "no_price"; readonly reason: NoLiquidationReason };

export interface LiquidationEvaluationInput extends IsolatedLiquidationInput {
  readonly markPrice: Decimal.Value;
  /** Biaya funding kumulatif yang sudah dibayar trader (≥0 = biaya). */
  readonly fundingPaid?: Decimal.Value;
  /** Fee kumulatif yang sudah dibayar trader (≥0 = biaya). */
  readonly feesPaid?: Decimal.Value;
}

export interface LiquidationEvaluation {
  readonly liquidated: boolean;
  readonly positionEquity: Decimal;
  readonly maintenanceMargin: Decimal;
}

export interface LiquidationCloseInput extends IsolatedLiquidationInput {
  readonly exitPrice: Decimal.Value;
  readonly fundingPaid?: Decimal.Value;
  readonly feesPaid?: Decimal.Value;
  readonly liquidationFee?: Decimal.Value;
}

export interface LiquidationCloseOutcome {
  readonly realizedPnl: Decimal;
  /** Delta dompet yang dikembalikan. Tidak pernah negatif untuk posisi isolated. */
  readonly walletDelta: Decimal;
  /** true bila kerugian mentah melebihi margin posisi (butuh audit). */
  readonly insolvent: boolean;
}

export interface LiquidationModel {
  readonly id: string;
  /** Selalu "simulator": model ini tidak mengklaim semantik exchange riil. */
  readonly provenance: "simulator";
  calculateLiquidationPrice(input: IsolatedLiquidationInput): LiquidationPriceResult;
  evaluate(input: LiquidationEvaluationInput): LiquidationEvaluation;
  settleClose(input: LiquidationCloseInput): LiquidationCloseOutcome;
}

/**
 * Model isolated sederhana:
 *
 *   notional_entry = size × quanto_multiplier × entry_price
 *   initial_margin = ceil8(notional_entry / leverage)          ← conserv. ke atas
 *   maintenance    = notional(mark) × maintenance_rate         ← conserv. ke atas
 *   buffer         = initial_margin − maintenance(at entry)
 *   distance/unit  = buffer / (size × quanto_multiplier)
 *   liq_long       = entry − distance        (di bawah entry)
 *   liq_short      = entry + distance        (di atas entry)
 *
 * Domain sah: `buffer > 0`, yaitu `1/leverage > maintenance_rate`.
 * Untuk 997 kontrak USDT Gate.io (probe 20 Sep 2026), `1/leverage_max −
 * maintenance_rate` selalu > 0 (minimum 0.002), jadi pada leverage yang diizinkan
 * kontrak, buffer selalu positif dan harga likuidasi selalu ada.
 *
 * Asumsi (belum terverifikasi terhadap Gate.io):
 *  - maintenance dihitung dari harga entry saat menurunkan harga likuidasi
 *  - tidak memperhitungkan fee taker penutup dalam rumus harga likuidasi
 *  - MMR tunggal, bukan berjenjang (risk_limit tier)
 *  - tidak ada komponen funding dalam rumus harga likuidasi
 */
export class SimpleIsolatedLiquidationModel implements LiquidationModel {
  readonly id = "simple-isolated-v1";
  readonly provenance = "simulator" as const;

  calculateLiquidationPrice(input: IsolatedLiquidationInput): LiquidationPriceResult {
    const { spec, direction, size, entryPrice } = input;
    const lev = assertValidLeverage(spec, input.leverage);
    assertValidMaintenanceRate(spec);
    const entry = assertValidPrice(entryPrice, "Harga entry");
    if (!Number.isFinite(size) || size <= 0) {
      throw new InvalidSizeError(`Size harus positif, dapat: ${size}`);
    }

    // Selftest internal (dipakai maintenanceMarginFor juga).
    const quantity = baseQuantityFor(spec, size);
    const initialMargin = roundMarginUp(notionalAtEntry(spec, size, entry).div(lev));
    const maintenanceAtEntry = roundMarginUp(
      notionalAtEntry(spec, size, entry).times(spec.maintenanceRate),
    );
    const buffer = initialMargin.minus(maintenanceAtEntry);

    if (buffer.lessThanOrEqualTo(0)) {
      // Bukan input tidak valid: ini keadaan pasar yang sah tapi degenerate.
      return { kind: "no_price", reason: "initial_margin_not_above_maintenance" };
    }

    const distancePerUnit = buffer.div(quantity);
    const rawPrice =
      direction === "long" ? entry.minus(distancePerUnit) : entry.plus(distancePerUnit);

    return {
      kind: "price",
      price: quantizeLiquidationPrice(rawPrice, direction, spec.markPriceRound),
      distancePerUnit,
    };
  }

  evaluate(input: LiquidationEvaluationInput): LiquidationEvaluation {
    const { spec, direction, size, entryPrice, markPrice } = input;
    assertValidLeverage(spec, input.leverage);
    const entry = assertValidPrice(entryPrice, "Harga entry");
    const mark = assertValidPrice(markPrice, "Mark price");

    const quantity = baseQuantityFor(spec, size);
    const initialMargin = roundMarginUp(
      notionalAtEntry(spec, size, entry).div(new Decimal(input.leverage)),
    );
    const upnl = roundMoneyNeutral(
      quantity.times(mark.minus(entry)).times(directionSign(direction)),
    );
    const funding = new Decimal(input.fundingPaid ?? 0);
    const fees = new Decimal(input.feesPaid ?? 0);
    const positionEquity = roundMoneyNeutral(initialMargin.plus(upnl).minus(funding).minus(fees));
    const maintenance = maintenanceMarginFor(spec, size, mark);

    return {
      liquidated: positionEquity.lessThanOrEqualTo(maintenance),
      positionEquity,
      maintenanceMargin: maintenance,
    };
  }

  settleClose(input: LiquidationCloseInput): LiquidationCloseOutcome {
    const { spec, direction, size, entryPrice, exitPrice } = input;
    const entry = assertValidPrice(entryPrice, "Harga entry");
    const exit = assertValidPrice(exitPrice, "Harga keluar");
    const lev = assertValidLeverage(spec, input.leverage);

    const quantity = baseQuantityFor(spec, size);
    const realizedPnl = roundMoneyNeutral(
      quantity.times(exit.minus(entry)).times(directionSign(direction)),
    );
    const initialMargin = roundMarginUp(notionalAtEntry(spec, size, entry).div(lev));

    const raw = initialMargin
      .plus(realizedPnl)
      .minus(new Decimal(input.fundingPaid ?? 0))
      .minus(new Decimal(input.feesPaid ?? 0))
      .minus(new Decimal(input.liquidationFee ?? 0));

    // Kerugian isolated tidak boleh melebihi margin posisi: kembalikan 0 dan
    // tandai insolvent untuk audit. Ini CLAMP pada hasil settlement (dompet),
    // bukan pada harga likuidasi.
    const insolvent = raw.lessThan(0);
    return {
      realizedPnl,
      walletDelta: roundMoneyNeutral(insolvent ? new Decimal(0) : raw),
      insolvent,
    };
  }
}

function notionalAtEntry(spec: ContractSpec, size: number, entry: Decimal): Decimal {
  return baseQuantityFor(spec, size).times(entry);
}

/** Model default yang dipakai paper exchange sampai A6 terverifikasi. */
export const SIMPLE_ISOLATED_LIQUIDATION: LiquidationModel = new SimpleIsolatedLiquidationModel();

// ─────────────────────────────────────────────────────────────
// Wrapper kompatibel (bentuk lama). Mendelegasikan ke model default.
// ─────────────────────────────────────────────────────────────

export interface LiquidationCheck {
  readonly liquidated: boolean;
  readonly positionEquity: Decimal;
  readonly maintenanceMargin: Decimal;
}

/**
 * Harga likuidasi, atau `null` bila model tidak menghasilkan harga bermakna
 * (keadaan degenerate `no_price`). Lihat `LiquidationPriceResult`.
 */
export function liquidationPrice(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  entryPrice: Decimal.Value,
  leverage: Decimal.Value,
): Decimal | null {
  const result = SIMPLE_ISOLATED_LIQUIDATION.calculateLiquidationPrice({
    spec,
    direction,
    size,
    entryPrice,
    leverage,
  });
  return result.kind === "price" ? result.price : null;
}

export function shouldLiquidate(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  entryPrice: Decimal.Value,
  initialMargin: Decimal.Value,
  funding: Decimal.Value,
  feesPaid: Decimal.Value,
  markPrice: Decimal.Value,
): LiquidationCheck {
  const mark = assertValidPrice(markPrice, "Mark price");
  const entry = assertValidPrice(entryPrice, "Harga entry");
  const quantity = baseQuantityFor(spec, size);
  const upnl = roundMoneyNeutral(
    quantity.times(mark.minus(entry)).times(directionSign(direction)),
  );
  const positionEquity = roundMoneyNeutral(
    new Decimal(initialMargin).plus(upnl).minus(funding).minus(feesPaid),
  );
  const maintenance = maintenanceMarginFor(spec, size, mark);
  return {
    liquidated: positionEquity.lessThanOrEqualTo(maintenance),
    positionEquity,
    maintenanceMargin: maintenance,
  };
}

export interface LiquidationOutcome {
  readonly realizedPnl: Decimal;
  readonly walletDelta: Decimal;
  readonly insolvent: boolean;
}

export function liquidationOutcome(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  entryPrice: Decimal.Value,
  initialMargin: Decimal.Value,
  funding: Decimal.Value,
  feesPaid: Decimal.Value,
  exitPrice: Decimal.Value,
  liquidationFee: Decimal.Value,
): LiquidationOutcome {
  const directionSignValue = directionSign(direction);
  const entry = assertValidPrice(entryPrice, "Harga entry");
  const exit = assertValidPrice(exitPrice, "Harga keluar");
  const quantity = baseQuantityFor(spec, size);
  const realizedPnl = roundMoneyNeutral(quantity.times(exit.minus(entry)).times(directionSignValue));
  const raw = new Decimal(initialMargin)
    .plus(realizedPnl)
    .minus(funding)
    .minus(feesPaid)
    .minus(liquidationFee);
  const insolvent = raw.lessThan(0);
  return {
    realizedPnl,
    walletDelta: roundMoneyNeutral(insolvent ? new Decimal(0) : raw),
    insolvent,
  };
}
