import {
  OrderIntentSchema,
  canonicalHashes,
  type CanonicalState,
  type MarketObservation,
  type OrderIntent,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import type { AnalyticsService } from "../analytics/analytics-service.js";
import { DecisionCoordinator } from "../decision/decision-coordinator.js";
import type { DecisionService } from "../decision/decision-service.js";
import type { TradeExecutionService } from "../execution/trade-execution-service.js";
import type { CandidateTreatment, TreatmentResult } from "@crypastra/core";
import type { AutonomousTradeTracker } from "../execution/autonomous-trade-tracker.js";
import { ValidationError } from "../db/errors.js";
import { AccountRepository } from "../repositories/account-repository.js";
import { ContractRepository } from "../repositories/contract-repository.js";
import { FillRepository } from "../repositories/fill-repository.js";
import { LedgerRepository } from "../repositories/ledger-repository.js";
import { MarketObservationRepository } from "../repositories/market-observation-repository.js";
import { OrderRepository } from "../repositories/order-repository.js";
import { PositionRepository } from "../repositories/position-repository.js";
import { MarketRiskProcessor } from "../market/live-risk-processor.js";
import { MarketRuntime } from "../market/market-runtime.js";
import {
  ReplayMarketDataProvider,
  type ReplaySpeed,
  type ReplayState,
} from "../market/replay-market-data-provider.js";
import { MarkToMarketService } from "./mark-to-market-service.js";
import { OrderService } from "./order-service.js";
import { PositionService } from "./position-service.js";

/**
 * Mesin replay (Phase 8).
 *
 * Menggerakkan SATU mesin ekonomi yang sama: `MarketRuntime` → `MarketState` →
 * `MarketRiskProcessor` → `MarkToMarketService`/`OrderService`. Tidak ada
 * engine kedua untuk replay.
 *
 * ISOLASI (dua koneksi):
 *  - `source` : database REKAMAN — dibaca SAJA (observasi pasar).
 *  - `target` : database terisolasi — SEMUA tulisan ekonomi (akun, order, fill,
 *               posisi, ledger, event domain).
 *
 * Rekaman pasar bukan keadaan akun, jadi ia tidak perlu disalin; yang diisolasi
 * adalah EKONOMI-nya. Dengan begitu akun paper LIVE tidak pernah tersentuh dan
 * replay tidak pernah melakukan "rewind" destruktif. Bila `source` tidak
 * diberikan, ia sama dengan `target` (memudahkan test).
 */

export type ScheduledReplayCommand =
  | {
      readonly afterObservationSeq: number;
      readonly kind: "submit_order";
      readonly intent: Omit<OrderIntent, "contract"> & { contract: string };
    }
  | {
      readonly afterObservationSeq: number;
      readonly kind: "amend_protection";
      readonly contract: string;
      readonly takeProfitPrice?: string | null;
      readonly stopLossPrice?: string | null;
    }
  | {
      readonly afterObservationSeq: number;
      readonly kind: "close_position";
      readonly contract: string;
      readonly reason?: "manual";
    };

export interface ReplayInput {
  readonly sessionId: string;
  readonly accountId: string;
  readonly speed?: ReplaySpeed;
  readonly contract?: string;
  readonly fromSeq?: number;
  readonly toSeq?: number;
  readonly commands?: readonly ScheduledReplayCommand[];
  /** Batas observasi; berguna untuk test bertahap. */
  readonly maxObservations?: number;
}

export interface ReplayResult {
  readonly sessionId: string;
  readonly accountId: string;

  readonly observationsProcessed: number;
  readonly commandsProcessed: number;
  readonly startVirtualTimeMs: number;
  readonly endVirtualTimeMs: number;
  readonly finalState: ReplayState;

  readonly hashes: ReturnType<typeof canonicalHashes>;
  readonly balances: CanonicalState["balances"];
  readonly openPositions: number;
  readonly totalPositions: number;
  readonly orderCount: number;
  readonly fillCount: number;
  readonly ledgerCount: number;

  /** Keluaran lapisan intelijen (Phase 9) bila analytics dipasang. */
  readonly analytics?: {
    readonly counters: Record<string, number>;
    readonly digest: ReturnType<AnalyticsService["digest"]>;
  };

  /** Keluaran lapisan keputusan (Phase 10) bila decision service dipasang. */
  readonly decisions?: {
    readonly counters: ReturnType<DecisionService["counters"]>;
    readonly digest: ReturnType<DecisionService["digest"]>;
  };

  /** Keluaran eksekusi otonom (Phase 11) bila mode otonom aktif. */
  readonly autonomous?: {
    readonly execution: Record<string, number>;
    readonly tracker: ReturnType<AutonomousTradeTracker["counters"]>;
    readonly tradeRecords: number;
  };

  readonly commandResults: readonly {
    readonly kind: ScheduledReplayCommand["kind"];
    readonly afterObservationSeq: number;
    readonly status: "applied" | "skipped";
    readonly detail: string;
  }[];
}

export class ReplayService {
  readonly #conn: DatabaseConnection;
  readonly #observations: MarketObservationRepository;
  readonly #accounts: AccountRepository;
  readonly #contracts: ContractRepository;
  readonly #positions: PositionRepository;
  readonly #orders: OrderRepository;
  readonly #fills: FillRepository;
  readonly #ledger: LedgerRepository;

  readonly #analytics: AnalyticsService | undefined;
  readonly #decisions: DecisionService | undefined;
  readonly #execution: TradeExecutionService | undefined;
  readonly #tracker: AutonomousTradeTracker | undefined;
  readonly #treatment: CandidateTreatment | undefined;
  readonly #onTreatment: ((result: TreatmentResult) => void) | undefined;

  constructor(
    input:
      | DatabaseConnection
      | {
          target: DatabaseConnection;
          source?: DatabaseConnection;
          analytics?: AnalyticsService;
          decisions?: DecisionService;
          execution?: TradeExecutionService;
          tracker?: AutonomousTradeTracker;
          treatment?: CandidateTreatment;
          onTreatment?: (result: TreatmentResult) => void;
        },
  ) {
    const target = "target" in input ? input.target : input;
    const source = "target" in input ? (input.source ?? input.target) : input;
    this.#analytics = "target" in input ? input.analytics : undefined;
    this.#decisions = "target" in input ? input.decisions : undefined;
    this.#execution = "target" in input ? input.execution : undefined;
    this.#tracker = "target" in input ? input.tracker : undefined;
    this.#treatment = "target" in input ? input.treatment : undefined;
    this.#onTreatment = "target" in input ? input.onTreatment : undefined;
    this.#observations = new MarketObservationRepository(source);
    this.#accounts = new AccountRepository(target);
    this.#contracts = new ContractRepository(target);
    this.#positions = new PositionRepository(target);
    this.#orders = new OrderRepository(target);
    this.#fills = new FillRepository(target);
    this.#ledger = new LedgerRepository(target);
    this.#conn = target;
  }

  /** Jalankan replay lengkap secara sinkron (deterministik). */
  run(input: ReplayInput): ReplayResult {
    const account = this.#accounts.require(input.accountId);
    const observations = this.#loadObservations(input);
    if (observations.length === 0) {
      throw new ValidationError(`Sesi ${input.sessionId} tidak punya observasi untuk diputar`);
    }

    const contracts = [...new Set(observations.map((entry) => entry.observation.contract))];
    const contract = input.contract ?? contracts[0]!;
    // Kontrak harus dikenal di database target (tempat ekonomi ditulis).
    this.#contracts.require(contract);

    const provider = new ReplayMarketDataProvider({
      observations: observations.map((entry) => entry.observation),
      speed: "max",
    });
    // Lapisan keputusan (Phase 10) memakai engine MURNI yang sama seperti live:
    // tidak ada ReplayDecisionEngine. Akun tetap karena keputusan Phase 10
    // tidak mengeksekusi order (§26).
    if (this.#decisions !== undefined && this.#analytics !== undefined) {
      const coordinator = new DecisionCoordinator({
        connection: this.#conn,
        decisions: this.#decisions,
        provider,
        contracts: this.#contracts,
        accountId: input.accountId,
        watchedContracts: contracts,
        clock: provider.clock,
        // Gate eksekusi diperiksa DI DALAM TradeExecutionService: bila OFF,
        // keputusan tetap dipersist tetapi tidak ada ekonomi yang dibuat.
        ...(this.#execution === undefined ? {} : { execution: this.#execution }),
        ...(this.#tracker === undefined ? {} : { tracker: this.#tracker }),
        ...(this.#treatment === undefined ? {} : { treatment: this.#treatment }),
        ...(this.#onTreatment === undefined ? {} : { onTreatment: this.#onTreatment }),
      });
      this.#analytics.setScannerResultHandler((result) => coordinator.onScannerResult(result));
    }

    const runtime = this.#buildRuntime(provider, contracts, (contract, markPrice) => {
      // MAE/MFE diperbarui dari mark yang sudah terjadi, sebelum finalisasi.
      this.#tracker?.onMark(contract, markPrice, provider.clock.nowMs());
    });
    // Pemasangan sinkron: provider replay mengirim event secara sinkron, jadi
    // tidak ada async di jalur ekonomi replay.
    runtime.attachProvider();

    const commandsBySeq = groupCommands(input.commands ?? []);
    const commandResults: Array<ReplayResult["commandResults"][number]> = [];
    // ID deterministik di jalur ekonomi replay: tidak ada UUID acak, sehingga
    // id order/fill/posisi dapat direproduksi untuk debugging.
    const ids = deterministicIds(input.sessionId);
    const orders = new OrderService({ connection: this.#conn, ...ids });
    const positions = new PositionService({ connection: this.#conn });

    let processed = 0;
    let commandsProcessed = 0;

    // Loop sinkron: setiap step menaikkan VirtualClock ke observedAtMs observasi,
    // lalu menjalankan perintah yang dijadwalkan SETELAH observasi itu.
    for (const entry of observations) {
      const observation = provider.stepOnce();
      if (observation === null) {
        break;
      }
      processed += 1;
      // Jalankan pemroses risiko pada setiap observasi supaya TP/SL/likuidasi
      // dievaluasi dengan mark terbaru, seperti pada live.
      runtime.flushRisk();

      const scheduled = commandsBySeq.get(entry.seq) ?? [];
      for (const command of scheduled) {
        const outcome = this.#runCommand({
          command: command.command,
          index: command.index,
          sessionId: input.sessionId,
          accountId: account.id,
          contract,
          runtime,
          orders,
          positions,
        });
        commandResults.push({
          kind: command.command.kind,
          afterObservationSeq: entry.seq,
          status: outcome.status,
          detail: outcome.detail,
        });
        if (outcome.status === "applied") {
          commandsProcessed += 1;
        }
      }
    }

    runtime.flushRisk();

    const finalProviderState = provider.replayState();
    const canonical = this.#canonicalState(account.id);
    const openPositions = this.#positions.listOpen(account.id).length;

    return {
      sessionId: input.sessionId,
      accountId: account.id,
      observationsProcessed: processed,
      commandsProcessed,
      startVirtualTimeMs: observations[0]!.observation.observedAtMs,
      endVirtualTimeMs: provider.clock.nowMs(),
      finalState: finalProviderState,
      hashes: canonicalHashes(canonical),
      balances: canonical.balances,
      openPositions,
      totalPositions: this.#positions.count(),
      orderCount: this.#orders.count(),
      fillCount: this.#fills.count(),
      ledgerCount: this.#ledger.list(account.id, { limit: 1_000_000 }).length,
      ...(this.#analytics === undefined
        ? {}
        : {
            analytics: {
              counters: this.#analytics.counters() as unknown as Record<string, number>,
              digest: this.#analytics.digest(),
            },
          }),
      ...(this.#decisions === undefined
        ? {}
        : {
            decisions: {
              counters: this.#decisions.counters(),
              digest: this.#decisions.digest(),
            },
          }),
      ...(this.#execution === undefined || this.#tracker === undefined
        ? {}
        : {
            autonomous: {
              execution: this.#execution.counters() as unknown as Record<string, number>,
              tracker: this.#tracker.counters(),
              tradeRecords: this.#tracker.closedRecords().length,
            },
          }),
      commandResults,
    };
  }

  #loadObservations(input: ReplayInput): Array<{ seq: number; observation: MarketObservation }> {
    const rows = this.#observations.list(input.sessionId, {
      ...(input.contract === undefined ? {} : { contract: input.contract }),
      limit: 1_000_000,
    });
    const filtered = rows.filter((row) => {
      if (input.fromSeq !== undefined && row.seq < input.fromSeq) return false;
      if (input.toSeq !== undefined && row.seq > input.toSeq) return false;
      return true;
    });
    return input.maxObservations === undefined ? filtered : filtered.slice(0, input.maxObservations);
  }

  /**
   * Rakit runtime dengan pengkabelan yang SAMA seperti live: risk processor,
   * pencatat candle tertutup, dan stream pasar (di sini tanpa hub).
   */
  #buildRuntime(
    provider: ReplayMarketDataProvider,
    contracts: readonly string[],
    onMark?: (contract: string, markPrice: string) => void,
  ): MarketRuntime {
    const markToMarket = new MarkToMarketService({ connection: this.#conn });
    const riskProcessor = new MarketRiskProcessor({
      positions: this.#positions,
      markToMarket,
      clock: provider.clock,
    });
    const runtime = new MarketRuntime({
      provider,
      clock: provider.clock,
      contracts,
      staleness: { maxStalenessMs: 5000 },
      riskIntervalMs: 1000,
      onRiskTick: (contract, mark) => {
        riskProcessor.handleMark(contract, mark as { markPrice: string; eventTsMs: number });
        onMark?.(contract, String((mark as { markPrice: string }).markPrice));
      },
      // Jalur intelijen yang SAMA seperti live (§20): tidak ada
      // ReplayFeatureEngine/BacktestScanner terpisah.
      onClosedCandle: (candle) => {
        this.#analytics?.onClosedCandle(candle);
      },
    });
    return runtime;
  }

  #runCommand(input: {
    command: ScheduledReplayCommand;
    index: number;
    sessionId: string;
    accountId: string;
    contract: string;
    runtime: MarketRuntime;
    orders: OrderService;
    positions: PositionService;
  }): { status: "applied" | "skipped"; detail: string } {
    const { command } = input;
    // Id perintah deterministik: tidak ada UUID acak di jalur ekonomi.
    const commandId = `replay:${input.sessionId}:${input.index}`;

    if (command.kind === "submit_order") {
      const book = input.runtime.state === null ? null : input.runtime.marketProvider().getBook(command.intent.contract);
      if (book === null) {
        return { status: "skipped", detail: "kutipan eksekusi belum tersedia pada titik ini" };
      }
      const intent = OrderIntentSchema.parse(command.intent);
      const result = input.orders.submitOrder({
        commandId,
        accountId: input.accountId,
        intent,
        book,
        nowMs: input.runtime.clock.nowMs(),
      });
      return {
        status: "applied",
        detail: `order ${result.order.status} (${result.order.id})`,
      };
    }

    if (command.kind === "amend_protection") {
      const position = this.#positions.findOpen(input.accountId, command.contract);
      if (position === null) {
        return { status: "skipped", detail: `tidak ada posisi terbuka ${command.contract}` };
      }
      input.positions.amendProtection({
        commandId,
        positionId: position.id,
        takeProfitPrice: command.takeProfitPrice,
        stopLossPrice: command.stopLossPrice,
        nowMs: input.runtime.clock.nowMs(),
      });
      return { status: "applied", detail: `proteksi diperbarui (${position.id})` };
    }

    const position = this.#positions.findOpen(input.accountId, command.contract);
    if (position === null) {
      return { status: "skipped", detail: `tidak ada posisi terbuka ${command.contract}` };
    }
    const book = input.runtime.marketProvider().getBook(command.contract);
    if (book === null) {
      return { status: "skipped", detail: "kutipan eksekusi belum tersedia" };
    }
    const bidPrice = book.bids[0]?.price;
    const askPrice = book.asks[0]?.price;
    if (bidPrice === undefined || askPrice === undefined) {
      // Tanpa dua sisi kutipan, penutupan tidak aman dilakukan.
      return { status: "skipped", detail: "kutipan bid/ask tidak lengkap" };
    }
    const quote = { contract: command.contract, bidPrice, askPrice };
    const markToMarket = new MarkToMarketService({ connection: this.#conn });
    const settlement = markToMarket.closePosition({
      commandId,
      positionId: position.id,
      execution: quote,
      nowMs: input.runtime.clock.nowMs(),
      reason: command.reason ?? "manual",
    });
    return { status: "applied", detail: `closed ${settlement.positionId} @ ${settlement.executionPrice.toFixed()}` };
  }

  /** Keadaan ekonomi kanonik dari database replay. */
  #canonicalState(accountId: string): CanonicalState {
    const balances = this.#ledger.balances(accountId);
    return {
      ledger: this.#ledger.list(accountId, { limit: 1_000_000 }).map((entry) => ({
        type: entry.type,
        amount: entry.amount.toFixed(8),
        marginDelta: entry.marginDelta.toFixed(8),
        reservedDelta: entry.reservedDelta.toFixed(8),
        balanceAfter: entry.balanceAfter.toFixed(8),
        refType: entry.refType,
      })),
      positions: this.#positions.listByAccount(accountId, { limit: 10_000 }).map((position) => ({
        contract: position.contract,
        direction: position.direction,
        status: position.status,
        size: position.size,
        entryPrice: position.entryPrice.toFixed(),
        initialMargin: position.initialMargin.toFixed(8),
        realizedPnl: position.realizedPnl.toFixed(8),
        accumulatedFunding: position.accumulatedFunding.toFixed(8),
        feesPaid: position.feesPaid.toFixed(8),
        closeReason: position.closeReason,
      })),
      fills: this.#fills.listByAccount(accountId, { limit: 10_000 }).map((fill) => ({
        contract: fill.contract,
        side: fill.side,
        size: fill.size,
        price: fill.price.toFixed(),
        fee: fill.fee.toFixed(8),
        realizedPnl: fill.realizedPnl.toFixed(8),
        liquidity: fill.liquidity,
        isLiquidation: fill.isLiquidation,
        isTpSl: fill.isTpSl,
      })),
      orders: this.#orders.listByAccount(accountId, { limit: 10_000 }).map((order) => ({
        contract: order.contract,
        side: order.side,
        type: order.type,
        size: order.size,
        status: order.status,
        filledSize: order.filledSize,
        leverage: order.leverage.toFixed(),
      })),
      balances: {
        walletBalance: balances.walletBalance.toFixed(8),
        usedMargin: balances.usedMargin.toFixed(8),
        reservedMargin: balances.reservedMargin.toFixed(8),
        realizedPnl: balances.realizedPnl.toFixed(8),
        feesPaid: balances.feesPaid.toFixed(8),
        fundingPaid: balances.fundingPaid.toFixed(8),
      },
    };
  }
}

/** Kelompokkan perintah berdasarkan `afterObservationSeq`, urut indeks asli. */
/** Pabrik id deterministik untuk satu sesi replay. */
function deterministicIds(sessionId: string): {
  orderIdFactory: () => string;
  fillIdFactory: () => string;
  positionIdFactory: () => string;
} {
  let order = 0;
  let fill = 0;
  let position = 0;
  return {
    orderIdFactory: () => `replay:${sessionId}:order:${(order += 1)}`,
    fillIdFactory: () => `replay:${sessionId}:fill:${(fill += 1)}`,
    positionIdFactory: () => `replay:${sessionId}:position:${(position += 1)}`,
  };
}

function groupCommands(
  commands: readonly ScheduledReplayCommand[],
): Map<number, Array<{ command: ScheduledReplayCommand; index: number }>> {
  const grouped = new Map<number, Array<{ command: ScheduledReplayCommand; index: number }>>();
  commands.forEach((command, index) => {
    const list = grouped.get(command.afterObservationSeq) ?? [];
    list.push({ command, index });
    grouped.set(command.afterObservationSeq, list);
  });
  return grouped;
}
