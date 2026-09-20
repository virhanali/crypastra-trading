/**
 * Perekam pasar NYATA (Phase 13) — PUBLIK saja, PAPER/RESEARCH only.
 *
 *   bun run record:market [--contracts BTC_USDT,ETH_USDT] [--seconds 3600]
 *                         [--db <path>] [--interval 5m]
 *
 * Memakai provider pasar PUBLIK Gate.io dan MarketRecorder Phase 8. Tidak ada
 * API key, tidak ada kanal privat, tidak ada order.
 *
 * Mode yang didukung (§37):
 *   RECORD ONLY        — rekam saja (default)
 *   RECORD + COLLECT   — tambah kolektor Jev asinkron (CRYPASTRA_JEV=1)
 */
import { systemClock } from "@crypastra/core";
import { GateioMarketDataProvider, realJevConfigFromEnv, RealJevAdapter } from "@crypastra/adapters";
import { openDatabase } from "../apps/server/src/db/database.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../apps/server/src/repositories/market-observation-repository.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import { MarketRuntime } from "../apps/server/src/market/market-runtime.js";
import { JevEvaluationRepository } from "../apps/server/src/repositories/jev-evaluation-repository.js";
import { LiveJevCollector } from "../apps/server/src/treatment/live-jev-collector.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const contracts = (flag("--contracts", "BTC_USDT,ETH_USDT") ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const seconds = Number.parseInt(flag("--seconds", "3600") ?? "3600", 10);
const dbPath = resolve(flag("--db", process.env.CRYPASTRA_DB_PATH ?? "data/research.db")!);
mkdirSync(dirname(dbPath), { recursive: true });

const connection = openDatabase({ path: dbPath });
const recorder = new MarketRecorder({
  sessions: new RecordingSessionRepository(connection),
  observations: new MarketObservationRepository(connection),
});

// ── Resumability (§3): sesi aktif yang cocok DILANJUTKAN; yang tidak cocok
// ditutup sebagai `aborted` (tidak pernah mencampur konfigurasi berbeda). ──
const active = new RecordingSessionRepository(connection).active();
let sessionId: string;
if (active !== null) {
  // active adalah RecordingSessionRecord: `contracts` SUDAH array hasil
  // parse (lihat mapSessionRow). Memakai `active.contractsJson` di sini
  // adalah bug: field itu tidak ada di tipe ini, JSON.parse(undefined)
  // melempar setiap kali sesi recording aktif ditemukan saat start.
  const activeContracts = [...active.contracts];
  const sameUniverse =
    activeContracts.length === contracts.length && activeContracts.every((c) => contracts.includes(c));
  if (sameUniverse) {
    sessionId = active.id;
    console.log(`[record] melanjutkan sesi aktif ${sessionId}`);
  } else {
    new RecordingSessionRepository(connection).stop(active.id, systemClock.nowMs(), "aborted");
    sessionId = recorder.startSession({ source: "live", contracts, startedAtMs: systemClock.nowMs() });
    console.log(`[record] sesi lama ${active.id} ditutup (aborted); sesi baru ${sessionId}`);
  }
} else {
  sessionId = recorder.startSession({ source: "live", contracts, startedAtMs: systemClock.nowMs() });
}

const jevRequested = process.env.CRYPASTRA_JEV === "1";
const jevConfig = jevRequested ? realJevConfigFromEnv() : null;
const collector =
  jevConfig === null
    ? null
    : new LiveJevCollector({
        port: new RealJevAdapter(jevConfig),
        store: new JevEvaluationRepository(connection),
        evaluators: ["trend_alignment", "momentum_sustainability", "reversal_risk"],
        queueCapacity: Number.parseInt(process.env.CRYPASTRA_JEV_QUEUE ?? "200", 10),
        concurrency: Number.parseInt(process.env.CRYPASTRA_JEV_CONCURRENCY ?? "2", 10),
        requestsPerMinute: Number.parseInt(process.env.CRYPASTRA_JEV_RPM ?? "60", 10),
        timeoutMs: jevConfig.timeoutMs,
        onDiagnostic: (event) => console.log(`[collector] ${event.type} ${event.detail}`),
      });

console.log(`\nRECORD MARKET (PAPER/RESEARCH, tanpa order)`);
console.log(`  session        ${sessionId}`);
console.log(`  contracts      ${contracts.join(", ")}`);
console.log(`  mulai          ${new Date(systemClock.nowMs()).toISOString()}`);
console.log(`  mode           ${collector === null ? "RECORD ONLY" : "RECORD + COLLECT"}`);
console.log(`  timeframe      5m (candle tertutup saja)`);
console.log(`  storage        ${dbPath}\n`);

// Metadata kontrak diisi jalur startup yang sudah ada (`dev:server:live`).
// Perekaman dan pelabelan tidak membutuhkannya, jadi tool ini tidak
// menduplikasi logika refresh kontrak.
const provider = new GateioMarketDataProvider();
const runtime = new MarketRuntime({
  provider,
  clock: systemClock,
  contracts,
  staleness: { maxStalenessMs: 10_000 },
  riskIntervalMs: 1000,
  onClosedCandle: (candle) => {
    // Candle tertutup saja; analitik/collector TIDAK pernah memblokir ingest.
    recorder.onEvent({ type: "candle", candle }, systemClock.nowMs());
  },
});
// Semua event pasar mentah masuk ke recorder (mark/quote/funding/candle).
const off = provider.onEvent((event) => recorder.onEvent(event, systemClock.nowMs()));

const startedAt = systemClock.nowMs();
const statsTimer = setInterval(() => {
  const stats = new MarketObservationRepository(connection).stats(sessionId);
  const metrics = recorder.metrics();
  const elapsed = Math.round((systemClock.nowMs() - startedAt) / 1000);
  // Diagnostik koneksi (pola: stall diam-diam tanpa error di log bila
  // socket setengah-terbuka; angka-angka ini membedakannya dari "tidak ada
  // pesan karena pasar sepi").
  const gate = provider.metrics();
  console.log(
    `[record] ${elapsed}s obs=${stats.total} mark=${stats.byKind.mark ?? 0} quote=${stats.byKind.quote ?? 0} ` +
      `funding=${stats.byKind.funding ?? 0} candle=${stats.byKind.candle ?? 0} ` +
      `bytes=${stats.bytes} skipped=${metrics.observationsSkippedUnchanged}` +
      ` | ws=${provider.state()} conn=${gate.wsConnections} msg=${gate.wsMessages} ` +
      `reconn=${gate.wsReconnects} sched=${gate.reconnectsScheduled} attempt=${gate.reconnectAttempt} parseErr=${gate.wsParseErrors}` +
      (collector === null ? "" : ` | collector=${JSON.stringify(collector.status())}`),
  );
}, 15_000);

function shutdown(signal: string): void {
  console.log(`\n[record] ${signal} diterima; menutup sesi...`);
  clearInterval(statsTimer);
  off();
  collector?.stop();
  recorder.stopSession(systemClock.nowMs(), "completed");
  connection.close();
  console.log(`[record] sesi ${sessionId} difinalisasi (completed)`);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await runtime.start();
console.log(`[record] feed publik aktif; berhenti dengan Ctrl-C (atau ${seconds}s)`);
if (seconds > 0) {
  setTimeout(() => shutdown("durasi selesai"), seconds * 1000);
}
