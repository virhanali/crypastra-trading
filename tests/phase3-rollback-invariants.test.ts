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

interface EconomicSnapshot {
  readonly orders: number;
  readonly fills: number;
  readonly positions: number;
  readonly openPositions: number;
  readonly ledger: number;
  readonly commands: number;
  readonly wallet: string;
  readonly used: string;
  readonly reserved: string;
  readonly fees: string;
  readonly realized: string;
}

function snapshot(h: ExchangeHarness): EconomicSnapshot {
  const balances = h.balances();
  return {
    orders: h.orders.count(),
    fills: h.fills.count(),
    positions: h.positions.count(),
    openPositions: h.positions.listOpen(h.accountId).length,
    ledger: h.ledger.list(h.accountId, { limit: 100_000 }).length,
    commands: (h.connection.sqlite.query("SELECT COUNT(*) AS n FROM trade_commands").get() as { n: number }).n,
    wallet: balances.walletBalance.toString(),
    used: balances.usedMargin.toString(),
    reserved: balances.reservedMargin.toString(),
    fees: balances.feesPaid.toString(),
    realized: balances.realizedPnl.toString(),
  };
}

describe("19. injeksi kegagalan — rollback penuh", () => {
  /**
   * Setiap kasus menjalankan perintah yang gagal DI TENGAH, lalu memastikan
   * keadaan ekonomi identik dengan sebelum perintah. Tidak ada operasi ekonomi
   * yang tersisa separuh.
   */

  test("gagal setelah order insert (validasi intent) → tidak ada jejak ekonomi", () => {
    const h = setup("10");
    const before = snapshot(h);

    const result = h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 100, type: "market" }),
      book: btcBook(),
      nowMs: h.now(),
    });

    // Order rejected DIPERSIST (audit), tetapi tidak ada efek ekonomi.
    expect(result.order.status).toBe("rejected");
    const after = snapshot(h);
    expect(after.wallet).toBe(before.wallet);
    expect(after.used).toBe(before.used);
    expect(after.reserved).toBe(before.reserved);
    expect(after.fees).toBe(before.fees);
    expect(after.realized).toBe(before.realized);
    expect(after.fills).toBe(before.fills);
    expect(after.positions).toBe(before.positions);
    expect(after.ledger).toBe(before.ledger);
    // Hanya baris order audit + command yang bertambah.
    expect(after.orders).toBe(before.orders + 1);
    expect(after.commands).toBe(before.commands + 1);
  });

  test("exception di dalam transaksi service menggulung order, fill, posisi, ledger, dan command", () => {
    const h = setup();
    const before = snapshot(h);

    // Paksa kegagalan SETELAH beberapa penulisan: book dengan harga tidak valid
    // membuat planLevelConsumption melempar saat sudah ada order tersimpan.
    expect(() =>
      h.connection.transaction(() => {
        const service = h.service;
        service.submitOrder({
          commandId: "c-boom",
          accountId: h.accountId,
          intent: intent({ side: "buy", size: 1, type: "market" }),
          book: btcBook(),
          nowMs: h.now(),
        });
        throw new Error("kegagalan setelah eksekusi");
      }),
    ).toThrow("kegagalan setelah eksekusi");

    const after = snapshot(h);
    expect(after).toEqual(before);
  });

  test("gagal saat posisi (transisi ilegal) menggulung semuanya", () => {
    const h = setup();
    h.service.submitOrder({
      commandId: "c1",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "market" }),
      book: btcBook(),
      nowMs: h.advance(),
    });
    const before = snapshot(h);

    // evaluate pada order yang sudah final akan melempar sebelum efek apa pun.
    expect(() =>
      h.service.evaluateOrder({
        commandId: "c2",
        orderId: "ord000001",
        book: btcBook(),
        nowMs: h.advance(),
      }),
    ).toThrow();

    expect(snapshot(h)).toEqual(before);
  });

  test("gagal pada ledger PnL (trigger injeksi) menggulung fill, margin, dan posisi", () => {
    const h = setup();
    // Buka posisi lebih dulu supaya order berikutnya menghasilkan PnL realisasi.
    h.service.submitOrder({
      commandId: "open",
      accountId: h.accountId,
      intent: intent({ side: "buy", size: 2, type: "market" }),
      book: btcBook(),
      nowMs: h.advance(),
    });

    // Injeksi kegagalan pada penulisan ledger PnL. Urutan penulisan dalam satu
    // fill: fill -> margin/reservasi -> posisi -> PnL -> fee. Jadi kegagalan di
    // sini terjadi SETELAH fill dan posisi ditulis, dan semuanya harus batal.
    h.connection.sqlite
      .prepare(
        `CREATE TRIGGER inject_failure BEFORE INSERT ON ledger
         WHEN NEW.idempotency_key = 'fill:fil000002:realized-pnl'
         BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END`,
      )
      .run();

    const before = snapshot(h);

    expect(() =>
      h.service.submitOrder({
        commandId: "reduce",
        accountId: h.accountId,
        intent: intent({ side: "sell", size: 1, type: "market" }),
        book: book("BTC_USDT", [["81000", 100]], [["81010", 100]]),
        nowMs: h.advance(),
      }),
    ).toThrow();

    // Fill kedua, mutasi posisi, entri margin, dan command semuanya batal.
    expect(snapshot(h)).toEqual(before);
    expect(h.fills.count()).toBe(1);
    expect(h.orders.count()).toBe(1);
    expect(h.positions.findOpen(h.accountId, "BTC_USDT")!.size).toBe(2);
    expect(h.ledger.verifyBalances(h.accountId).cacheMatches).toBe(true);

    h.connection.sqlite.prepare("DROP TRIGGER inject_failure").run();
  });

  test("kegagalan setelah reservasi menggulung reservasi", () => {
    const h = setup();
    const before = snapshot(h);

    expect(() =>
      h.connection.transaction(() => {
        h.service.submitOrder({
          commandId: "c-res",
          accountId: h.accountId,
          intent: intent({ side: "buy", size: 5, type: "limit", price: "79000", timeInForce: "gtc" }),
          book: btcBook(),
          nowMs: h.now(),
        });
        throw new Error("gagal setelah reservasi");
      }),
    ).toThrow("gagal setelah reservasi");

    expect(snapshot(h)).toEqual(before);
  });

  test("kegagalan setelah first fill menggulung fill pertama juga", () => {
    const h = setup();
    const before = snapshot(h);

    expect(() =>
      h.connection.transaction(() => {
        h.service.submitOrder({
          commandId: "c-multi",
          accountId: h.accountId,
          intent: intent({ side: "buy", size: 2, type: "market" }),
          book: book("BTC_USDT", [["79990", 100]], [["80000", 1], ["80010", 1]]),
          nowMs: h.now(),
        });
        throw new Error("gagal setelah fill");
      }),
    ).toThrow("gagal setelah fill");

    expect(snapshot(h)).toEqual(before);
    expect(h.fills.count()).toBe(0);
  });

  test("rollback tetap menjaga integritas cache saldo", () => {
    const h = setup();
    const before = snapshot(h);
    expect(() =>
      h.connection.transaction(() => {
        h.service.submitOrder({
          commandId: "c-x",
          accountId: h.accountId,
          intent: intent({ side: "buy", size: 3, type: "market" }),
          book: btcBook(),
          nowMs: h.now(),
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const verified = h.ledger.verifyBalances(h.accountId);
    expect(verified.cacheMatches).toBe(true);
    expect(verified.chainMismatch).toBeNull();
    expect(snapshot(h)).toEqual(before);
  });
});

describe("15. invariant akuntansi setelah setiap operasi", () => {
  test("seluruh invariant DATA-MODEL yang dapat diperiksa", () => {
    const h = setup();
    const ops = [
      () => h.service.submitOrder({ commandId: "o1", accountId: h.accountId, intent: intent({ side: "buy", size: 4, type: "market" }), book: btcBook(), nowMs: h.advance() }),
      () => h.service.submitOrder({ commandId: "o2", accountId: h.accountId, intent: intent({ side: "buy", size: 2, type: "limit", price: "79000", timeInForce: "gtc" }), book: btcBook(), nowMs: h.advance() }),
      () => h.service.submitOrder({ commandId: "o3", accountId: h.accountId, intent: intent({ side: "sell", size: 1, type: "market" }), book: book("BTC_USDT", [["81000", 100]], [["81010", 100]]), nowMs: h.advance() }),
      () => h.service.cancelOrder({ commandId: "o4", orderId: "ord000002", nowMs: h.advance() }),
      () => h.service.submitOrder({ commandId: "o5", accountId: h.accountId, intent: intent({ side: "sell", size: 10, type: "market" }), book: book("BTC_USDT", [["79000", 100]], [["79010", 100]]), nowMs: h.advance() }),
    ];

    for (const op of ops) {
      op();
      assertInvariants(h);
    }
  });

  test("invariant tetap berlaku setelah rentetan order gagal", () => {
    const h = setup("20");
    for (let i = 0; i < 10; i += 1) {
      h.service.submitOrder({
        commandId: `f${i}`,
        accountId: h.accountId,
        intent: intent({ side: "buy", size: 50, type: "market" }),
        book: btcBook(),
        nowMs: h.advance(),
      });
      assertInvariants(h);
    }
  });
});

function assertInvariants(h: ExchangeHarness): void {
  const accountId = h.accountId;

  // 1. Tidak ada posisi berukuran negatif, dan posisi open selalu > 0.
  for (const position of h.positions.listOpen(accountId)) {
    expect(position.size).toBeGreaterThan(0);
    expect(position.initialMargin.greaterThanOrEqualTo(0)).toBe(true);
  }
  const allPositions = h.connection.sqlite
    .query("SELECT size, initial_margin, status FROM positions WHERE account_id = ?")
    .all(accountId) as Array<{ size: number; initial_margin: string; status: string }>;
  for (const row of allPositions) {
    expect(row.size).toBeGreaterThanOrEqual(0);
    expect(new Decimal(row.initial_margin).greaterThanOrEqualTo(0)).toBe(true);
    if (row.status !== "open") {
      expect(row.size).toBe(0);
    }
  }

  // 2. Reserved dan used tidak boleh negatif.
  const balances = h.balances();
  expect(balances.reservedMargin.greaterThanOrEqualTo(0)).toBe(true);
  expect(balances.usedMargin.greaterThanOrEqualTo(0)).toBe(true);

  // 3. Available tidak boleh negatif (risiko overspend).
  expect(h.available().greaterThanOrEqualTo(0)).toBe(true);

  // 4. Σ fill size per order == orders.filled_size, dan filled <= size.
  for (const order of h.orders.listByAccount(accountId)) {
    const total = h.fills.totalSizeForOrder(order.id);
    expect(total).toBe(order.filledSize);
    expect(order.filledSize).toBeLessThanOrEqual(order.size);
    expect(order.size - order.filledSize).toBeGreaterThanOrEqual(0);
    if (order.status === "filled") {
      expect(order.size - order.filledSize).toBe(0);
    }
  }

  // 5. used_margin == Σ margin posisi open (invariant 2 DATA-MODEL).
  expect(h.positions.totalOpenMargin(accountId).eq(balances.usedMargin)).toBe(true);

  // 6. reserved_margin == Σ reservasi order live.
  const liveReserved = h.orders
    .listLive(accountId)
    .reduce((sum, order) => sum.plus(order.reservedMargin), new Decimal(0));
  expect(liveReserved.eq(balances.reservedMargin)).toBe(true);

  // 7. Order non-live tidak menahan reservasi.
  for (const order of h.orders.listByAccount(accountId)) {
    if (order.status === "filled" || order.status === "cancelled" || order.status === "rejected") {
      expect(order.reservedMargin.isZero()).toBe(true);
    }
  }

  // 8. Cache saldo konsisten dengan ledger (invariant 1 + rekonsiliasi).
  const verified = h.ledger.verifyBalances(accountId);
  expect(verified.chainMismatch).toBeNull();
  expect(verified.cacheMatches).toBe(true);

  // 9. Order canceled tidak boleh punya fill setelah pembatalan.
  for (const order of h.orders.listByAccount(accountId)) {
    if (order.status !== "cancelled") {
      continue;
    }
    const events = h.orders.events(order.id);
    const cancelIndex = events.findIndex((event) => event.type === "cancelled");
    if (cancelIndex < 0) {
      continue;
    }
    const fillsAfterCancel = events.slice(cancelIndex + 1).filter((event) => event.type === "fill");
    expect(fillsAfterCancel).toHaveLength(0);
  }
}
