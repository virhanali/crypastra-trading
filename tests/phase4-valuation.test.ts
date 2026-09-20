import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STALENESS_POLICY,
  Decimal,
  InvalidPriceError,
  markFreshness,
  MarkSnapshotSchema,
  parseMarkSnapshot,
  totalUnrealized,
  valuateAccount,
  valuatePosition,
} from "../packages/core/src/index.js";
import { BTC_USDT, ETH_USDT, SOL_USDT } from "./helpers/fixtures.js";

const position = (over: Partial<Parameters<typeof valuatePosition>[0]["position"]> = {}) => ({
  id: "pos1",
  direction: "long" as const,
  size: 1,
  entryPrice: "80000",
  leverage: "10",
  initialMargin: "0.8",
  accumulatedFunding: "0",
  feesPaid: "0",
  ...over,
});

describe("3. MarkSnapshot", () => {
  test("parse valid snapshot", () => {
    const snapshot = parseMarkSnapshot({
      contract: "BTC_USDT",
      markPrice: "80123.45",
      observedAtMs: 1000,
      sourceTimestampMs: 990,
      funding: null,
    });
    expect(snapshot.contract).toBe("BTC_USDT");
    expect(snapshot.markPrice).toBe("80123.45");
    expect(snapshot.funding).toBeNull();
  });

  test("funding opsional dan tervalidasi", () => {
    const snapshot = parseMarkSnapshot({
      contract: "BTC_USDT",
      markPrice: "80000",
      observedAtMs: 1,
      sourceTimestampMs: 1,
      funding: { fundingRate: "-0.0001", fundingTimestampMs: 500, intervalSeconds: 28800 },
    });
    expect(snapshot.funding!.fundingRate).toBe("-0.0001");
    expect(() =>
      parseMarkSnapshot({
        contract: "BTC_USDT",
        markPrice: "80000",
        observedAtMs: 1,
        sourceTimestampMs: 1,
        funding: { fundingRate: "-0.0001", fundingTimestampMs: -5, intervalSeconds: 28800 },
      }),
    ).toThrow();
  });

  test("snapshot tanpa kontrak / harga ditolak (strict)", () => {
    expect(() => MarkSnapshotSchema.parse({ markPrice: "1", observedAtMs: 1, sourceTimestampMs: 1 })).toThrow();
    expect(() =>
      MarkSnapshotSchema.parse({ contract: "BTC_USDT", observedAtMs: 1, sourceTimestampMs: 1 }),
    ).toThrow();
    // Field asing ditolak.
    expect(() =>
      MarkSnapshotSchema.parse({
        contract: "BTC_USDT",
        markPrice: "1",
        observedAtMs: 1,
        sourceTimestampMs: 1,
        lastPrice: "2",
      }),
    ).toThrow();
  });

  test("mark price tidak boleh <= 0 saat dipakai valuasi", () => {
    expect(() =>
      valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "0" }),
    ).toThrow(InvalidPriceError);
    expect(() =>
      valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "-1" }),
    ).toThrow(InvalidPriceError);
  });
});

describe("2. staleness mark", () => {
  test("segar di dalam ambang", () => {
    const fresh = markFreshness({ observedAtMs: 1000, sourceTimestampMs: 990 }, { maxStalenessMs: 5000 });
    expect(fresh.ageMs).toBe(10);
    expect(fresh.stale).toBe(false);
  });

  test("tepat pada ambang masih segar, lewat ambang jadi basi", () => {
    const policy = { maxStalenessMs: 100 };
    expect(markFreshness({ observedAtMs: 100, sourceTimestampMs: 0 }, policy).stale).toBe(false);
    expect(markFreshness({ observedAtMs: 101, sourceTimestampMs: 0 }, policy).stale).toBe(true);
  });

  test("timestamp sumber di masa depan dianggap TIDAK valid (basi)", () => {
    const future = markFreshness({ observedAtMs: 100, sourceTimestampMs: 200 }, DEFAULT_STALENESS_POLICY);
    expect(future.ageMs).toBe(-100);
    expect(future.stale).toBe(true);
  });
});

