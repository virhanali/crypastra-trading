import { afterEach, describe, expect, test } from "bun:test";
import { Decimal, parseMarkSnapshot } from "../packages/core/src/index.js";
import { MarkToMarketService } from "../apps/server/src/services/mark-to-market-service.js";
import { book, intent, setupExchange, type ExchangeHarness } from "./helpers/exchange.js";
import { BTC_USDT, ETH_USDT, SOL_USDT } from "./helpers/fixtures.js";

const harnesses: ExchangeHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function setup(balance = "10000") {
  const h = setupExchange({ initialBalance: balance, specs: [BTC_USDT, ETH_USDT, SOL_USDT], startMs: 1_700_000_000_000 });
  harnesses.push(h);
  return { h, m2m: new MarkToMarketService({ connection: h.connection }) };
}

function markOf(h: ExchangeHarness, contract: string, price: string, funding?: { timestampMs: number; rate: string }) {
  return parseMarkSnapshot({
    contract,
    markPrice: price,
    observedAtMs: h.now(),
    sourceTimestampMs: h.now(),
    funding: funding === undefined ? null : { fundingRate: funding.rate, fundingTimestampMs: funding.timestampMs, intervalSeconds: 28800 },
  });
}

const quote = (contract: string, price: string) => ({ contract, bidPrice: price, askPrice: price });

function openPosition(
  h: ExchangeHarness,
  commandId: string,
  side: "buy" | "sell",
  size: number,
  price: string,
  protection: { tpPrice?: string; slPrice?: string } = {},
  contract = "BTC_USDT",
) {
  return h.service.submitOrder({
    commandId,
    accountId: h.accountId,
    intent: intent({
      contract,
      side,
      size,
      type: "market",
      tpPrice: protection.tpPrice ?? null,
      slPrice: protection.slPrice ?? null,
    }),
    book: book(contract, [[price, 1000]], [[price, 1000]]),
    nowMs: h.advance(),
  });
}

interface Snap {
  openPositions: number;
  fills: number;
  ledger: number;
  commands: number;
  wallet: string;
  used: string;
  reserved: string;
  fees: string;
  fundingPaid: string;
  realized: string;
}

/**
 * Keadaan EKONOMI saja. Jumlah baris `trade_commands` adalah pembukuan
 * idempotensi, bukan efek ekonomi: perintah dengan commandId berbeda memang
 * menambah baris command walau tidak mengubah ekonomi apa pun.
 */
function economicSnap(h: ExchangeHarness): Omit<Snap, "commands"> {
  const { commands: _commands, ...rest } = snap(h);
  return rest;
}

function snap(h: ExchangeHarness): Snap {
  const b = h.balances();
  return {
    openPositions: h.positions.listOpen(h.accountId).length,
    fills: h.fills.count(),
    ledger: h.ledger.list(h.accountId, { limit: 100_000 }).length,
    commands: (h.connection.sqlite.query("SELECT COUNT(*) AS n FROM trade_commands").get() as { n: number }).n,
    wallet: b.walletBalance.toString(),
    used: b.usedMargin.toString(),
    reserved: b.reservedMargin.toString(),
    fees: b.feesPaid.toString(),
    fundingPaid: b.fundingPaid.toString(),
    realized: b.realizedPnl.toString(),
  };
}

