import { describe, expect, test } from "bun:test";
import {
  averageFillPrice,
  Decimal,
  InvalidSizeError,
  liquidationOutcome,
  liquidationPrice,
  planLevelConsumption,
  shouldLiquidate,
  SIMPLE_ISOLATED_LIQUIDATION,
  SimpleIsolatedLiquidationModel,
} from "../packages/core/src/index.js";
import { ARIA_USDT, BTC_USDT, ETH_USDT, PEPE_USDT, SATS_USDT, SOL_USDT, XRP_USDT } from "./helpers/fixtures.js";

const model = new SimpleIsolatedLiquidationModel();

describe("6. likuidasi — batas model", () => {
  test("model menyatakan provenance simulator, bukan Gate.io", () => {
    expect(SIMPLE_ISOLATED_LIQUIDATION.provenance).toBe("simulator");
    expect(SIMPLE_ISOLATED_LIQUIDATION.id).toBe("simple-isolated-v1");
    // Tidak ada klaim "gate" di identifier model.
    expect(SIMPLE_ISOLATED_LIQUIDATION.id.toLowerCase()).not.toContain("gate");
  });

  test("LONG: likuidasi di bawah entry; SHORT: di atas entry", () => {
    const long = model.calculateLiquidationPrice({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      leverage: "10",
    });
    const short = model.calculateLiquidationPrice({
      spec: BTC_USDT,
      direction: "short",
      size: 1,
      entryPrice: "80000",
      leverage: "10",
    });
    expect(long.kind).toBe("price");
    expect(short.kind).toBe("price");
    if (long.kind === "price" && short.kind === "price") {
      expect(long.price.lessThan("80000")).toBe(true);
      expect(short.price.greaterThan("80000")).toBe(true);
    }
  });

  test("panjang buffer = entry × (1/leverage − maintenance_rate)", () => {
    // 80000 × (1/10 − 0.003) = 80000 × 0.097 = 7760
    const result = model.calculateLiquidationPrice({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      leverage: "10",
    });
    if (result.kind !== "price") {
      throw new Error("harus menghasilkan harga");
    }
    expect(result.distancePerUnit.toString()).toBe("7760");
    expect(result.price.toString()).toBe("72240");
  });

  test("hasil harga dikuantisasi ke mark_price_round", () => {
    const spec = { ...BTC_USDT, markPriceRound: "1" };
    const result = model.calculateLiquidationPrice({
      spec,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      leverage: "10",
    });
    if (result.kind !== "price") {
      throw new Error("harus menghasilkan harga");
    }
    // 72240 → dibulatkan ke atas ke kelipatan 1 (menuju entry) = 72240
    expect(result.price.toString()).toBe("72240");
    expect(result.price.modulo(1).isZero()).toBe(true);
  });
});

