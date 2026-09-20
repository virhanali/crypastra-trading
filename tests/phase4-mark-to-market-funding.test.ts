import { afterEach, describe, expect, test } from "bun:test";
import { Decimal, parseMarkSnapshot } from "../packages/core/src/index.js";
import { MarkToMarketService } from "../apps/server/src/services/mark-to-market-service.js";
import { btcBook, book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT, ETH_USDT, SOL_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function setup(balance = "10000"): ExchangeHarness {
  const h = setupExchange({ initialBalance: balance, specs: [BTC_USDT, ETH_USDT, SOL_USDT], startMs: 1_700_000_000_000 });
  harnesses.push(h);
  return h;
}

function mark(h: ExchangeHarness, contract: string, price: string, options: {
  fundingTimestampMs?: number;
  fundingRate?: string;
  intervalSeconds?: number;
  sourceOffsetMs?: number;
} = {}) {
  return parseMarkSnapshot({
    contract,
    markPrice: price,
    observedAtMs: h.now(),
    sourceTimestampMs: h.now() - (options.sourceOffsetMs ?? 0),
    funding:
      options.fundingTimestampMs === undefined
        ? null
        : {
            fundingRate: options.fundingRate ?? "0.0001",
            fundingTimestampMs: options.fundingTimestampMs,
            intervalSeconds: options.intervalSeconds ?? 28800,
          },
  });
}

/** Buka posisi LONG/SHORT pada harga tetap. */
function open(h: ExchangeHarness, commandId: string, side: "buy" | "sell", size: number, price: string) {
  return h.service.submitOrder({
    commandId,
    accountId: h.accountId,
    intent: intent({ side, size, type: "market" }),
    book: book("BTC_USDT", [[price, 1000]], [[price, 1000]]),
    nowMs: h.advance(),
  });
}

describe("1. mark-to-market TIDAK menulis ledger", () => {
  test("perubahan mark hanya mengubah valuasi, bukan ledger", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 1, "80000");

    const ledgerBefore = h.ledger.list(h.accountId, { limit: 1000 }).length;
    const walletBefore = h.balances().walletBalance;

    for (const price of ["81000", "82000", "79000", "80000", "85000"]) {
      const result = m2m.processMark({
        commandId: `m-${price}`,
        accountId: h.accountId,
        mark: mark(h, "BTC_USDT", price),
        execution: { contract: "BTC_USDT", bidPrice: price, askPrice: price },
        nowMs: h.advance(),
      });
      expect(result.stale).toBe(false);
      expect(result.actions).toHaveLength(0);
      expect(result.funding).toHaveLength(0);
    }

    // Tidak ada satu pun entri ledger baru dari valuasi.
    expect(h.ledger.list(h.accountId, { limit: 1000 }).length).toBe(ledgerBefore);
    expect(h.balances().walletBalance.eq(walletBefore)).toBe(true);
  });

  test("unrealized PnL dilaporkan per posisi dan di akun", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 2, "80000");

    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "81000"),
      execution: { contract: "BTC_USDT", bidPrice: "81000", askPrice: "81000" },
      nowMs: h.advance(),
    });

    // 2 × 0.0001 × 1000 = 0.2
    expect(result.preValuations).toHaveLength(1);
    expect(result.preValuations[0]!.unrealizedPnl.toString()).toBe("0.2");
    expect(result.accountValuation.unrealizedPnl.toString()).toBe("0.2");
    expect(
      result.accountValuation.equity.eq(h.balances().walletBalance.plus("0.2")),
    ).toBe(true);
  });

  test("mark price basi: valuasi tetap dilaporkan, tidak ada aksi", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 1, "80000");

    const stale = m2m.processMark({
      commandId: "stale",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "70000", { sourceOffsetMs: 60_000 }),
      execution: { contract: "BTC_USDT", bidPrice: "70000", askPrice: "70000" },
      nowMs: h.advance(),
    });
    expect(stale.stale).toBe(true);
    expect(stale.actions).toHaveLength(0);
    // Posisi tetap terbuka.
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")).not.toBeNull();
  });
});

