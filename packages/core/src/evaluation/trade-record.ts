import { Decimal } from "../money.js";
import type { Direction } from "../exchange/types.js";

/**
 * Representasi riset siklus hidup satu trade otonom (Phase 11).
 *
 * DERIVED, bukan authoritative: sumber kebenaran ekonomi tetap
 * orders/fills/positions/ledger. TradeRecord adalah materialisasi untuk
 * evaluasi, dan boleh dibangun ulang dari sumber kanonik.
 *
 * Semua nilai uang/analitik berupa string desimal.
 */
export const EVALUATION_VERSION = "evaluation-v1";

export type ExitReason = "take_profit" | "stop_loss" | "liquidation" | "manual" | "open";

export interface TradeRecord {
  readonly tradeId: string;
  readonly accountId: string;
  readonly decisionId: string;
  readonly contract: string;
  readonly side: Direction;

  readonly decisionTimeMs: number;
  readonly entryTimeMs: number;
  readonly exitTimeMs: number | null;

  /** Harga acuan dari TradePlan (konteks perencanaan, bukan harga isian). */
  readonly plannedReference: string;
  /** Harga isian rata-rata aktual dari Paper Exchange. */
  readonly actualEntry: string;

  readonly size: number;
  readonly leverage: string;

  readonly stopLoss: string;
  readonly takeProfit: string;

  readonly plannedRiskAmount: string;
  /** Risiko awal AKTUAL: |actualEntry − SL| × multiplier × size terisi. */
  readonly actualInitialRiskAmount: string;

  /** PnL realisasi kotor (sebelum biaya/funding), sesuai semantik ledger. */
  readonly grossRealizedPnl: string;
  /** Biaya, positif = beban (rebate negatif). */
  readonly fees: string;
  /** Funding, positif = beban. */
  readonly funding: string;
  readonly netPnl: string;

  readonly exitReason: ExitReason;

  /** Maximum Adverse Excursion dalam harga (selalu ≥ 0). */
  readonly mae: string;
  /** Maximum Favorable Excursion dalam harga (selalu ≥ 0). */
  readonly mfe: string;
  /** MAE dinormalisasi ke risiko awal (R). */
  readonly maeR: string | null;
  /** MFE dinormalisasi ke risiko awal (R). */
  readonly mfeR: string | null;

  /** netPnl / actualInitialRiskAmount; null bila risiko 0. */
  readonly rMultiple: string | null;

  readonly holdingDurationMs: number | null;

  readonly featureVersion: string;
  readonly scannerVersion: string;
  readonly scannerConfigHash: string;
  readonly decisionVersion: string;
  readonly riskPolicyVersion: string;
  readonly riskPolicyHash: string;
  readonly evaluationVersion: string;
}

export interface ExcursionState {
  readonly mae: Decimal;
  readonly mfe: Decimal;
}

export function emptyExcursion(): ExcursionState {
  return { mae: new Decimal(0), mfe: new Decimal(0) };
}

/**
 * Perbarui MAE/MFE dengan satu mark. Murni dan inkremental — tidak ada
 * look-ahead: hanya mark yang sudah terjadi.
 *
 * LONG : MFE = max(mark − entry), MAE = max(entry − mark)
 * SHORT: MFE = max(entry − mark), MAE = max(mark − entry)
 */
export function updateExcursion(
  state: ExcursionState,
  side: Direction,
  entryPrice: Decimal.Value,
  markPrice: Decimal.Value,
): ExcursionState {
  const entry = new Decimal(entryPrice);
  const mark = new Decimal(markPrice);
  const favorable = side === "long" ? mark.minus(entry) : entry.minus(mark);
  const adverse = side === "long" ? entry.minus(mark) : mark.minus(entry);
  return {
    mae: Decimal.max(state.mae, adverse),
    mfe: Decimal.max(state.mfe, favorable),
  };
}

/**
 * netPnl = grossRealizedPnl − fees − funding
 *
 * `fees` dan `funding` memakai konvensi BIAYA POSITIF (rebate bernilai negatif),
 * konsisten dengan `fees_paid` di ledger. Tidak diturunkan dari delta wallet,
 * karena wallet juga bergerak oleh efek lain (deposit, margin meta, dsb).
 */
export function netPnlFor(input: {
  grossRealizedPnl: Decimal.Value;
  fees: Decimal.Value;
  funding: Decimal.Value;
}): Decimal {
  return new Decimal(input.grossRealizedPnl)
    .minus(new Decimal(input.fees))
    .minus(new Decimal(input.funding));
}

/** R multiple = netPnl / risiko awal aktual. null bila risiko ≤ 0. */
export function rMultipleFor(netPnl: Decimal.Value, actualInitialRisk: Decimal.Value): Decimal | null {
  const risk = new Decimal(actualInitialRisk);
  if (!risk.isFinite() || risk.lessThanOrEqualTo(0)) {
    return null;
  }
  return new Decimal(netPnl).div(risk);
}

/** Risiko awal aktual dari isian sebenarnya. */
export function actualInitialRiskFor(input: {
  side: Direction;
  actualEntry: Decimal.Value;
  stopLoss: Decimal.Value;
  multiplier: Decimal.Value;
  size: number;
}): Decimal {
  const entry = new Decimal(input.actualEntry);
  const stop = new Decimal(input.stopLoss);
  const distance = input.side === "long" ? entry.minus(stop) : stop.minus(entry);
  if (distance.lessThanOrEqualTo(0)) {
    return new Decimal(0);
  }
  return distance.times(new Decimal(input.multiplier)).times(input.size);
}

/** Slippage masuk relatif terhadap acuan perencanaan (bisa negatif). */
export function entrySlippageFor(input: {
  side: Direction;
  actualFill: Decimal.Value;
  plannedReference: Decimal.Value;
}): Decimal {
  const fill = new Decimal(input.actualFill);
  const planned = new Decimal(input.plannedReference);
  return input.side === "long" ? fill.minus(planned) : planned.minus(fill);
}

/** Slippage dalam basis poin terhadap harga acuan. */
export function entrySlippageBpsFor(input: {
  side: Direction;
  actualFill: Decimal.Value;
  plannedReference: Decimal.Value;
}): Decimal | null {
  const planned = new Decimal(input.plannedReference);
  if (planned.isZero()) {
    return null;
  }
  return entrySlippageFor(input).div(planned).times(10_000);
}
