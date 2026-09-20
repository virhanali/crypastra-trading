import { describe, expect, test } from "bun:test";
import {
  Decimal,
  directionForSide,
  InvalidOrderError,
  planPositionTransition,
  reduceOnlySize,
  type PositionSnapshot,
} from "../packages/core/src/index.js";
import { ARIA_USDT, BTC_USDT, ETH_USDT, SOL_USDT, XRP_USDT } from "./helpers/fixtures.js";

const snap = (direction: "long" | "short", size: number, entryPrice: string, initialMargin: string, leverage = "10"): PositionSnapshot => ({
  direction,
  size,
  entryPrice,
  initialMargin,
  leverage,
});

describe("9 & 10. transisi posisi (murni)", () => {
  test("tanpa posisi → open", () => {
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: null,
      fillSide: "buy",
      fillSize: 3,
      fillPrice: "80000",
    });
    expect(plan.kind).toBe("open");
    expect(plan.closedSize).toBe(0);
    expect(plan.openedSize).toBe(3);
    expect(plan.realizedPnl.isZero()).toBe(true);
    expect(plan.result!.direction).toBe("long");
    expect(plan.result!.size).toBe(3);
    // 3 × 0.0001 × 80000 = 24 notional / 10 = 2.4
    expect(plan.openedMargin.toString()).toBe("2.4");
  });

  test("searah → increase dengan entry rata-rata tertimbang", () => {
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("long", 1, "80000", "0.8"),
      fillSide: "buy",
      fillSize: 1,
      fillPrice: "81000",
    });
    expect(plan.kind).toBe("increase");
    expect(plan.result!.size).toBe(2);
    // (0.0001×80000 + 0.0001×81000) / 0.0002 = 80500
    expect(plan.result!.entryPrice.toString()).toBe("80500");
    // margin = 0.8 + (0.0001×81000/10 = 0.81) = 1.61
    expect(plan.result!.initialMargin.toString()).toBe("1.61");
    expect(plan.realizedPnl.isZero()).toBe(true);
  });

  test("increase dengan harga sama tidak menggeser entry", () => {
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("long", 5, "80000", "4"),
      fillSide: "buy",
      fillSize: 5,
      fillPrice: "80000",
    });
    expect(plan.result!.entryPrice.toString()).toBe("80000");
    expect(plan.result!.size).toBe(10);
  });

  test("berlawanan lebih kecil → reduce, PnL realisasi, margin dilepas proporsional", () => {
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("long", 10, "80000", "8"),
      fillSide: "sell",
      fillSize: 4,
      fillPrice: "81000",
    });
    expect(plan.kind).toBe("reduce");
    expect(plan.closedSize).toBe(4);
    expect(plan.openedSize).toBe(0);
    // 4 × 0.0001 × (81000−80000) = 0.4
    expect(plan.realizedPnl.toString()).toBe("0.4");
    // margin dilepas = 8 × 4/10 = 3.2
    expect(plan.releasedMargin.toString()).toBe("3.2");
    expect(plan.result!.size).toBe(6);
    expect(plan.result!.initialMargin.toString()).toBe("4.8");
    expect(plan.result!.entryPrice.toString()).toBe("80000");
  });

  test("berlawanan sama besar → close penuh, seluruh margin dilepas", () => {
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("long", 7, "80000", "5.6"),
      fillSide: "sell",
      fillSize: 7,
      fillPrice: "79000",
    });
    expect(plan.kind).toBe("close");
    expect(plan.result).toBeNull();
    expect(plan.closesOldPosition).toBe(true);
    expect(plan.releasedMargin.toString()).toBe("5.6");
    // 7 × 0.0001 × (79000−80000) = −0.7
    expect(plan.realizedPnl.toString()).toBe("-0.7");
  });

  test("berlawanan lebih besar → flip: close penuh + open sisa arah baru", () => {
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("long", 3, "80000", "2.4"),
      fillSide: "sell",
      fillSize: 10,
      fillPrice: "81000",
    });
    expect(plan.kind).toBe("flip");
    expect(plan.closedSize).toBe(3);
    expect(plan.openedSize).toBe(7);
    expect(plan.closesOldPosition).toBe(true);
    // PnL dari 3 kontrak: 3 × 0.0001 × 1000 = 0.3
    expect(plan.realizedPnl.toString()).toBe("0.3");
    // Seluruh margin lama dilepas.
    expect(plan.releasedMargin.toString()).toBe("2.4");
    // Posisi baru SHORT 7 kontrak.
    expect(plan.result!.direction).toBe("short");
    expect(plan.result!.size).toBe(7);
    expect(plan.result!.entryPrice.toString()).toBe("81000");
    // margin baru = 7 × 0.0001 × 81000 / 10 = 5.67
    expect(plan.result!.initialMargin.toString()).toBe("5.67");
  });

  test("SHORT: increase, reduce, close, dan flip simetris", () => {
    const increase = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("short", 1, "80000", "0.8"),
      fillSide: "sell",
      fillSize: 1,
      fillPrice: "79000",
    });
    expect(increase.kind).toBe("increase");
    expect(increase.result!.entryPrice.toString()).toBe("79500");
    expect(increase.result!.direction).toBe("short");

    const reduce = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("short", 10, "80000", "8"),
      fillSide: "buy",
      fillSize: 4,
      fillPrice: "79000",
    });
    expect(reduce.kind).toBe("reduce");
    // SHORT untung saat harga turun: 4 × 0.0001 × (80000−79000) = 0.4
    expect(reduce.realizedPnl.toString()).toBe("0.4");

    const flip = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing: snap("short", 2, "80000", "1.6"),
      fillSide: "buy",
      fillSize: 5,
      fillPrice: "78000",
    });
    expect(flip.kind).toBe("flip");
    expect(flip.result!.direction).toBe("long");
    expect(flip.result!.size).toBe(3);
    // 2 × 0.0001 × (80000−78000) = 0.4
    expect(flip.realizedPnl.toString()).toBe("0.4");
  });

  test("ukuran posisi tidak pernah negatif pada semua transisi", () => {
    const cases = [
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: null, fillSide: "buy", fillSize: 1, fillPrice: "80000" }),
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: snap("long", 5, "80000", "4"), fillSide: "buy", fillSize: 2, fillPrice: "80000" }),
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: snap("long", 5, "80000", "4"), fillSide: "sell", fillSize: 2, fillPrice: "80000" }),
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: snap("long", 5, "80000", "4"), fillSide: "sell", fillSize: 5, fillPrice: "80000" }),
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: snap("long", 5, "80000", "4"), fillSide: "sell", fillSize: 9, fillPrice: "80000" }),
    ];
    for (const plan of cases) {
      if (plan.result !== null) {
        expect(plan.result.size).toBeGreaterThan(0);
      }
    }
  });

  test("multiplier heterogen dihormati (SOL qm=1, XRP qm=10, ETH qm=0.01)", () => {
    const sol = planPositionTransition({
      spec: SOL_USDT,
      leverage: "10",
      existing: null,
      fillSide: "buy",
      fillSize: 10,
      fillPrice: "150",
    });
    // 10 × 1 × 150 = 1500 / 10 = 150
    expect(sol.openedMargin.toString()).toBe("150");

    const xrp = planPositionTransition({
      spec: XRP_USDT,
      leverage: "10",
      existing: null,
      fillSide: "buy",
      fillSize: 3,
      fillPrice: "2.5",
    });
    // 3 × 10 × 2.5 = 75 / 10 = 7.5
    expect(xrp.openedMargin.toString()).toBe("7.5");

    const eth = planPositionTransition({
      spec: ETH_USDT,
      leverage: "10",
      existing: null,
      fillSide: "buy",
      fillSize: 1,
      fillPrice: "3000",
    });
    // 1 × 0.01 × 3000 = 30 / 10 = 3
    expect(eth.openedMargin.toString()).toBe("3");
  });

  test("entry rata-rata eksak, tanpa pembulatan antara", () => {
    const plan = planPositionTransition({
      spec: ARIA_USDT,
      leverage: "10",
      existing: snap("long", 3, "0.05", "1.5"),
      fillSide: "buy",
      fillSize: 1,
      fillPrice: "0.06",
    });
    // (300×0.05 + 100×0.06)/400 = 21/400 = 0.0525
    expect(plan.result!.entryPrice.toString()).toBe("0.0525");
  });

  test("leverage berbeda pada satu posisi ditolak", () => {
    expect(() =>
      planPositionTransition({
        spec: BTC_USDT,
        leverage: "20",
        existing: snap("long", 1, "80000", "0.8", "10"),
        fillSide: "buy",
        fillSize: 1,
        fillPrice: "80000",
      }),
    ).toThrow(InvalidOrderError);
  });

  test("input tidak valid ditolak", () => {
    expect(() =>
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: null, fillSide: "buy", fillSize: 0, fillPrice: "80000" }),
    ).toThrow();
    expect(() =>
      planPositionTransition({ spec: BTC_USDT, leverage: "10", existing: null, fillSide: "buy", fillSize: 1, fillPrice: "0" }),
    ).toThrow();
  });
});

