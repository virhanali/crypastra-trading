/**
 * Titik masuk server.
 *
 *   CRYPASTRA_MODE=simulation bun run src/main.ts   (default)
 *   CRYPASTRA_MODE=live       bun run src/main.ts
 *
 * Mode `live` menyambungkan feed pasar PUBLIK Gate.io ke paper exchange.
 * Tidak ada API key, tidak ada kanal privat, tidak ada order ke exchange.
 *
 * Urutan startup (docs/PLAN.md §24):
 *   DB + migrasi → refresh ContractSpec → runtime pasar → HTTP/WS → siap.
 * Shutdown: hentikan pemroses risiko → tutup Gate WS → tutup HTTP/WS → tutup DB.
 */
import { ContractSpecSchema, systemClock } from "@crypastra/core";
import { z } from "zod";
import { GateioMarketDataProvider, GATE_REST_BASE } from "@crypastra/adapters";
import { createApp, type MarketDetailView } from "./api/app.js";
import { openDatabase, DEFAULT_DB_PATH } from "./db/database.js";
import { ContractRepository } from "./repositories/contract-repository.js";
import { CandleRepository } from "./repositories/candle-repository.js";
import { PositionRepository } from "./repositories/position-repository.js";
import { MarkToMarketService } from "./services/mark-to-market-service.js";
import { InMemoryMarketSnapshotProvider } from "./market/market-snapshot-provider.js";
import { LiveRiskProcessor } from "./market/live-risk-processor.js";
import { MarketRuntime } from "./market/market-runtime.js";
import { AnalyticsService } from "./analytics/analytics-service.js";
import { DecisionService } from "./decision/decision-service.js";
import { DecisionCoordinator } from "./decision/decision-coordinator.js";
import { TradeExecutionService } from "./execution/trade-execution-service.js";
import { JevTreatment, NoTreatment } from "@crypastra/core";
import { realJevConfigFromEnv, RealJevAdapter } from "@crypastra/adapters";
import { JevEvaluationRepository } from "./repositories/jev-evaluation-repository.js";
import { TreatmentResultRepository } from "./repositories/treatment-result-repository.js";
import { AutonomousTradeTracker } from "./execution/autonomous-trade-tracker.js";
import { createRealtimeHub } from "./realtime/ws.js";

/**
 * Konfigurasi runtime, dipecah oleh zod — konsisten dengan aturan repo bahwa
 * tidak ada `Number()`/`parseInt` mentah di jalur server. Nilai di sini adalah
 * parameter operasional (port, timeout), bukan nilai finansial.
 */
const ConfigSchema = z.object({
  mode: z.enum(["simulation", "live"]).default("simulation"),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  host: z.string().min(1).default("127.0.0.1"),
  dbPath: z.string().min(1).default(DEFAULT_DB_PATH),
  stalenessMs: z.coerce.number().int().positive().default(5000),
  riskIntervalMs: z.coerce.number().int().positive().default(1000),
  refreshContracts: z.boolean().default(true),
  cors: z.string().default("*"),
});

const CONFIG = ConfigSchema.parse({
  mode: process.env.CRYPASTRA_MODE,
  port: process.env.PORT,
  host: process.env.HOST,
  dbPath: process.env.CRYPASTRA_DB_PATH,
  stalenessMs: process.env.CRYPASTRA_STALENESS_MS,
  riskIntervalMs: process.env.CRYPASTRA_RISK_INTERVAL_MS,
  refreshContracts: process.env.CRYPASTRA_REFRESH_CONTRACTS !== "0",
  cors: process.env.CRYPASTRA_CORS,
});