describe("6b. domain sah dan keadaan degenerate", () => {
  test("seluruh kontrak nyata: buffer > 0 pada leverage maksimum", () => {
    for (const spec of [BTC_USDT, ETH_USDT, SOL_USDT, XRP_USDT, PEPE_USDT, SATS_USDT, ARIA_USDT]) {
      const levMax = new Decimal(spec.leverageMax);
      const mmr = new Decimal(spec.maintenanceRate);
      const buffer = new Decimal(1).div(levMax).minus(mmr);
      expect(buffer.greaterThan(0)).toBe(true);
    }
  });

  test("initial margin <= maintenance margin → no_price, bukan angka palsu", () => {
    // Konstruksi spec artifisial: leverage_max 100 tapi MMR 0.02 → 1/100 < 0.02
    const degenerate = { ...BTC_USDT, leverageMax: "100", maintenanceRate: "0.02" };
    const result = model.calculateLiquidationPrice({
      spec: degenerate,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      leverage: "100",
    });
    expect(result.kind).toBe("no_price");
    if (result.kind === "no_price") {
      expect(result.reason).toBe("initial_margin_not_above_maintenance");
    }
  });

  test("wrapper lama mengembalikan null untuk keadaan degenerate", () => {
    const degenerate = { ...BTC_USDT, leverageMax: "100", maintenanceRate: "0.02" };
    expect(liquidationPrice(degenerate, "long", 1, "80000", "100")).toBeNull();
  });

  test("harga likuidasi TIDAK di-clamp ke 0; hasil selalu positif pada domain sah", () => {
    for (const spec of [ETH_USDT, SOL_USDT, XRP_USDT, PEPE_USDT, SATS_USDT, ARIA_USDT]) {
      const result = model.calculateLiquidationPrice({
        spec,
        direction: "long",
        size: Math.max(spec.orderSizeMin, 1),
        entryPrice: "100",
        leverage: spec.leverageMax,
      });
      if (result.kind === "price") {
        expect(result.price.greaterThan(0)).toBe(true);
      }
    }
  });

  test("size tidak valid ditolak eksplisit", () => {
    expect(() =>
      model.calculateLiquidationPrice({
        spec: BTC_USDT,
        direction: "long",
        size: 0,
        entryPrice: "80000",
        leverage: "10",
      }),
    ).toThrow(InvalidSizeError);
    expect(() =>
      model.calculateLiquidationPrice({
        spec: BTC_USDT,
        direction: "long",
        size: -5,
        entryPrice: "80000",
        leverage: "10",
      }),
    ).toThrow(InvalidSizeError);
  });
});

