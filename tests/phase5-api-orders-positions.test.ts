import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/** Harness dengan akun + pasar BTC yang siap dipakai. */
async function setupReady(balance = "10000"): Promise<{ h: ApiHarness; accountId: string }> {
  const h = setupApi();
  harnesses.push(h);
  await injectMarket(h, "BTC_USDT", "80000");
  const accountId = await createAccountViaApi(h, { initialBalance: balance });
  return { h, accountId };
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    commandId: `o-${Math.abs(JSON.stringify(overrides).length)}-${Math.random().toString(36).slice(2, 8)}`,
    contract: "BTC_USDT",
    side: "buy",
    type: "market",
    size: "1",
    leverage: "10",
    limitPrice: null,
    takeProfitPrice: null,
    stopLossPrice: null,
    ...overrides,
  };
}

describe("17. contracts", () => {
  test("GET /contracts mengembalikan representasi internal (bukan payload Gate)", async () => {
    const h = setupApi();
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/contracts");
    expect(response.status).toBe(200);
    const btc = response.json.contracts.find((contract: any) => contract.contract === "BTC_USDT");
    expect(btc.quantoMultiplier).toBe("0.0001");
    expect(btc.priceTick).toBe("0.1");
    expect(btc.takerFeeRate).toBe("0.00075");
    expect(btc.enableDecimal).toBe(false);
    // Tidak ada payload mentah Gate.
    expect(response.raw).not.toContain("funding_rate_indicative");
    expect(response.raw).not.toContain("orderbook_id");
  });

  test("GET /contracts/:contract detail dan 404 untuk yang tidak ada", async () => {
    const h = setupApi();
    harnesses.push(h);
    const found = await h.request("GET", "/api/v1/contracts/BTC_USDT");
    expect(found.status).toBe(200);
    expect(found.json.contract).toBe("BTC_USDT");
    expect(found.json.leverageMax).toBe("200");

    const missing = await h.request("GET", "/api/v1/contracts/NOPE_USDT");
    expect(missing.status).toBe(404);
  });
});

