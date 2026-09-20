import { z } from "zod";
import { Decimal } from "./money.js";
import {
  assertValidLeverage,
  assertValidSize,
  baseQuantityFor,
  notionalValueFor,
} from "./exchange/contract-math.js";
import { quantizeToTick } from "./exchange/rounding.js";

export const DecimalSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "harus berupa string desimal")
  .describe("Nilai desimal sebagai string; jangan pernah dikirim sebagai number.");

export type DecimalString = z.infer<typeof DecimalSchema>;

export const ContractSpecSchema = z
  .object({
    contract: z.string().min(1),
    base: z.string().min(1),
    quote: z.string().min(1),
    quantoMultiplier: DecimalSchema,
    orderSizeMin: z.number().int().nonnegative(),
    orderSizeMax: z.number().int().positive(),
    /**
     * `enable_decimal` Gate.io. true = ukuran kontrak boleh desimal dan
     * `order_size_min` biasanya 0. Diverifikasi 20 Sep 2026: 14 dari 997 kontrak
     * bernilai true, termasuk ETH_USDT, SOL_USDT, XRP_USDT, TRX_USDT.
     */
    enableDecimal: z.boolean().default(false),
    orderPriceRound: DecimalSchema,
    markPriceRound: DecimalSchema,
    leverageMin: DecimalSchema,
    leverageMax: DecimalSchema,
    maintenanceRate: DecimalSchema,
    makerFeeRate: DecimalSchema,
    takerFeeRate: DecimalSchema,
    fundingIntervalSeconds: z.number().int().positive(),
    marketOrderSlipRatio: DecimalSchema.nullable().default(null),
    status: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

export type ContractSpec = z.infer<typeof ContractSpecSchema>;

export function isTradeable(spec: ContractSpec): boolean {
  return spec.status === "trading";
}

/** @deprecated gunakan `assertValidSize` di exchange/contract-math.ts. */
export function validateSize(spec: ContractSpec, size: number): void {
  assertValidSize(spec, size);
}

/** @deprecated gunakan `assertValidLeverage` di exchange/contract-math.ts. */
export function validateLeverage(spec: ContractSpec, leverage: Decimal.Value): void {
  assertValidLeverage(spec, leverage);
}

/** Kuantisasi harga ke tick kontrak. Lihat exchange/rounding.ts. */
export function roundToTick(price: Decimal.Value, tick: Decimal.Value): Decimal {
  return quantizeToTick(price, tick);
}

/** contracts → base asset quantity (divalidasi). */
export function qtyBase(spec: ContractSpec, size: number): Decimal {
  return baseQuantityFor(spec, size);
}

/** contracts × price → quote notional (divalidasi, eksak tanpa pembulatan). */
export function notional(spec: ContractSpec, size: number, price: Decimal.Value): Decimal {
  return notionalValueFor(spec, size, price);
}
