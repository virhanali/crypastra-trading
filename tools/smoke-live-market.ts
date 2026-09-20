#!/usr/bin/env bun
/**
 * SMOKE TEST LIVE — PAPER ONLY.
 *
 * Menghubungkan ke WebSocket PUBLIK Gate.io USDT perpetual, berlangganan
 * BTC_USDT, dan memverifikasi bahwa mark/bid/ask/candle benar-benar mengalir
 * ke MarketState + LiveMarketSnapshotProvider.
 *
 * - Tanpa API key. Tanpa kanal privat. Tanpa order ke Gate.
 * - TIDAK dijalankan sebagai bagian `bun test` (butuh jaringan).
 *
 * Jalankan: bun run smoke:live
 */
import { Decimal, systemClock } from "@crypastra/core";
import { GateioMarketDataProvider } from "@crypastra/adapters";
import { MarketRuntime } from "../apps/server/src/market/market-runtime.js";

const CONTRACT = process.env.GATE_CONTRACT ?? "BTC_USDT";
const SECONDS = Number(process.env.GATE_SMOKE_SECONDS ?? 20);

const line = (label: string, value: unknown) => console.log(`${label.padEnd(26)} ${String(value)}`);

const clock = systemClock;
const provider = new GateioMarketDataProvider();

const runtime = new MarketRuntime({
  provider,
  clock,
  contracts: [CONTRACT],
  staleness: { maxStalenessMs: 10_000 },
  riskIntervalMs: 1000,
});

console.log(`SMOKE LIVE (PAPER, tanpa order) — ${CONTRACT} selama ${SECONDS}s\n`);
await runtime.start();

const statuses: Record<string, number> = {};
const off = provider.onEvent((event) => {
  statuses[event.type] = (statuses[event.type] ?? 0) + 1;
});
void off;

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));

const market = runtime.marketProvider();
const state = runtime.state.get(CONTRACT);
const health = runtime.feedHealth();
const mark = market.getMark(CONTRACT);
const book = market.getBook(CONTRACT);

console.log("\n-- MarketState --");
line("lastPrice", state?.lastPrice?.toString() ?? "(tidak ada)");
line("markPrice", state?.markPrice?.toString() ?? "(tidak ada)");
line("indexPrice", state?.indexPrice?.toString() ?? "(tidak ada)");
line("fundingRate", state?.fundingRate?.toString() ?? "(tidak ada)");
line("bestBid", state?.bestBid?.toString() ?? "(tidak ada)");
line("bestAsk", state?.bestAsk?.toString() ?? "(tidak ada)");
line("candle 5m terbaru", state?.latestCandle === null || state?.latestCandle === undefined
  ? "(tidak ada)"
  : `t=${state.latestCandle.openTimeSeconds} c=${state.latestCandle.c} closed=${state.latestCandle.windowClosed}`);
line("fundingNextApplyMs", state?.fundingNextApplyMs ?? "(tidak ada)");

console.log("\n-- Provider --");
line("mark tersedia", mark !== null);
line("mark status", market.markStatus(CONTRACT));
line("mark age (ms)", mark === null ? "n/a" : clock.nowMs() - mark.sourceTimestampMs);
line("buku tersedia", book !== null);
const topBid = book?.bids[0];
const topAsk = book?.asks[0];
line(
  "bid < ask",
  topBid === undefined || topAsk === undefined
    ? "n/a"
    : new Decimal(topBid.price).lessThan(topAsk.price)
      ? "true"
      : new Decimal(topBid.price).eq(topAsk.price)
        ? "sama"
        : "false",
);

console.log("\n-- Feed health --");
line("koneksi", health.state);
line("siap", runtime.isReady());
line("reconnect", health.reconnectCount);
line("lastMessageAge (ms)", health.lastMessageAtMs === null ? "n/a" : clock.nowMs() - health.lastMessageAtMs);
line("kontrak basi", health.staleContracts.join(",") || "(tidak ada)");
line("buku belum sinkron", health.unsyncedBooks.join(",") || "(tidak ada)");

console.log("\n-- Event (10s) --");
for (const [type, count] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
  line(type, count);
}

await runtime.stop();
console.log("\nselesai. PAPER ONLY — tidak ada order yang dikirim ke exchange.");