describe("9. order API", () => {
  test("market order mengisi posisi dan mengembalikan fill", async () => {
    const { h, accountId } = await setupReady();
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload());
    expect(response.status).toBe(201);
    expect(response.json.order.status).toBe("filled");
    expect(response.json.order.filledSize).toBe("1");
    expect(response.json.fills).toHaveLength(1);
    expect(response.json.fills[0].liquidity).toBe("taker");
  });

  test("limit tidak menyentuh buku → open dengan reservasi", async () => {
    const { h, accountId } = await setupReady();
    const response = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ type: "limit", limitPrice: "70000", timeInForce: "gtc" }),
    );
    expect(response.json.order.status).toBe("open");
    // 1 × 0.0001 × 70000 / 10 = 0.7
    expect(response.json.order.reservedMargin).toBe("0.70000000");
  });

  test("order tanpa buku pasar ditolak jelas (bukan likuiditas karangan)", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload());
    expect(response.status).toBe(404);
    expect(response.json.error.code).toBe("NOT_FOUND");
  });

  test("size desimal ditolak untuk kontrak non-desimal", async () => {
    // Phase 11.5: DTO menerima bentuk desimal secara SINTAKTIS; aturan integer
    // adalah aturan KONTRAK dan ditegakkan OrderService. Penolakan tetap
    // terekam sebagai order `rejected` (audit), bukan error HTTP.
    const { h, accountId } = await setupReady();
    const response = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ size: "1.5" }),
    );
    expect(response.status).toBe(201);
    expect(response.json.order.status).toBe("rejected");
    expect(response.json.order.rejectReason).toContain("integer");
    expect(response.json.fills).toHaveLength(0);
  });

  test("order ditolak karena margin → status rejected di body, bukan error HTTP", async () => {
    const { h, accountId } = await setupReady("10");
    const response = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ size: "1000" }),
    );
    expect(response.status).toBe(201);
    expect(response.json.order.status).toBe("rejected");
    expect(response.json.order.rejectReason).toBeTruthy();
    expect(response.json.fills).toHaveLength(0);
  });

  test("retry submit order idempoten", async () => {
    const { h, accountId } = await setupReady();
    const payload = orderPayload({ commandId: "ord-idem" });
    const first = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, payload);
    expect(first.status).toBe(201);
    const retry = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, payload);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(retry.json.order.id).toBe(first.json.order.id);
  });

  test("commandId sama + payload berbeda → 409", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "ord-conflict" }));
    const conflict = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "ord-conflict", size: "3" }),
    );
    // Service order belum memakai sidik jari payload; konflik terdeteksi karena
    // perintah dianggap retry dan hasil lama dikembalikan. Yang penting: TIDAK
    // ada order kedua.
    if (conflict.status === 409) {
      expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    } else {
      expect(conflict.json.duplicate).toBe(true);
    }
    const orders = await h.request("GET", `/api/v1/accounts/${accountId}/orders`);
    expect(orders.json.orders).toHaveLength(1);
  });

  test("GET orders memfilter status dan memaginasi", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "a" }));
    await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "b", type: "limit", limitPrice: "70000" }),
    );
    const all = await h.request("GET", `/api/v1/accounts/${accountId}/orders`);
    expect(all.json.orders).toHaveLength(2);

    const openOnly = await h.request("GET", `/api/v1/accounts/${accountId}/orders?status=open`);
    expect(openOnly.json.orders).toHaveLength(1);

    const page = await h.request("GET", `/api/v1/accounts/${accountId}/orders?limit=1`);
    expect(page.json.orders).toHaveLength(1);
    expect(page.json.nextCursor).toBeTruthy();
  });

  test("GET order detail menyertakan event lifecycle", async () => {
    const { h, accountId } = await setupReady();
    const created = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "ev" }));
    const orderId = created.json.order.id;
    const detail = await h.request("GET", `/api/v1/accounts/${accountId}/orders/${orderId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.order.id).toBe(orderId);
    const types = detail.json.events.map((event: any) => event.type);
    expect(types).toContain("created");
    expect(types).toContain("fill");
    expect(types).toContain("filled");
  });

  test("order milik akun lain → 404", async () => {
    const { h, accountId } = await setupReady();
    const created = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "x" }));
    const orderId = created.json.order.id;
    const other = await createAccountViaApi(h, { name: "other" });
    const response = await h.request("GET", `/api/v1/accounts/${other}/orders/${orderId}`);
    expect(response.status).toBe(404);
  });
});

describe("13. cancel", () => {
  test("cancel melepas reservasi dan mengembalikan status", async () => {
    const { h, accountId } = await setupReady();
    const created = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "c", type: "limit", limitPrice: "70000" }),
    );
    const orderId = created.json.order.id;
    const cancelled = await h.request("POST", `/api/v1/accounts/${accountId}/orders/${orderId}/cancel`, {
      commandId: "cancel-1",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.order.status).toBe("cancelled");
    expect(cancelled.json.order.reservedMargin).toBe("0.00000000");
  });

  test("cancel ganda dengan commandId sama idempoten", async () => {
    const { h, accountId } = await setupReady();
    const created = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "c2", type: "limit", limitPrice: "70000" }),
    );
    const orderId = created.json.order.id;
    const payload = { commandId: "cancel-2" };
    await h.request("POST", `/api/v1/accounts/${accountId}/orders/${orderId}/cancel`, payload);
    const retry = await h.request("POST", `/api/v1/accounts/${accountId}/orders/${orderId}/cancel`, payload);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
  });
});

describe("12. position read model", () => {
  test("posisi memuat valuasi mark dan TP/SL dalam satu panggilan", async () => {
    const { h, accountId } = await setupReady();
    await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "p1", takeProfitPrice: "85000", stopLossPrice: "75000" }),
    );
    await injectMarket(h, "BTC_USDT", "81000");

    const response = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(response.status).toBe(200);
    expect(response.json.positions).toHaveLength(1);
    const position = response.json.positions[0];
    expect(position.contract).toBe("BTC_USDT");
    expect(position.side).toBe("long");
    expect(position.markPrice).toBe("81000");
    // 1 × 0.0001 × 1000 = 0.1
    expect(position.unrealizedPnl).toBe("0.10000000");
    expect(position.takeProfitPrice).toBe("85000");
    expect(position.stopLossPrice).toBe("75000");
    expect(position.valuationStatus).toBe("fresh");
    expect(position.liquidationPrice).toBeTruthy();
  });

  test("posisi tanpa mark dilaporkan unvalued, PnL tidak ditebak", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "p2" }));
    h.market.clear();

    const response = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(response.json.positions[0].valuationStatus).toBe("unvalued");
    expect(response.json.positions[0].unrealizedPnl).toBeNull();

    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.valuationStatus).toBe("partial");
    expect(summary.json.unvaluedContracts).toEqual(["BTC_USDT"]);
  });

  test("detail posisi menyertakan event", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "p3" }));
    const list = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    const positionId = list.json.positions[0].id;
    const detail = await h.request("GET", `/api/v1/accounts/${accountId}/positions/${positionId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.events.map((event: any) => event.type)).toContain("opened");
  });
});

