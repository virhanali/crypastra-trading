import { describe, expect, test } from "bun:test";
import {
  ContractSpecSchema,
  Decimal,
  initialMarginFor,
  maintenanceMarginFor,
  notional,
  feeFor,
  fundingPaymentFor,
  realizedPnlFor,
  liquidationPrice,
  shouldLiquidate,
  liquidationOutcome,
  evaluateTpSl,
} from "../packages/core/src/index.js";

/**
 * Fixture nyata dari probe Gate.io 20 Sep 2026.
 * Lihat docs/gateio-market-data.md §3.
 */
const BTC = ContractSpecSchema.parse({
  contract: "BTC_USDT",
  base: "BTC",
  quote: "USDT",
  quantoMultiplier: "0.0001",
  orderSizeMin: 1,
  orderSizeMax: 12000000,
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

describe("konversi kontrak (quanto_multiplier)", () => {
  test("notional BTC_USDT: 1 kontrak pada 80000 = 8 USDT", () => {
    expect(notional(BTC, 1, "80000").toString()).toBe("8");
  });

  test("quanto_multiplier heterogen tidak boleh diasumsikan 0.0001", () => {
    const alt = ContractSpecSchema.parse({ ...BTC, contract: "XYZ_USDT", quantoMultiplier: "1" });
    expect(notional(alt, 1, "2").toString()).toBe("2");
  });
});

describe("margin isolated", () => {
  test("initial margin = notional / leverage, dibulatkan ke atas", () => {
    expect(initialMarginFor({ spec: BTC, size: 1, price: "80000", leverage: "10" }).toString()).toBe(
      "0.8",
    );
  });

  test("maintenance margin = notional * mmr", () => {
    expect(maintenanceMarginFor(BTC, 1, "80000").toString()).toBe("0.024");
  });
});

describe("fee maker/taker", () => {
  test("taker fee = notional * 0.00075", () => {
    const { fee, rate } = feeFor(BTC, 1, "80000", "taker");
    expect(fee.toString()).toBe("0.006");
    expect(rate.toString()).toBe("0.00075");
  });

  test("maker rebate bernilai negatif (exchange membayar trader)", () => {
    const { fee } = feeFor(BTC, 1, "80000", "maker");
    expect(fee.isNegative()).toBe(true);
    expect(fee.toString()).toBe("-0.0008");
  });

  test("fee tidak pernah membulatkan dust menjadi nol", () => {
    const { fee } = feeFor(BTC, 1, "0.5", "taker");
    expect(fee.isZero()).toBe(false);
    expect(fee.toString()).toBe("0.00000004");
  });
});

describe("unrealized / realized PnL", () => {
  test("long profit saat mark naik; short profit saat mark turun", () => {
    // 1 kontrak = 0.0001 BTC, jadi pergerakan $1000 = 0.1 USDT.
    expect(realizedPnlFor(BTC, "long", 1, "80000", "81000").toString()).toBe("0.1");
    expect(realizedPnlFor(BTC, "short", 1, "80000", "81000").toString()).toBe("-0.1");
    expect(realizedPnlFor(BTC, "short", 1, "80000", "79000").toString()).toBe("0.1");
    // 100 kontrak = 0.01 BTC -> pergerakan $1000 = 10 USDT.
    expect(realizedPnlFor(BTC, "long", 100, "80000", "81000").toString()).toBe("10");
  });
});

describe("funding", () => {
  test("rate positif: long membayar, short menerima", () => {
    const long = fundingPaymentFor(BTC, "long", 1, "80000", "0.000097");
    const short = fundingPaymentFor(BTC, "short", 1, "80000", "0.000097");
    expect(long.isPositive()).toBe(true);
    expect(short.isNegative()).toBe(true);
    expect(long.plus(short).isZero()).toBe(true);
  });
});

describe("likuidasi", () => {
  test("long terlikuidasi di bawah entry, short di atas entry", () => {
    const long = liquidationPrice(BTC, "long", 1, "80000", "10")!;
    const short = liquidationPrice(BTC, "short", 1, "80000", "10")!;
    expect(long.lessThan("80000")).toBe(true);
    expect(short.greaterThan("80000")).toBe(true);
  });

  test("leverage 1: liq price = entry * mmr (bukan nol, tapi jauh di bawah)", () => {
    const long = liquidationPrice(BTC, "long", 1, "80000", "1")!;
    // entry - (entry - entry*mmr) = entry * mmr = 240
    expect(long.toString()).toBe("240");
    expect(long.lessThan("1000")).toBe(true);
    expect(long.greaterThan(0)).toBe(true);
  });

  test("trigger saat equity <= maintenance", () => {
    // init 0.8, equity @79000 = 0.7, maintenance = 0.0237 -> belum likuidasi.
    const near = shouldLiquidate(BTC, "long", 1, "80000", "0.8", "0", "0", "79000");
    expect(near.liquidated).toBe(false);
    // equity @72000 = 0.0 <= maintenance 0.0216 -> likuidasi.
    const crash = shouldLiquidate(BTC, "long", 1, "80000", "0.8", "0", "0", "72000");
    expect(crash.liquidated).toBe(true);
  });

  test("kerugian likuidasi tidak membuat dompet negatif (isolated)", () => {
    const outcome = liquidationOutcome(
      BTC,
      "long",
      1,
      "80000",
      "0.8",
      "0",
      "0",
      "79000",
      "0.005",
    );
    expect(outcome.walletDelta.greaterThanOrEqualTo(0)).toBe(true);
    expect(outcome.insolvent).toBe(false);
  });

  test("gap ekstrem ditandai insolvent dan di-clamp ke nol", () => {
    const outcome = liquidationOutcome(
      BTC,
      "long",
      1,
      "80000",
      "0.8",
      "0",
      "0",
      "70000",
      "0.005",
    );
    expect(outcome.walletDelta.isZero()).toBe(true);
    expect(outcome.insolvent).toBe(true);
  });
});

describe("TP/SL", () => {
  test("long: TP di atas, SL di bawah", () => {
    const state = { tpPrice: "82000", slPrice: "78000" };
    expect(evaluateTpSl(state, "long", "82500")).toBe("tp");
    expect(evaluateTpSl(state, "long", "77500")).toBe("sl");
    expect(evaluateTpSl(state, "long", "80000")).toBeNull();
  });

  test("short: TP di bawah, SL di atas", () => {
    const state = { tpPrice: "78000", slPrice: "82000" };
    expect(evaluateTpSl(state, "short", "77500")).toBe("tp");
    expect(evaluateTpSl(state, "short", "82500")).toBe("sl");
  });

  test("gap yang memenuhi TP dan SL sekaligus -> SL menang", () => {
    const state = { tpPrice: "78000", slPrice: "82000" };
    expect(evaluateTpSl(state, "long", "1000")).toBe("sl");
  });
});

describe("disiplin desimal", () => {
  test("akumulasi 1000 fee kecil tidak menghasilkan drift float", () => {
    let total = new Decimal(0);
    for (let i = 0; i < 1000; i += 1) {
      total = total.plus(feeFor(BTC, 1, "80000", "taker").fee);
    }
    expect(total.toString()).toBe("6");
  });
});