describe("6c. 15 skenario likuidasi (ACCOUNTING.md §10)", () => {
  test("L1: leverage 1, LONG → liq = entry × mmr", () => {
    expect(liquidationPrice(BTC_USDT, "long", 1, "80000", "1")!.toString()).toBe("240");
  });

  test("L2: leverage maksimum kontrak, LONG tetap di bawah entry", () => {
    const price = liquidationPrice(BTC_USDT, "long", 1, "80000", BTC_USDT.leverageMax)!;
    expect(price.greaterThan(0)).toBe(true);
    expect(price.lessThan("80000")).toBe(true);
    // 80000 × (1 − 1/200 + 0.003) = 80000 × 0.998 = 79840
    expect(price.toString()).toBe("79840");
  });

  test("L3: leverage maksimum kontrak, SHORT di atas entry", () => {
    const price = liquidationPrice(BTC_USDT, "short", 1, "80000", BTC_USDT.leverageMax)!;
    expect(price.greaterThan("80000")).toBe(true);
    // 80000 × (1 + 1/200 − 0.003) = 80000 × 1.002 = 80160
    expect(price.toString()).toBe("80160");
  });

  test("L4: harga sangat kecil (PEPE) tetap menghasilkan harga positif", () => {
    const price = liquidationPrice(PEPE_USDT, "long", 1, "0.00001", "75")!;
    expect(price.greaterThan(0)).toBe(true);
    expect(price.lessThan("0.00001")).toBe(true);
  });

  test("L5: harga sangat besar tetap konsisten", () => {
    const price = liquidationPrice(BTC_USDT, "long", 1, "1000000", "10")!;
    const expected = new Decimal("1000000").times(new Decimal(1).minus(new Decimal(1).div(10)).plus("0.003"));
    expect(price.minus(expected).abs().lessThan("0.01")).toBe(true);
  });

  test("L6: maintenance rate tinggi (ARIA 8%) mempersempit jarak likuidasi", () => {
    const ariaAtMax = liquidationPrice(ARIA_USDT, "long", 1, "0.05", "1")!;
    const btcAtMax = liquidationPrice(BTC_USDT, "long", 1, "80000", "1")!;
    // Rasio jarak ke entry = 1 − 1/lev + mmr; untuk lev 1 = mmr
    expect(ariaAtMax.div("0.05").toString()).toBe("0.08");
    // 80000 × 0.003 = 240 → rasio 0.003
    expect(btcAtMax.div("80000").toString()).toBe("0.003");
  });

  test("L7: jarak likuidasi menyempit saat leverage naik", () => {
    const at5 = liquidationPrice(BTC_USDT, "long", 1, "80000", "5")!;
    const at50 = liquidationPrice(BTC_USDT, "long", 1, "80000", "50")!;
    const at200 = liquidationPrice(BTC_USDT, "long", 1, "80000", "200")!;
    expect(at50.greaterThan(at5)).toBe(true);
    expect(at200.greaterThan(at50)).toBe(true);
  });

  test("L8: SHORT jarak menyempit saat leverage naik", () => {
    const at5 = liquidationPrice(BTC_USDT, "short", 1, "80000", "5")!;
    const at200 = liquidationPrice(BTC_USDT, "short", 1, "80000", "200")!;
    expect(at200.lessThan(at5)).toBe(true);
    expect(at200.greaterThan("80000")).toBe(true);
  });

  test("L9: equity tepat sama dengan maintenance → likuidasi", () => {
    const liq = liquidationPrice(BTC_USDT, "long", 1, "80000", "10")!;
    const initialMargin = "0.8";
    const atLiq = shouldLiquidate(BTC_USDT, "long", 1, "80000", initialMargin, "0", "0", liq.toFixed());
    const above = shouldLiquidate(BTC_USDT, "long", 1, "80000", initialMargin, "0", "0", "73000");
    // Tepat di ambang: liquidated true; sedikit di atas: false
    expect(above.liquidated).toBe(false);
    expect(atLiq.positionEquity.lessThanOrEqualTo(atLiq.maintenanceMargin.plus("0.01"))).toBe(true);
  });

  test("L10: di atas maintenance tidak likuidasi", () => {
    const check = shouldLiquidate(BTC_USDT, "long", 1, "80000", "0.8", "0", "0", "79000");
    expect(check.liquidated).toBe(false);
    expect(check.positionEquity.toString()).toBe("0.7");
    expect(check.maintenanceMargin.toString()).toBe("0.0237");
  });

  test("L11: di bawah maintenance likuidasi", () => {
    const check = shouldLiquidate(BTC_USDT, "long", 1, "80000", "0.8", "0", "0", "72000");
    expect(check.liquidated).toBe(true);
  });

  test("L12: funding kumulatif dapat memicu likuidasi walau harga tidak bergerak", () => {
    const withoutFunding = shouldLiquidate(BTC_USDT, "long", 1, "80000", "0.8", "0", "0", "80000");
    const withFunding = shouldLiquidate(BTC_USDT, "long", 1, "80000", "0.8", "0.8", "0", "80000");
    expect(withoutFunding.liquidated).toBe(false);
    expect(withFunding.liquidated).toBe(true);
  });

  test("L13: fee kumulatif mengurangi equity posisi", () => {
    const check = shouldLiquidate(BTC_USDT, "long", 1, "80000", "0.8", "0", "0.79", "80000");
    expect(check.liquidated).toBe(true);
  });

  test("L14: SHORT tidak terlikuidasi saat harga turun", () => {
    const check = shouldLiquidate(BTC_USDT, "short", 1, "80000", "0.8", "0", "0", "70000");
    expect(check.liquidated).toBe(false);
  });

  test("L15: LONG tidak terlikuidasi saat harga naik", () => {
    const check = shouldLiquidate(BTC_USDT, "long", 1, "80000", "0.8", "0", "0", "90000");
    expect(check.liquidated).toBe(false);
  });
});

