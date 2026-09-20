#!/usr/bin/env bun
/**
 * Probe Gate.io USDT perpetual: REST + WebSocket.
 *
 * Tujuan: memverifikasi ulang SETIAP fakta di docs/gateio-market-data.md
 * dengan perintah yang sama, kapan pun. Jalankan: bun run probe
 *
 * Read-only. Tidak butuh API key. Tidak melakukan order.
 */
import { GateioMarketDataProvider, intervalToSeconds } from "@crypastra/adapters";
import { Decimal } from "@crypastra/core";

const CONTRACT = process.env.GATE_CONTRACT ?? "BTC_USDT";
const INTERVAL = process.env.GATE_INTERVAL ?? "5m";
const WS_SECONDS = Number(process.env.GATE_WS_SECONDS ?? 20);

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(28)} ${String(value)}`);

async function restFacts(): Promise<void> {
  console.log("\n=== REST ===");
  const provider = new GateioMarketDataProvider();
  const spec = await provider.loadContract(CONTRACT);

  console.log(`\n-- contract ${CONTRACT} --`);
  line("quanto_multiplier", spec.quantoMultiplier);
  line("order_size_min", spec.orderSizeMin);
  line("order_size_max", spec.orderSizeMax);
  line("order_price_round", spec.orderPriceRound);
  line("mark_price_round", spec.markPriceRound);
  line("maintenance_rate", spec.maintenanceRate);
  line("leverage", `${spec.leverageMin} - ${spec.leverageMax}`);
  line("maker_fee_rate", spec.makerFeeRate);
  line("taker_fee_rate", spec.takerFeeRate);
  line("funding_interval", `${spec.fundingIntervalSeconds} s`);
  line("market_order_slip_ratio", spec.marketOrderSlipRatio);
  line("status", spec.status);

  const candles = await provider.loadCandles(CONTRACT, INTERVAL, 2000);
  console.log(`\n-- candlesticks ${INTERVAL} --`);
  line("jumlah diminta", 2000);
  line("jumlah diterima", candles.length);
  const newest = candles.at(-1);
  const oldest = candles[0];
  if (newest !== undefined) {
    line("terbaru t (detik)", newest.openTimeSeconds);
    line("terbaru windowClosed", newest.windowClosed);
    line("contoh candle", `o=${newest.o} h=${newest.h} l=${newest.l} c=${newest.c} v=${newest.v}`);
  }
  if (oldest !== undefined && newest !== undefined) {
    line(
      "rentang historis (jam)",
      ((newest.openTimeSeconds - oldest.openTimeSeconds) / 3600).toFixed(2),
    );
  }
  line("intervalToSeconds", intervalToSeconds(INTERVAL));

  console.log("\n-- ticker (3 harga berbeda) --");
  const tickers = await fetch(
    `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${CONTRACT}`,
  ).then((r) => r.json() as Promise<Array<Record<string, unknown>>>);
  const ticker = tickers[0];
  if (ticker !== undefined) {
    line("last", ticker.last);
    line("mark_price", ticker.mark_price);
    line("index_price", ticker.index_price);
    line("funding_rate", ticker.funding_rate);
    line("funding_next_apply (REST)", "tidak ada di /tickers");
    const last = new Decimal(String(ticker.last));
    const mark = new Decimal(String(ticker.mark_price));
    line("mark vs last (%)", mark.minus(last).div(last).times(100).toFixed(4));
  }

  const contractRow = await fetch(
    `https://api.gateio.ws/api/v4/futures/usdt/contracts/${CONTRACT}`,
  ).then((r) => r.json() as Promise<Record<string, unknown>>);
  console.log("\n-- funding (dari /contracts) --");
  line("funding_rate", contractRow.funding_rate);
  line("funding_interval", `${contractRow.funding_interval} s`);
  line("funding_next_apply", contractRow.funding_next_apply);
  line("funding_rate_limit", contractRow.funding_rate_limit);
  line("mark_type", contractRow.mark_type);

  console.log("\n-- funding history butuh auth? --");
  const funding = await fetch(
    `https://api.gateio.ws/api/v4/futures/usdt/contracts/${CONTRACT}/funding_rate?limit=1`,
  ).then((r) => r.json() as Promise<Record<string, unknown>>);
  line("respons", JSON.stringify(funding).slice(0, 120));
}

async function wsFacts(): Promise<void> {
  console.log("\n=== WEBSOCKET ===");
  const provider = new GateioMarketDataProvider({ pingIntervalMs: 5_000 });
  const counts = new Map<string, number>();
  const samples = new Map<string, unknown>();

  const fmt = (value: unknown) => JSON.stringify(value).slice(0, 240);

  const off = provider.onEvent((event) => {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    if (!samples.has(event.type)) {
      samples.set(event.type, event);
      console.log(`first ${event.type}: ${fmt(event)}`);
    }
  });

  await provider.connect();
  await provider.subscribeTicker(CONTRACT);
  await provider.subscribeCandles(CONTRACT, INTERVAL);
  await provider.subscribeTrades(CONTRACT);
  await provider.subscribeBook(CONTRACT);

  console.log("\nchannel yang ditolak (bila ada) akan tercetak di atas sebagai [gateio] subscribe gagal");

  await new Promise((resolve) => setTimeout(resolve, WS_SECONDS * 1000));

  console.log(`\n-- jumlah event dalam ${WS_SECONDS} detik --`);
  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    line(type, count);
  }
  line("mark price age (ms)", provider.markPriceAgeMs(CONTRACT));

  off();
  await provider.disconnect();
}

async function main(): Promise<void> {
  console.log(`probe Gate.io — contract=${CONTRACT} interval=${INTERVAL}`);
  await restFacts();
  await wsFacts();
  console.log("\nselesai. Bandingkan hasil dengan docs/gateio-market-data.md.");
}

await main();