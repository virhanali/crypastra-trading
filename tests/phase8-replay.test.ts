import { afterEach, describe, expect, test } from "bun:test";
import { virtualClock, type MarketObservation } from "../packages/core/src/index.js";
import { MarketRecorder } from "../apps/server/src/market/market-recorder.js";
import {
  MarketObservationRepository,
  RecordingSessionRepository,
} from "../apps/server/src/repositories/market-observation-repository.js";
import { MarketRuntime } from "../apps/server/src/market/market-runtime.js";
import { ReplayMarketDataProvider } from "../apps/server/src/market/replay-market-data-provider.js";
import { ReplayService, type ScheduledReplayCommand } from "../apps/server/src/services/replay-service.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { LedgerRepository } from "../apps/server/src/repositories/ledger-repository.js";
import { PositionRepository } from "../apps/server/src/repositories/position-repository.js";
import { FillRepository } from "../apps/server/src/repositories/fill-repository.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";
import { BTC_USDT } from "./helpers/fixtures.js";

const dbs: TempDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.cleanup();
});

const T0 = 1_700_000_000_000;
const MARK = "80000";
const BID = "79999";
const ASK = "80001";

/**
 * Skenario golden deterministik.
 *
 * Situasi pasar yang direkam (semua waktu virtual, tidak ada jam dinding):
 *   seq 1  mark 80000, funding 0.0001 (next apply di masa depan)
 *   seq 2  quote bid/ask 79999/80001
 *   seq 3  mark 80000 (masih sama, waktu maju)
 *   seq 4  funding rate berubah
 *   seq 5  mark turun ke 78500 (LONG SL 78000 belum kena)
 *   seq 6  quote bergeser
 *   seq 7  mark turun ke 77500 (SL kena; eksekusi memakai BID)
 *   seq 8  candle 5m tertutup
 *
 * Perintah terjadwal:
 *   setelah seq 2 : buka LONG 1 kontrak market (harus terisi di ASK 80001)
 *   setelah seq 3 : set TP 82000 / SL 78000
 *
 * Hasil yang diharapkan: SL terpicu dari MARK (77500 <= 78000) tetapi
 * penutupan diselesaikan memakai kutipan eksekusi (BID), bukan harga trigger.
 */
function buildScenario(): {
  sessionId: string;
  accountId: string;
  commands: ScheduledReplayCommand[];
  db: TempDatabase;
} {
  const db = openTempDatabase();
  dbs.push(db);
  const contracts = new ContractRepository(db.connection);
  contracts.upsert({ spec: BTC_USDT, rawJson: "{}", updatedAtMs: 1 });
  const accounts = new AccountRepository(db.connection);
  const account = accounts.create({ name: "replay", mode: "simulation", initialBalance: "1000", createdAtMs: 1 });
  const ledger = new LedgerRepository(db.connection);
  ledger.append({ accountId: account.id, tsMs: 1, type: "deposit", amount: "0", idempotencyKey: `${account.id}:seed` });

  const sessions = new RecordingSessionRepository(db.connection, () => "sess-golden");
  const observations = new MarketObservationRepository(db.connection);
  const recorder = new MarketRecorder({ sessions, observations });
  const sessionId = recorder.startSession({ source: "live", contracts: ["BTC_USDT"], startedAtMs: T0 });

  // Observasi disimpan langsung agar seq dapat diprediksi (1..8).
  const mark = (offsetMs: number, price: string): MarketObservation => ({
    kind: "mark", contract: "BTC_USDT", sourceTimestampMs: T0 + offsetMs, observedAtMs: T0 + offsetMs,
    markPrice: price, lastPrice: price, indexPrice: price,
  });
  const quote = (offsetMs: number, bid: string, ask: string): MarketObservation => ({
    kind: "quote", contract: "BTC_USDT", sourceTimestampMs: T0 + offsetMs, observedAtMs: T0 + offsetMs,
    bestBid: bid, bestBidSize: 500, bestAsk: ask, bestAskSize: 500,
  });
  const funding = (offsetMs: number, rate: string): MarketObservation => ({
    kind: "funding", contract: "BTC_USDT", sourceTimestampMs: T0 + offsetMs, observedAtMs: T0 + offsetMs,
    fundingRate: rate, fundingTimestampMs: T0 + 3600_000, intervalSeconds: 28800, markPrice: MARK,
  });

  recorder.record(sessionId, mark(0, MARK), T0);
  recorder.record(sessionId, quote(1000, BID, ASK), T0 + 1000);
  recorder.record(sessionId, mark(2000, MARK), T0 + 2000);
  recorder.record(sessionId, funding(3000, "0.0001"), T0 + 3000);
  recorder.record(sessionId, mark(4000, "78500"), T0 + 4000);
  recorder.record(sessionId, quote(5000, "78499", "78501"), T0 + 5000);
  recorder.record(sessionId, mark(6000, "77500"), T0 + 6000);
  recorder.record(sessionId, quote(6000, "77400", "77410"), T0 + 6000);
  recorder.record(sessionId, {
    kind: "candle", contract: "BTC_USDT", sourceTimestampMs: T0 + 7000, observedAtMs: T0 + 7000,
    interval: "5m", openTimeSeconds: Math.floor((T0 + 7000) / 1000), open: "80000", high: "80001",
    low: "77400", close: "77450", volume: 123, closed: true,
  }, T0 + 7000);
  recorder.stopSession(T0 + 8000);

  const commands: ScheduledReplayCommand[] = [
    {
      afterObservationSeq: 2,
      kind: "submit_order",
      intent: {
        contract: "BTC_USDT", side: "buy", type: "market", size: 1, price: null,
        leverage: "10", timeInForce: "ioc", reduceOnly: false, tpPrice: null, slPrice: null,
      },
    },
    { afterObservationSeq: 3, kind: "amend_protection", contract: "BTC_USDT", takeProfitPrice: "82000", stopLossPrice: "78000" },
  ];

  return { sessionId, accountId: account.id, commands, db };
}