describe("10. presedensi runtime", () => {
  test("likuidasi > SL > TP > funding", () => {
    const { h, m2m } = setup();
    // SL dan TP sama-sama akan terpicu pada mark 72000 (likuidasi juga).
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "70000", slPrice: "78000" });
    const fundingTs = h.now() + 1;
    h.advance(5);

    const result = m2m.processMark({
      commandId: "p",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "72000", { timestampMs: fundingTs, rate: "0.0001" }),
      execution: quote("BTC_USDT", "71990"),
      nowMs: h.now(),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.reason).toBe("liquidation");
    // Posisi sudah ditutup → funding TIDAK dikenakan pada snapshot yang sama.
    expect(result.funding).toHaveLength(0);
  });

  test("SL > TP saat likuidasi tidak berlaku", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "70000", slPrice: "90000" });
    const result = m2m.processMark({
      commandId: "p",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "80000"),
      execution: quote("BTC_USDT", "80000"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("stop_loss");
  });

  test("kebijakan terdokumentasi: posisi yang ditutup aksi risiko TIDAK dikenakan funding pada snapshot yang sama", () => {
    const { h, m2m } = setup();
    openPosition(h, "a", "buy", 5, "80000", { tpPrice: "82000" });
    const fundingTs = h.now() + 1;
    h.advance(5);

    const result = m2m.processMark({
      commandId: "p",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "82500", { timestampMs: fundingTs, rate: "0.0001" }),
      execution: quote("BTC_USDT", "82490"),
      nowMs: h.now(),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.reason).toBe("take_profit");
    // Posisi sudah tertutup saat funding diproses → tidak dikenakan.
    expect(result.funding).toHaveLength(0);
  });

  test("posisi yang TETAP terbuka dikenakan funding pada snapshot yang sama", () => {
    const { h, m2m } = setup();
    openPosition(h, "b", "buy", 5, "80000");
    const fundingTs = h.now() + 1;
    h.advance(5);

    const result = m2m.processMark({
      commandId: "p",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "82500", { timestampMs: fundingTs, rate: "0.0001" }),
      execution: quote("BTC_USDT", "82500"),
      nowMs: h.now(),
    });

    expect(result.actions).toHaveLength(0);
    expect(result.funding).toHaveLength(1);
    // 5 × 0.0001 × 82500 = 41.25 notional × 0.0001 = 0.004125
    expect(result.funding[0]!.amount.toString()).toBe("0.004125");
  });

  test("data basi membatalkan SEMUA aksi risiko dan funding", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    const fundingTs = h.now() + 1;
    h.advance(100_000);
    const result = m2m.processMark({
      commandId: "stale",
      accountId: h.accountId,
      mark: parseMarkSnapshot({
        contract: "BTC_USDT",
        markPrice: "70000",
        observedAtMs: h.now(),
        sourceTimestampMs: h.now() - 120_000,
        funding: { fundingRate: "0.0001", fundingTimestampMs: fundingTs, intervalSeconds: 28800 },
      }),
      execution: quote("BTC_USDT", "69990"),
      nowMs: h.now(),
    });
    expect(result.stale).toBe(true);
    expect(result.actions).toHaveLength(0);
    expect(result.funding).toHaveLength(0);
    expect(h.positions.listOpen(h.accountId)).toHaveLength(1);
  });

  test("fitur bisa dimatikan lewat konfigurasi runtime", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    const result = m2m.processMark({
      commandId: "off",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "70000"),
      execution: quote("BTC_USDT", "69990"),
      nowMs: h.advance(),
      config: { enableLiquidation: false, enableTpSl: false },
    });
    expect(result.actions).toHaveLength(0);
    expect(h.positions.listOpen(h.accountId)).toHaveLength(1);
  });
});

