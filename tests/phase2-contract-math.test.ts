import { describe, expect, test } from "bun:test";
import {
  absoluteExposureFor,
  assertValidLeverage,
  assertValidMaintenanceRate,
  assertValidMultiplier,
  assertValidSize,
  baseQuantityFor,
  Decimal,
  InvalidContractSpecError,
  InvalidLeverageError,
  InvalidSizeError,
  notional,
  notionalValueFor,
  qtyBase,
  signedExposureFor,
  signedNotionalFor,
  sizeForNotional,
  validateSize,
} from "../packages/core/src/index.js";
import { ARIA_USDT, BTC_USDT, ETH_USDT, PEPE_USDT, SATS_USDT, SOL_USDT, XRP_USDT } from "./helpers/fixtures.js";

describe("1. contract math — rantai satuan", () => {
  test("BTC_USDT fixture: 1 kontrak = 0.0001 BTC, notional 80000 = 8 USDT", () => {
    expect(baseQuantityFor(BTC_USDT, 1).toString()).toBe("0.0001");
    expect(notionalValueFor(BTC_USDT, 1, "80000").toString()).toBe("8");
    // Alias kompatibel dari contract.ts
    expect(qtyBase(BTC_USDT, 1).toString()).toBe("0.0001");
    expect(notional(BTC_USDT, 1, "80000").toString()).toBe("8");
  });

  test("kuantitas base + notional berskala linear pada jumlah kontrak", () => {
    expect(baseQuantityFor(BTC_USDT, 250).toString()).toBe("0.025");
    expect(notionalValueFor(BTC_USDT, 250, "80000").toString()).toBe("2000");
  });

  test("multiplier TIDAK di-hardcode ke 0.0001 (kontrak non-BTC)", () => {
    // SOL: multiplier 1 → 1 kontrak = 1 SOL
    expect(baseQuantityFor(SOL_USDT, 1).toString()).toBe("1");
    expect(notionalValueFor(SOL_USDT, 1, "150").toString()).toBe("150");
    // XRP: multiplier 10
    expect(baseQuantityFor(XRP_USDT, 1).toString()).toBe("10");
    // PEPE: multiplier 10 juta
    expect(baseQuantityFor(PEPE_USDT, 1).toString()).toBe("10000000");
    // ARIA: multiplier 100
    expect(baseQuantityFor(ARIA_USDT, 3).toString()).toBe("300");
    // ETH: multiplier 0.01
    expect(baseQuantityFor(ETH_USDT, 1).toString()).toBe("0.01");
  });

  test("eksposur bertanda: long positif, short negatif", () => {
    expect(signedExposureFor(BTC_USDT, "long", 5).toString()).toBe("0.0005");
    expect(signedExposureFor(BTC_USDT, "short", 5).toString()).toBe("-0.0005");
    expect(absoluteExposureFor(BTC_USDT, 5).toString()).toBe("0.0005");
    expect(signedNotionalFor(BTC_USDT, "long", 1, "80000").toString()).toBe("8");
    expect(signedNotionalFor(BTC_USDT, "short", 1, "80000").toString()).toBe("-8");
  });

  test("sizeForNotional membulatkan ke bawah, tidak pernah melebihi target", () => {
    // 8 USDT / (0.0001 × 80000) = 1 kontrak tepat
    expect(sizeForNotional(BTC_USDT, "8", "80000")).toBe(1);
    // 7.99 USDT tidak cukup untuk 1 kontrak penuh
    expect(sizeForNotional(BTC_USDT, "7.99", "80000")).toBe(0);
    // SOL: 150 USDT / (1 × 150) = 1
    expect(sizeForNotional(SOL_USDT, "150", "150")).toBe(1);
    expect(sizeForNotional(SOL_USDT, "299", "150")).toBe(1);
  });
});

