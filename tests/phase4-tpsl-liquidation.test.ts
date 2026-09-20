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

function setup(balance = "10000"): { h: ExchangeHarness; m2m: MarkToMarketService } {
  const h = setupExchange({ initialBalance: balance, specs: [BTC_USDT, ETH_USDT, SOL_USDT], startMs: 1_700_000_000_000 });
  harnesses.push(h);
  return { h, m2m: new MarkToMarketService({ connection: h.connection }) };
}

function markOf(h: ExchangeHarness, contract: string, price: string) {
  return parseMarkSnapshot({
    contract,
    markPrice: price,
    observedAtMs: h.now(),
    sourceTimestampMs: h.now(),
    funding: null,
  });
}

function quote(contract: string, price: string) {
  return { contract, bidPrice: price, askPrice: price };
}

/** Buka posisi dengan TP/SL opsional pada harga simetris (entry = price). */
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

describe("7. persistensi TP/SL", () => {
  test("TP/SL dari intent tersimpan pada posisi saat dibuka", () => {
    const { h } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "85000", slPrice: "75000" });
    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.tpPrice!.toString()).toBe("85000");
    expect(position.slPrice!.toString()).toBe("75000");
  });

  test("posisi tanpa TP/SL tetap valid (null)", () => {
    const { h } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const position = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    expect(position.tpPrice).toBeNull();
    expect(position.slPrice).toBeNull();
  });
});

describe("8. trigger TP/SL memakai mark, eksekusi memakai kutipan", () => {
  test("LONG TP: mark >= TP menutup posisi", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "82000" });

    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "82500"),
      execution: quote("BTC_USDT", "82490"),
      nowMs: h.advance(),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.reason).toBe("take_profit");
    expect(result.actions[0]!.triggeredAtMark!.toString()).toBe("82500");
    // Eksekusi memakai kutipan (bid 82490), bukan harga trigger.
    expect(result.actions[0]!.executionPrice.toString()).toBe("82490");
    // 1 × 0.0001 × (82490 − 80000) = 0.249
    expect(result.actions[0]!.realizedPnl.toString()).toBe("0.249");
    expect(h.positions.listOpen(h.accountId)).toHaveLength(0);
  });

  test("LONG TP: tepat pada target tetap terpicu (inklusif)", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "82000" });
    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "82000"),
      execution: quote("BTC_USDT", "82000"),
      nowMs: h.advance(),
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.reason).toBe("take_profit");
  });

  test("LONG TP: di bawah target tidak terpicu", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "82000" });
    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "81999"),
      execution: quote("BTC_USDT", "81999"),
      nowMs: h.advance(),
    });
    expect(result.actions).toHaveLength(0);
    expect(h.positions.listOpen(h.accountId)).toHaveLength(1);
  });

  test("LONG SL: mark <= SL menutup posisi", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "77500"),
      execution: quote("BTC_USDT", "77490"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("stop_loss");
    expect(result.actions[0]!.executionPrice.toString()).toBe("77490");
    expect(result.actions[0]!.realizedPnl.toString()).toBe("-0.251");
  });

  test("SHORT TP: mark <= TP menutup posisi", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "sell", 1, "80000", { tpPrice: "78000" });
    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "77500"),
      execution: quote("BTC_USDT", "77510"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("take_profit");
    // SHORT ditutup di ASK 77510: 1 × 0.0001 × (80000 − 77510) = 0.249
    expect(result.actions[0]!.executionPrice.toString()).toBe("77510");
    expect(result.actions[0]!.realizedPnl.toString()).toBe("0.249");
  });

  test("SHORT SL: mark >= SL menutup posisi", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "sell", 1, "80000", { slPrice: "82000" });
    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "82500"),
      execution: quote("BTC_USDT", "82510"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("stop_loss");
    expect(result.actions[0]!.realizedPnl.toString()).toBe("-0.251");
  });

  test("SL menang bila TP dan SL sama-sama terpicu (trigger bersilangan)", () => {
    const { h, m2m } = setup();
    // LONG dengan TP di bawah SL (salah konfigurasi): mark memenuhi keduanya.
    openPosition(h, "c1", "buy", 1, "80000", { tpPrice: "70000", slPrice: "90000" });
    const result = m2m.processMark({
      commandId: "m1",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "80000"),
      execution: quote("BTC_USDT", "79990"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("stop_loss");
  });
});

