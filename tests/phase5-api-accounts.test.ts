import { afterEach, describe, expect, test } from "bun:test";
import { Decimal } from "../packages/core/src/index.js";
import { createAccountViaApi, setupApi, type ApiHarness } from "./helpers/api.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

function setup(): ApiHarness {
  const h = setupApi();
  harnesses.push(h);
  return h;
}

describe("6. account API", () => {
  test("POST /accounts membuat akun dengan saldo awal", async () => {
    const h = setup();
    const response = await h.request("POST", "/api/v1/accounts", {
      commandId: "c1",
      name: "paper",
      mode: "simulation",
      baseCurrency: "USDT",
      initialBalance: "10000",
    });
    expect(response.status).toBe(201);
    expect(response.json.account.accountId).toBeTruthy();
    expect(response.json.account.initialBalance).toBe("10000.00000000");
    expect(response.json.duplicate).toBe(false);
  });

  test("GET /accounts/:id mengembalikan akun", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const response = await h.request("GET", `/api/v1/accounts/${accountId}`);
    expect(response.status).toBe(200);
    expect(response.json.account.accountId).toBe(accountId);
  });

  test("akun tidak dikenal → 404 NOT_FOUND", async () => {
    const h = setup();
    const response = await h.request("GET", "/api/v1/accounts/tidak-ada");
    expect(response.status).toBe(404);
    expect(response.json.error.code).toBe("NOT_FOUND");
  });

  test("POST /accounts menolak field asing (strict)", async () => {
    const h = setup();
    const response = await h.request("POST", "/api/v1/accounts", {
      commandId: "c1",
      name: "paper",
      mode: "simulation",
      baseCurrency: "USDT",
      initialBalance: "100",
      sneaky: "field",
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe("VALIDATION_ERROR");
  });

  test("saldo awal negatif ditolak", async () => {
    const h = setup();
    const response = await h.request("POST", "/api/v1/accounts", {
      commandId: "c1",
      name: "paper",
      mode: "simulation",
      baseCurrency: "USDT",
      initialBalance: "-1",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("11. deposit/withdraw + idempotensi", () => {
  test("deposit menambah saldo dan tercatat di ledger", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
      commandId: "dep-1",
      amount: "250.5",
    });
    expect(response.status).toBe(201);
    expect(response.json.balances.walletBalance).toBe("10250.50000000");

    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    const deposit = ledger.json.entries.find((entry: any) => entry.type === "deposit");
    expect(deposit.amount).toBe("250.50000000");
  });

  test("retry deposit 20× hanya menambah 100 sekali", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const payload = { commandId: "dep-retry", amount: "100" };

    const first = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, payload);
    expect(first.status).toBe(201);
    for (let i = 0; i < 20; i += 1) {
      const retry = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, payload);
      expect(retry.status).toBe(200);
      expect(retry.json.duplicate).toBe(true);
    }

    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.walletBalance).toBe("10100.00000000");

    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    expect(ledger.json.entries.filter((entry: any) => entry.type === "deposit")).toHaveLength(1);
  });

  test("commandId sama + amount berbeda → 409 IDEMPOTENCY_CONFLICT", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "same", amount: "100" });
    const conflict = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
      commandId: "same",
      amount: "200",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.walletBalance).toBe("10100.00000000");
  });

  test("withdraw mengurangi saldo", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/withdraw`, {
      commandId: "w1",
      amount: "1000",
    });
    expect(response.status).toBe(201);
    expect(response.json.balances.walletBalance).toBe("9000.00000000");
  });

  test("withdraw melebihi saldo → 422 INSUFFICIENT_BALANCE, saldo tidak berubah", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const response = await h.request("POST", `/api/v1/accounts/${accountId}/withdraw`, {
      commandId: "w2",
      amount: "999999",
    });
    expect(response.status).toBe(422);
    expect(response.json.error.code).toBe("INSUFFICIENT_BALANCE");

    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.walletBalance).toBe("10000.00000000");
  });

  test("withdraw retry tidak menarik dua kali", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const payload = { commandId: "w-retry", amount: "100" };
    await h.request("POST", `/api/v1/accounts/${accountId}/withdraw`, payload);
    for (let i = 0; i < 5; i += 1) {
      await h.request("POST", `/api/v1/accounts/${accountId}/withdraw`, payload);
    }
    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.walletBalance).toBe("9900.00000000");
  });

  test("amount negatif/nol ditolak", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    for (const amount of ["0", "-50"]) {
      const response = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
        commandId: `bad-${amount}`,
        amount,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("6b. reset/reseed", () => {
  test("reset mengubah saldo lewat entri ledger, riwayat tetap utuh", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d", amount: "500" });

    const response = await h.request("POST", `/api/v1/accounts/${accountId}/reset`, {
      commandId: "r1",
      balance: "1000",
    });
    expect(response.status).toBe(201);

    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(summary.json.walletBalance).toBe("1000.00000000");

    // Riwayat TIDAK dihapus: deposit lama masih ada, plus entri reset.
    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    const types = ledger.json.entries.map((entry: any) => entry.type);
    expect(types).toContain("deposit");
    expect(types).toContain("reset");
    expect(ledger.json.entries.length).toBeGreaterThanOrEqual(2);
  });

  test("reset idempoten", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const payload = { commandId: "r2", balance: "500" };
    await h.request("POST", `/api/v1/accounts/${accountId}/reset`, payload);
    const retry = await h.request("POST", `/api/v1/accounts/${accountId}/reset`, payload);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    const ledger = await h.request("GET", `/api/v1/accounts/${accountId}/ledger`);
    expect(ledger.json.entries.filter((entry: any) => entry.type === "reset")).toHaveLength(1);
  });
});

describe("7. account summary read model", () => {
  test("berisi seluruh field yang dibutuhkan UI", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const response = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    expect(response.status).toBe(200);
    for (const field of [
      "walletBalance",
      "unrealizedPnl",
      "equity",
      "availableBalance",
      "reservedMargin",
      "positionMargin",
      "marginRatio",
      "openPositionCount",
      "openOrderCount",
      "valuationStatus",
      "unvaluedContracts",
      "latestEventSeq",
      "asOf",
    ]) {
      expect(response.json).toHaveProperty(field);
    }
    // Tanpa posisi: used_margin 0, equity 10000 → rasio 0 (null hanya bila equity 0).
    expect(response.json.marginRatio).toBe("0.00000000");
    expect(response.json.valuationStatus).toBe("fresh");
    expect(typeof response.json.latestEventSeq).toBe("number");
  });

  test("equity = wallet + unrealized, available = wallet − margin", async () => {
    const h = setup();
    const accountId = await createAccountViaApi(h);
    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    const wallet = new Decimal(summary.json.walletBalance);
    const unrealized = new Decimal(summary.json.unrealizedPnl);
    expect(new Decimal(summary.json.equity).eq(wallet.plus(unrealized))).toBe(true);
    expect(
      new Decimal(summary.json.availableBalance).eq(
        wallet.minus(new Decimal(summary.json.positionMargin)).minus(summary.json.reservedMargin),
      ),
    ).toBe(true);
  });
});
