import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { btcBook, book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function setup(balance = "10000"): ExchangeHarness {
  const h = setupExchange({ initialBalance: balance, specs: [BTC_USDT] });
  harnesses.push(h);
  return h;
}

describe("5. idempotensi perintah", () => {
  test("retry submit yang sama tidak menggandakan efek ekonomi", () => {
    const h = setup();
    const command = {
      commandId: "cmd-1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    };

    const first = h.service.submitOrder(command);
    const snapshot = {
      orders: h.orders.count(),
      fills: h.fills.count(),
      positions: h.positions.count(),
      ledger: h.ledger.list(h.accountId).length,
      balances: h.balances(),
    };

    const second = h.service.submitOrder(command);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.filledSize).toBe(first.order.filledSize);

    // Tidak ada efek baru.
    expect(h.orders.count()).toBe(snapshot.orders);
    expect(h.fills.count()).toBe(snapshot.fills);
    expect(h.positions.count()).toBe(snapshot.positions);
    expect(h.ledger.list(h.accountId).length).toBe(snapshot.ledger);
    expect(h.balances().walletBalance.eq(snapshot.balances.walletBalance)).toBe(true);
    expect(h.balances().usedMargin.eq(snapshot.balances.usedMargin)).toBe(true);
    expect(h.balances().reservedMargin.eq(snapshot.balances.reservedMargin)).toBe(true);
    expect(h.balances().feesPaid.eq(snapshot.balances.feesPaid)).toBe(true);
  });

  test("retry tidak menahan reservasi dua kali", () => {
    const h = setup();
    const command = {
      commandId: "cmd-reserve",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 5, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.now(),
    };
    const first = h.service.submitOrder(command);
    const reserved = h.balances().reservedMargin;

    h.service.submitOrder(command);
    h.service.submitOrder(command);

    expect(h.balances().reservedMargin.eq(reserved)).toBe(true);
    expect(reserved.eq(first.order.reservedMargin)).toBe(true);
    expect(h.orders.count()).toBe(1);
  });

  test("retry tidak menggandakan fill, fee, dan PnL", () => {
    const h = setup();
    h.service.submitOrder({
      commandId: "open",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 4, type: "market" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const reduceCommand = {
      commandId: "cmd-reduce",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 2, type: "market" }),
      book: book("BTC_USDT", [["81000", 1000]], [["81010", 1000]]),
      nowMs: h.advance(),
    };

    const first = h.service.submitOrder(reduceCommand);
    const feeAfterFirst = h.balances().feesPaid;
    const pnlAfterFirst = h.balances().realizedPnl;
    const fillsAfterFirst = h.fills.count();

    h.service.submitOrder(reduceCommand);

    expect(first.fills).toHaveLength(1);
    expect(h.balances().feesPaid.eq(feeAfterFirst)).toBe(true);
    expect(h.balances().realizedPnl.eq(pnlAfterFirst)).toBe(true);
    expect(h.fills.count()).toBe(fillsAfterFirst);
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.size).toBe(2);
  });

  test("retry evaluate tidak menggandakan fill", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 4, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });

    const evaluate = {
      commandId: "cmd-eval",
      orderId: submitted.order.id,
      book: book("BTC_USDT", [["78990", 100]], [["78995", 2]]),
      nowMs: h.advance(),
    };
    const first = h.service.evaluateOrder(evaluate);
    expect(first.order.filledSize).toBe(2);
    const fillsAfter = h.fills.count();

    const second = h.service.evaluateOrder(evaluate);
    expect(second.duplicate).toBe(true);
    expect(second.order.filledSize).toBe(2);
    expect(h.fills.count()).toBe(fillsAfter);
  });

  test("retry cancel tidak melepas reservasi dua kali", () => {
    const h = setup();
    const submitted = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 3, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const cancel = { commandId: "cmd-cancel", orderId: submitted.order.id, nowMs: h.advance() };

    const first = h.service.cancelOrder(cancel);
    const ledgerAfter = h.ledger.list(h.accountId).length;
    const second = h.service.cancelOrder(cancel);

    expect(first.order.status).toBe("cancelled");
    expect(second.duplicate).toBe(true);
    expect(h.balances().reservedMargin.isZero()).toBe(true);
    expect(h.ledger.list(h.accountId).length).toBe(ledgerAfter);
  });

  test("commandId berbeda dengan perintah sama tetap dijalankan (bukan idempotensi palsu)", () => {
    const h = setup();
    const base = {
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    };
    h.service.submitOrder({ ...base, commandId: "a" });
    h.service.submitOrder({ ...base, commandId: "b" });
    // Dua perintah berbeda = dua order berbeda.
    expect(h.orders.count()).toBe(2);
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.size).toBe(2);
  });

  test("commandId kosong ditolak", () => {
    const h = setup();
    expect(() =>
      h.service.submitOrder({
        commandId: "   ",
        accountId: h.accountId,
        intent: intent({ size: 1 }),
        book: btcBook(),
        nowMs: h.now(),
      }),
    ).toThrow();
  });
});