describe("13. gap: trigger != harga eksekusi", () => {
  test("LONG SL 78000, mark gap ke 75000 → eksekusi di kutipan 74900", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });

    const result = m2m.processMark({
      commandId: "gap",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "75000"),
      execution: { contract: "BTC_USDT", bidPrice: "74900", askPrice: "74910" },
      nowMs: h.advance(),
    });

    const action = result.actions[0]!;
    expect(action.reason).toBe("stop_loss");
    expect(action.triggeredAtMark!.toString()).toBe("75000");
    // TIDAK boleh mengaku terisi di 78000.
    expect(action.executionPrice.toString()).toBe("74900");
    expect(action.executionPrice.toString()).not.toBe("78000");
    // 1 × 0.0001 × (74900 − 80000) = −0.51
    expect(action.realizedPnl.toString()).toBe("-0.51");
    expect(action.deficit.isZero()).toBe(true);
  });

  test("gap melewati seluruh margin → defisit tercatat dan kas tidak negatif", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000" });
    const walletBefore = h.balances().walletBalance;

    const result = m2m.processMark({
      commandId: "deep",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "70000"),
      execution: { contract: "BTC_USDT", bidPrice: "69000", askPrice: "69010" },
      nowMs: h.advance(),
    });

    const action = result.actions[0]!;
    // PnL sebenarnya = 1 × 0.0001 × (69000 − 80000) = −1.1; margin 0.8 → defisit 0.3
    expect(action.realizedPnl.toString()).toBe("-1.1");
    expect(action.pnlAppliedToWallet.toString()).toBe("-0.8");
    expect(action.deficit.toString()).toBe("0.3");
    expect(action.insolvent).toBe(true);

    // Kas turun tepat sebesar margin + fee penutupan (bukan 1.1), dan tidak negatif.
    //   Δwallet = pnl_realized(−1.1) + deficit_terampuni(+0.3) − fee
    //           = −0.8 − fee
    expect(
      h.balances().walletBalance.eq(walletBefore.minus("0.8").minus(action.fee)),
    ).toBe(true);
    expect(h.balances().walletBalance.isNegative()).toBe(false);
    // Konservasi: PnL sebenarnya = porsi kas − defisit.
    expect(action.pnlAppliedToWallet.minus(action.deficit).eq(action.realizedPnl)).toBe(true);

    // Defisit terlihat di ledger.
    const deficitEntry = h.ledger
      .list(h.accountId, { limit: 1000 })
      .find((entry) => entry.type === "liquidation_loss");
    expect(deficitEntry).toBeDefined();
    expect(deficitEntry!.amount.toString()).toBe("0.3");
    expect(deficitEntry!.meta.deficit).toBe("0.3");
  });

  test("SHORT gap ke atas: eksekusi di ask, bukan harga SL", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "sell", 1, "80000", { slPrice: "82000" });
    const result = m2m.processMark({
      commandId: "gap",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "85000"),
      execution: { contract: "BTC_USDT", bidPrice: "85000", askPrice: "85010" },
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("stop_loss");
    expect(result.actions[0]!.executionPrice.toString()).toBe("85010");
    // 1 × 0.0001 × (80000 − 85010) = −0.501
    expect(result.actions[0]!.realizedPnl.toString()).toBe("-0.501");
  });
});

