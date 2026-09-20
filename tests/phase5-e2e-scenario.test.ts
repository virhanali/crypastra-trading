import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { Decimal } from "../packages/core/src/index.js";
import { injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/**
 * 31. SKENARIO END-TO-END LEWAT API
 *
 * Seluruh langkah hanya memakai HTTP/WS — tidak ada repository internal yang
 * dipanggil langsung dari test. Deterministik: clock disuntik, id dari server.
 */
describe("31. skenario end-to-end API", () => {
  test("buat → deposit → order → TP → tutup → riwayat → ledger → resume WS", async () => {
    const h = setupApi();
    harnesses.push(h);

    // 1. Pasar BTC tersedia (simulasi; Phase 6 akan menggantinya dengan feed nyata).
    await injectMarket(h, "BTC_USDT", "80000");

    // 2. Buat akun paper + deposit 1000.
    const created = await h.request("POST", "/api/v1/accounts", {
      commandId: "e2e-create",
      name: "e2e",
      mode: "simulation",
      baseCurrency: "USDT",
      initialBalance: "0",
    });
    expect(created.status).toBe(201);
    const accountId = created.json.account.accountId as string;

    const deposit = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
      commandId: "e2e-deposit",
      amount: "1000",
    });
    expect(deposit.status).toBe(201);

    // 3. Submit LONG BTC market 1 kontrak @lev 10.
    const submitted = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "e2e-order",
      contract: "BTC_USDT",
      side: "buy",
      type: "market",
      size: "1",
      leverage: "10",
      limitPrice: null,
      takeProfitPrice: "82000",
      stopLossPrice: "78000",
    });
    expect(submitted.status).toBe(201);
    expect(submitted.json.order.status).toBe("filled");
    expect(submitted.json.fills).toHaveLength(1);

    // 4. Ringkasan akun.
    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.walletBalance).toBe("999.99400000"); // 1000 − fee taker 0.006
    expect(summary.json.positionMargin).toBe("0.80000000");
    expect(summary.json.openPositionCount).toBe(1);
    const boundarySeq = summary.json.latestEventSeq as number;

    // 5. Posisi.
    const positions = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(positions.json.positions).toHaveLength(1);
    const position = positions.json.positions[0];
    const positionId = position.id as string;
    expect(position.side).toBe("long");
    expect(position.entryPrice).toBe("80000");
    expect(position.takeProfitPrice).toBe("82000");

    // 6. Mark naik → unrealized PnL terlihat.
    await injectMarket(h, "BTC_USDT", "81000");
    const moved = await h.request("GET", `/api/v1/accounts/${accountId}/positions/${positionId}`);
    expect(moved.json.position.markPrice).toBe("81000");
    expect(moved.json.position.unrealizedPnl).toBe("0.10000000");

    const summaryMoved = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    const wallet = new Decimal(summaryMoved.json.walletBalance);
    expect(
      new Decimal(summaryMoved.json.equity).eq(wallet.plus(summaryMoved.json.unrealizedPnl)),
    ).toBe(true);

    // 7. Ubah TP/SL.
    const amended = await h.request(
      "PATCH",
      `/api/v1/accounts/${accountId}/positions/${positionId}/protection`,
      { commandId: "e2e-protection", takeProfitPrice: "81500", stopLossPrice: "78500" },
    );
    expect(amended.status).toBe(200);
    expect(amended.json.position.takeProfitPrice).toBe("81500");

    // 8. Gerakkan pasar melewati TP.
    await injectMarket(h, "BTC_USDT", "81600");
    const processed = await h.request(
      "POST",
      `/api/v1/accounts/${accountId}/process-mark/BTC_USDT`,
      { commandId: "e2e-process" },
    );
    expect(processed.status).toBe(200);
    expect(processed.json.actions).toHaveLength(1);
    expect(processed.json.actions[0].reason).toBe("take_profit");

    // 9. Posisi tertutup; riwayat mencatatnya.
    const afterClose = await h.request("GET", `/api/v1/accounts/${accountId}/positions`);
    expect(afterClose.json.positions).toHaveLength(0);

    const history = await h.request("GET", `/api/v1/accounts/${accountId}/history`);
    expect(history.json.positions).toHaveLength(1);
    expect(history.json.positions[0].status).toBe("closed");
    expect(history.json.positions[0].closeReason).toBe("take_profit");

    // 10. Ledger berisi seluruh efek ekonomi.
    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    const types = ledger.json.entries.map((entry: any) => entry.type);
    expect(types).toContain("deposit");
    expect(types).toContain("margin_lock");
    expect(types).toContain("fee");
    expect(types).toContain("pnl_realized");
    expect(types).toContain("margin_release");

    // 11. Integritas sehat setelah seluruh siklus.
    const integrity = await h.request("GET", "/api/v1/health/integrity");
    expect(integrity.status).toBe(200);

    // 12. Reconnect WS dari seq snapshot: tidak ada event ekonomi yang hilang.
    const server = await h.listen(true);
    const wsUrl = server.url.replace("http://", "ws://") + "/ws";
    const frames: any[] = [];
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));
    const collected = new Promise<void>((resolve) => {
      socket.on("message", (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString("utf8")));
        if (frames.some((frame) => frame.type === "position.closed")) {
          resolve();
        }
      });
    });
    socket.send(JSON.stringify({ op: "subscribe", accountId, afterSeq: boundarySeq }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.hub!.tick();
    await collected;

    const events = frames.filter((frame) => typeof frame.seq === "number");
    expect(events.length).toBeGreaterThan(0);
    // Semua event > batas snapshot (tidak ada yang terkirim ulang).
    for (const event of events) {
      expect(event.seq).toBeGreaterThan(boundarySeq);
    }
    // Tidak ada seq duplikat (dedupe klien berbasis seq tetap mungkin, tapi di
    // sini pengiriman tidak menggandakan).
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // Urutan menaik.
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // Event penutupan posisi hadir.
    expect(events.some((event) => event.type === "position.closed")).toBe(true);

    socket.close();
    await server.close();
  }, 30_000);

  test("skenario yang sama reproducible (ekonomi identik) dengan clock yang sama", async () => {
    const runScenario = async (): Promise<{ digest: string }> => {
      const h = setupApi();
      harnesses.push(h);
      await injectMarket(h, "BTC_USDT", "80000");
      const accountId = (
        await h.request("POST", "/api/v1/accounts", {
          commandId: "c",
          name: "e2e",
          mode: "simulation",
          baseCurrency: "USDT",
          initialBalance: "1000",
        })
      ).json.account.accountId as string;

      await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
        commandId: "o",
        contract: "BTC_USDT",
        side: "buy",
        type: "market",
        size: "2",
        leverage: "10",
        limitPrice: null,
        takeProfitPrice: null,
        stopLossPrice: null,
      });
      await injectMarket(h, "BTC_USDT", "81000");
      const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
      await h.request("POST", `/api/v1/accounts/${accountId}/positions/${positionId}/close`, {
        commandId: "close",
      });

      const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
      const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
      const fills = await h.request("GET", `/api/v1/accounts/${accountId}/fills`);
      return {
        digest: JSON.stringify({
          ledger: ledger.json.entries.map((entry: any) => `${entry.type}|${entry.amount}|${entry.balanceAfter}`),
          summary: {
            wallet: summary.json.walletBalance,
            realized: summary.json.unrealizedPnl,
            equity: summary.json.equity,
          },
          fills: fills.json.fills.map((fill: any) => `${fill.size}|${fill.price}|${fill.fee}|${fill.realizedPnl}`),
        }),
      };
    };

    const first = await runScenario();
    const second = await runScenario();
    expect(second.digest).toBe(first.digest);
  }, 30_000);
});
