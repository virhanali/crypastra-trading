#!/usr/bin/env bun
/**
 * SMOKE TEST LIVE — PAPER TRADING (LOCAL DB).
 *
 * Menjalankan siklus paper trading penuh terhadap data pasar PUBLIK Gate.io:
 *   akun → deposit → tunggu mark segar → order market kecil → posisi → UPnL →
 *   tutup manual → rekonsiliasi ledger.
 *
 * !! PAPER ONLY !!
 * - Tidak ada API key, tidak ada kanal privat, tidak ada order ke Gate.
 * - Memakai database SEMENTARA di /tmp; tidak menyentuh data produksi.
 *
 * Jalankan: bun run smoke:paper
 */
import { Decimal } from "@crypastra/core";
import { GateioMarketDataProvider } from "@crypastra/adapters";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../apps/server/src/db/database.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { integrityReport } from "../apps/server/src/repositories/integrity.js";
import { MarketRuntime } from "../apps/server/src/market/market-runtime.js";
import { AccountService } from "../apps/server/src/services/account-service.js";
import { OrderService } from "../apps/server/src/services/order-service.js";
import { MarkToMarketService } from "../apps/server/src/services/mark-to-market-service.js";
import { OrderIntentSchema } from "@crypastra/core";

const CONTRACT = process.env.GATE_CONTRACT ?? "BTC_USDT";
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS ?? 25_000);

const dir = mkdtempSync(join(tmpdir(), "crypastra-paper-smoke-"));
const dbPath = join(dir, "paper-smoke.db");
const connection = openDatabase({ path: dbPath });
const clock = { nowMs: () => Date.now() };

const line = (label: string, value: unknown) => console.log(`${label.padEnd(26)} ${String(value)}`);
console.log("=== PAPER TRADING SMOKE (uang VIRTUAL, DB sementara) ===");
console.log(`db: ${dbPath}\n`);

const provider = new GateioMarketDataProvider();
const runtime = new MarketRuntime({
  provider,
  clock,
  contracts: [CONTRACT],
  staleness: { maxStalenessMs: 10_000 },
  riskIntervalMs: 5000,
});

// Kontrak harus ada di DB sebelum order.
const contracts = new ContractRepository(connection);
const spec = await provider.loadContract(CONTRACT);
contracts.upsert({ spec, rawJson: "{}", updatedAtMs: clock.nowMs() });

const accounts = new AccountService({ connection, clock });
const orders = new OrderService({ connection });
const markToMarket = new MarkToMarketService({ connection });

await runtime.start();
const market = runtime.marketProvider();

// 1. Tunggu mark segar.
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline && market.markStatus(CONTRACT) !== "fresh") {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (market.markStatus(CONTRACT) !== "fresh") {
  console.error("Mark tidak segar dalam batas waktu; smoke dibatalkan.");
  await runtime.stop();
  connection.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
line("mark awal", market.getMark(CONTRACT)!.markPrice);

// 2. Akun + deposit virtual.
const account = accounts.create({
  commandId: "smoke-account",
  name: "paper-smoke",
  mode: "simulation",
  baseCurrency: "USDT",
  initialBalance: "10000",
  nowMs: clock.nowMs(),
}).result;
accounts.deposit({ accountId: account.id, commandId: "smoke-deposit", amount: "1000", nowMs: clock.nowMs() });
line("wallet setelah deposit", accounts.balances(account.id).walletBalance.toFixed(8));

// 3. Order market PAPER kecil (dieksekusi terhadap kutipan publik).
const book = market.getBook(CONTRACT);
if (book === null) {
  console.error("Buku pasar belum tersedia; smoke dibatalkan.");
  await runtime.stop();
  connection.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
const intent = OrderIntentSchema.parse({
  contract: CONTRACT,
  side: "buy",
  type: "market",
  size: 1,
  price: null,
  leverage: "10",
  timeInForce: "ioc",
  reduceOnly: false,
  tpPrice: null,
  slPrice: null,
});
const submitted = orders.submitOrder({
  commandId: "smoke-order",
  accountId: account.id,
  intent,
  book,
  nowMs: clock.nowMs(),
});
line("order (PAPER)", submitted.order.status);
line("fill price", submitted.fills[0]?.price.toFixed() ?? "(tidak ada)");
line("fee", submitted.fills[0]?.fee.toFixed(8) ?? "(tidak ada)");
const positionId = submitted.position?.id ?? null;
line("posisi", positionId === null ? "(tidak ada)" : `${submitted.position!.direction} ${submitted.position!.size} @ ${submitted.position!.entryPrice.toFixed()}`);

// 4. Amati UPnL berubah seiring mark bergerak.
const first = markToMarket.valuatePositionForApi({ position: submitted.position!, markPrice: market.getMark(CONTRACT)!.markPrice });
line("UPnL awal", first.unrealizedPnl.toFixed(8));
await new Promise((resolve) => setTimeout(resolve, 5000));
const second = markToMarket.valuatePositionForApi({ position: submitted.position!, markPrice: market.getMark(CONTRACT)!.markPrice });
line("UPnL setelah 5s", second.unrealizedPnl.toFixed(8));
line("mark bergerak", !first.markPrice.eq(second.markPrice));

// 5. Tutup manual (PAPER).
const closeBook = market.getBook(CONTRACT)!;
const closed = markToMarket.closePosition({
  commandId: "smoke-close",
  positionId: positionId!,
  execution: { contract: CONTRACT, bidPrice: closeBook.bids[0]!.price, askPrice: closeBook.asks[0]!.price },
  nowMs: clock.nowMs(),
});
line("penutupan", closed.reason);
line("realized PnL", closed.realizedPnl.toFixed(8));
line("defisit", closed.deficit.toFixed(8));

// 6. Rekonsiliasi ledger.
const balances = accounts.balances(account.id);
line("wallet akhir", balances.walletBalance.toFixed(8));
line("fees_paid", balances.feesPaid.toFixed(8));
line("realized_pnl", balances.realizedPnl.toFixed(8));
const integrity = integrityReport(connection);
line("integritas cache==ledger", integrity.mismatches.length === 0 ? "OK" : "GAGAL");
if (integrity.mismatches.length > 0) {
  console.error(JSON.stringify(integrity.mismatches, null, 2));
}

await runtime.stop();
connection.close();
rmSync(dir, { recursive: true, force: true });
console.log("\nselesai. TIDAK ada order yang dikirim ke Gate — semuanya PAPER.");
void new Decimal(0);