describe("1b. enable_decimal (14/997 kontrak Gate.io)", () => {
  test("kontrak integer menolak ukuran desimal", () => {
    expect(() => assertValidSize(BTC_USDT, 1.5)).toThrow(InvalidSizeError);
    expect(() => validateSize(SATS_USDT, 0.5)).toThrow(InvalidSizeError);
  });

  test("kontrak desimal MENERIMA ukuran desimal", () => {
    // ETH_USDT enable_decimal=true
    expect(assertValidSize(ETH_USDT, 0.5)).toBe(0.5);
    expect(assertValidSize(ETH_USDT, 0.001)).toBe(0.001);
    expect(() => assertValidSize(ETH_USDT, 0)).toThrow(InvalidSizeError);
  });

  test("order_size_min = 0 tetap menolak ukuran 0", () => {
    // Regresi: `size < orderSizeMin` dengan min 0 akan meloloskan size 0.
    expect(ETH_USDT.orderSizeMin).toBe(0);
    expect(() => assertValidSize(ETH_USDT, 0)).toThrow(InvalidSizeError);
    expect(() => assertValidSize(XRP_USDT, 0)).toThrow(InvalidSizeError);
    expect(() => assertValidSize(SOL_USDT, 0)).toThrow(InvalidSizeError);
  });

  test("ukuran negatif dan melebihi maksimum ditolak", () => {
    expect(() => assertValidSize(BTC_USDT, -1)).toThrow(InvalidSizeError);
    expect(() => assertValidSize(BTC_USDT, BTC_USDT.orderSizeMax + 1)).toThrow(InvalidSizeError);
    expect(() => assertValidSize(BTC_USDT, 0)).toThrow(InvalidSizeError);
  });

  test("enable_decimal default false bila tidak diberikan", () => {
    expect(BTC_USDT.enableDecimal).toBe(false);
    expect(ETH_USDT.enableDecimal).toBe(true);
  });
});

describe("12. input tidak valid gagal eksplisit", () => {
  test("harga <= 0 ditolak", () => {
    expect(() => notionalValueFor(BTC_USDT, 1, "0")).toThrow();
    expect(() => notionalValueFor(BTC_USDT, 1, "-5")).toThrow();
  });

  test("multiplier tidak valid ditolak", () => {
    const broken = { ...BTC_USDT, quantoMultiplier: "0" };
    expect(() => assertValidMultiplier(broken)).toThrow(InvalidContractSpecError);
    const negative = { ...BTC_USDT, quantoMultiplier: "-1" };
    expect(() => assertValidMultiplier(negative)).toThrow(InvalidContractSpecError);
  });

  test("maintenance_rate tidak valid ditolak", () => {
    expect(() => assertValidMaintenanceRate({ ...BTC_USDT, maintenanceRate: "-0.1" })).toThrow(
      InvalidContractSpecError,
    );
    expect(() => assertValidMaintenanceRate({ ...BTC_USDT, maintenanceRate: "1" })).toThrow(
      InvalidContractSpecError,
    );
    expect(() => assertValidMaintenanceRate({ ...BTC_USDT, maintenanceRate: "1.5" })).toThrow(
      InvalidContractSpecError,
    );
  });

  test("leverage di luar rentang kontrak ditolak", () => {
    // BTC 1..200
    expect(() => assertValidLeverage(BTC_USDT, "0")).toThrow(InvalidLeverageError);
    expect(() => assertValidLeverage(BTC_USDT, "-10")).toThrow(InvalidLeverageError);
    expect(() => assertValidLeverage(BTC_USDT, "201")).toThrow(InvalidLeverageError);
    // ARIA hanya sampai 10 — membuktikan batas tidak diasumsikan 1..200
    expect(() => assertValidLeverage(ARIA_USDT, "11")).toThrow(InvalidLeverageError);
    expect(assertValidLeverage(ARIA_USDT, "10").toString()).toBe("10");
    // SATS sampai 25, PEPE sampai 75
    expect(() => assertValidLeverage(SATS_USDT, "26")).toThrow(InvalidLeverageError);
    expect(() => assertValidLeverage(PEPE_USDT, "76")).toThrow(InvalidLeverageError);
  });

  test("leverage tak berhingga ditolak", () => {
    expect(() => assertValidLeverage(BTC_USDT, new Decimal(Infinity))).toThrow(InvalidLeverageError);
    expect(() => assertValidLeverage(BTC_USDT, new Decimal(NaN))).toThrow(InvalidLeverageError);
  });

  test("error bertipe DomainError sehingga bisa ditangkap spesifik", () => {
    try {
      assertValidLeverage(BTC_USDT, "9999");
      throw new Error("seharusnya melempar");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLeverageError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("InvalidLeverageError");
    }
  });
});
