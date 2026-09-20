#!/usr/bin/env bun
/**
 * SMOKE REKAM → PUTAR ULANG (Phase 8).
 *
 * Merekam observasi pasar Gate publik selama N detik, lalu memutar ulang
 * rekaman itu DUA KALI ke keadaan terisolasi dan membandingkan sidik jari
 * ekonomi. Tidak ada order yang dikirim ke exchange.
 *
 * Jalankan: bun run smoke:record-replay
 * Opsi:     GATE_SMOKE_SECONDS=30 SMOKE_TRADE=1 bun run smoke:record-replay
 *
 * `SMOKE_TRADE=1` menjadwalkan satu order PAPER saat kutipan sudah tersedia.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@crypastra/core";
import { GateioMarketDataProvider } from "@crypastra/adapters";
import { openDatabase, type DatabaseConnection } from "../apps/server/src/db/database.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { LedgerRepository } from "../apps/server/src/repositories/ledger-repository.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../apps/server/src/repositories/market-observation-repository.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import { ReplayService, type ScheduledReplayCommand } from "../apps/server/src/services/replay-service.js";

const CONTRACT = process.env.GATE_CONTRACT ?? "BTC_USDT";
const SECONDS = Number(process.env.GATE_SMOKE_SECONDS ?? 30);
const WITH_TRADE = process.env.SMOKE_TRADE === "1";

const line = (label: string, value: unknown) => console.log(`${label.padEnd(30)} ${String(value)}`);

// ── 1. Rekam ───────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "crypastra-record-replay-"));
const connection: DatabaseConnection = openDatabase({ path: join(dir, "capture.db") });
const contracts = new ContractRepository(connection);
const sessions = new RecordingSessionRepository(connection);
const observations = new MarketObservationRepository(connection);
const accounts = new AccountRepository(connection);
const ledger = new LedgerRepository(connection);

const provider = new GateioMarketDataProvider();
const spec = await provider.loadContract(CONTRACT);
contracts.upsert({ spec, rawJson: "{}", updatedAtMs: systemClock.nowMs() });

const recorder = new MarketRecorder({ sessions, observations });

console.log(`=== SMOKE REKAM → PUTAR ULANG (${CONTRACT}, ${SECONDS}s, PAPER ONLY) ===\n`);
console.log("-- merekam pasar publik Gate --");

const sessionId = recorder.startSession({
  source: "live",
  contracts: [CONTRACT],
  startedAtMs: systemClock.nowMs(),
  metadata: { tool: "smoke-record-replay" },
});

const unsubscribe = provider.onEvent((event) => recorder.onEvent(event, systemClock.nowMs()));
await provider.connect();
await provider.subscribeTicker(CONTRACT);
await provider.subscribeCandles(CONTRACT, "5m");
await provider.subscribeBookTicker(CONTRACT);

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));

recorder.stopSession(systemClock.nowMs());
unsubscribe();
await provider.disconnect();

const stats = observations.stats(sessionId);
console.log(`\n-- rekaman --`);
line("session", sessionId);
line("total observasi", stats.total);
line("per jenis", JSON.stringify(stats.byKind));
line("bytes (payload)", stats.bytes);
line("observasi/detik", stats.observationsPerSecond?.toFixed(2) ?? "—");
line("proyeksi 1 jam", `${(stats.projectedBytes.oneHour / 1024).toFixed(1)} KiB`);
line("proyeksi 8 jam", `${(stats.projectedBytes.eightHours / 1024 / 1024).toFixed(1)} MiB`);
line("proyeksi 24 jam", `${(stats.projectedBytes.twentyFourHours / 1024 / 1024).toFixed(1)} MiB`);

if (stats.total === 0) {
  console.error("\nTidak ada observasi terekam (jaringan?). Smoke dibatalkan.");
  connection.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

// ── 2. Putar ulang dua kali ke keadaan terisolasi ──────────────────
function isolatedRun(label: string) {
  const runDir = mkdtempSync(join(tmpdir(), `crypastra-replay-${label}-`));
  const runConnection = openDatabase({ path: join(runDir, "replay.db") });
  try {
    new ContractRepository(runConnection).upsert({ spec, rawJson: "{}", updatedAtMs: 1 });
    const account = new AccountRepository(runConnection).create({
      name: `replay-${label}`,
      mode: "replay",
      initialBalance: "1000",
      createdAtMs: 1,
    });
    void new LedgerRepository(runConnection);

    const commands: ScheduledReplayCommand[] = [];
    if (WITH_TRADE) {
      // Buka LONG setelah observasi ke-3 (kutipan diharapkan sudah ada).
      commands.push({
        afterObservationSeq: 3,
        kind: "submit_order",
        intent: {
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
        },
      });
    }

    const result = new ReplayService({ target: runConnection, source: connection }).run({
      sessionId,
      accountId: account.id,
      commands,
    });
    return result;
  } finally {
    runConnection.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

console.log("\n-- putar ulang (keadaan terisolasi) --");
const runA = isolatedRun("a");
const runB = isolatedRun("b");

line("observasi diproses", `${runA.observationsProcessed} / ${runB.observationsProcessed}`);
line("virtual start → end", `${runA.startVirtualTimeMs} → ${runA.endVirtualTimeMs}`);
line("wallet akhir (A / B)", `${runA.balances.walletBalance} / ${runB.balances.walletBalance}`);
line("hash gabungan A", runA.hashes.combinedHash);
line("hash gabungan B", runB.hashes.combinedHash);
line("deterministik", runA.hashes.combinedHash === runB.hashes.combinedHash ? "YA" : "TIDAK");

console.log("\nselesai. PAPER ONLY — tidak ada order yang dikirim ke Gate.");
connection.close();
rmSync(dir, { recursive: true, force: true });

if (runA.hashes.combinedHash !== runB.hashes.combinedHash) {
  process.exit(1);
}
