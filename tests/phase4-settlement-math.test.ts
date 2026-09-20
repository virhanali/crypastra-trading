import { describe, expect, test } from "bun:test";
import {
  closingSide,
  Decimal,
  executionPriceFor,
  fundingDueFor,
  fundingIdempotencyKey,
  fundingPaymentAtMark,
  InvalidPriceError,
  settleIsolatedClose,
  settlementIdempotencyKey,
} from "../packages/core/src/index.js";
import { ARIA_USDT, BTC_USDT, SOL_USDT } from "./helpers/fixtures.js";

describe("9 & 11. settlement penutupan isolated", () => {
  test("close untung: seluruh margin dilepas, PnL masuk wallet penuh", () => {
    const settlement = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      exitPrice: "81000",
      initialMargin: "0.8",
    });
    expect(settlement.realizedPnl.toString()).toBe("0.1");
    expect(settlement.releasedMargin.toString()).toBe("0.8");
    expect(settlement.pnlAppliedToWallet.toString()).toBe("0.1");
    expect(settlement.deficit.isZero()).toBe(true);
    expect(settlement.insolvent).toBe(false);
  });

  test("close rugi dalam batas margin: kerugian dibebankan penuh, tanpa defisit", () => {
    const settlement = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      exitPrice: "79000",
      initialMargin: "0.8",
    });
    expect(settlement.realizedPnl.toString()).toBe("-0.1");
    expect(settlement.pnlAppliedToWallet.toString()).toBe("-0.1");
    expect(settlement.deficit.isZero()).toBe(true);
  });

  test("rugi TEPAT sebesar margin: tidak ada defisit", () => {
    const settlement = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      exitPrice: "72000",
      initialMargin: "0.8",
    });
    // 1 × 0.0001 × (72000−80000) = −0.8
    expect(settlement.realizedPnl.toString()).toBe("-0.8");
    expect(settlement.pnlAppliedToWallet.toString()).toBe("-0.8");
    expect(settlement.deficit.isZero()).toBe(true);
    expect(settlement.insolvent).toBe(false);
  });

  test("rugi MELEBIHI margin (gap): kerugian kas dibatasi, defisit dicatat", () => {
    const settlement = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      exitPrice: "70000",
      initialMargin: "0.8",
    });
    // PnL sebenarnya −1.0, margin hanya 0.8 → defisit 0.2
    expect(settlement.realizedPnl.toString()).toBe("-1");
    expect(settlement.pnlAppliedToWallet.toString()).toBe("-0.8");
    expect(settlement.deficit.toString()).toBe("0.2");
    expect(settlement.insolvent).toBe(true);
  });

  test("SHORT gap ke atas juga dibatasi", () => {
    const settlement = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "short",
      size: 2,
      entryPrice: "80000",
      exitPrice: "85000",
      initialMargin: "1.6",
    });
    // 2 × 0.0001 × (80000−85000) = −1.0, margin 1.6 → tidak insolvent
    expect(settlement.realizedPnl.toString()).toBe("-1");
    expect(settlement.pnlAppliedToWallet.toString()).toBe("-1");
    expect(settlement.deficit.isZero()).toBe(true);

    const worse = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "short",
      size: 2,
      entryPrice: "80000",
      exitPrice: "90000",
      initialMargin: "1.6",
    });
    // 2 × 0.0001 × (−10000) = −2.0, margin 1.6 → defisit 0.4
    expect(worse.realizedPnl.toString()).toBe("-2");
    expect(worse.deficit.toString()).toBe("0.4");
    expect(worse.insolvent).toBe(true);
  });

  test("invariant: kas yang dibebankan tidak pernah melebihi margin", () => {
    const margin = new Decimal("0.8");
    for (const exit of ["100", "1", "50000", "79000", "0.01"]) {
      const settlement = settleIsolatedClose({
        spec: BTC_USDT,
        direction: "long",
        size: 1,
        entryPrice: "80000",
        exitPrice: exit,
        initialMargin: margin,
      });
      expect(settlement.pnlAppliedToWallet.greaterThanOrEqualTo(margin.negated())).toBe(true);
      expect(settlement.deficit.greaterThanOrEqualTo(0)).toBe(true);
      // Konservasi: kas menyerap min(PnL, −margin); sisanya menjadi defisit.
      // Maka: PnL sebenarnya = porsi kas − defisit.
      expect(settlement.pnlAppliedToWallet.minus(settlement.deficit).eq(settlement.realizedPnl)).toBe(true);
      // Dan kas tidak pernah dibebani lebih dari margin.
      expect(settlement.pnlAppliedToWallet.eq(Decimal.max(settlement.realizedPnl, margin.negated()))).toBe(true);
    }
  });

  test("multiplier heterogen dihormati", () => {
    const settlement = settleIsolatedClose({
      spec: SOL_USDT,
      direction: "long",
      size: 3,
      entryPrice: "150",
      exitPrice: "140",
      initialMargin: "45",
    });
    // 3 × 1 × (140−150) = −30
    expect(settlement.realizedPnl.toString()).toBe("-30");
    expect(settlement.deficit.isZero()).toBe(true);
  });

  test("harga keluar tidak valid ditolak", () => {
    expect(() =>
      settleIsolatedClose({ spec: BTC_USDT, direction: "long", size: 1, entryPrice: "80000", exitPrice: "0", initialMargin: "0.8" }),
    ).toThrow(InvalidPriceError);
  });
});

