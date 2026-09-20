import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

/** Field yang HARUS berupa string (nilai finansial). */
const FINANCIAL_FIELDS = [
  "walletBalance",
  "unrealizedPnl",
  "equity",
  "availableBalance",
  "reservedMargin",
  "positionMargin",
  "marginRatio",
  "entryPrice",
  "markPrice",
  "initialMargin",
  "maintenanceMargin",
  "realizedPnl",
  "liquidationPrice",
  "takeProfitPrice",
  "stopLossPrice",
  "amount",
  "balanceAfter",
  "marginDelta",
  "reservedDelta",
  "price",
  "fee",
  "feeRate",
  "quantoMultiplier",
  "priceTick",
  "makerFeeRate",
  "takerFeeRate",
  "leverage",
  "accumulatedFunding",
  "feesPaid",
  "size",
];

function assertFinancialStrings(value: unknown, path = "$"): string[] {
  const problems: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...assertFinancialStrings(item, `${path}[${index}]`)));
    return problems;
  }
  if (typeof value !== "object" || value === null) {
    return problems;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FINANCIAL_FIELDS.includes(key) && child !== null && typeof child !== "string") {
      problems.push(`${path}.${key} bertipe ${typeof child}, seharusnya string`);
    }
    problems.push(...assertFinancialStrings(child, `${path}.${key}`));
  }
  return problems;
}

describe("3. serialisasi uang sebagai string", () => {
  test("seluruh endpoint membaca nilai finansial sebagai string", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d", amount: "500" });
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "o", contract: "BTC_USDT", side: "buy", type: "market", size: "1",
      leverage: "10", limitPrice: null, takeProfitPrice: "85000", stopLossPrice: "75000",
    });
    await injectMarket(h, "BTC_USDT", "81000");
    const positionId = (await h.request("GET", `/api/v1/accounts/${accountId}/positions`)).json.positions[0].id;
    await h.request("PATCH", `/api/v1/accounts/${accountId}/positions/${positionId}/protection`, {
      commandId: "p", takeProfitPrice: "86000",
    });

    const endpoints = [
      `/api/v1/accounts/${accountId}`,
      `/api/v1/accounts/${accountId}/summary`,
      `/api/v1/accounts/${accountId}/positions`,
      `/api/v1/accounts/${accountId}/positions/${positionId}`,
      `/api/v1/accounts/${accountId}/orders`,
      `/api/v1/accounts/${accountId}/fills`,
      `/api/v1/accounts/${accountId}/history`,
      `/api/v1/accounts/${accountId}/ledger`,
      `/api/v1/accounts/${accountId}/events`,
      "/api/v1/contracts",
      "/api/v1/contracts/BTC_USDT",
    ];

    const problems: string[] = [];
    for (const endpoint of endpoints) {
      const response = await h.request("GET", endpoint);
      expect(response.status).toBe(200);
      problems.push(...assertFinancialStrings(response.json, endpoint));
    }
    expect(problems).toEqual([]);
  });

  test("respons tulis juga string semua", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h);
    const deposit = await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
      commandId: "d",
      amount: "1.23456789",
    });
    const order = await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "o", contract: "BTC_USDT", side: "buy", type: "market", size: "1",
      leverage: "10", limitPrice: null, takeProfitPrice: null, stopLossPrice: null,
    });
    expect(assertFinancialStrings(deposit.json, "deposit")).toEqual([]);
    expect(assertFinancialStrings(order.json, "order")).toEqual([]);
  });

  test("tidak ada angka float mentah di respons finansial", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000.55");
    const accountId = await createAccountViaApi(h);
    await h.request("POST", `/api/v1/accounts/${accountId}/orders`, {
      commandId: "o", contract: "BTC_USDT", side: "buy", type: "market", size: "1",
      leverage: "10", limitPrice: null, takeProfitPrice: null, stopLossPrice: null,
    });
    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    // Harga dengan pecahan tidak boleh muncul sebagai number di JSON mentah.
    expect(summary.raw).not.toMatch(/"walletBalance":\s*[0-9]/);
    expect(summary.raw).not.toMatch(/"equity":\s*[0-9]/);
    expect(summary.raw).toMatch(/"walletBalance":"[0-9.]+"/);
  });

  test("penjaga arsitektur: rute tidak memakai Number() pada nilai finansial", () => {
    const API_DIR = join(import.meta.dir, "..", "apps", "server", "src", "api");
    const offenders: string[] = [];
    for (const file of readdirSync(API_DIR)) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(join(API_DIR, file), "utf8")
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
        })
        .join("\n");
      for (const pattern of [/\bparseFloat\b/, /\.toNumber\s*\(/, /\bNumber\s*\(/]) {
        if (pattern.test(source)) {
          offenders.push(`${file} cocok dengan ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("direktori api ada dan berisi app.ts", () => {
    const API_DIR = join(import.meta.dir, "..", "apps", "server", "src", "api");
    expect(statSync(API_DIR).isDirectory()).toBe(true);
    expect(readdirSync(API_DIR)).toContain("app.ts");
  });
});

describe("5. kontrak error", () => {
  test("semua error memakai amplop stabil", async () => {
    const h = setupApi();
    harnesses.push(h);
    const cases: Array<{ url: string; method: string; status: number; code: string }> = [
      { url: "/api/v1/accounts/nope", method: "GET", status: 404, code: "NOT_FOUND" },
      { url: "/api/v1/contracts/nope", method: "GET", status: 404, code: "NOT_FOUND" },
      { url: "/api/v1/accounts", method: "POST", status: 400, code: "VALIDATION_ERROR" },
      { url: "/tidak-ada-rute", method: "GET", status: 404, code: "NOT_FOUND" },
    ];
    for (const entry of cases) {
      const response = await h.request(entry.method, entry.url, entry.method === "POST" ? {} : undefined);
      expect(response.status).toBe(entry.status);
      expect(response.json.error.code).toBe(entry.code);
      expect(typeof response.json.error.message).toBe("string");
      expect(response.json.error.details).toBeDefined();
    }
  });

  test("tidak ada stack trace atau pesan SQL yang bocor", async () => {
    const h = setupApi();
    harnesses.push(h);
    const responses = [
      await h.request("GET", "/api/v1/accounts/nope"),
      await h.request("POST", "/api/v1/accounts", {}),
      await h.request("GET", "/api/v1/accounts/nope/summary"),
      await h.request("GET", "/api/v1/accounts/nope/ledger"),
    ];
    for (const response of responses) {
      expect(response.raw).not.toContain("    at ");
      expect(response.raw).not.toContain("SQLITE");
      expect(response.raw).not.toContain("SELECT");
      expect(response.raw).not.toContain("node_modules");
    }
  });

  test("rute bisnis memakai prefiks /api/v1", async () => {
    const h = setupApi();
    harnesses.push(h);
    // Tanpa versi → 404 (tidak ada rute bisnis tak-berversi).
    const unversioned = await h.request("GET", "/accounts/x");
    expect(unversioned.status).toBe(404);
    const versioned = await h.request("GET", "/api/v1/accounts/x");
    expect(versioned.status).toBe(404);
    expect(versioned.json.error.code).toBe("NOT_FOUND");
  });

  test("openapi tersedia dan menyebut aturan string", async () => {
    const h = setupApi();
    harnesses.push(h);
    const response = await h.request("GET", "/api/v1/openapi.json");
    expect(response.status).toBe(200);
    expect(response.json.openapi).toBe("3.1.0");
    expect(response.json.info.description).toContain("STRING");
    expect(Object.keys(response.json.paths).length).toBeGreaterThan(10);
  });
});