describe("5 & 6. funding runtime", () => {
  test("funding diterapkan sekali lalu idempoten", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 10, "80000");
    const walletBefore = h.balances().walletBalance;
    const fundingTs = h.now() + 100;
    h.advance(200);

    const first = m2m.processMark({
      commandId: "f1",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });

    expect(first.funding).toHaveLength(1);
    expect(first.funding[0]!.applied).toBe(true);
    // 10 × 0.0001 × 80000 = 80 notional × 0.0001 = 0.008 (trader membayar)
    expect(first.funding[0]!.amount.toString()).toBe("0.008");
    expect(h.balances().walletBalance.eq(walletBefore.minus("0.008"))).toBe(true);
    expect(h.balances().fundingPaid.toString()).toBe("0.008");

    const ledgerAfterFirst = h.ledger.list(h.accountId, { limit: 1000 }).length;

    // Tick berikutnya dengan timestamp funding SAMA: tidak ada efek baru.
    h.advance();
    const second = m2m.processMark({
      commandId: "f2",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    expect(second.funding).toHaveLength(1);
    expect(second.funding[0]!.applied).toBe(false);
    expect(h.ledger.list(h.accountId, { limit: 1000 }).length).toBe(ledgerAfterFirst);
    expect(h.balances().walletBalance.eq(walletBefore.minus("0.008"))).toBe(true);
  });

  test("retry commandId sama tidak menggandakan funding", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 10, "80000");
    const fundingTs = h.now() + 10;
    h.advance(50);
    const command = {
      commandId: "same",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    };
    m2m.processMark(command);
    const wallet = h.balances().walletBalance;
    const count = h.ledger.list(h.accountId, { limit: 1000 }).length;
    const retry = m2m.processMark(command);
    expect(retry.duplicate).toBe(true);
    expect(h.balances().walletBalance.eq(wallet)).toBe(true);
    expect(h.ledger.list(h.accountId, { limit: 1000 }).length).toBe(count);
  });

  test("replay/restart: timestamp funding lama tidak diterapkan ulang", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 5, "80000");
    const fundingTs = h.now() + 5;
    h.advance(10);
    m2m.processMark({
      commandId: "a",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    const wallet = h.balances().walletBalance;

    // Instance service baru (mensimulasikan restart) memproses ulang.
    const restarted = new MarkToMarketService({ connection: h.connection });
    h.advance(1000);
    const replay = restarted.processMark({
      commandId: "b",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    expect(replay.funding[0]!.applied).toBe(false);
    expect(h.balances().walletBalance.eq(wallet)).toBe(true);
  });

  test("short MENERIMA funding saat rate positif", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "sell", 10, "80000");
    const walletBefore = h.balances().walletBalance;
    const fundingTs = h.now() + 1;
    h.advance(5);
    const result = m2m.processMark({
      commandId: "f",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    // Short menerima 0.008.
    expect(result.funding[0]!.amount.toString()).toBe("-0.008");
    expect(h.balances().walletBalance.greaterThan(walletBefore)).toBe(true);
    expect(h.balances().fundingPaid.toString()).toBe("-0.008");
  });

  test("funding memakai MARK price, bukan harga lain", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 10, "80000");
    const fundingTs = h.now() + 1;
    h.advance(5);
    const result = m2m.processMark({
      commandId: "f",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "81000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "70000", askPrice: "70001" },
      nowMs: h.now(),
    });
    // 10 × 0.0001 × 81000 = 81 notional × 0.0001 = 0.0081
    expect(result.funding[0]!.amount.toString()).toBe("0.0081");
  });

  test("timestamp funding di masa depan belum diterapkan", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 10, "80000");
    const result = m2m.processMark({
      commandId: "future",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: h.now() + 10_000 }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    expect(result.funding).toHaveLength(0);
  });

  test("BOUNDARY: posisi dibuka tepat pada timestamp funding tetap dikenakan", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    const fundingTs = h.now();
    // Buka TEPAT pada fundingTs (tanpa memajukan clock).
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 10, type: "market" }),
      book: book("BTC_USDT", [["80000", 100]], [["80000", 100]]),
      nowMs: fundingTs,
    });
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.openedAtMs).toBe(fundingTs);

    const result = m2m.processMark({
      commandId: "at",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]!.amount.toString()).toBe("0.008");
  });

  test("BOUNDARY: posisi dibuka SETELAH timestamp funding tidak dikenakan", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    const fundingTs = h.now();
    h.advance(10);
    open(h, "c1", "buy", 10, "80000");

    const result = m2m.processMark({
      commandId: "after",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    expect(result.funding).toHaveLength(0);
  });

  test("BOUNDARY: posisi ditutup TEPAT pada timestamp funding tidak dikenakan", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 10, "80000");
    const fundingTs = h.now();

    // Tutup tepat pada fundingTs lewat jalur manual settlement.
    m2m.closePosition({
      commandId: "close",
      positionId: h.positions.listOpen(h.accountId)[0]!.id,
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: fundingTs,
    });
    expect(h.positions.listOpen(h.accountId)).toHaveLength(0);

    const result = m2m.processMark({
      commandId: "at",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: fundingTs,
    });
    expect(result.funding).toHaveLength(0);
  });

  test("funding tidak menyentuh margin posisi", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    open(h, "c1", "buy", 10, "80000");
    const usedBefore = h.balances().usedMargin;
    const fundingTs = h.now() + 1;
    h.advance(5);
    m2m.processMark({
      commandId: "f",
      accountId: h.accountId,
      mark: mark(h, "BTC_USDT", "80000", { fundingTimestampMs: fundingTs, fundingRate: "0.0001" }),
      execution: { contract: "BTC_USDT", bidPrice: "80000", askPrice: "80000" },
      nowMs: h.now(),
    });
    expect(h.balances().usedMargin.eq(usedBefore)).toBe(true);
  });
});