describe("18. idempotensi runtime", () => {
  test("snapshot mark duplikat (commandId sama) tidak menggandakan efek", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    const command = {
      commandId: "dup",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "77000"),
      execution: quote("BTC_USDT", "76990"),
      nowMs: h.advance(),
    };
    const first = m2m.processMark(command);
    expect(first.actions).toHaveLength(1);
    const after = snap(h);

    const second = m2m.processMark(command);
    expect(second.duplicate).toBe(true);
    expect(snap(h)).toEqual(after);
  });

  test("snapshot duplikat dengan commandId BERBEDA tetap tidak menggandakan (posisi sudah tertutup)", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    m2m.processMark({
      commandId: "first",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "77000"),
      execution: quote("BTC_USDT", "76990"),
      nowMs: h.advance(),
    });
    const after = snap(h);

    const again = m2m.processMark({
      commandId: "second",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "77000"),
      execution: quote("BTC_USDT", "76990"),
      nowMs: h.advance(),
    });
    expect(again.actions).toHaveLength(0);
    const { commands: _ignored, ...afterEconomics } = after;
    expect(economicSnap(h)).toEqual(afterEconomics);
  });

  test("trigger SL berulang tidak menutup dua kali", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    for (let i = 0; i < 5; i += 1) {
      m2m.processMark({
        commandId: `sl-${i}`,
        accountId: h.accountId,
        mark: markOf(h, "BTC_USDT", "76000"),
        execution: quote("BTC_USDT", "75990"),
        nowMs: h.advance(),
      });
    }
    expect(h.fills.count()).toBe(2); // 1 fill buka + 1 fill tutup
    expect(h.positions.listOpen(h.accountId)).toHaveLength(0);
  });

  test("liquidation berulang tidak menggandakan settlement", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    for (let i = 0; i < 4; i += 1) {
      m2m.processMark({
        commandId: `liq-${i}`,
        accountId: h.accountId,
        mark: markOf(h, "BTC_USDT", "70000"),
        execution: quote("BTC_USDT", "69990"),
        nowMs: h.advance(),
      });
    }
    const closes = h.ledger.list(h.accountId, { limit: 1000 }).filter((e) => e.type === "pnl_realized");
    const openPnl = closes.filter((e) => e.meta.reason === undefined);
    const closePnl = closes.filter((e) => e.meta.reason === "liquidation");
    // Tidak ada fill buka yang menghasilkan pnl_realized; hanya satu penutupan.
    expect(openPnl).toHaveLength(0);
    expect(closePnl).toHaveLength(1);
  });

  test("funding duplikat dengan commandId berbeda tidak menggandakan (ledger idempoten)", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 10, "80000");
    const fundingTs = h.now() + 1;
    h.advance(5);

    const makeCommand = (id: string) => ({
      commandId: id,
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "80000", { timestampMs: fundingTs, rate: "0.0001" }),
      execution: quote("BTC_USDT", "80000"),
      nowMs: h.now(),
    });
    m2m.processMark(makeCommand("f1"));
    const after = snap(h);
    const second = m2m.processMark(makeCommand("f2"));

    expect(second.funding[0]!.applied).toBe(false);
    for (const [key, value] of Object.entries(economicSnap(h))) {
      expect(value).toEqual((after as Record<string, unknown>)[key]);
    }
    expect(h.ledger.list(h.accountId, { limit: 1000 }).filter((e) => e.type === "funding")).toHaveLength(1);
  });

  test("penutupan manual duplikat ditolak setelah posisi tertutup", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const positionId = h.positions.listOpen(h.accountId)[0]!.id;
    m2m.closePosition({ commandId: "m1", positionId, execution: quote("BTC_USDT", "80000"), nowMs: h.advance() });
    expect(() =>
      m2m.closePosition({ commandId: "m2", positionId, execution: quote("BTC_USDT", "80000"), nowMs: h.advance() }),
    ).toThrow();
    expect(h.fills.count()).toBe(2);
  });
});

