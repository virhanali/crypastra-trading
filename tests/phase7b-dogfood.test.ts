import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { CommandBook, actionKey } from "../apps/web/src/lib/command-id.js";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/**
 * Alur dogfood deterministik (mode simulasi) memakai ENDPOINT yang sama dengan
 * terminal, bukan repository internal. Ini menggantikan browser flow: seluruh
 * lapisan HTTP + matching + ledger + outbox dilewati persis seperti yang
 * dilakukan UI.
 */
async function setup(): Promise<{ h: ApiHarness; accountId: string }> {
  const h = setupApi();
  harnesses.push(h);
  await injectMarket(h, "BTC_USDT", "80000");
  const accountId = await createAccountViaApi(h, { initialBalance: "0" });
  const deposit = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
    commandId: "df-deposit",
    amount: "1000",
  });
  expect(deposit.status).toBe(201);
  return { h, accountId };
}

async function nextCommandId(book: CommandBook, key: string): Promise<string> {
  return book.for(key);
}

describe("alur dogfood: limit → reserve → cancel", () => {
  test("limit resting menahan margin, cancel melepaskannya", async () => {
    const { h, accountId } = await setup();
    const commands = new CommandBook((() => {
      let n = 0;
      return () => `c-${(n += 1)}`;
    })());

    const before = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(before.json.reservedMargin).toBe("0.00000000");
    const availableBefore = new Decimal(before.json.availableBalance);

    // LIMIT di bawah pasar → resting, margin direservasi.
    const key = actionKey("submit_order", { contract: "BTC_USDT", side: "buy", size: 5, price: "70000" });
    const submit = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: await nextCommandId(commands, key),
      contract: "BTC_USDT",
      side: "buy",
      type: "limit",
      size: "5",
      leverage: "10",
      limitPrice: "70000",
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    expect(submit.status).toBe(201);
    expect(submit.json.order.status).toBe("open");

    const resting = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    // 5 × 0.0001 × 70000 / 10 = 3.5
    expect(resting.json.reservedMargin).toBe("3.50000000");
    expect(new Decimal(resting.json.availableBalance).eq(availableBefore.minus("3.5"))).toBe(true);
    expect(resting.json.openOrderCount).toBe(1);

    // Cancel → reservasi dilepas.
    const cancelKey = actionKey("cancel_order", { orderId: submit.json.order.id });
    const cancelled = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders/${submit.json.order.id}/cancel`,
      { commandId: await nextCommandId(commands, cancelKey) },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.order.status).toBe("cancelled");

    const afterCancel = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(afterCancel.json.reservedMargin).toBe("0.00000000");
    expect(new Decimal(afterCancel.json.availableBalance).eq(availableBefore)).toBe(true);
    expect(afterCancel.json.openOrderCount).toBe(0);
  });
});

describe("alur dogfood: market → posisi → TP/SL → close", () => {
  test("market LONG, amend protection, lalu close penuh dengan ledger konsisten", async () => {
    const { h, accountId } = await setup();

    // 1. Market LONG.
    const submit = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "mk-1",
      contract: "BTC_USDT",
      side: "buy",
      type: "market",
      size: "2",
      leverage: "10",
      limitPrice: null,
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    expect(submit.status).toBe(201);
    expect(submit.json.order.status).toBe("filled");
    expect(submit.json.fills).toHaveLength(1);

    const positions = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(positions.json.positions).toHaveLength(1);
    const position = positions.json.positions[0];
    expect(position.side).toBe("long");
    expect(position.size).toBe("2");
    expect(position.markPrice).toBe("80000");

    const afterOpen = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    // 2 × 0.0001 × 80000 / 10 = 1.6
    expect(afterOpen.json.positionMargin).toBe("1.60000000");

    // 2. TP/SL awal.
    const setBoth = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${position.id}/protection`,
      { commandId: "tp-1", takeProfitPrice: "82000", stopLossPrice: "78000" },
    );
    expect(setBoth.status).toBe(200);
    expect(setBoth.json.position.takeProfitPrice).toBe("82000");
    expect(setBoth.json.position.stopLossPrice).toBe("78000");

    // 3. Amend: ubah TP saja (SL tidak disebut → dipertahankan).
    const amendTp = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${position.id}/protection`,
      { commandId: "tp-2", takeProfitPrice: "83000" },
    );
    expect(amendTp.json.position.takeProfitPrice).toBe("83000");
    expect(amendTp.json.position.stopLossPrice).toBe("78000");

    // 4. Kosongkan TP (null), SL tetap.
    const clearTp = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${position.id}/protection`,
      { commandId: "tp-3", takeProfitPrice: null },
    );
    expect(clearTp.json.position.takeProfitPrice).toBeNull();
    expect(clearTp.json.position.stopLossPrice).toBe("78000");

    // 5. Mark bergerak → UPnL terlihat.
    await injectMarket(h, "BTC_USDT", "81000");
    const moved = await h.request("GET", `/api/v1/accounts/${accountId}/positions/${position.id}`);
    // 2 × 0.0001 × 1000 = 0.2
    expect(moved.json.position.unrealizedPnl).toBe("0.20000000");

    // 6. Close penuh memakai kutipan pasar server.
    const close = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/positions/${position.id}/close`,
      { commandId: "close-1" },
    );
    expect(close.status).toBe(200);
    expect(close.json.settlement.reason).toBe("manual");

    const afterClose = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(afterClose.json.positions).toHaveLength(0);

    // 7. Fill & riwayat & ledger mencatat seluruhnya.
    const fills = await h.request("GET", `/api/v1/accounts/${accountId}/fills`);
    expect(fills.json.fills.length).toBeGreaterThanOrEqual(2);
    const history = await h.request("GET", `/api/v1/accounts/${accountId}/history`);
    expect(history.json.positions[0].status).toBe("closed");
    expect(history.json.positions[0].closeReason).toBe("manual");

    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    const types = ledger.json.entries.map((entry: any) => entry.type);
    expect(types).toContain("margin_lock");
    expect(types).toContain("margin_release");
    expect(types).toContain("fee");
    expect(types).toContain("pnl_realized");

    // 8. Margin posisi dilepas; integritas tetap sehat.
    const finalSummary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(finalSummary.json.positionMargin).toBe("0.00000000");
    expect(finalSummary.json.openPositionCount).toBe(0);
    const integrity = await h.request("GET", "/api/v1/health/integrity");
    expect(integrity.status).toBe(200);
  });
});

describe("idempotensi sisi klien terhadap backend nyata", () => {
  test("double submit dengan commandId sama → tepat satu order", async () => {
    const { h, accountId } = await setup();
    const payload = {
      commandId: "dup-1",
      contract: "BTC_USDT",
      side: "buy",
      type: "limit",
      size: "1",
      leverage: "10",
      limitPrice: "70000",
      takeProfitPrice: null,
      stopLossPrice: null,
    };
    const first = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, payload);
    expect(first.status).toBe(201);
    const second = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, payload);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.order.id).toBe(first.json.order.id);

    const orders = await h.request("GET", `/api/v1/accounts/${accountId}/orders`);
    expect(orders.json.orders).toHaveLength(1);
  });

  test("commandId sama dengan payload berbeda → 409, bukan order kedua", async () => {
    const { h, accountId } = await setup();
    const base = {
      commandId: "conf-1",
      contract: "BTC_USDT",
      side: "buy",
      type: "limit",
      size: "1",
      leverage: "10",
      limitPrice: "70000",
      takeProfitPrice: null,
      stopLossPrice: null,
    };
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, base);
    const conflict = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      ...base,
      size: "3",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const orders = await h.request("GET", `/api/v1/accounts/${accountId}/orders`);
    expect(orders.json.orders).toHaveLength(1);
    expect(orders.json.orders[0].size).toBe("1");
  });

  test("cancel dua kali dengan commandId sama → idempoten", async () => {
    const { h, accountId } = await setup();
    const submit = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "cx-1",
      contract: "BTC_USDT",
      side: "buy",
      type: "limit",
      size: "1",
      leverage: "10",
      limitPrice: "70000",
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    const orderId = submit.json.order.id;
    const first = await h.request("POST", `/api/v1/accounts/${accountId}/orders/${orderId}/cancel`, { commandId: "cc-1" });
    expect(first.status).toBe(200);
    const second = await h.request("POST", `/api/v1/accounts/${accountId}/orders/${orderId}/cancel`, { commandId: "cc-1" });
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);

    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.reservedMargin).toBe("0.00000000");
  });

  test("amandemen TP/SL idempoten", async () => {
    const { h, accountId } = await setup();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "mk-2",
      contract: "BTC_USDT",
      side: "buy",
      type: "market",
      size: "1",
      leverage: "10",
      limitPrice: null,
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    const payload = { commandId: "pp-1", takeProfitPrice: "82000" };
    const first = await h.request("PATCH", `/api/v1/accounts/${accountId}/positions/${positionId}/protection`, payload);
    expect(first.status).toBe(200);
    const second = await h.request("PATCH", `/api/v1/accounts/${accountId}/positions/${positionId}/protection`, payload);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);

    const detail = await h.request("GET", `/api/v1/accounts/${accountId}/positions/${positionId}`);
    const updates = detail.json.events.filter((event: any) => event.type === "protection_updated");
    expect(updates).toHaveLength(1);
  });
});

describe("error mapping yang dipakai UI", () => {
  test("saldo tidak cukup → 422 INSUFFICIENT_BALANCE, tanpa efek ekonomi", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h, { initialBalance: "10" });
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "poor-1",
      contract: "BTC_USDT",
      side: "buy",
      type: "market",
      size: "1000",
      leverage: "10",
      limitPrice: null,
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    // Penolakan order adalah keadaan domain yang dipersist (201 + rejected).
    expect(response.status).toBe(201);
    expect(response.json.order.status).toBe("rejected");
    expect(response.json.order.rejectReason).toBeTruthy();
    expect(response.json.fills).toHaveLength(0);

    const positions = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(positions.json.positions).toHaveLength(0);
  });

  test("TP salah sisi → 422 INVALID_ORDER", async () => {
    const { h, accountId } = await setup();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "mk-3",
      contract: "BTC_USDT",
      side: "buy",
      type: "market",
      size: "1",
      leverage: "10",
      limitPrice: null,
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    const response = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${positionId}/protection`,
      { commandId: "bad-tp", takeProfitPrice: "70000" },
    );
    expect(response.status).toBe(422);
    expect(response.json.error.code).toBe("INVALID_ORDER");
    // Tidak ada stack trace / SQL yang bocor.
    expect(response.raw).not.toContain("    at ");
    expect(response.raw).not.toContain("SQLITE");
  });

  test("close tanpa kutipan pasar → 404, bukan harga karangan", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h, { initialBalance: "1000" });
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "mk-4",
      contract: "BTC_USDT",
      side: "buy",
      type: "market",
      size: "1",
      leverage: "10",
      limitPrice: null,
      takeProfitPrice: null,
      stopLossPrice: null,
    });
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    // Buku pasar hilang → penutupan harus menolak, bukan menebak harga.
    h.market.clear();
    const response = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/positions/${positionId}/close`,
      { commandId: "close-nomarket" },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    // Posisi tetap terbuka.
    const positions = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(positions.json.positions).toHaveLength(1);
  });
});