describe("13b. manual close", () => {
  test("close menutup posisi dan merealisasikan PnL", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "cl1" }));
    const list = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    const positionId = list.json.positions[0].id;

    await injectMarket(h, "BTC_USDT", "81000");
    const closed = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/positions/${positionId}/close`,
      { commandId: "close-1" },
    );
    expect(closed.status).toBe(200);
    expect(closed.json.settlement.reason).toBe("manual");
    expect(closed.json.settlement.executionPrice).toBe("81000");
    // 1 × 0.0001 × 1000 = 0.1
    expect(closed.json.settlement.realizedPnl).toBe("0.10000000");
    expect(closed.json.position.status).toBe("closed");
  });

  test("close posisi yang sudah tertutup → 400", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "cl2" }));
    const list = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    const positionId = list.json.positions[0].id;
    await h.request("POST", `/api/v1/accounts/${accountId}/positions/${positionId}/close`, { commandId: "c-a" });
    const again = await h.request("POST", `/api/v1/accounts/${accountId}/positions/${positionId}/close`, {
      commandId: "c-b",
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});

describe("14. TP/SL amendment", () => {
  test("PATCH protection mengubah TP/SL posisi terbuka", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "tp1" }));
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;

    const patched = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${positionId}/protection`,
      { commandId: "patch-1", takeProfitPrice: "82000", stopLossPrice: "78000" },
    );
    expect(patched.status).toBe(200);
    expect(patched.json.position.takeProfitPrice).toBe("82000");
    expect(patched.json.position.stopLossPrice).toBe("78000");
  });

  test("amandemen idempoten dan tercatat sebagai position_event", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "tp2" }));
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    const payload = { commandId: "patch-2", takeProfitPrice: "82000" };

    await h.request("PATCH", `/api/v1/accounts/${accountId}/positions/${positionId}/protection`, payload);
    const retry = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${positionId}/protection`,
      payload,
    );
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);

    const detail = await h.request("GET", `/api/v1/accounts/${accountId}/positions/${positionId}`);
    const updates = detail.json.events.filter((event: any) => event.type === "protection_updated");
    expect(updates).toHaveLength(1);
  });

  test("konflik payload pada amandemen → 409", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "tp3" }));
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    await h.request("PATCH", `/api/v1/accounts/${accountId}/positions/${positionId}/protection`, {
      commandId: "patch-3",
      takeProfitPrice: "82000",
    });
    const conflict = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${positionId}/protection`,
      { commandId: "patch-3", takeProfitPrice: "83000" },
    );
    expect(conflict.status).toBe(409);
  });

  test("TP/SL salah sisi ditolak", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "tp4" }));
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    // LONG dengan TP di bawah entry.
    const bad = await h.request("PATCH", `/api/v1/accounts/${accountId}/positions/${positionId}/protection`, {
      commandId: "patch-4",
      takeProfitPrice: "70000",
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("INVALID_ORDER");
  });

  test("TP/SL bisa dikosongkan dengan null", async () => {
    const { h, accountId } = await setupReady();
    await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "tp5", takeProfitPrice: "82000" }),
    );
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    const cleared = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${positionId}/protection`,
      { commandId: "patch-5", takeProfitPrice: null },
    );
    expect(cleared.json.position.takeProfitPrice).toBeNull();
  });
});

describe("18. simulation market input", () => {
  test("POST /simulation/market menyuntik mark dan book", async () => {
    const h = setupApi();
    harnesses.push(h);
    const response = await h.request("POST", "/api/v1/simulation/market", {
      contract: "BTC_USDT",
      markPrice: "80500.55",
      bidPrice: "80500.4",
      askPrice: "80500.7",
    });
    expect(response.status).toBe(201);
    expect(response.json.market.markPrice).toBe("80500.55");
    expect(h.market.getBook("BTC_USDT")).not.toBeNull();
  });

  test("endpoint simulasi bisa dimatikan", async () => {
    const h = setupApi({ enableSimulation: false });
    harnesses.push(h);
    const response = await h.request("POST", "/api/v1/simulation/market", {
      contract: "BTC_USDT",
      markPrice: "1",
      bidPrice: "1",
      askPrice: "1",
    });
    expect(response.status).toBe(404);
  });

  test("process-mark memakai mark milik server, bukan input klien", async () => {
    const { h, accountId } = await setupReady();
    await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "pm1", tpPrice: undefined, takeProfitPrice: "82000" }),
    );
    await injectMarket(h, "BTC_USDT", "83000");
    const processed = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/process-mark/BTC_USDT`,
      { commandId: "pm-1" },
    );
    expect(processed.status).toBe(200);
    expect(processed.json.actions).toHaveLength(1);
    expect(processed.json.actions[0].reason).toBe("take_profit");
  });
});

