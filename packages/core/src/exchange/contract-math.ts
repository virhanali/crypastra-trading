import {
  InvalidContractSpecError,
  InvalidLeverageError,
  InvalidOrderError,
  InvalidPriceError,
  InvalidSizeError,
} from "../errors.js";
import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import { floorToContractCount } from "./rounding.js";
import type { Direction } from "./types.js";

/**
 * Matematika kontrak eksplisit. Satuan ditulis di setiap fungsi.
 *
 * Rantai satuan:
 *   contracts × base_asset_per_contract = base_asset_quantity
 *   base_asset_quantity × quote_per_base = quote notional
 *
 * `quanto_multiplier` = base asset per 1 contract, dan HETEROGEN di Gate.io:
 * 0.0001 (BTC), 0.01 (ETH), 1 (SOL/XRP…), 100 (ARIA/TRX…), 10000000 (BIG/PEPE).
 * Jangan pernah mengasumsikan nilai BTC secara global.
 */

/**
 * Parse desimal yang aman: kesalahan format dari decimal.js dikonversi menjadi
 * error domain bertipe, bukan `DecimalError` mentah. Input tidak valid tidak
 * pernah dibiarkan lewat atau "diperbaiki" diam-diam.
 */
function parseDecimalStrict(
  value: Decimal.Value,
  label: string,
  contract: string,
  make: (message: string) => Error,
): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw make(`${label} bukan desimal valid untuk ${contract}: ${String(value)}`);
  }
  if (!parsed.isFinite()) {
    throw make(`${label} harus berhingga untuk ${contract}: ${String(value)}`);
  }
  return parsed;
}

/** Validasi `quanto_multiplier` > 0. Melempar InvalidContractSpecError. */
export function assertValidMultiplier(spec: ContractSpec): Decimal {
  const multiplier = parseDecimalStrict(
    spec.quantoMultiplier,
    "quanto_multiplier",
    spec.contract,
    (message) => new InvalidContractSpecError(message),
  );
  if (multiplier.lessThanOrEqualTo(0)) {
    throw new InvalidContractSpecError(
      `quanto_multiplier harus positif untuk ${spec.contract}, dapat: ${spec.quantoMultiplier}`,
    );
  }
  return multiplier;
}

/** Validasi tick harga > 0. */
export function assertValidTick(tick: Decimal.Value, label: string, contract: string): Decimal {
  const value = parseDecimalStrict(tick, label, contract, (message) => new InvalidContractSpecError(message));
  if (value.lessThanOrEqualTo(0)) {
    throw new InvalidContractSpecError(
      `${label} harus positif untuk ${contract}, dapat: ${String(tick)}`,
    );
  }
  return value;
}

/** Validasi `maintenance_rate` di [0, 1). MMR = 1 berarti seluruh notional. */
export function assertValidMaintenanceRate(spec: ContractSpec): Decimal {
  const rate = parseDecimalStrict(
    spec.maintenanceRate,
    "maintenance_rate",
    spec.contract,
    (message) => new InvalidContractSpecError(message),
  );
  if (rate.isNegative() || rate.greaterThanOrEqualTo(1)) {
    throw new InvalidContractSpecError(
      `maintenance_rate harus di [0, 1) untuk ${spec.contract}, dapat: ${spec.maintenanceRate}`,
    );
  }
  return rate;
}

export function assertValidPrice(price: Decimal.Value, label = "Harga"): Decimal {
  const value = parseDecimalStrict(price, label, "nilai", (message) => new InvalidPriceError(message));
  if (value.lessThanOrEqualTo(0)) {
    throw new InvalidPriceError(`${label} harus positif, dapat: ${String(price)}`);
  }
  return value;
}

/** Validasi ukuran kontrak: > 0, dalam batas kontrak, integer bila kontrak tidak mendukung desimal. */
export function assertValidSize(spec: ContractSpec, size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidSizeError(`Size harus positif, dapat: ${size}`);
  }
  // `order_size_min` Gate.io bisa 0 (kontrak dengan enable_decimal=true), jadi
  // batas bawah 0 tidak cukup: ukuran 0 selalu tidak bermakna.
  if (size < spec.orderSizeMin) {
    throw new InvalidSizeError(
      `Size ${size} di bawah minimum ${spec.orderSizeMin} untuk ${spec.contract}`,
    );
  }
  if (size > spec.orderSizeMax) {
    throw new InvalidSizeError(
      `Size ${size} di atas maksimum ${spec.orderSizeMax} untuk ${spec.contract}`,
    );
  }
  if (!spec.enableDecimal && !Number.isInteger(size)) {
    throw new InvalidSizeError(
      `Size harus integer untuk ${spec.contract} (enable_decimal=false), dapat: ${size}`,
    );
  }
  return size;
}

