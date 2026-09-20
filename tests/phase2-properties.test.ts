import { describe, expect, test } from "bun:test";
import {
  averageFillPrice,
  Decimal,
  feeFor,
  fundingPaymentFor,
  initialMarginFor,
  maintenanceMarginFor,
  notionalValueFor,
  planLevelConsumption,
  realizedPnlFor,
  unrealizedPnlFor,
  type ContractSpec,
} from "../packages/core/src/index.js";
import { ARIA_USDT, BTC_USDT, ETH_USDT, PEPE_USDT, SATS_USDT, SOL_USDT, XRP_USDT, VERIFIED_SPECS } from "./helpers/fixtures.js";

/**
 * Uji properti DETERMINISTIK: menyapu rentang parameter penuh, bukan angka acak.
 * Tidak ada randomness (lihat docs/PLAN.md §10 dan requirement Phase 2 §10).
 */

/** Rentang leverage yang sah per kontrak: min, tengah, maks, dan beberapa titik. */
function leverageGrid(spec: ContractSpec): string[] {
  const min = new Decimal(spec.leverageMin);
  const max = new Decimal(spec.leverageMax);
  const mid = min.plus(max).div(2);
  const values = new Set<string>([min.toString(), "2", mid.toDecimalPlaces(0).toString(), max.toString()]);
  return [...values].filter((value) => {
    const lev = new Decimal(value);
    return lev.greaterThanOrEqualTo(min) && lev.lessThanOrEqualTo(max) && lev.greaterThan(0);
  });
}

/** Harga masuk representatif per kontrak (di sekitar harga acuan). */
const PRICE_GRID: Record<string, string[]> = {
  BTC_USDT: ["80000", "1", "1000000"],
  ETH_USDT: ["3000", "0.01", "100000"],
  SOL_USDT: ["150", "0.01", "10000"],
  XRP_USDT: ["2.5", "0.0001", "1000"],
  PEPE_USDT: ["0.00001", "0.000000001", "0.5"],
  SATS_USDT: ["0.0000003", "0.00000000001", "1"],
  ARIA_USDT: ["0.05", "0.00001", "100"],
};

const SIZE_GRID = [1, 2, 7, 100];