describe("17 & 20. transaksionalitas dan rollback", () => {
  test("kegagalan pada penulisan ledger funding menggulung seluruh pemrosesan", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 10, "80000");
    const fundingTs = h.now() + 1;
    h.advance(5);
    const before = snap(h);

    // Trigger DB menolak penulisan ledger funding.
    h.connection.sqlite
      .prepare(
        `CREATE TRIGGER inject_funding_fail BEFORE INSERT ON ledger
         WHEN NEW.type = 'funding'
         BEGIN SELECT RAISE(ABORT, 'injected funding failure'); END`,
      )
      .run();

    expect(() =>
      m2m.processMark({
        commandId: "boom",
        accountId: h.accountId,
        mark: markOf(h, "BTC_USDT", "80000", { timestampMs: fundingTs, rate: "0.0001" }),
        execution: quote("BTC_USDT", "80000"),
        nowMs: h.now(),
      }),
    ).toThrow();

    expect(snap(h)).toEqual(before);
    h.connection.sqlite.prepare("DROP TRIGGER inject_funding_fail").run();
  });

  test("kegagalan pada settlement penutupan menggulung fill, posisi, dan ledger", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    const before = snap(h);

    // Gagal saat menulis ledger PnL penutupan.
    h.connection.sqlite
      .prepare(
        `CREATE TRIGGER inject_settle_fail BEFORE INSERT ON ledger
         WHEN NEW.idempotency_key LIKE 'settle:%:pnl'
         BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END`,
      )
      .run();

    expect(() =>
      m2m.processMark({
        commandId: "boom",
        accountId: h.accountId,
        mark: markOf(h, "BTC_USDT", "77000"),
        execution: quote("BTC_USDT", "76990"),
        nowMs: h.advance(),
      }),
    ).toThrow();

    // Posisi masih terbuka, tidak ada fill baru, ledger & saldo tidak berubah.
    expect(snap(h)).toEqual(before);
    expect(h.positions.listOpen(h.accountId)).toHaveLength(1);
    h.connection.sqlite.prepare("DROP TRIGGER inject_settle_fail").run();

    // Dan setelah trigger dibuang, pemrosesan berikutnya berhasil.
    const retry = m2m.processMark({
      commandId: "retry",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "77000"),
      execution: quote("BTC_USDT", "76990"),
      nowMs: h.advance(),
    });
    expect(retry.actions[0]!.reason).toBe("stop_loss");
  });

  test("kegagalan pada posisi close event menggulung penutupan", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const before = snap(h);

    h.connection.sqlite
      .prepare(
        `CREATE TRIGGER inject_event_fail BEFORE INSERT ON position_events
         WHEN NEW.type = 'closed'
         BEGIN SELECT RAISE(ABORT, 'injected close event failure'); END`,
      )
      .run();

    expect(() =>
      m2m.closePosition({
        commandId: "boom",
        positionId: h.positions.listOpen(h.accountId)[0]!.id,
        execution: quote("BTC_USDT", "80000"),
        nowMs: h.advance(),
      }),
    ).toThrow();

    expect(snap(h)).toEqual(before);
    h.connection.sqlite.prepare("DROP TRIGGER inject_event_fail").run();
  });

  test("rollback tetap menjaga rekonsiliasi cache saldo", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    h.connection.sqlite
      .prepare(
        `CREATE TRIGGER inject_pnl_fail BEFORE INSERT ON ledger
         WHEN NEW.idempotency_key LIKE 'settle:%:pnl'
         BEGIN SELECT RAISE(ABORT, 'nope'); END`,
      )
      .run();
    expect(() =>
      m2m.processMark({
        commandId: "boom",
        accountId: h.accountId,
        mark: markOf(h, "BTC_USDT", "77000"),
        execution: quote("BTC_USDT", "76990"),
        nowMs: h.advance(),
      }),
    ).toThrow();
    h.connection.sqlite.prepare("DROP TRIGGER inject_pnl_fail").run();

    const verified = h.ledger.verifyBalances(h.accountId);
    expect(verified.cacheMatches).toBe(true);
    expect(verified.chainMismatch).toBeNull();
    const balances = h.balances();
    expect(h.positions.totalOpenMargin(h.accountId).eq(balances.usedMargin)).toBe(true);
  });
});

describe("15. available balance saat runtime", () => {
  test("unrealized profit tidak menambah available", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const before = h.available();

    m2m.processMark({
      commandId: "up",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "90000"),
      execution: quote("BTC_USDT", "90000"),
      nowMs: h.advance(),
    });

    // Profit besar tapi available tidak berubah (margin belum dilepas).
    expect(h.available().eq(before)).toBe(true);
    const valuation = m2m.cashValuation(h.accountId);
    expect(valuation.availableBalance.eq(before)).toBe(true);
  });

  test("equity mengikuti unrealized, available tidak", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const evaluated = m2m.evaluateAccount({
      accountId: h.accountId,
      marks: new Map([["BTC_USDT", "85000"]]),
    });
    // 1 × 0.0001 × 5000 = 0.5
    expect(evaluated.account.unrealizedPnl.toString()).toBe("0.5");
    expect(
      evaluated.account.equity.eq(h.balances().walletBalance.plus("0.5")),
    ).toBe(true);
    expect(
      evaluated.account.availableBalance.eq(h.available()),
    ).toBe(true);
  });

  test("unrealized loss menurunkan equity dan menaikkan margin ratio", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const evaluated = m2m.evaluateAccount({
      accountId: h.accountId,
      marks: new Map([["BTC_USDT", "73000"]]),
    });
    expect(evaluated.account.unrealizedPnl.toString()).toBe("-0.7");
    expect(evaluated.account.equity.lessThan(h.balances().walletBalance)).toBe(true);
    expect(evaluated.account.marginRatio!.greaterThan(0)).toBe(true);
  });
});
