import { afterEach, describe, expect, test } from "bun:test";
import { OrderIntentSchema, type OrderIntent } from "../packages/core/src/index.js";
import { btcBook, book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/**
 * 21. ORIGIN-AGNOSTIC
 *
 * Paper Exchange tidak boleh tahu siapa yang mengirim order. `OrderIntent`
 * sengaja TIDAK punya field asal. Label produsen hidup di lapisan luar
 * (`auditSource`) dan hanya disimpan untuk observability.
 *
 * Test ini menjalankan intent yang SAMA melalui keadaan akun/pasar yang SAMA
 * untuk beberapa "adapter" produsen, lalu membandingkan seluruh hasil ekonomi.
 * Kalau ekonomi bergantung pada produsen, test ini gagal.
 */

type Producer = "manual" | "strategy" | "jev" | "replay";

/** Adapter luar yang mewakili produsen berbeda. Semuanya menghasilkan OrderIntent. */
function producerIntent(producer: Producer, overrides: Parameters<typeof intent>[0] = {}): OrderIntent {
  // Sengaja berbeda "cara" membentuknya, tapi hasil OrderIntent-nya identik.
  switch (producer) {
    case "manual":
      return intent(overrides);
    case "strategy":
      return OrderIntentSchema.parse({ ...intent(overrides) });
    case "jev": {
      const base = intent(overrides);
      return { ...base };
    }
    case "replay":
      return JSON.parse(JSON.stringify(intent(overrides))) as OrderIntent;
    default:
      throw new Error("producer tidak dikenal");
  }
}

interface EconomicOutcome {
  readonly order: {
    status: string;
    size: number;
    filledSize: number;
    avgFillPrice: string | null;
    reservedMargin: string;
    rejectReason: string | null;
  };
  readonly fills: Array<{ size: number; price: string; liquidity: string; fee: string; realizedPnl: string }>;
  readonly position: { direction: string; size: number; entryPrice: string; initialMargin: string } | null;
  readonly balances: { wallet: string; used: string; reserved: string; fees: string; realized: string };
  readonly ledger: Array<{ type: string; amount: string; marginDelta: string; reservedDelta: string }>;
}

/** Jalankan satu skenario penuh dengan produsen tertentu; kembalikan hasil ekonomi. */
function runScenario(producer: Producer): EconomicOutcome {
  const h = setupExchange({ initialBalance: "10000", specs: [BTC_USDT], startMs: 1_700_000_000_000 });
  try {
    const submit = (commandId: string, overrides: Parameters<typeof intent>[0], bookSnapshot: ReturnType<typeof btcBook>) =>
      h.service.submitOrder({
        commandId,
        accountId: h.accountId,
        intent: producerIntent(producer, overrides),
        book: bookSnapshot,
        nowMs: h.advance(),
        // Metadata produsen: DI LUAR OrderIntent, hanya untuk audit.
        auditSource: producer,
      });

    // 1. Buka LONG
    submit("c1", { side: "buy", size: 3, type: "market" }, btcBook());
    // 2. Tambah LONG di harga berbeda
    submit("c2", { side: "buy", size: 2, type: "market" }, book("BTC_USDT", [["80990", 100]], [["81000", 100]]));
    // 3. Reduce (realisasi PnL)
    submit("c3", { side: "sell", size: 1, type: "market" }, book("BTC_USDT", [["81500", 100]], [["81510", 100]]));
    // 4. Limit resting
    const resting = submit("c4", { side: "buy", size: 2, type: "limit", price: "79000", timeInForce: "gtc" }, btcBook());
    // 5. Resting terisi dari snapshot baru
    h.service.evaluateOrder({
      commandId: "c5",
      orderId: resting.order.id,
      book: book("BTC_USDT", [["78990", 100]], [["78995", 2]]),
      nowMs: h.advance(),
    });
    // 6. Flip ke SHORT
    submit("c6", { side: "sell", size: 20, type: "market" }, book("BTC_USDT", [["80000", 100]], [["80010", 100]]));

    const order = h.orders.require(resting.order.id);
    const position = h.positions.findOpen(h.accountId, "BTC_USDT");
    const balances = h.balances();

    return {
      order: {
        status: order.status,
        size: order.size,
        filledSize: order.filledSize,
        avgFillPrice: order.avgFillPrice === null ? null : order.avgFillPrice.toString(),
        reservedMargin: order.reservedMargin.toString(),
        rejectReason: order.rejectReason,
      },
      fills: h.fills.listByOrder(resting.order.id).map((fill) => ({
        size: fill.size,
        price: fill.price.toString(),
        liquidity: fill.liquidity,
        fee: fill.fee.toString(),
        realizedPnl: fill.realizedPnl.toString(),
      })),
      position: position === null ? null : {
        direction: position.direction,
        size: position.size,
        entryPrice: position.entryPrice.toString(),
        initialMargin: position.initialMargin.toString(),
      },
      balances: {
        wallet: balances.walletBalance.toString(),
        used: balances.usedMargin.toString(),
        reserved: balances.reservedMargin.toString(),
        fees: balances.feesPaid.toString(),
        realized: balances.realizedPnl.toString(),
      },
      ledger: h.ledger.list(h.accountId, { limit: 10_000 }).map((entry) => ({
        type: entry.type,
        amount: entry.amount.toString(),
        marginDelta: entry.marginDelta.toString(),
        reservedDelta: entry.reservedDelta.toString(),
      })),
    };
  } finally {
    h.cleanup();
  }
}

describe("21. origin-agnostic", () => {
  test("OrderIntent tidak punya field asal", () => {
    const probe = intent({ size: 1 });
    const keys = Object.keys(probe);
    for (const forbidden of ["source", "origin", "producer", "jev", "strategy", "human", "replay", "auditSource"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test("OrderIntentSchema menolak field asal (strict)", () => {
    const withSource = { ...intent({ size: 1 }), source: "human" };
    expect(() => OrderIntentSchema.parse(withSource)).toThrow();
    const withOrigin = { ...intent({ size: 1 }), origin: "jev" };
    expect(() => OrderIntentSchema.parse(withOrigin)).toThrow();
  });

  test("empat produsen menghasilkan hasil ekonomi IDENTIK", () => {
    const manual = runScenario("manual");
    const strategy = runScenario("strategy");
    const jev = runScenario("jev");
    const replay = runScenario("replay");

    expect(strategy).toEqual(manual);
    expect(jev).toEqual(manual);
    expect(replay).toEqual(manual);
  });

  test("hasil ekonomi tidak hampa (skenario benar-benar mengeksekusi sesuatu)", () => {
    const outcome = runScenario("manual");
    expect(outcome.ledger.length).toBeGreaterThan(3);
    expect(outcome.order.status).toBe("filled");
    expect(outcome.position).not.toBeNull();
    expect(outcome.balances.used).not.toBe("0");
  });

  test("auditSource tersimpan di orders.source tetapi tidak mengubah ekonomi", () => {
    const results = (["manual", "jev"] as Producer[]).map((producer) => {
      const h = setupExchange({ initialBalance: "1000", specs: [BTC_USDT], startMs: 1000 });
      try {
        const result = h.service.submitOrder({
          commandId: "c1",
          accountId: h.accountId,
          intent: producerIntent(producer, { side: "buy", size: 1, type: "market" }),
          book: btcBook(),
          nowMs: h.now(),
          auditSource: producer,
        });
        return {
          source: result.order.source,
          balances: {
            wallet: h.balances().walletBalance.toString(),
            used: h.balances().usedMargin.toString(),
            fees: h.balances().feesPaid.toString(),
          },
        };
      } finally {
        h.cleanup();
      }
    });

    // Label audit berbeda...
    expect(results[0]!.source).toBe("manual");
    expect(results[1]!.source).toBe("jev");
    // ...tetapi ekonomi identik.
    expect(results[1]!.balances).toEqual(results[0]!.balances);
  });
});