describe("1 & 14. valuasi posisi", () => {
  test("LONG: mark naik → upnl positif; mark turun → negatif", () => {
    const up = valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "81000" });
    expect(up.unrealizedPnl.toString()).toBe("0.1");
    const down = valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "79000" });
    expect(down.unrealizedPnl.toString()).toBe("-0.1");
  });

  test("SHORT: mark turun → upnl positif", () => {
    const valuation = valuatePosition({
      spec: BTC_USDT,
      position: position({ direction: "short" }),
      markPrice: "79000",
    });
    expect(valuation.unrealizedPnl.toString()).toBe("0.1");
  });

  test("upnl = 0 saat mark == entry", () => {
    expect(valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "80000" }).unrealizedPnl.isZero()).toBe(true);
  });

  test("maintenance margin memakai mark, bukan entry", () => {
    const atEntry = valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "80000" });
    const higher = valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "90000" });
    expect(atEntry.maintenanceMargin.toString()).toBe("0.024");
    expect(higher.maintenanceMargin.toString()).toBe("0.027");
  });

  test("initial margin diambil dari posisi, tidak dihitung ulang", () => {
    const valuation = valuatePosition({ spec: BTC_USDT, position: position({ initialMargin: "1.23" }), markPrice: "81000" });
    expect(valuation.initialMargin.toString()).toBe("1.23");
  });

  test("liquidation state: healthy pada mark jauh, liquidatable saat mark melewati harga likuidasi", () => {
    const healthy = valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "80000" });
    expect(healthy.liquidationState).toBe("healthy");
    expect(healthy.liquidationPrice!.toString()).toBe("72240");

    // Mark di bawah harga likuidasi → posisi likuidatable.
    const doomed = valuatePosition({ spec: BTC_USDT, position: position(), markPrice: "72000" });
    expect(doomed.liquidationState).toBe("liquidatable");
  });

  test("multiplier heterogen dihormati", () => {
    const sol = valuatePosition({
      spec: SOL_USDT,
      position: { id: "p", direction: "long", size: 2, entryPrice: "150", leverage: "10", initialMargin: "30", accumulatedFunding: "0", feesPaid: "0" },
      markPrice: "160",
    });
    // 2 × 1 × 10 = 20
    expect(sol.unrealizedPnl.toString()).toBe("20");
  });

  test("funding/fee kumulatif masuk position equity", () => {
    const valuation = valuatePosition({
      spec: BTC_USDT,
      position: position({ accumulatedFunding: "0.5", feesPaid: "0.1" }),
      markPrice: "80000",
    });
    // equity posisi = 0.8 + 0 − 0.6 = 0.2
    expect(valuation.positionEquity.toString()).toBe("0.2");
    // PnL belum realisasi TIDAK dipengaruhi funding.
    expect(valuation.unrealizedPnl.isZero()).toBe(true);
  });
});

describe("14 & 15. valuasi akun", () => {
  test("equity = wallet + unrealized; identity totalUnrealized", () => {
    const valuations = [
      valuatePosition({ spec: BTC_USDT, position: position({ id: "a" }), markPrice: "81000" }),
      valuatePosition({
        spec: ETH_USDT,
        position: { id: "b", direction: "short", size: 1, entryPrice: "3000", leverage: "10", initialMargin: "3", accumulatedFunding: "0", feesPaid: "0" },
        markPrice: "2900",
      }),
      valuatePosition({
        spec: SOL_USDT,
        position: { id: "c", direction: "long", size: 5, entryPrice: "150", leverage: "10", initialMargin: "75", accumulatedFunding: "0", feesPaid: "0" },
        markPrice: "152",
      }),
    ];
    const total = totalUnrealized(valuations);
    // BTC +0.1, ETH +1 (1 × 0.01 × 100), SOL +10 (5 × 1 × 2)
    expect(total.toString()).toBe("11.1");

    const account = valuateAccount(
      { walletBalance: "10000", positionMargin: "78.8", reservedMargin: "5" },
      total,
    );
    expect(account.equity.eq(new Decimal("10000").plus(total))).toBe(true);
    expect(account.unrealizedPnl.eq(total)).toBe(true);
  });

  test("available balance TIDAK memasukkan unrealized profit", () => {
    const account = valuateAccount(
      { walletBalance: "1000", positionMargin: "80", reservedMargin: "20" },
      "500",
    );
    // 1000 − 80 − 20 = 900, bukan 1400.
    expect(account.availableBalance.toString()).toBe("900");
    expect(account.equity.toString()).toBe("1500");
  });

  test("unrealized loss menurunkan equity dan menaikkan margin ratio", () => {
    const account = valuateAccount(
      { walletBalance: "1000", positionMargin: "500", reservedMargin: "0" },
      "-400",
    );
    expect(account.equity.toString()).toBe("600");
    // 500 / 600 = 0.83333333
    expect(account.marginRatio!.toString()).toBe("0.83333333");
  });

  test("available dibulatkan ke bawah (konservatif)", () => {
    const account = valuateAccount(
      { walletBalance: "100.123456789", positionMargin: "10", reservedMargin: "5" },
      "0",
    );
    expect(account.availableBalance.toString()).toBe("85.12345678");
  });

  test("margin ratio null saat equity nol", () => {
    expect(
      valuateAccount({ walletBalance: "0", positionMargin: "10", reservedMargin: "0" }, "0").marginRatio,
    ).toBeNull();
  });

  test("account upnl == Σ position upnl", () => {
    const marks = new Map<string, string>([["BTC_USDT", "81000"], ["SOL_USDT", "148"]]);
    const valuations = [
      valuatePosition({ spec: BTC_USDT, position: position({ id: "a" }), markPrice: marks.get("BTC_USDT")! }),
      valuatePosition({
        spec: SOL_USDT,
        position: { id: "c", direction: "long", size: 5, entryPrice: "150", leverage: "10", initialMargin: "75", accumulatedFunding: "0", feesPaid: "0" },
        markPrice: marks.get("SOL_USDT")!,
      }),
    ];
    const account = valuateAccount(
      { walletBalance: "1000", positionMargin: "75.8", reservedMargin: "0" },
      totalUnrealized(valuations),
    );
    const manual = valuations.reduce((sum, valuation) => sum.plus(valuation.unrealizedPnl), new Decimal(0));
    expect(account.unrealizedPnl.eq(manual)).toBe(true);
  });
});
