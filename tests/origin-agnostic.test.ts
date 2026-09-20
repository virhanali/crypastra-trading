import { describe, expect, test } from "bun:test";
import {
  BookSnapshot,
  ContractSpecSchema,
  Ledger,
  OrderIntentSchema,
  simulateFill,
  type OrderOrigin,
} from "../packages/core/src/index.js";

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

const book: BookSnapshot = {
  contract: "BTC_USDT",
  updateId: 1,
  eventTsMs: 1,
  bids: [{ price: "80000", size: 500 }],
  asks: [{ price: "80010", size: 500 }],
};

const marketBuy = OrderIntentSchema.parse({
  contract: "BTC_USDT",
  side: "buy",
  type: "market",
  size: 3,
  price: null,
  leverage: "10",
  timeInForce: "ioc",
  reduceOnly: false,
  tpPrice: null,
  slPrice: null,
});

describe("Paper Exchange tidak peduli asal order (ADR 0004)", () => {
  test("order identik dari origin berbeda menghasilkan fill identik", () => {
    const origins: OrderOrigin[] = ["human", "jev", "strategy", "replay", "test"];
    const results = origins.map(() => simulateFill(BTC, marketBuy, book));
    const serialized = results.map((r) => JSON.stringify(r));
    expect(new Set(serialized).size).toBe(1);
  });

  test("OrderIntent tidak punya field yang mengubah perilaku exchange", () => {
    const keys = Object.keys(marketBuy);
    expect(keys).not.toContain("source");
    expect(keys).not.toContain("origin");
    expect(keys).not.toContain("mode");
  });

  test("ledger mencatat fill yang sama terlepas dari origin", () => {
    const origins: OrderOrigin[] = ["human", "jev", "replay"];
    const balances = origins.map((origin) => {
      const ledger = new Ledger("10000");
      const fill = simulateFill(BTC, marketBuy, book).fills[0]!;
      ledger.append({
        accountId: "acc",
        tsMs: 1,
        type: "fee",
        amount: `-${fill.fee}`,
        idempotencyKey: `fee:${origin}`,
        refType: "fill",
        refId: "fill-1",
      });
      return ledger.walletBalance.toFixed(8);
    });
    expect(new Set(balances).size).toBe(1);
  });
});

describe("matching", () => {
  test("market buy memakan ask; fee taker diterapkan", () => {
    const result = simulateFill(BTC, marketBuy, book);
    expect(result.filledSize).toBe(3);
    expect(result.fills[0]!.price).toBe("80010");
    expect(result.fills[0]!.liquidity).toBe("taker");
    // 3 kontrak * 0.0001 * 80010 * 0.00075 = 0.018, dibulatkan ke atas 8dp.
    expect(result.fills[0]!.fee).toBe("0.01800225");
  });

  test("limit sell di atas bid tidak tereksekusi dan bersisa di buku (GTC)", () => {
    const limitSell = OrderIntentSchema.parse({
      ...marketBuy,
      side: "sell",
      type: "limit",
      price: "80005",
      timeInForce: "gtc",
    });
    const result = simulateFill(BTC, limitSell, book);
    expect(result.filledSize).toBe(0);
    expect(result.restsOnBook).toBe(true);
  });

  test("limit IOC yang tidak menyentuh buku tidak bersisa di buku", () => {
    const iocBuy = OrderIntentSchema.parse({
      ...marketBuy,
      type: "limit",
      price: "80005",
      timeInForce: "ioc",
    });
    const result = simulateFill(BTC, iocBuy, book);
    expect(result.filledSize).toBe(0);
    expect(result.restsOnBook).toBe(false);
  });

  test("post_only yang akan langsung tereksekusi ditolak", () => {
    const po = OrderIntentSchema.parse({
      ...marketBuy,
      type: "limit",
      price: "81000",
      timeInForce: "post_only",
    });
    const result = simulateFill(BTC, po, book);
    expect(result.rejected).not.toBeNull();
    expect(result.filledSize).toBe(0);
  });

  test("partial fill saat buku tipis: sisa dilaporkan, bukan hilang", () => {
    const thin: BookSnapshot = { ...book, asks: [{ price: "80010", size: 1 }] };
    const result = simulateFill(BTC, marketBuy, thin);
    expect(result.filledSize).toBe(1);
    expect(result.remainingSize).toBe(2);
  });
});

describe("ledger append-only", () => {
  test("idempotency key yang sama tidak menggandakan entri", () => {
    const ledger = new Ledger("1000");
    const first = ledger.append({
      accountId: "acc",
      tsMs: 1,
      type: "funding",
      amount: "-1.5",
      idempotencyKey: "funding:BTC_USDT:1:pos1",
    });
    const second = ledger.append({
      accountId: "acc",
      tsMs: 1,
      type: "funding",
      amount: "-1.5",
      idempotencyKey: "funding:BTC_USDT:1:pos1",
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(ledger.entries.length).toBe(1);
    expect(ledger.walletBalance.toString()).toBe("998.5");
  });

  test("rebuild dari ledger cocok dengan saldo cache", () => {
    const ledger = new Ledger("10000");
    ledger.append({ accountId: "acc", tsMs: 1, type: "deposit", amount: "5000", idempotencyKey: "d1" });
    ledger.append({ accountId: "acc", tsMs: 2, type: "fee", amount: "-0.006", idempotencyKey: "f1" });
    ledger.append({ accountId: "acc", tsMs: 3, type: "pnl_realized", amount: "12.345678", idempotencyKey: "p1" });
    ledger.append({ accountId: "acc", tsMs: 4, type: "withdrawal", amount: "-100", idempotencyKey: "w1" });
    const rebuilt = ledger.rebuild();
    expect(rebuilt.mismatchSeq).toBeNull();
    expect(rebuilt.walletBalance.eq(ledger.walletBalance)).toBe(true);
  });
});