import { afterEach, describe, expect, test } from "bun:test";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";
import type { DatabaseConnection } from "../apps/server/src/db/database.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function domainEventRows(connection: DatabaseConnection): Array<{ seq: number; type: string; account_id: string }> {
  return connection.sqlite
    .query("SELECT seq, type, account_id FROM domain_events ORDER BY seq")
    .all() as Array<{ seq: number; type: string; account_id: string }>;
}

describe("20. urutan global monoton", () => {
  test("seq naik monoton lintas agregat dalam satu akun", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h);

    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d1", amount: "500" });
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "o1", contract: "BTC_USDT", side: "buy", type: "market", size: "1",
      leverage: "10", limitPrice: null, takeProfitPrice: null, stopLossPrice: null,
    });

    const rows = domainEventRows(h.connection);
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.seq).toBeGreaterThan(rows[i - 1]!.seq);
    }
    // Berbagai tipe agregat berbagi satu urutan.
    const types = new Set(rows.map((row) => row.type));
    expect(types.has("account.created")).toBe(true);
    expect(types.has("ledger.created")).toBe(true);
    expect(types.has("order.created")).toBe(true);
    expect(types.has("fill.created")).toBe(true);
    expect(types.has("position.opened")).toBe(true);
  });

  test("GET /events mengembalikan urutan dan latestEventSeq", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d", amount: "1" });

    const response = await h.request("GET", `/api/v1/accounts/${accountId}/events`);
    expect(response.status).toBe(200);
    const seqs = response.json.events.map((event: any) => event.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(response.json.latestEventSeq).toBe(Math.max(...seqs));
  });

  test("event setelah afterSeq hanya mengembalikan yang lebih baru", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d1", amount: "1" });
    const first = await h.request("GET", `/api/v1/accounts/${accountId}/events`);
    const cursor = first.json.events[0].seq;

    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d2", amount: "2" });
    const after = await h.request("GET", `/api/v1/accounts/${accountId}/events?after=${cursor}`);
    expect(after.json.events.length).toBeGreaterThan(0);
    for (const event of after.json.events) {
      expect(event.seq).toBeGreaterThan(cursor);
    }
  });
});

describe("21. transactional outbox", () => {
  test("event dan efek ekonomi commit bersama", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    const before = domainEventRows(h.connection).length;

    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d", amount: "100" });

    const after = domainEventRows(h.connection);
    expect(after.length).toBeGreaterThan(before);
    // Ada event ledger.created yang cocok dengan entri ledger.
    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    const ledgerSeqs = ledger.json.entries.map((entry: any) => String(entry.seq));
    const ledgerEvents = after.filter((row) => row.type === "ledger.created");
    expect(ledgerEvents.length).toBe(ledgerSeqs.length);
  });

  test("rollback tidak menerbitkan event yang commit", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    const before = domainEventRows(h.connection).length;

    // Withdraw melebihi saldo → gagal di tengah, seluruh transaksi batal.
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/withdraw`, {
      commandId: "w-bad",
      amount: "999999",
    });
    expect(response.status).toBe(422);

    expect(domainEventRows(h.connection).length).toBe(before);
  });

  test("retry idempoten tidak menerbitkan event baru", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    const payload = { commandId: "d-retry", amount: "100" };
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, payload);
    const after = domainEventRows(h.connection).length;

    for (let i = 0; i < 3; i += 1) {
      await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, payload);
    }
    expect(domainEventRows(h.connection).length).toBe(after);
  });

  test("domain_events append-only di level database", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    expect(() =>
      h.connection.sqlite.prepare("UPDATE domain_events SET type = 'tampered'").run(),
    ).toThrow(/append-only/);
    expect(() => h.connection.sqlite.prepare("DELETE FROM domain_events").run()).toThrow(/append-only/);
    void accountId;
  });

  test("event terpisah per akun (langganan akun lain tidak melihatnya)", async () => {
    const h = setupApi();
    harnesses.push(h);
    const a = await createAccountViaApi(h, { name: "a" });
    const b = await createAccountViaApi(h, { name: "b" });
    await h.request("POST", `/api/v1/accounts/${a}/deposit`, { commandId: "da", amount: "5" });

    const eventsA = await h.request("GET", `/api/v1/accounts/${a}/events`);
    const eventsB = await h.request("GET", `/api/v1/accounts/${b}/events`);
    expect(eventsA.json.events.length).toBeGreaterThan(0);
    // Stream bersifat per-akun: event akun A tidak pernah muncul di stream B.
    expect(eventsB.json.events.every((event: any) => event.accountId === b)).toBe(true);
    expect(eventsB.json.events.some((event: any) => event.accountId === a)).toBe(false);
    // `latestEventSeq` adalah posisi GLOBAL, bukan jumlah event akun ini: event
    // milik B sendiri punya seq 2 karena A dibuat lebih dulu.
    expect(eventsB.json.latestEventSeq).toBe(eventsB.json.events.at(-1).seq);
  });
});

describe("26. health & integrity", () => {
  test("/health/live dan /health/ready", async () => {
    const h = setupApi();
    harnesses.push(h);
    const live = await h.request("GET", "/health/live");
    expect(live.status).toBe(200);
    expect(live.json.status).toBe("ok");
    const ready = await h.request("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.json.status).toBe("ready");
  });

  test("integrity sehat → 200", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "o", contract: "BTC_USDT", side: "buy", type: "market", size: "1",
      leverage: "10", limitPrice: null, takeProfitPrice: null, stopLossPrice: null,
    });

    const response = await h.request("GET", "/api/v1/health/integrity");
    expect(response.status).toBe(200);
    expect(response.json.status).toBe("ok");
    expect(response.json.mismatches).toEqual([]);
  });

  test("integrity rusak → 503 dengan detail mesin-terbaca", async () => {
    const h = setupApi();
    harnesses.push(h);
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d", amount: "10" });

    // Rusak cache saldo langsung di DB (cache memang turunan, bukan sumber kebenaran).
    h.connection.sqlite
      .prepare("UPDATE account_balances SET wallet_balance = '999999.00000000'")
      .run();

    const response = await h.request("GET", "/api/v1/health/integrity");
    expect(response.status).toBe(503);
    expect(response.json.status).toBe("failed");
    expect(response.json.mismatches.length).toBeGreaterThan(0);
    expect(response.json.mismatches[0]).toHaveProperty("cacheMatches", false);
  });

  test("health tidak membocorkan path database", async () => {
    const h = setupApi();
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/health/integrity");
    expect(response.raw).not.toContain("/tmp/");
    expect(response.raw).not.toContain(".db");
    expect(response.raw).not.toContain("sqlite");
  });
});