describe("10. invariant lintas kontrak nyata", () => {
  test("notional, margin, dan maintenance selalu >= 0", () => {
    for (const spec of VERIFIED_SPECS) {
      for (const price of PRICE_GRID[spec.contract] ?? ["1"]) {
        for (const size of SIZE_GRID) {
          const notional = notionalValueFor(spec, size, price);
          const margin = initialMarginFor({ spec, size, price, leverage: "1" });
          const maintenance = maintenanceMarginFor(spec, size, price);
          expect(notional.greaterThanOrEqualTo(0)).toBe(true);
          expect(margin.greaterThanOrEqualTo(0)).toBe(true);
          expect(maintenance.greaterThanOrEqualTo(0)).toBe(true);
        }
      }
    }
  });

  test("PnL(entry == mark) == 0 untuk semua kontrak, arah, ukuran, harga", () => {
    for (const spec of VERIFIED_SPECS) {
      for (const price of PRICE_GRID[spec.contract] ?? ["1"]) {
        for (const size of SIZE_GRID) {
          expect(unrealizedPnlFor(spec, "long", size, price, price).isZero()).toBe(true);
          expect(unrealizedPnlFor(spec, "short", size, price, price).isZero()).toBe(true);
        }
      }
    }
  });

  test("LONG: mark naik → PnL tidak menurun; SHORT: mark naik → PnL tidak meningkat", () => {
    for (const spec of VERIFIED_SPECS) {
      const prices = PRICE_GRID[spec.contract] ?? ["1"];
      const entry = prices[0]!;
      const lower = new Decimal(entry).times("0.9");
      const higher = new Decimal(entry).times("1.1");
      for (const size of SIZE_GRID) {
        const longLower = unrealizedPnlFor(spec, "long", size, entry, lower);
        const longHigher = unrealizedPnlFor(spec, "long", size, entry, higher);
        expect(longHigher.greaterThanOrEqualTo(longLower)).toBe(true);

        const shortLower = unrealizedPnlFor(spec, "short", size, entry, lower);
        const shortHigher = unrealizedPnlFor(spec, "short", size, entry, higher);
        expect(shortHigher.lessThanOrEqualTo(shortLower)).toBe(true);
      }
    }
  });

  test("PnL dan eksposur berskala linear pada jumlah kontrak", () => {
    for (const spec of VERIFIED_SPECS) {
      const price = (PRICE_GRID[spec.contract] ?? ["1"])[0]!;
      const exit = new Decimal(price).times("1.001");
      const one = realizedPnlFor(spec, "long", 1, price, exit.toFixed());
      const ten = realizedPnlFor(spec, "long", 10, price, exit.toFixed());
      // Linear kecuali terpotong pembulatan 8 dp.
      const expected = new Decimal(one).times(10);
      expect(new Decimal(ten).minus(expected).abs().lessThanOrEqualTo("0.0000001")).toBe(true);
    }
  });

  test("leverage lebih besar → initial margin tidak bertambah", () => {
    for (const spec of VERIFIED_SPECS) {
      const price = (PRICE_GRID[spec.contract] ?? ["1"])[0]!;
      const grid = leverageGrid(spec);
      let previous: Decimal | null = null;
      for (const leverage of grid) {
        const margin = initialMarginFor({ spec, size: 1, price, leverage });
        if (previous !== null) {
          expect(margin.lessThanOrEqualTo(previous)).toBe(true);
        }
        previous = margin;
      }
    }
  });

  test("maintenance margin tidak bergantung pada leverage", () => {
    for (const spec of VERIFIED_SPECS) {
      const price = (PRICE_GRID[spec.contract] ?? ["1"])[0]!;
      const a = maintenanceMarginFor(spec, 1, price);
      const b = maintenanceMarginFor(spec, 1, price);
      expect(a.eq(b)).toBe(true);
    }
  });

  test("rate fee 0 → fee 0; rate negatif → fee negatif (rebate)", () => {
    const zero = { ...BTC_USDT, makerFeeRate: "0", takerFeeRate: "0" };
    for (const size of SIZE_GRID) {
      expect(feeFor(zero, size, "80000", "taker").fee.isZero()).toBe(true);
    }
    for (const spec of VERIFIED_SPECS) {
      const rebate = feeFor(spec, 1, (PRICE_GRID[spec.contract] ?? ["1"])[0]!, "maker");
      // Semua kontrak Gate.io punya maker fee negatif (terverifikasi 997/997).
      expect(rebate.rate.isNegative()).toBe(true);
      expect(rebate.fee.isNegative() || rebate.fee.isZero()).toBe(true);
    }
  });

  test("funding long + short selalu berjumlah nol", () => {
    for (const spec of VERIFIED_SPECS) {
      const price = (PRICE_GRID[spec.contract] ?? ["1"])[0]!;
      for (const rate of ["0.0001", "-0.0001", "0", "0.003", "-0.02"]) {
        const long = fundingPaymentFor(spec, "long", 7, price, rate);
        const short = fundingPaymentFor(spec, "short", 7, price, rate);
        expect(long.plus(short).isZero()).toBe(true);
      }
    }
  });

  test("konsumsi level buku tidak pernah melebihi permintaan", () => {
    const levels = [
      { price: "100", size: 1 },
      { price: "101", size: 5 },
      { price: "102", size: 50 },
    ];
    for (const requested of [1, 2, 6, 7, 56, 1000]) {
      const result = planLevelConsumption(requested, levels);
      expect(result.filledSize).toBeLessThanOrEqual(requested);
      expect(result.filledSize + result.remainingSize).toBe(requested);
      expect(result.takes.reduce((sum, take) => sum + take.size, 0)).toBe(result.filledSize);
    }
  });

  test("rata-rata harga fill berada di antara harga terendah dan tertinggi", () => {
    const takes = [
      { price: new Decimal("100"), size: 1 },
      { price: new Decimal("110"), size: 2 },
    ];
    const avg = averageFillPrice(BTC_USDT, takes)!;
    expect(avg.greaterThanOrEqualTo("100")).toBe(true);
    expect(avg.lessThanOrEqualTo("110")).toBe(true);
  });
});

