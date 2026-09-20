import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import { assertValidPrice, baseQuantityFor, directionSign } from "./contract-math.js";
import { roundMoneyNeutral } from "./rounding.js";
import type { Direction, Position } from "./types.js";

/**
 * PnL futures linear (USDT-margined). Semua nilai dalam USDT.
 *
 * Satuan:
 *   base_asset_quantity × (harga keluar − harga masuk) × arah = USDT
 *   contracts × base_asset_per_contract = base_asset_quantity
 *
 * Mark price adalah input valuasi untuk unrealized PnL; fungsi di sini TIDAK
 * mengambil atau menyimpulkan mark price — nilainya diberikan pemanggil.
 */

/**
 * Rumus PnL dasar, dipakai baik untuk unrealized (harga = mark) maupun realized
 * (harga = harga keluar).
 *
 *   LONG : qty × (exit − entry)
 *   SHORT: qty × (entry − exit)
 *
 * Contoh terverifikasi BTC_USDT: size 1, multiplier 0.0001, entry 80000,
 * exit 81000 → 0.0001 × 1000 = 0.1 USDT (bukan 10).
 */
export function pnlFor(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  entryPrice: Decimal.Value,
  exitPrice: Decimal.Value,
): Decimal {
  const sign = directionSign(direction);
  const entry = assertValidPrice(entryPrice, "Harga masuk");
  const exit = assertValidPrice(exitPrice, "Harga keluar");
  const quantity = baseQuantityFor(spec, size);
  return roundMoneyNeutral(quantity.times(exit.minus(entry)).times(sign));
}

/** PnL belum direalisasi pada mark price. */
export function unrealizedPnlFor(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  entryPrice: Decimal.Value,
  markPrice: Decimal.Value,
): Decimal {
  return pnlFor(spec, direction, size, entryPrice, markPrice);
}

/** PnL realisasi pada harga keluar. */
export function realizedPnlFor(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  entryPrice: Decimal.Value,
  exitPrice: Decimal.Value,
): Decimal {
  return pnlFor(spec, direction, size, entryPrice, exitPrice);
}

/** PnL belum direalisasi dari objek posisi (bentuk yang dipakai engine). */
export function unrealizedPnl(
  spec: ContractSpec,
  position: Pick<Position, "direction" | "size" | "entryPrice">,
  markPrice: Decimal.Value,
): Decimal {
  return unrealizedPnlFor(spec, position.direction, position.size, position.entryPrice, markPrice);
}