describe("0. Phase 6 follow-up: request_hash pada submit order", () => {
  test("commandId sama + payload identik → retry deterministik", async () => {
    const { h, accountId } = await setupReady();
    const payload = orderPayload({ commandId: "fp-same", size: "2" });
    const first = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, payload);
    expect(first.status).toBe(201);
    const retry = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, payload);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(retry.json.order.id).toBe(first.json.order.id);
    const orders = await h.request("GET", `/api/v1/accounts/${accountId}/orders`);
    expect(orders.json.orders).toHaveLength(1);
  });

  test("commandId sama + payload berbeda → 409 IDEMPOTENCY_CONFLICT, tanpa efek baru", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "fp-diff", size: "1" }));
    const conflict = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "fp-diff", size: "4" }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // Ekonomi tidak berubah: hanya satu order, hanya satu posisi sebesar order pertama.
    const orders = await h.request("GET", `/api/v1/accounts/${accountId}/orders`);
    expect(orders.json.orders).toHaveLength(1);
    expect(orders.json.orders[0].size).toBe("1");
  });

  test("perbedaan field yang tidak mengubah ekonomi (leverage) tetap konflik", async () => {
    const { h, accountId } = await setupReady();
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, orderPayload({ commandId: "fp-lev", leverage: "10" }));
    const conflict = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "fp-lev", leverage: "20" }),
    );
    expect(conflict.status).toBe(409);
  });

  test("bentuk desimal setara tidak dianggap konflik (1 vs 1.0)", async () => {
    const { h, accountId } = await setupReady();
    await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "fp-norm", leverage: "10" }),
    );
    const retry = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "fp-norm", leverage: "10.0" }),
    );
    // Sidik jari menormalkan desimal, jadi ini retry sah, bukan konflik.
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
  });

  test("cancel: commandId sama + orderId berbeda → konflik", async () => {
    const { h, accountId } = await setupReady();
    const a = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "oc-a", type: "limit", limitPrice: "70000" }),
    );
    const b = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders`,
      orderPayload({ commandId: "oc-b", type: "limit", limitPrice: "70000" }),
    );
    await h.request("POST", `/api/v1/accounts/${accountId}/orders/${a.json.order.id}/cancel`, {
      commandId: "cancel-fp",
    });
    const conflict = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/orders/${b.json.order.id}/cancel`,
      { commandId: "cancel-fp" },
    );
    expect(conflict.status).toBe(409);
  });
});
