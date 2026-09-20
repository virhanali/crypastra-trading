import { ContractSpecSchema, type ContractSpec } from "../../packages/core/src/index.js";

/**
 * Spesifikasi kontrak NYATA, disalin dari
 * `GET /api/gateio.ws/api/v4/futures/usdt/contracts` pada 20 Sep 2026.
 *
 * Jangan mengarang nilai di sini. Kalau butuh kontrak lain, ambil dari API dan
 * perbarui `docs/gateio-market-data.md`.
 */
export const BTC_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "BTC_USDT",
  base: "BTC",
  quote: "USDT",
  quantoMultiplier: "0.0001",
  orderSizeMin: 1,
  orderSizeMax: 12000000,
  enableDecimal: false,
  orderPriceRound: "0.1",
  markPriceRound: "0.01",
  leverageMin: "1",
  leverageMax: "200",
  maintenanceRate: "0.003",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 28800,
  marketOrderSlipRatio: "0.01",
  status: "trading",
  source: "gateio",
});

/** Kontrak desimal (enable_decimal=true, order_size_min=0). */
export const ETH_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "ETH_USDT",
  base: "ETH",
  quote: "USDT",
  quantoMultiplier: "0.01",
  orderSizeMin: 0,
  orderSizeMax: 10000000,
  enableDecimal: true,
  orderPriceRound: "0.01",
  markPriceRound: "0.01",
  leverageMin: "1",
  leverageMax: "200",
  maintenanceRate: "0.003",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 28800,
  marketOrderSlipRatio: "0.01",
  status: "trading",
  source: "gateio",
});

/** Multiplier = 1 (bukan 0.0001 seperti BTC). */
export const SOL_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "SOL_USDT",
  base: "SOL",
  quote: "USDT",
  quantoMultiplier: "1",
  orderSizeMin: 0,
  orderSizeMax: 300000,
  enableDecimal: true,
  orderPriceRound: "0.01",
  markPriceRound: "0.01",
  leverageMin: "1",
  leverageMax: "100",
  maintenanceRate: "0.005",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 28800,
  marketOrderSlipRatio: "0.02",
  status: "trading",
  source: "gateio",
});

/** Multiplier = 10. */
export const XRP_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "XRP_USDT",
  base: "XRP",
  quote: "USDT",
  quantoMultiplier: "10",
  orderSizeMin: 0,
  orderSizeMax: 600000,
  enableDecimal: true,
  orderPriceRound: "0.0001",
  markPriceRound: "0.0001",
  leverageMin: "1",
  leverageMax: "100",
  maintenanceRate: "0.005",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 28800,
  marketOrderSlipRatio: "0.02",
  status: "trading",
  source: "gateio",
});

/** Multiplier besar (10 juta) dan tick 9 dp. */
export const PEPE_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "PEPE_USDT",
  base: "PEPE",
  quote: "USDT",
  quantoMultiplier: "10000000",
  orderSizeMin: 0,
  orderSizeMax: 120000,
  enableDecimal: true,
  orderPriceRound: "0.000000001",
  markPriceRound: "0.000000001",
  leverageMin: "1",
  leverageMax: "75",
  maintenanceRate: "0.0065",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 28800,
  marketOrderSlipRatio: "0.015",
  status: "trading",
  source: "gateio",
});

/** Tick 11 dp — membuktikan harga TIDAK boleh diasumsikan 8 dp. */
export const SATS_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "SATS_USDT",
  base: "SATS",
  quote: "USDT",
  quantoMultiplier: "10000000",
  orderSizeMin: 1,
  orderSizeMax: 830000,
  enableDecimal: false,
  orderPriceRound: "0.00000000001",
  markPriceRound: "0.00000000001",
  leverageMin: "1",
  leverageMax: "25",
  maintenanceRate: "0.02",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 14400,
  marketOrderSlipRatio: "0.04",
  status: "trading",
  source: "gateio",
});

/**
 * MMR tinggi dengan leverage maksimum rendah: 1/10 − 0.08 = 0.02.
 * Kasus batas untuk buffer liquidation.
 */
export const ARIA_USDT: ContractSpec = ContractSpecSchema.parse({
  contract: "ARIA_USDT",
  base: "ARIA",
  quote: "USDT",
  quantoMultiplier: "100",
  orderSizeMin: 0,
  orderSizeMax: 12000,
  enableDecimal: true,
  orderPriceRound: "0.00001",
  markPriceRound: "0.00001",
  leverageMin: "1",
  leverageMax: "10",
  maintenanceRate: "0.08",
  makerFeeRate: "-0.0001",
  takerFeeRate: "0.00075",
  fundingIntervalSeconds: 14400,
  marketOrderSlipRatio: "0.04",
  status: "trading",
  source: "gateio",
});

/** Semua spesifikasi nyata di atas — dipakai untuk uji properti lintas kontrak. */
export const VERIFIED_SPECS: readonly ContractSpec[] = [
  BTC_USDT,
  ETH_USDT,
  SOL_USDT,
  XRP_USDT,
  PEPE_USDT,
  SATS_USDT,
  ARIA_USDT,
];

/** Harga masuk yang wajar per kontrak untuk uji numerik. */
export const REFERENCE_PRICE: Readonly<Record<string, string>> = {
  BTC_USDT: "80000",
  ETH_USDT: "3000",
  SOL_USDT: "150",
  XRP_USDT: "2.5",
  PEPE_USDT: "0.00001",
  SATS_USDT: "0.0000003",
  ARIA_USDT: "0.05",
};