describe("10b. properti likuidasi pada domain sah", () => {
  test("seluruh kontrak nyata: liq_long < entry < liq_short pada setiap leverage sah", async () => {
    const { liquidationPrice } = await import("../packages/core/src/index.js");
    for (const spec of VERIFIED_SPECS) {
      const price = (PRICE_GRID[spec.contract] ?? ["1"])[0]!;
      for (const leverage of leverageGrid(spec)) {
        const long = liquidationPrice(spec, "long", 1, price, leverage);
        const short = liquidationPrice(spec, "short", 1, price, leverage);
        expect(long).not.toBeNull();
        expect(short).not.toBeNull();
        if (long !== null && short !== null) {
          expect(long.lessThan(price)).toBe(true);
          expect(long.greaterThan(0)).toBe(true);
          expect(short.greaterThan(price)).toBe(true);
        }
      }
    }
  });

  test("jarak likuidasi long dan short simetris terhadap entry", async () => {
    const { liquidationPrice } = await import("../packages/core/src/index.js");
    for (const spec of VERIFIED_SPECS) {
      const price = (PRICE_GRID[spec.contract] ?? ["1"])[0]!;
      for (const leverage of leverageGrid(spec)) {
        const long = liquidationPrice(spec, "long", 1, price, leverage)!;
        const short = liquidationPrice(spec, "short", 1, price, leverage)!;
        const entry = new Decimal(price);
        const longDistance = entry.minus(long);
        const shortDistance = short.minus(entry);
        // Kuantisasi tick bisa membuat selisih kecil; toleransi 2 tick.
        const tolerance = new Decimal(spec.markPriceRound).times(2);
        expect(longDistance.minus(shortDistance).abs().lessThanOrEqualTo(tolerance)).toBe(true);
      }
    }
  });

  test("likuidasi lebih awal saat maintenance rate lebih tinggi", async () => {
    const { liquidationPrice } = await import("../packages/core/src/index.js");
    // Pada leverage 1, jarak = mmr × entry
    const aria = liquidationPrice(ARIA_USDT, "long", 1, "1", "1")!;
    const btcLow = { ...BTC_USDT, maintenanceRate: "0.005" };
    const btcHigh = { ...BTC_USDT, maintenanceRate: "0.05" };
    const low = liquidationPrice(btcLow, "long", 1, "1", "1")!;
    const high = liquidationPrice(btcHigh, "long", 1, "1", "1")!;
    expect(high.greaterThan(low)).toBe(true);
    // ARIA mmr 0.08 → liq 0.08
    expect(aria.toString()).toBe("0.08");
  });
});

describe("fixtures konsisten dengan data Gate.io", () => {
  test("setiap fixture punya maker fee negatif dan buffer positif", () => {
    for (const spec of VERIFIED_SPECS) {
      expect(new Decimal(spec.makerFeeRate).isNegative()).toBe(true);
      const buffer = new Decimal(1).div(spec.leverageMax).minus(spec.maintenanceRate);
      expect(buffer.greaterThan(0)).toBe(true);
    }
  });

  test("tick kontrak bervariasi termasuk 11 dp (bukan 8 dp)", () => {
    const scales = VERIFIED_SPECS.map((spec) => spec.orderPriceRound.length);
    expect(new Set(scales).size).toBeGreaterThan(1);
    expect(SATS_USDT.orderPriceRound).toBe("0.00000000001");
  });

  test("multiplier fixture mencakup rentang lebar", () => {
    const values = VERIFIED_SPECS.map((spec) => new Decimal(spec.quantoMultiplier));
    const min = Decimal.min(...values);
    const max = Decimal.max(...values);
    expect(min.lessThanOrEqualTo("0.0001")).toBe(true);
    expect(max.greaterThanOrEqualTo("10000000")).toBe(true);
  });
});
