import { Decimal } from "decimal.js";

/**
 * Aritmetika desimal untuk PREVIEW di frontend.
 *
 * Memakai library desimal yang SAMA dengan `packages/core` (decimal.js) dan
 * konfigurasi yang sama, supaya estimasi tidak menyimpang karena pembulatan
 * float. Angka TIDAK pernah melewati `Number` di jalur ini — `Number` hanya
 * boleh di `PriceChart` untuk penggambaran.
 *
 * PENTING: ini hanya PREVIEW untuk manusia. Backend tetap otoritatif atas fill,
 * fee, reservasi, margin, dan PnL yang sebenarnya.
 */

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

export { Decimal };

export const MONEY_DP = 8;

/** Margin & fee dibulatkan KE ATAS — sama seperti kebijakan core. */
export function roundUpMoney(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_CEIL);
}

export function dec(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

/** Apakah string adalah desimal valid (bukan Number, bukan format tampilan). */
export function isDecimal(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  try {
    return new Decimal(value.trim()).isFinite();
  } catch {
    return false;
  }
}

/**
 * Apakah `price` kelipatan `tick`. Memakai sisa bagi desimal eksak, sehingga
 * tick sangat kecil (mis. 0.00000000001 milik SATS_USDT) tetap benar.
 */
export function isTickAligned(price: Decimal.Value, tick: Decimal.Value): boolean {
  const t = new Decimal(tick);
  if (!t.isFinite() || t.lessThanOrEqualTo(0)) {
    return false;
  }
  const p = new Decimal(price);
  if (!p.isFinite() || p.lessThanOrEqualTo(0)) {
    return false;
  }
  return p.dividedBy(t).isInteger();
}

export function decimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  return dot < 0 ? 0 : value.length - dot - 1;
}

/** Nilai mentah untuk API: tanpa pemisah ribuan, tanpa simbol mata uang. */
export function toApiDecimal(value: string): string {
  return value.trim().replace(/,/g, "");
}