describe("16. saldo tidak cukup", () => {
  test("margin tidak cukup → rejected tanpa efek ekonomi apa pun", () => {
    const h = setup("10");
    const before = {
      wallet: h.balances().walletBalance,
      used: h.balances().usedMargin,
      reserved: h.balances().reservedMargin,
      fees: h.balances().feesPaid,
      fills: h.fills.count(),
      positions: h.positions.count(),
      ledger: h.ledger.list(h.accountId).length,
    };

    // 100 kontrak × 0.0001 × 80000 = 800 notional; margin @10 = 80 > 10.
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 100, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });

    expect(result.order.status).toBe("rejected");
    expect(result.order.rejectReason).not.toBeNull();
    expect(result.fills).toHaveLength(0);

    expect(h.balances().walletBalance.eq(before.wallet)).toBe(true);
    expect(h.balances().usedMargin.eq(before.used)).toBe(true);
    expect(h.balances().reservedMargin.eq(before.reserved)).toBe(true);
    expect(h.balances().feesPaid.eq(before.fees)).toBe(true);
    expect(h.fills.count()).toBe(before.fills);
    expect(h.positions.count()).toBe(before.positions);
    expect(h.ledger.list(h.accountId).length).toBe(before.ledger);
  });

  test("limit resting yang butuh margin melebihi saldo ditolak", () => {
    const h = setup("10");
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 100, type: "limit", price: "79000", timeInForce: "gtc" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("rejected");
    expect(h.balances().reservedMargin.isZero()).toBe(true);
    expect(h.orders.listLive(h.accountId)).toHaveLength(0);
  });

  test("order rejected tetap terekam untuk audit, dengan event penolakan", () => {
    const h = setup("10");
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 100, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    // Keputusan Phase 3: order ditolak DIPERSIST untuk audit (tanpa efek ekonomi).
    expect(h.orders.require(result.order.id).status).toBe("rejected");
    const events = h.orders.events(result.order.id);
    expect(events.map((event) => event.type)).toContain("rejected");
  });

  test("saldo yang cukup tepat (batas) berhasil", () => {
    // 1 kontrak @80000, margin @10 = 0.8; fee taker 0.006. Butuh ≈ 0.806.
    const h = setup("0.81");
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("filled");
    expect(h.available().greaterThanOrEqualTo(0)).toBe(true);
  });

  test("saldo di bawah kebutuhan (termasuk fee) ditolak", () => {
    const h = setup("0.7");
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("rejected");
    expect(h.available().greaterThanOrEqualTo(0)).toBe(true);
  });

  test("reduce_only tetap diizinkan walau saldo tersedia nol", () => {
    const h = setup("0.9");
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const result = h.service.submitOrder({
      commandId: "c2",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 1, type: "market", reduceOnly: true }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    expect(result.order.status).toBe("filled");
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")).toBeNull();
  });

  test("available tidak pernah negatif setelah rentetan order", () => {
    const h = setup("50");
    for (let i = 0; i < 12; i += 1) {
      h.service.submitOrder({
        commandId: `c${i}`,
        accountId: h.accountId,
        intent: intent({ side: "buy", size: 5, type: "limit", price: "79000", timeInForce: "gtc" }),
        book: btcBook(),
        nowMs: h.advance(),
      });
      expect(h.available().greaterThanOrEqualTo(0)).toBe(true);
    }
  });
});