describe("24. golden replay: determinisme dua kali jalan", () => {
  test("dua replay dengan input identik menghasilkan sidik jari identik", () => {
    const first = buildScenario();
    const second = buildScenario();

    const runA = new ReplayService(first.db.connection).run({
      sessionId: first.sessionId,
      accountId: first.accountId,
      commands: first.commands,
    });
    const runB = new ReplayService(second.db.connection).run({
      sessionId: second.sessionId,
      accountId: second.accountId,
      commands: second.commands,
    });

    // Observasi & perintah sama-sama diproses.
    expect(runA.observationsProcessed).toBe(9);
    expect(runB.observationsProcessed).toBe(9);
    expect(runA.commandsProcessed).toBe(2);

    // Sidik jari kanonik identik.
    expect(runB.hashes.combinedHash).toBe(runA.hashes.combinedHash);
    expect(runB.hashes.ledgerHash).toBe(runA.hashes.ledgerHash);
    expect(runB.hashes.positionsHash).toBe(runA.hashes.positionsHash);
    expect(runB.hashes.balancesHash).toBe(runA.hashes.balancesHash);
    expect(runB.balances).toEqual(runA.balances);
    expect(runB.fillCount).toBe(runA.fillCount);
    expect(runB.orderCount).toBe(runA.orderCount);
    expect(runB.openPositions).toBe(runA.openPositions);
  });

  test("ekonomi hasil replay sesuai semantik simulator", () => {
    const scenario = buildScenario();
    const result = new ReplayService(scenario.db.connection).run({
      sessionId: scenario.sessionId,
      accountId: scenario.accountId,
      commands: scenario.commands,
    });

    // Perintah diterapkan.
    expect(result.commandResults.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(result.commandResults[1]!.detail).toContain("proteksi diperbarui");

    // 1 order, 2 fill (buka + tutup karena SL), posisi tertutup.
    expect(result.orderCount).toBe(1);
    expect(result.fillCount).toBe(2);
    expect(result.openPositions).toBe(0);
    expect(result.totalPositions).toBe(1);

    const positions = new PositionRepository(scenario.db.connection).listByAccount(scenario.accountId);
    const position = positions[0]!;
    expect(position.closeReason).toBe("stop_loss");
    // Terpicu oleh MARK (77500 ≤ 78000). Penutupan OTOMATIS memakai kebijakan
    // simulator Phase 6: eksekusi di MARK saat pemicu, BUKAN di harga trigger
    // dan bukan di buku (buku dipakai oleh penutupan MANUAL).
    // 1 × 0.0001 × (77500 − 80001) = −0.2501
    expect(position.realizedPnl.toString()).toBe("-0.2501");

    const fills = new FillRepository(scenario.db.connection).listByAccount(scenario.accountId, { limit: 10 });
    const openFill = fills.find((fill) => !fill.isTpSl)!;
    const closeFill = fills.find((fill) => fill.isTpSl)!;
    // Buka di ASK buku (80001); tutup otomatis di MARK saat pemicu (77500).
    expect(openFill.price.toFixed()).toBe("80001");
    expect(closeFill.price.toFixed()).toBe("77500");

    // Ledger mencatat seluruh efek.
    const ledger = new LedgerRepository(scenario.db.connection).list(scenario.accountId, { limit: 100 });
    const types = new Set(ledger.map((entry) => entry.type));
    expect(types.has("margin_lock")).toBe(true);
    expect(types.has("margin_release")).toBe(true);
    expect(types.has("fee")).toBe(true);
    expect(types.has("pnl_realized")).toBe(true);
  });

  test("funding belum jatuh tempo sehingga tidak dikenakan (batas waktu dihormati)", () => {
    const scenario = buildScenario();
    const result = new ReplayService(scenario.db.connection).run({
      sessionId: scenario.sessionId,
      accountId: scenario.accountId,
      commands: scenario.commands,
    });
    const ledger = new LedgerRepository(scenario.db.connection).list(scenario.accountId, { limit: 100 });
    expect(ledger.some((entry) => entry.type === "funding")).toBe(false);
    expect(result.balances.fundingPaid).toBe("0.00000000");
  });
});

describe("12 & 20. STEP vs MAX identik; staleness dari waktu terekam", () => {
  test("MAX dan STEP menghasilkan urutan & waktu virtual yang sama", async () => {
    const scenario = buildScenario();
    const rows = new MarketObservationRepository(scenario.db.connection).list(scenario.sessionId);

    const run = async (speed: "step" | "max") => {
      const provider = new ReplayMarketDataProvider({
        observations: rows.map((row) => row.observation),
        clock: virtualClock(0) as ReturnType<typeof virtualClock>,
        speed,
      });
      const times: number[] = [];
      // STEP: satu per satu. MAX: sekaligus.
      if (speed === "step") {
        while (provider.stepOnce() !== null) {
          times.push(provider.clock.nowMs());
        }
      } else {
        await provider.runToCompletion();
        times.push(provider.clock.nowMs());
      }
      return { times, finalVirtualTime: provider.clock.nowMs(), processed: provider.progress().processed };
    };

    const stepped = await run("step");
    const maxed = await run("max");
    expect(stepped.processed).toBe(rows.length);
    expect(maxed.processed).toBe(rows.length);
    expect(maxed.finalVirtualTime).toBe(stepped.finalVirtualTime);
    // Waktu virtual maju ke observedAtMs observasi terakhir, terlepas dari pacing.
    expect(stepped.finalVirtualTime).toBe(rows[rows.length - 1]!.observation.observedAtMs);
  });

  test("staleness dihitung dari waktu TEREKAM, bukan dari kecepatan pemutaran", async () => {
    // Observasi pertama diterima tepat waktu → segar.
    // Observasi kedua TERLAMBAT 60 detik (observedAtMs jauh setelah source) →
    // harus dinilai BASI, walau replay memprosesnya dalam milidetik.
    const rows: MarketObservation[] = [
      { kind: "mark", contract: "BTC_USDT", sourceTimestampMs: T0, observedAtMs: T0, markPrice: "80000", lastPrice: "80000", indexPrice: "80000" },
      { kind: "mark", contract: "BTC_USDT", sourceTimestampMs: T0 + 1000, observedAtMs: T0 + 61_000, markPrice: "80100", lastPrice: "80100", indexPrice: "80100" },
    ];
    const provider = new ReplayMarketDataProvider({ observations: rows, clock: virtualClock(0), speed: "max" });
    const observed: Array<{ status: string; ageMs: number }> = [];
    const runtime = new MarketRuntime({
      provider,
      clock: provider.clock,
      contracts: ["BTC_USDT"],
      staleness: { maxStalenessMs: 5000 },
      riskIntervalMs: 1000,
      onRiskTick: () => {
        const mark = runtime.marketProvider().getMark("BTC_USDT");
        if (mark !== null) {
          observed.push({
            status: runtime.marketProvider().markStatus("BTC_USDT"),
            ageMs: provider.clock.nowMs() - mark.sourceTimestampMs,
          });
        }
      },
    });
    runtime.attachProvider();
    while (provider.stepOnce() !== null) {
      runtime.flushRisk();
    }

    expect(observed).toHaveLength(2);
    // Observasi 1: umur 0 → segar.
    expect(observed[0]!.ageMs).toBe(0);
    expect(observed[0]!.status).toBe("fresh");
    // Observasi 2: umur 60 detik meski diproses instan → basi.
    expect(observed[1]!.ageMs).toBe(60_000);
    expect(observed[1]!.status).toBe("stale");
  });
});
