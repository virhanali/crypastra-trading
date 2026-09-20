#!/usr/bin/env bun
/**
 * SMOKE DOGFOOD LIVE — PAPER, LEWAT HTTP API (jalur yang sama dengan terminal).
 *
 * Berbeda dari `tools/smoke-paper-trade.ts` (yang memanggil service langsung),
 * tool ini menembak endpoint `/api/v1` yang benar-benar dipakai UI:
 *   akun → deposit → market order PAPER di kutipan Gate → posisi → TP/SL → close
 *   → ledger → integritas.
 *
 * !! PAPER ONLY !!
 * - Tidak ada API key, tidak ada kanal privat, tidak ada order ke Gate.
 * - Server harus sudah jalan (mis. `bun run dev:server:live`).
 *
 * Jalankan: bun run smoke:live-api           (default http://127.0.0.1:8787)
 *           CRYPASTRA_API=http://127.0.0.1:8801 bun run smoke:live-api
 */
const BASE = `${process.env.CRYPASTRA_API ?? "http://127.0.0.1:8787"}/api/v1`;
const CONTRACT = process.env.SMOKE_CONTRACT ?? "BTC_USDT";
const RUN = `smoke-${Date.now().toString(36)}`;

const line = (label: string, value: unknown) => console.log(`${label.padEnd(28)} ${String(value)}`);

interface ApiResponse {
  readonly status: number;
  readonly body: any;
}

async function call(method: string, path: string, payload?: unknown): Promise<ApiResponse> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: payload === undefined ? {} : { "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function requireOk(result: ApiResponse, label: string): any {
  if (result.status >= 400) {
    throw new Error(`${label} gagal (HTTP ${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

console.log("=== PAPER DOGFOOD lewat HTTP API (uang VIRTUAL, LIVE MARKET) ===");
console.log(`api: ${BASE}\n`);

// 1. Pasar harus segar dan punya kutipan eksekusi dua sisi.
const state = requireOk(
  await call("GET", `/market/state?contracts=${CONTRACT}`),
  "market/state",
);
const market = state.contracts[0];
line("mode server", state.mode);
line("mark", market.markPrice);
line("markStatus", market.markStatus);
line("bestBid / bestAsk", `${market.bestBid ?? "—"} / ${market.bestAsk ?? "—"}`);
if (market.markStatus !== "fresh" || market.bestBid === null || market.bestAsk === null) {
  console.error("Pasar belum segar / kutipan belum dua sisi — dogfood dibatalkan.");
  process.exit(1);
}

// 2. Akun + deposit virtual.
const created = requireOk(
  await call("POST", "/accounts", {
    commandId: `${RUN}-account`,
    name: "live-dogfood",
    mode: "simulation",
    baseCurrency: "USDT",
    initialBalance: "0",
  }),
  "create account",
);
const accountId = created.account.accountId as string;
line("account", accountId);

requireOk(
  await call("POST", `/accounts/${accountId}/deposit`, { commandId: `${RUN}-deposit`, amount: "1000" }),
  "deposit",
);

// 3. Market LONG PAPER kecil di kutipan live.
const order = requireOk(
  await call("POST", `/accounts/${accountId}/orders`, {
    commandId: `${RUN}-order`,
    contract: CONTRACT,
    side: "buy",
    type: "market",
    size: "1",
    leverage: "10",
    limitPrice: null,
    takeProfitPrice: null,
    stopLossPrice: null,
  }),
  "submit order",
);
line("order PAPER", order.order.status);
line("fill price (kutipan Gate)", order.fills[0]?.price ?? "—");
line("fee", order.fills[0]?.fee ?? "—");

const positions = requireOk(await call("GET", `/accounts/${accountId}/positions`), "positions");
if (positions.positions.length === 0) {
  console.error("Tidak ada posisi setelah order — dogfood dibatalkan.");
  process.exit(1);
}
let position = positions.positions[0];
line("posisi", `${position.side} ${position.size} @ ${position.entryPrice}`);
line("UPnL awal", position.unrealizedPnl);
const initialUpnl = position.unrealizedPnl as string;

// 4. TP/SL (MARK-triggered).
const entry = Number(position.entryPrice);
const tp = (entry * 1.02).toFixed(1);
const sl = (entry * 0.98).toFixed(1);
const protectedPosition = requireOk(
  await call("PATCH", `/accounts/${accountId}/positions/${position.id}/protection`, {
    commandId: `${RUN}-protection`,
    takeProfitPrice: tp,
    stopLossPrice: sl,
  }),
  "protection",
);
line("TP / SL diset", `${protectedPosition.position.takeProfitPrice} / ${protectedPosition.position.stopLossPrice}`);

// 5. Amati pergerakan mark/UPnL.
const waitMs = Number(process.env.SMOKE_WAIT_MS ?? 8000);
await new Promise((resolve) => setTimeout(resolve, waitMs));
const after = requireOk(await call("GET", `/accounts/${accountId}/positions/${position.id}`), "position detail");
position = after.position;
line("mark setelah tunggu", position.markPrice);
line("UPnL setelah tunggu", position.unrealizedPnl);
line("UPnL berubah", position.unrealizedPnl !== initialUpnl);

// 6. Tutup PAPER.
const closed = requireOk(
  await call("POST", `/accounts/${accountId}/positions/${position.id}/close`, { commandId: `${RUN}-close` }),
  "close",
);
line("penutupan", closed.settlement.reason);
line("harga eksekusi close", closed.settlement.executionPrice);
line("realized PnL", closed.settlement.realizedPnl);
line("defisit", closed.settlement.deficit);

// 7. Rekonsiliasi.
const summary = requireOk(await call("GET", `/accounts/${accountId}/summary`), "summary");
line("wallet akhir", summary.walletBalance);
line("positionMargin", summary.positionMargin);
line("openPositions", summary.openPositionCount);

const ledger = requireOk(await call("GET", `/accounts/${accountId}/ledger`), "ledger");
const types = (ledger.entries as Array<{ type: string }>).map((entry) => entry.type);
line("tipe ledger", [...new Set(types)].join(","));

const integrity = await call("GET", "/health/integrity");
line("integritas", integrity.status === 200 ? "OK" : `GAGAL (${integrity.status})`);

console.log("\nselesai. LIVE MARKET + PAPER — tidak ada order yang dikirim ke Gate.");