describe("validasi intent", () => {
  test("size di luar batas kontrak ditolak", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: BTC_USDT.orderSizeMax + 1, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("rejected");
  });

  test("leverage di luar rentang kontrak ditolak", () => {
    const h = setup();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market", leverage: "201" }),
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("rejected");
  });

  test("market dengan harga dan limit tanpa harga ditolak", () => {
    const h = setup();
    // OrderIntentSchema menolak bentuk ini, jadi dibangun manual.
    const marketWithPrice = { ...intent({ size: 1 }), price: "80000" };
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: marketWithPrice,
      book: btcBook(),
      nowMs: h.now(),
    });
    expect(result.order.status).toBe("rejected");
  });

  test("kontrak tidak dikenal ditolak", () => {
    const h = setup();
    expect(() =>
      h.service.submitOrder({
        commandId: "c1",
        accountId: h.accountId,
        intent: intent({ contract: "NOPE_USDT", size: 1 }),
        book: btcBook("NOPE_USDT"),
        nowMs: h.now(),
      }),
    ).toThrow();
  });
});

describe("22. determinisme clock dan id", () => {
  test("timestamp ekonomi berasal dari nowMs yang disuntik, bukan Date.now()", () => {
    const h = setup();
    const t = h.now();
    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 1, type: "market" }),
      book: btcBook(),
      nowMs: t,
    });
    expect(result.order.createdAtMs).toBe(t);
    expect(result.order.updatedAtMs).toBe(t);
    expect(h.fills.listByOrder(result.order.id)[0]!.tsMs).toBe(t);
    expect(h.ledger.list(h.accountId).at(-1)!.tsMs).toBe(t);
  });

  test("id deterministik memungkinkan reproduksi byte-per-byte", () => {
    const run = () => {
      const h = setupExchange({ initialBalance: "1000", specs: [BTC_USDT], startMs: 1000 });
      try {
        h.service.submitOrder({
          commandId: "c1",
          accountId: h.accountId,
          intent: intent({ side: "buy", size: 2, type: "market" }),
          book: btcBook(),
          nowMs: h.now(),
        });
        return JSON.stringify({
          orders: h.orders.count(),
          order: h.orders.require("ord000001").status,
          fills: h.fills.listByOrder("ord000001").map((fill) => ({ size: fill.size, price: fill.price.toString(), fee: fill.fee.toString() })),
          balances: {
            wallet: h.balances().walletBalance.toString(),
            used: h.balances().usedMargin.toString(),
            fees: h.balances().feesPaid.toString(),
          },
          ledgerKeys: h.ledger.list(h.accountId).map((entry) => entry.idempotencyKey),
        });
      } finally {
        h.cleanup();
      }
    };
    expect(run()).toBe(run());
  });
});

describe("grafik ketergantungan Decimal", () => {
  test("PnL realisasi dari pengurangan cocok dengan perhitungan manual", () => {
    const h = setup();
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 3, type: "market" }),
      book: book("BTC_USDT", [["79990", 100]], [["80000", 3]]),
      nowMs: h.advance(),
    });
    h.service.submitOrder({
      commandId: "c2",
      accountId: h.accountId,
      intent: intent({ side: "sell", size: 1, type: "market" }),
      book: book("BTC_USDT", [["81234", 100]], [["81240", 100]]),
      nowMs: h.advance(),
    });
    // 1 × 0.0001 × (81234 − 80000) = 0.1234
    expect(h.balances().realizedPnl.eq(new Decimal("0.1234"))).toBe(true);
  });
});
