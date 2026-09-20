import { Decimal } from "decimal.js";

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

export { Decimal };

export type DecimalValue = Decimal.Value;

export const MONEY_DP = 8;
export const RATE_DP = 18;

export type Money = Decimal;

export function money(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

export function roundUp(value: Decimal.Value, dp = MONEY_DP): Decimal {
  return new Decimal(value).toDecimalPlaces(dp, Decimal.ROUND_UP);
}

export function roundDown(value: Decimal.Value, dp = MONEY_DP): Decimal {
  return new Decimal(value).toDecimalPlaces(dp, Decimal.ROUND_DOWN);
}

export function roundHalfUp(value: Decimal.Value, dp = MONEY_DP): Decimal {
  return new Decimal(value).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

export function isPositive(value: Decimal.Value): boolean {
  return new Decimal(value).isPositive() && !new Decimal(value).isZero();
}

export function toCanonical(value: Decimal.Value, dp = MONEY_DP): string {
  return roundHalfUp(value, dp).toFixed(dp);
}

export function parseMoney(value: string, label = "value"): Decimal {
  try {
    return new Decimal(value);
  } catch {
    throw new Error(`Nilai uang tidak valid untuk ${label}: ${JSON.stringify(value)}`);
  }
}