/** Validasi leverage terhadap rentang kontrak. */
export function assertValidLeverage(spec: ContractSpec, leverage: Decimal.Value): Decimal {
  const lev = parseDecimalStrict(
    leverage,
    "Leverage",
    spec.contract,
    (message) => new InvalidLeverageError(message),
  );
  if (lev.lessThanOrEqualTo(0)) {
    throw new InvalidLeverageError(
      `Leverage harus positif untuk ${spec.contract}, dapat: ${String(leverage)}`,
    );
  }
  const min = new Decimal(spec.leverageMin);
  const max = new Decimal(spec.leverageMax);
  if (lev.lessThan(min) || lev.greaterThan(max)) {
    throw new InvalidLeverageError(
      `Leverage ${lev.toString()} di luar rentang ${spec.leverageMin}–${spec.leverageMax} untuk ${spec.contract}`,
    );
  }
  return lev;
}

/**
 * contracts → base asset quantity.
 * Contoh BTC_USDT: 1 contract × 0.0001 BTC/contract = 0.0001 BTC.
 */
export function baseQuantityFor(spec: ContractSpec, size: number): Decimal {
  return new Decimal(assertValidSize(spec, size)).times(assertValidMultiplier(spec));
}

/**
 * contracts × price → quote notional (USDT).
 * Contoh BTC_USDT: 1 contract × 0.0001 BTC/contract × 80000 USDT/BTC = 8 USDT.
 *
 * Return EKSAK (tanpa pembulatan); pembulatan adalah keputusan pemanggil.
 */
export function notionalValueFor(
  spec: ContractSpec,
  size: number,
  price: Decimal.Value,
): Decimal {
  return baseQuantityFor(spec, size).times(assertValidPrice(price));
}

/**
 * Eksposur base asset BERTANDA: long positif, short negatif.
 * Berguna untuk menghitung eksposur bersih lintas posisi.
 */
export function signedExposureFor(
  spec: ContractSpec,
  direction: Direction,
  size: number,
): Decimal {
  const qty = baseQuantityFor(spec, size);
  return direction === "long" ? qty : qty.negated();
}

/** Eksposur base asset ABSOLUT (selalu ≥ 0). */
export function absoluteExposureFor(spec: ContractSpec, size: number): Decimal {
  return baseQuantityFor(spec, size).abs();
}

/**
 * Eksposur quote (USDT) bertanda pada harga tertentu.
 */
export function signedNotionalFor(
  spec: ContractSpec,
  direction: Direction,
  size: number,
  price: Decimal.Value,
): Decimal {
  const value = notionalValueFor(spec, size, price);
  return direction === "long" ? value : value.negated();
}

/**
 * Notional → jumlah kontrak, dibulatkan ke bawah (tidak pernah melebihi target).
 * Mengembalikan cacah kontrak (integer), bukan nilai uang.
 */
export function sizeForNotional(
  spec: ContractSpec,
  targetNotional: Decimal.Value,
  price: Decimal.Value,
): number {
  const perContract = assertValidMultiplier(spec).times(assertValidPrice(price));
  return floorToContractCount(new Decimal(targetNotional).div(perContract));
}

/** Notional minimum untuk satu kontrak pada harga tertentu (untuk cek kelayakan order). */
export function minNotionalFor(spec: ContractSpec, price: Decimal.Value): Decimal {
  const minSize = Math.max(spec.orderSizeMin, 1);
  return notionalValueFor(spec, minSize, price);
}

/**
 * Tanda arah posisi: long = +1, short = −1.
 * Memvalidasi runtime supaya arah yang tidak dikenal gagal eksplisit, bukan
 * diam-diam diperlakukan sebagai short (fallback `else`).
 */
export function directionSign(direction: Direction): Decimal {
  if (direction === "long") {
    return new Decimal(1);
  }
  if (direction === "short") {
    return new Decimal(-1);
  }
  throw new InvalidOrderError(`Arah posisi tidak dikenal: ${String(direction)}`);
}