describe("reduce_only", () => {
  test("membatasi ukuran pada eksposur yang bisa ditutup", () => {
    expect(
      reduceOnlySize({ spec: BTC_USDT, existing: snap("long", 5, "80000", "4"), fillSide: "sell", requestedSize: 8 }),
    ).toBe(5);
    expect(
      reduceOnlySize({ spec: BTC_USDT, existing: snap("long", 5, "80000", "4"), fillSide: "sell", requestedSize: 2 }),
    ).toBe(2);
  });

  test("searah posisi → 0 (akan menambah eksposur)", () => {
    expect(
      reduceOnlySize({ spec: BTC_USDT, existing: snap("long", 5, "80000", "4"), fillSide: "buy", requestedSize: 3 }),
    ).toBe(0);
  });

  test("tanpa posisi → 0", () => {
    expect(reduceOnlySize({ spec: BTC_USDT, existing: null, fillSide: "sell", requestedSize: 3 })).toBe(0);
  });
});

describe("directionForSide", () => {
  test("buy → long, sell → short", () => {
    expect(directionForSide("buy")).toBe("long");
    expect(directionForSide("sell")).toBe("short");
  });
});

describe("konservasi margin pada transisi", () => {
  test("increase menambah margin tepat sebesar margin fill", () => {
    const existing = snap("long", 4, "80000", "3.2");
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing,
      fillSide: "buy",
      fillSize: 2,
      fillPrice: "80000",
    });
    const delta = plan.result!.initialMargin.minus(existing.initialMargin);
    expect(delta.eq(plan.openedMargin)).toBe(true);
  });

  test("reduce melepas margin, sisanya tidak melebihi margin lama", () => {
    const existing = snap("long", 7, "80000", "5.6");
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing,
      fillSide: "sell",
      fillSize: 3,
      fillPrice: "80000",
    });
    expect(plan.releasedMargin.plus(plan.result!.initialMargin).lte(existing.initialMargin)).toBe(true);
    expect(plan.releasedMargin.lte(existing.initialMargin)).toBe(true);
  });

  test("close melepas seluruh margin lama", () => {
    const existing = snap("long", 7, "80000", "5.6");
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing,
      fillSide: "sell",
      fillSize: 7,
      fillPrice: "80500",
    });
    expect(plan.releasedMargin.eq(new Decimal(existing.initialMargin))).toBe(true);
  });

  test("flip melepas seluruh margin lama dan membuka margin baru", () => {
    const existing = snap("short", 4, "80000", "3.2");
    const plan = planPositionTransition({
      spec: BTC_USDT,
      leverage: "10",
      existing,
      fillSide: "buy",
      fillSize: 6,
      fillPrice: "79000",
    });
    expect(plan.releasedMargin.eq(new Decimal(existing.initialMargin))).toBe(true);
    expect(plan.openedMargin.greaterThan(0)).toBe(true);
  });
});