describe("11. likuidasi", () => {
  test("mark melewati harga likuidasi → posisi ditutup dengan reason liquidation", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    // Harga likuidasi @lev10 = 72240.
    const result = m2m.processMark({
      commandId: "liq",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "72000"),
      execution: quote("BTC_USDT", "71990"),
      nowMs: h.advance(),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.reason).toBe("liquidation");
    expect(result.actions[0]!.executionPrice.toString()).toBe("71990");
    expect(h.positions.listOpen(h.accountId)).toHaveLength(0);

    const closed = h.positions.require(result.actions[0]!.positionId);
    expect(closed.status).toBe("closed");
    expect(closed.closeReason).toBe("liquidation");
  });

  test("mark sehat tidak melikuidasi", () => {
    const { h, m2m } = setup();
    openPosition(h, "c1", "buy", 1, "80000");
    const result = m2m.processMark({
      commandId: "healthy",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "80000"),
      execution: quote("BTC_USDT", "80000"),
      nowMs: h.advance(),
    });
    expect(result.actions).toHaveLength(0);
    expect(h.positions.listOpen(h.accountId)).toHaveLength(1);
  });

  test("likuidasi MENDAHULUI SL/TP saat keduanya terpenuhi", () => {
    const { h, m2m } = setup();
    // SL 78000 juga akan terpicu pada mark 72000; likuidasi harus menang.
    openPosition(h, "c1", "buy", 1, "80000", { slPrice: "78000", tpPrice: "85000" });
    const result = m2m.processMark({
      commandId: "prec",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "72000"),
      execution: quote("BTC_USDT", "71990"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("liquidation");
  });

  test("likuidasi tidak menyentuh posisi kontrak lain", () => {
    const { h, m2m } = setup();
    openPosition(h, "btc", "buy", 1, "80000");
    openPosition(h, "eth", "buy", 1, "3000", {}, "ETH_USDT");

    const result = m2m.processMark({
      commandId: "liq-btc",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "70000"),
      execution: quote("BTC_USDT", "69990"),
      nowMs: h.advance(),
    });

    expect(result.actions).toHaveLength(1);
    // ETH tetap terbuka dan marginnya tetap terkunci.
    const eth = h.positions.findOpen(h.accountId, "ETH_USDT");
    expect(eth).not.toBeNull();
    expect(eth!.initialMargin.toString()).toBe("3");
  });
});

describe("16. isolasi margin antar posisi", () => {
  test("kerugian satu posisi tidak melikuidasi posisi lain", () => {
    const { h, m2m } = setup();
    // Saldo kecil supaya cross-margin (kalau ada) akan terlihat.
    openPosition(h, "btc", "buy", 1, "80000");
    openPosition(h, "sol", "buy", 5, "150", {}, "SOL_USDT");

    const btcBefore = h.positions.findOpen(h.accountId, "BTC_USDT")!;
    const solBefore = h.positions.findOpen(h.accountId, "SOL_USDT")!;

    // BTC rugi besar (likuidasi), SOL tidak tersentuh.
    const result = m2m.processMark({
      commandId: "liq",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "71000"),
      execution: quote("BTC_USDT", "70990"),
      nowMs: h.advance(),
    });
    expect(result.actions[0]!.reason).toBe("liquidation");

    const solAfter = h.positions.require(solBefore.id);
    expect(solAfter.status).toBe("open");
    expect(solAfter.size).toBe(solBefore.size);
    expect(solAfter.initialMargin.eq(solBefore.initialMargin)).toBe(true);
    expect(h.positions.require(btcBefore.id).status).toBe("closed");
  });

  test("margin posisi lain tetap terkunci setelah likuidasi", () => {
    const { h, m2m } = setup();
    openPosition(h, "btc", "buy", 1, "80000");
    openPosition(h, "sol", "buy", 5, "150", {}, "SOL_USDT");
    const solMargin = h.positions.findOpen(h.accountId, "SOL_USDT")!.initialMargin;

    m2m.processMark({
      commandId: "liq",
      accountId: h.accountId,
      mark: markOf(h, "BTC_USDT", "71000"),
      execution: quote("BTC_USDT", "70990"),
      nowMs: h.advance(),
    });

    // used_margin = margin SOL saja.
    expect(h.balances().usedMargin.eq(solMargin)).toBe(true);
    expect(h.positions.totalOpenMargin(h.accountId).eq(solMargin)).toBe(true);
  });
});