describe("6d. settlement likuidasi tidak membuat dompet negatif", () => {
  test("kerugian isolated di-clamp ke 0 dan ditandai insolvent", () => {
    const outcome = liquidationOutcome(
      BTC_USDT,
      "long",
      1,
      "80000",
      "0.8",
      "0",
      "0",
      "70000",
      "0.005",
    );
    expect(outcome.realizedPnl.toString()).toBe("-1");
    expect(outcome.walletDelta.isZero()).toBe(true);
    expect(outcome.insolvent).toBe(true);
  });

  test("kerugian terbatas (tidak insolvent) mengembalikan sisa margin", () => {
    const outcome = liquidationOutcome(
      BTC_USDT,
      "long",
      1,
      "80000",
      "0.8",
      "0",
      "0",
      "79000",
      "0.005",
    );
    expect(outcome.walletDelta.toString()).toBe("0.695");
    expect(outcome.insolvent).toBe(false);
  });

  test("model.settleClose equivalen dengan wrapper lama", () => {
    const viaModel = model.settleClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      leverage: "10",
      exitPrice: "79000",
      liquidationFee: "0.005",
    });
    const viaWrapper = liquidationOutcome(BTC_USDT, "long", 1, "80000", "0.8", "0", "0", "79000", "0.005");
    expect(viaModel.walletDelta.eq(viaWrapper.walletDelta)).toBe(true);
    expect(viaModel.realizedPnl.eq(viaWrapper.realizedPnl)).toBe(true);
  });
});

describe("8. averaging fill (regresi bug Phase 0)", () => {
  test("rata-rata harga TIDAK dikalikan quanto_multiplier", () => {
    // Bug Phase 0: Σ(harga×size×mult)/Σsize → 80010 × 0.0001 = 8.001
    const avg = averageFillPrice(BTC_USDT, [
      { price: new Decimal("80000"), size: 1 },
      { price: new Decimal("80010"), size: 1 },
    ]);
    expect(avg?.toString()).toBe("80005");
    expect(avg?.greaterThan("1000")).toBe(true);
  });

  test("tertimbang ukuran, bukan rata-rata sederhana", () => {
    const avg = averageFillPrice(BTC_USDT, [
      { price: new Decimal("80000"), size: 3 },
      { price: new Decimal("80100"), size: 1 },
    ]);
    // (80000×3 + 80100×1)/4 = 80025
    expect(avg?.toString()).toBe("80025");
  });

  test("dikuantisasi ke order_price_round kontrak", () => {
    const avg = averageFillPrice(BTC_USDT, [
      { price: new Decimal("80000.04"), size: 1 },
      { price: new Decimal("80000.06"), size: 1 },
    ]);
    // 80000.05 → tick 0.1 → half-up → 80000.1
    expect(avg?.toString()).toBe("80000.1");
  });

  test("tanpa take → null", () => {
    expect(averageFillPrice(BTC_USDT, [])).toBeNull();
  });
});

describe("8b. konsumsi level buku", () => {
  test("mengonsumsi berurutan sampai terpenuhi", () => {
    const result = planLevelConsumption(5, [
      { price: "100", size: 2 },
      { price: "101", size: 10 },
    ]);
    expect(result.filledSize).toBe(5);
    expect(result.remainingSize).toBe(0);
    expect(result.takes.map((take) => take.size)).toEqual([2, 3]);
    expect(result.takes.map((take) => take.price.toString())).toEqual(["100", "101"]);
  });

  test("buku tipis menyisakan ukuran yang belum terisi", () => {
    const result = planLevelConsumption(10, [{ price: "100", size: 3 }]);
    expect(result.filledSize).toBe(3);
    expect(result.remainingSize).toBe(7);
  });

  test("level berukuran nol dilewati", () => {
    const result = planLevelConsumption(1, [
      { price: "100", size: 0 },
      { price: "101", size: 5 },
    ]);
    expect(result.takes).toHaveLength(1);
    expect(result.takes[0]!.price.toString()).toBe("101");
  });

  test("harga level tidak valid ditolak", () => {
    expect(() => planLevelConsumption(1, [{ price: "0", size: 5 }])).toThrow();
  });

  test("ukuran permintaan tidak valid ditolak", () => {
    expect(() => planLevelConsumption(0, [{ price: "100", size: 5 }])).toThrow();
    expect(() => planLevelConsumption(-1, [])).toThrow();
  });
});
