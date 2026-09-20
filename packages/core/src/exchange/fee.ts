import { InvalidRateError } from "../errors.js";
import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import { directionSign, notionalValueFor } from "./contract-math.js";
import { roundFeeAmount, roundMoneyNeutral, scaleRate } from "./rounding.js";
import type { Direction, Liquidity } from "./types.js";

/**
 * Fee dan funding. Semua nilai dalam USDT (quote).
 *
 * Satuan:
 *   notional (USDT) × rate (dimensi-less) = fee (USDT)
 */

export interface FeeResult {
  /** Fee yang dibebankan, BERTANDA: positif = trader membayar, negatif = rebate. */
  readonly fee: Decimal;
  /** Rate yang dipakai (maker atau taker), diskalakan RATE_DP. */
  readonly rate: Decimal;
  /** Notional yang menjadi dasar perhitungan. */
  readonly notional: Decimal;
}

function assertFiniteRate(rate: Decimal.Value, label: string, contract: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(rate);
  } catch {
    throw new InvalidRateError(`${label} bukan desimal valid untuk ${contract}: ${String(rate)}`);
  }
  if (!parsed.isFinite()) {
    throw new InvalidRateError(`${label} harus berhingga untuk ${contract}, dapat: ${String(rate)}`);
  }
  return parsed;
}

/** Rate yang berlaku untuk jenis likuiditas tertentu. Bisa negatif (rebate maker). */
export function feeRateFor(spec: ContractSpec, liquidity: Liquidity): Decimal {
  const raw = liquidity === "maker" ? spec.makerFeeRate : spec.takerFeeRate;
  return scaleRate(assertFiniteRate(raw, `Fee rate ${liquidity}`, spec.contract));
}

/**
 * Fee untuk satu fill.
 *
 * Pembulatan memakai `roundFeeAmount` (ROUND_CEIL pada amount bertanda),
 * sehingga
 *   - biaya  → trader membayar tidak kurang dari nilai eksak
 *   - rebate → trader menerima tidak lebih dari nilai eksak
 * Rebate TIDAK di-clamp ke nol; nilainya harus tetap negatif dan terwakili.
 *
 * Contoh BTC_USDT terverifikasi: notional 8 × taker 0.00075 = 0.006 USDT.
 */
export function feeFor(
  spec: ContractSpec,
  size: number,
  price: Decimal.Value,
  liquidity: Liquidity,
): FeeResult {
  const rate = feeRateFor(spec, liquidity);
  const notional = notionalValueFor(spec, size, price);
  const fee = roundFeeAmount(notional.times(rate));
  return { fee, rate, notional };
}

/**
 * Besaran funding tanpa tanda arah. `fundingRate > 0` berarti LONG membayar SHORT.
 * Nilai selalu ≥ 0 atau ≤ 0 sesuai tanda rate; arah diterapkan pemanggil.
 */
export function fundingAmount(
  spec: ContractSpec,
  size: number,
  markPrice: Decimal.Value,
  fundingRate: Decimal.Value,
): Decimal {
  const rate = assertFiniteRate(fundingRate, "Funding rate", spec.contract);
  return roundMoneyNeutral(notionalValueFor(spec, size, markPrice).times(rate));
}

/**
 * Pembayaran funding dari sudut pandang trader.
 * Positif = trader MEMBAYAR (mengurangi saldo), negatif = trader MENERIMA.
 *
 * LONG membayar saat rate positif; SHORT menerima.
 */
export function fundingPaymentFor(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  markPrice: Decimal.Value,
  fundingRate: Decimal.Value,
): Decimal {
  const magnitude = fundingAmount(spec, size, markPrice, fundingRate);
  return roundMoneyNeutral(magnitude.times(directionSign(direction)));
}