describe("8. harga eksekusi tidak sama dengan harga trigger", () => {
  test("LONG ditutup di BID, SHORT di ASK", () => {
    const quote = { contract: "BTC_USDT", bidPrice: "74900", askPrice: "74910" };
    expect(executionPriceFor("long", quote).toString()).toBe("74900");
    expect(executionPriceFor("short", quote).toString()).toBe("74910");
  });

  test("gap: SL 78000 tapi eksekusi di 74900 (bukan 78000)", () => {
    // Mark 75000 (melewati SL), kutipan bid 74900.
    const quote = { contract: "BTC_USDT", bidPrice: "74900", askPrice: "74910" };
    const price = executionPriceFor("long", quote);
    expect(price.toString()).not.toBe("78000");
    expect(price.toString()).toBe("74900");

    const settlement = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      exitPrice: price,
      initialMargin: "0.8",
    });
    // Rugi dihitung dari harga EKSEKUSI, bukan harga trigger:
    //   1 × 0.0001 × (74900 − 80000) = −0.51
    // Kalau (salah) memakai harga trigger 78000, hasilnya −0.2.
    expect(settlement.realizedPnl.toString()).toBe("-0.51");
    expect(settlement.realizedPnl.isZero()).toBe(false);
    // −0.51 masih di dalam margin 0.8, jadi belum ada defisit.
    expect(settlement.deficit.isZero()).toBe(true);
    expect(settlement.pnlAppliedToWallet.toString()).toBe("-0.51");

    // Gap yang benar-benar melewati seluruh margin → defisit tercatat.
    const deeper = settleIsolatedClose({
      spec: BTC_USDT,
      direction: "long",
      size: 1,
      entryPrice: "80000",
      exitPrice: "70000",
      initialMargin: "0.8",
    });
    expect(deeper.deficit.toString()).toBe("0.2");
    expect(deeper.insolvent).toBe(true);
  });

  test("kutipan tidak valid ditolak", () => {
    expect(() => executionPriceFor("long", { contract: "BTC_USDT", bidPrice: "0", askPrice: "1" })).toThrow();
    expect(() => executionPriceFor("short", { contract: "BTC_USDT", bidPrice: "1", askPrice: "-1" })).toThrow();
  });

  test("closingSide: long→sell, short→buy", () => {
    expect(closingSide("long")).toBe("sell");
    expect(closingSide("short")).toBe("buy");
  });
});

describe("5. kebijakan funding (murni)", () => {
  test("due bila posisi dibuka sebelum atau tepat pada timestamp funding", () => {
    expect(fundingDueFor({ positionOpenedAtMs: 100, fundingTimestampMs: 200 })).toBe(true);
    expect(fundingDueFor({ positionOpenedAtMs: 200, fundingTimestampMs: 200 })).toBe(true);
    expect(fundingDueFor({ positionOpenedAtMs: 201, fundingTimestampMs: 200 })).toBe(false);
  });

  test("kunci idempotensi deterministik dan unik per posisi/timestamp", () => {
    expect(fundingIdempotencyKey("BTC_USDT", 1000, "pos1")).toBe("funding:BTC_USDT:1000:pos1");
    expect(fundingIdempotencyKey("BTC_USDT", 1000, "pos1")).not.toBe(
      fundingIdempotencyKey("BTC_USDT", 2000, "pos1"),
    );
    expect(fundingIdempotencyKey("BTC_USDT", 1000, "pos1")).not.toBe(
      fundingIdempotencyKey("BTC_USDT", 1000, "pos2"),
    );
  });

  test("kunci settlement deterministik per efek", () => {
    expect(settlementIdempotencyKey("liquidation", "pos1", "pnl")).toBe("settle:pos1:liquidation:pnl");
    expect(settlementIdempotencyKey("stop_loss", "pos1", "fee")).toBe("settle:pos1:stop_loss:fee");
    expect(settlementIdempotencyKey("liquidation", "pos1", "fee")).not.toBe(
      settlementIdempotencyKey("liquidation", "pos1", "pnl"),
    );
  });

  test("payment: long membayar saat rate positif, short menerima", () => {
    const long = fundingPaymentAtMark({ spec: BTC_USDT, direction: "long", size: 10, markPrice: "80000", rate: "0.0001" });
    const short = fundingPaymentAtMark({ spec: BTC_USDT, direction: "short", size: 10, markPrice: "80000", rate: "0.0001" });
    // 10 × 0.0001 × 80000 = 80 notional × 0.0001 = 0.008
    expect(long.toString()).toBe("0.008");
    expect(short.toString()).toBe("-0.008");
    expect(long.plus(short).isZero()).toBe(true);
  });

  test("rate negatif membalik arah", () => {
    expect(fundingPaymentAtMark({ spec: BTC_USDT, direction: "long", size: 10, markPrice: "80000", rate: "-0.0001" }).isNegative()).toBe(true);
    expect(fundingPaymentAtMark({ spec: BTC_USDT, direction: "short", size: 10, markPrice: "80000", rate: "-0.0001" }).isPositive()).toBe(true);
  });

  test("multiplier heterogen dihormati", () => {
    const amount = fundingPaymentAtMark({ spec: ARIA_USDT, direction: "long", size: 2, markPrice: "0.05", rate: "0.001" });
    // 2 × 100 × 0.05 = 10 notional × 0.001 = 0.01
    expect(amount.toString()).toBe("0.01");
  });
});
