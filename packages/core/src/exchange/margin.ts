import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import {
  assertValidLeverage,
  assertValidMaintenanceRate,
  assertValidPrice,
  directionSign,
  notionalValueFor,
} from "./contract-math.js";
import { unrealizedPnl } from "./pnl.js";
import { roundAvailableDown, roundMarginUp, roundMoneyNeutral } from "./rounding.js";
import type { Direction, Position } from "./types.js";

export interface MarginInput {
  readonly spec: ContractSpec;
  readonly size: number;
  readonly price: Decimal.Value;
  readonly leverage: Decimal.Value;
}

/**
 * Margin awal isolated = notional / leverage, dibulatkan KE ATAS
 * (`roundMarginUp`). Trader tidak pernah menaruh margin kurang dari nilai eksak.
 *
 * Contoh BTC_USDT terverifikasi: notional 8, leverage 10 → 0.8 USDT.
 */
export function initialMarginFor({ spec, size, price, leverage }: MarginInput): Decimal {
  const lev = assertValidLeverage(spec, leverage);
  const priceValue = assertValidPrice(price);
  return roundMarginUp(notionalValueFor(spec, size, priceValue).div(lev));
}

/**
 * Margin pemeliharaan = notional(mark) × maintenance_rate, dibulatkan KE ATAS.
 *
 * Sengaja dipisah dari likuidasi supaya model maintenance berjenjang
 * (risk_limit tier) bisa menggantikannya tanpa menulis ulang matematika lain.
 */
export function maintenanceMarginFor(
  spec: ContractSpec,
  size: number,
  markPrice: Decimal.Value,
): Decimal {
  const rate = assertValidMaintenanceRate(spec);
  const mark = assertValidPrice(markPrice, "Mark price");
  return roundMarginUp(notionalValueFor(spec, size, mark).times(rate));
}

export function positionLosses(
  position: Pick<Position, "accumulatedFunding" | "feesPaid">,
): Decimal {
  return new Decimal(position.accumulatedFunding).plus(position.feesPaid);
}

/**
 * Ekuitas posisi isolated:
 *   initial_margin + upnl − funding_kumulatif − fee_kumulatif
 */
export function positionEquity(
  spec: ContractSpec,
  position: Pick<
    Position,
    "direction" | "size" | "entryPrice" | "initialMargin" | "accumulatedFunding" | "feesPaid"
  >,
  markPrice: Decimal.Value,
): Decimal {
  return roundMoneyNeutral(
    new Decimal(position.initialMargin)
      .plus(unrealizedPnl(spec, position, markPrice))
      .minus(positionLosses(position)),
  );
}

export interface AccountInput {
  readonly walletBalance: Decimal.Value;
  readonly usedMargin: Decimal.Value;
  readonly reservedMargin: Decimal.Value;
}

export interface AccountValuation {
  readonly walletBalance: Decimal;
  readonly usedMargin: Decimal;
  readonly reservedMargin: Decimal;
  readonly availableBalance: Decimal;
  readonly equity: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly marginRatio: Decimal | null;
}

/**
 * Nilai akun turunan.
 *  available_balance = floor8(wallet − used − reserved)   ← konservatif ke bawah
 *  equity            = wallet + unrealized
 *  margin_ratio      = used_margin / equity
 */
export function deriveAccount(account: AccountInput, unrealized: Decimal.Value): AccountValuation {
  const walletBalance = new Decimal(account.walletBalance);
  const usedMargin = new Decimal(account.usedMargin);
  const reservedMargin = new Decimal(account.reservedMargin);
  const unrealizedPnlValue = new Decimal(unrealized);

  const availableBalance = roundAvailableDown(
    walletBalance.minus(usedMargin).minus(reservedMargin),
  );
  const equity = roundMoneyNeutral(walletBalance.plus(unrealizedPnlValue));
  const marginRatio = equity.isZero() ? null : roundMoneyNeutral(usedMargin.div(equity));

  return {
    walletBalance,
    usedMargin,
    reservedMargin,
    availableBalance,
    equity,
    unrealizedPnl: unrealizedPnlValue,
    marginRatio,
  };
}

/** @deprecated gunakan `directionSign` di exchange/contract-math.ts. */
export function directionMultiplier(direction: Direction): Decimal {
  return directionSign(direction);
}