const MODE = CONFIG.mode;
const PORT = CONFIG.port;
const HOST = CONFIG.host;
const CONTRACTS = (process.env.CRYPASTRA_CONTRACTS ?? "BTC_USDT,ETH_USDT,SOL_USDT")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const DEPTH_CONTRACTS = (process.env.CRYPASTRA_DEPTH_CONTRACTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const STALENESS_MS = CONFIG.stalenessMs;
const RISK_INTERVAL_MS = CONFIG.riskIntervalMs;
const REFRESH_TEST = CONFIG.refreshContracts;

const connection = openDatabase({ path: CONFIG.dbPath });
console.log(`[startup] mode=${MODE} db=${connection.path}`);

const contractsRepo = new ContractRepository(connection);
const positionsRepo = new PositionRepository(connection);
const candlesRepo = new CandleRepository(connection);

// ── Referensi kontrak (§25) ───────────────────────────────────────
async function refreshContracts(): Promise<void> {
  if (MODE !== "live" || !REFRESH_TEST) {
    return;
  }
  let fetched = 0;
  let valid = 0;
  let rejected = 0;
  let changed = 0;
  for (const contract of CONTRACTS) {
    fetched += 1;
    try {
      const payload = (await fetch(
        `${GATE_REST_BASE}/futures/usdt/contracts/${encodeURIComponent(contract)}`,
      ).then((response) => response.json())) as Record<string, unknown>;
      const [base, quote] = contract.split("_");
      const spec = ContractSpecSchema.parse({
        contract: String(payload.name ?? contract),
        base: base ?? contract,
        quote: quote ?? "USDT",
        quantoMultiplier: payload.quanto_multiplier,
        orderSizeMin: payload.order_size_min,
        orderSizeMax: payload.order_size_max,
        enableDecimal: payload.enable_decimal === true,
        orderPriceRound: payload.order_price_round,
        markPriceRound: payload.mark_price_round,
        leverageMin: payload.leverage_min,
        leverageMax: payload.leverage_max,
        maintenanceRate: payload.maintenance_rate,
        makerFeeRate: payload.maker_fee_rate,
        takerFeeRate: payload.taker_fee_rate,
        fundingIntervalSeconds: payload.funding_interval,
        marketOrderSlipRatio: payload.market_order_slip_ratio ?? null,
        status: payload.status,
        source: "gateio",
      });
      const previous = contractsRepo.find(contract);
      // Validasi lewat skema sebelum upsert; data tidak lengkap tidak menimpa.
      if (previous !== null && previous.quantoMultiplier !== spec.quantoMultiplier) {
        changed += 1;
      }
      contractsRepo.upsert({ spec, rawJson: JSON.stringify(payload), updatedAtMs: systemClock.nowMs() });
      valid += 1;
    } catch (error) {
      rejected += 1;
      console.warn(`[contracts] ${contract} ditolak: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(
    `[contracts] fetched=${fetched} valid=${valid} changed=${changed} rejected=${rejected}`,
  );
}

/**
 * Backfill candle historis untuk chart.
 *
 * REST dipakai HANYA untuk riwayat (bukan polling harga), satu kali per kontrak
 * saat startup. Tanpa ini chart kosong sampai candle 5m pertama tertutup.
 * Candle terakhir yang masih berjalan tidak disimpan.
 */
async function backfillCandles(): Promise<void> {
  if (MODE !== "live") {
    return;
  }
  const nowSeconds = Math.floor(systemClock.nowMs() / 1000);
  for (const contract of CONTRACTS) {
    try {
      const rows = (await fetch(
        `${GATE_REST_BASE}/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=5m&limit=300`,
      ).then((response) => response.json())) as Array<{
        t: number;
        o: string;
        h: string;
        l: string;
        c: string;
        v: number;
        sum: string;
      }>;
      let stored = 0;
      for (const row of rows) {
        // Hanya candle yang sudah lewat window-nya (windowClosed).
        if (row.t + 300 > nowSeconds) {
          continue;
        }
        candlesRepo.upsert({
          candle: {
            contract,
            interval: "5m",
            openTimeSeconds: row.t,
            o: row.o,
            h: row.h,
            l: row.l,
            c: row.c,
            v: row.v,
            sum: row.sum ?? "0",
            windowClosed: true,
          },
          provider: "gateio",
          ingestedAtMs: systemClock.nowMs(),
        });
        stored += 1;
      }
      console.log(`[candles] ${contract}: ${stored} candle historis disimpan`);
    } catch (error) {
      console.warn(`[candles] ${contract} gagal backfill: ${error instanceof Error ? error.message : error}`);
    }
  }
}

await refreshContracts();
await backfillCandles();

// ── Runtime pasar ─────────────────────────────────────────────────
// Hub dibuat lebih dulu supaya peristiwa pasar dapat langsung diteruskan.
const hub = createRealtimeHub({ connection });
const provider = new GateioMarketDataProvider();
const markToMarket = new MarkToMarketService({ connection });

let runtime: MarketRuntime | null = null;
let simulator: InMemoryMarketSnapshotProvider | null = null;

// Lapisan intelijen pasar (Phase 9) — OBSERVASIONAL. Bisa dimatikan dengan
// CRYPASTRA_ANALYTICS=0; mematikannya tidak mengubah perilaku ekonomi apa pun.
const analyticsEnabled = process.env.CRYPASTRA_ANALYTICS !== "0";
const analytics = analyticsEnabled
  ? new AnalyticsService({
      connection,
      clock: systemClock,
      onDiagnostic: (event) => {
        if (event.type === "scanner.result" || event.type === "analytics.error") {
          console.log(`[analytics] ${event.type} ${event.contract} ${event.detail}`);
        }
      },
    })
  : null;

// Lapisan keputusan otonom (Phase 10) — OBSERVASIONAL dan TANPA ORDER.
// Default OFF: menyalakannya hanya menambah baris `decisions`, tidak pernah
// menyentuh orders/fills/positions/ledger. Butuh akun target eksplisit karena
// runtime live tidak punya konsep "akun utama".
const decisionsEnabled = process.env.CRYPASTRA_DECISIONS === "1";
const decisionAccountId = process.env.CRYPASTRA_DECISION_ACCOUNT;
const decisionService =
  decisionsEnabled && decisionAccountId !== undefined
    ? new DecisionService({
        connection,
        clock: systemClock,
        onDiagnostic: (event) => {
          console.log(`[decision] ${event.type} ${event.contract} ${event.detail}`);
        },
      })
    : null;
if (decisionsEnabled && decisionAccountId === undefined) {
  console.log("[decision] CRYPASTRA_DECISIONS=1 tetapi CRYPASTRA_DECISION_ACCOUNT belum diisi; dilewati");
}

// Eksekusi otonom PAPER (Phase 11) — memerlukan DUA flag DAN akun eksplisit.
// Tanpa keputusan, eksekusi tidak mungkin aktif. Selalu PAPER: tidak ada
// endpoint privat Gate dan tidak ada kredensial exchange.
const executionRequested = process.env.CRYPASTRA_EXECUTION === "1";
const executionEnabled = executionRequested && decisionsEnabled && decisionAccountId !== undefined;
const executionService = executionEnabled
  ? new TradeExecutionService({
      connection,
      accountId: decisionAccountId!,
      enabled: true,
      onDiagnostic: (event) => console.log(`[execution] ${event.type} ${event.detail}`),
    })
  : null;
const tradeTracker = executionEnabled
  ? new AutonomousTradeTracker({ connection, clock: systemClock })
  : null;
// Perlakuan intelijen (Phase 12) — default OFF. Live V1 memakai mode OBSERVASI:
// evaluasi Jev dibaca dari cache (tanpa panggilan jaringan di jalur ingest), dan
// perlakuan hanya boleh MEMVETO kandidat baru; ia tidak pernah menyentuh risiko
// posisi yang sudah terbuka.
const jevRequested = process.env.CRYPASTRA_JEV === "1";
const jevEnabled = jevRequested && decisionsEnabled && decisionAccountId !== undefined;
const jevTreatment =
  jevEnabled && runtime === null
    ? new JevTreatment({
        store: new JevEvaluationRepository(connection),
        provider: process.env.CRYPASTRA_JEV_PROVIDER ?? "cache",
        model: process.env.CRYPASTRA_JEV_MODEL ?? "cache",
      })
    : null;
const treatmentResults = jevEnabled ? new TreatmentResultRepository(connection) : null;
const realJevConfig = jevRequested ? realJevConfigFromEnv() : null;
console.log(
  `JEV TREATMENT: ${jevEnabled ? "ON (cache; collect via tools/smoke:jev)" : "OFF"}` +
    (jevRequested && realJevConfig === null ? " (RealJevAdapter belum dikonfigurasi)" : ""),
);
void RealJevAdapter;
void NoTreatment;

console.log(
  `AUTONOMOUS PAPER EXECUTION: ${executionEnabled ? "ON" : "OFF"}` +
    (executionRequested && !executionEnabled
      ? " (diminta, tetapi CRYPASTRA_DECISIONS/CRYPASTRA_DECISION_ACCOUNT belum lengkap)"
      : ""),
);

if (MODE === "live") {
  const riskProcessor = new LiveRiskProcessor({
    positions: positionsRepo,
    markToMarket,
    clock: systemClock,
  });
  runtime = new MarketRuntime({
    provider,
    clock: systemClock,
    contracts: CONTRACTS,
    depthContracts: DEPTH_CONTRACTS,
    staleness: { maxStalenessMs: STALENESS_MS },
    riskIntervalMs: RISK_INTERVAL_MS,
    onRiskTick: (contract, mark) => {
      riskProcessor.handleMark(contract, mark as { markPrice: string; eventTsMs: number });
      // MAE/MFE diperbarui dari mark yang sudah terjadi; exit tetap milik
      // Paper Exchange (TP/SL/likuidasi).
      tradeTracker?.onMark(contract, String((mark as { markPrice: string }).markPrice), systemClock.nowMs());
    },
    // Peristiwa pasar mengalir ke klien sebagai stream EPHEMERAL; ia tidak
    // pernah ditulis ke `domain_events`.
    onMarketEvent: (event) => hub.publishMarket(event),
    onClosedCandle: (candle) => {
      // Hanya candle TERTUTUP yang dipersist (kebijakan Phase 6).
      candlesRepo.upsert({
        candle,
        provider: "gateio",
        ingestedAtMs: systemClock.nowMs(),
      });
      // Feature/scanner berjalan SETELAH persist candle dan hanya pada candle
      // tertutup. Tidak pernah menempatkan order.
      analytics?.onClosedCandle(candle);
    },
    fetchDepthSnapshot: async (contract) => {
      const payload = (await fetch(
        `${GATE_REST_BASE}/futures/usdt/order_book?contract=${encodeURIComponent(contract)}&limit=50&with_id=true`,
      ).then((response) => response.json())) as {
        id: number;
        bids: Array<{ p: string; s: number }>;
        asks: Array<{ p: string; s: number }>;
      };
      return {
        contract,
        updateId: payload.id,
        bids: payload.bids.map((level) => ({ price: level.p, size: level.s })),
        asks: payload.asks.map((level) => ({ price: level.p, size: level.s })),
      };
    },
  });
  // Keputusan dipasang SETELAH runtime ada, karena butuh provider kutipan.
  if (decisionService !== null && analytics !== null && decisionAccountId !== undefined) {
    const coordinator = new DecisionCoordinator({
      connection,
      decisions: decisionService,
      provider: runtime.marketProvider(),
      contracts: contractsRepo,
      accountId: decisionAccountId,
      watchedContracts: CONTRACTS,
      clock: systemClock,
      ...(executionService === null ? {} : { execution: executionService }),
      ...(tradeTracker === null ? {} : { tracker: tradeTracker }),
      ...(jevTreatment === null ? {} : { treatment: jevTreatment }),
      ...(treatmentResults === null
        ? {}
        : { onTreatment: (result: import("@crypastra/core").TreatmentResult) => treatmentResults.insertIfAbsent(result, systemClock.nowMs()) }),
      onDiagnostic: (message) => console.log(`[decision] ${message}`),
    });
    analytics.setScannerResultHandler((result) => coordinator.onScannerResult(result));
    console.log(`[decision] evaluasi otonom aktif untuk akun ${decisionAccountId} (tanpa eksekusi order)`);
  }

  simulator = new InMemoryMarketSnapshotProvider();
  await runtime.start();
  console.log(
    `[market] live feed dimulai untuk ${CONTRACTS.join(", ")} (depth: ${DEPTH_CONTRACTS.join(", ") || "tidak ada"})`,
  );
} else {
  simulator = new InMemoryMarketSnapshotProvider();
  console.log("[market] mode simulasi — feed Gate tidak diaktifkan");
}

const marketProvider = runtime?.marketProvider() ?? simulator;

// ── Aplikasi ──────────────────────────────────────────────────────
const context = createApp({
  connection,
  market: marketProvider,
  mode: MODE,
  enableSimulation: MODE === "simulation",
  feedHealth: () =>
    runtime === null
      ? { state: "idle", ready: true, mode: MODE }
      : { ...runtime.feedHealth(), ready: runtime.isReady() },
  marketDetail:
    runtime === null
      ? undefined
      : (contract): MarketDetailView | null => {
          const state = runtime!.state.get(contract);
          if (state === null) {
            return null;
          }
          const mark = runtime!.marketProvider().getMark(contract);
          return {
            contract,
            markPrice: mark === null ? null : mark.markPrice,
            markSourceTimestampMs: mark === null ? null : mark.sourceTimestampMs,
            markStatus: runtime!.marketProvider().markStatus(contract),
            lastPrice: state.lastPrice === null ? null : state.lastPrice.toString(),
            indexPrice: state.indexPrice === null ? null : state.indexPrice.toString(),
            fundingRate: state.fundingRate === null ? null : state.fundingRate.toString(),
            fundingNextApplyMs: state.fundingNextApplyMs,
            bestBid: state.bestBid === null ? null : state.bestBid.toString(),
            bestBidSize: state.bestBidSize,
            bestAsk: state.bestAsk === null ? null : state.bestAsk.toString(),
            bestAskSize: state.bestAskSize,
            depthStatus: state.depth?.status ?? null,
          };
        },
  corsOrigin: CONFIG.cors,
  logger: false,
});

hub.attach(context.app.server);

await context.app.listen({ port: PORT, host: HOST });
console.log(`[startup] HTTP+WS siap di http://${HOST}:${PORT} (PAPER ONLY)`);

// ── Shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  await hub.close();
  await runtime?.stop();
  await context.app.close();
  connection.close();
  console.log("[shutdown] selesai");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