describe("14. akun multi-posisi", () => {
  test("evaluateAccount menjumlahkan upnl lintas kontrak dan melaporkan yang tanpa mark", () => {
    const h = setup();
    const m2m = new MarkToMarketService({ connection: h.connection });
    // BTC long, ETH short, SOL long
    h.service.submitOrder({
      commandId: "b",
      accountId: h.accountId,
      intent: intent({ contract: "BTC_USDT", side: "buy", size: 1, type: "market" }),
      book: book("BTC_USDT", [["80000", 100]], [["80000", 100]]),
      nowMs: h.advance(),
    });
    h.service.submitOrder({
      commandId: "e",
      accountId: h.accountId,
      intent: intent({ contract: "ETH_USDT", side: "sell", size: 1, type: "market", leverage: "10" }),
      book: book("ETH_USDT", [["3000", 100]], [["3000", 100]]),
      nowMs: h.advance(),
    });
    h.service.submitOrder({
      commandId: "s",
      accountId: h.accountId,
      intent: intent({ contract: "SOL_USDT", side: "buy", size: 5, type: "market", leverage: "10" }),
      book: book("SOL_USDT", [["150", 100]], [["150", 100]]),
      nowMs: h.advance(),
    });
    expect(h.positions.listOpen(h.accountId)).toHaveLength(3);

    const marks = new Map<string, string>([
      ["BTC_USDT", "81000"],
      ["ETH_USDT", "2900"],
      ["SOL_USDT", "152"],
    ]);
    const evaluated = m2m.evaluateAccount({ accountId: h.accountId, marks });

    expect(evaluated.unvaluedContracts).toEqual([]);
    expect(evaluated.valuations).toHaveLength(3);
    // BTC +0.1, ETH +1, SOL +10 → 11.1
    const total = evaluated.valuations.reduce((sum, v) => sum.plus(v.unrealizedPnl), new Decimal(0));
    expect(total.toString()).toBe("11.1");
    expect(evaluated.account.unrealizedPnl.eq(total)).toBe(true);

    // Hanya mark BTC: dua kontrak lain dilaporkan tanpa mark, tidak ditebak.
    const partial = m2m.evaluateAccount({ accountId: h.accountId, marks: new Map([["BTC_USDT", "81000"]]) });
    expect(partial.valuations).toHaveLength(1);
    expect(partial.unvaluedContracts.sort()).toEqual(["ETH_USDT", "SOL_USDT"]);
    expect(partial.account.unrealizedPnl.toString()).toBe("0.1");
  });
});
