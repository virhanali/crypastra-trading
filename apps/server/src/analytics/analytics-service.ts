import {
  DEFAULT_FEATURE_CONFIG,
  DEFAULT_SCANNER_CONFIG,
  btcContextFromBtcFeatures,
  buildResearchDigest,
  createEngineState,
  applyClosedCandle,
  scan,
  scannerConfigHash,
  type ApplyOutcome,
  type BtcContext,
  type Candle,
  type EngineState,
  type FeatureConfig,
  type FeatureSnapshot,
  type ResearchDigest,
  type ScannerConfig,
  type ScannerResult,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { FeatureSnapshotRepository } from "../repositories/feature-snapshot-repository.js";
import { ScannerResultRepository } from "../repositories/scanner-result-repository.js";

export const BTC_CONTRACT = "BTC_USDT";

export interface AnalyticsCounters {
  candlesProcessed: number;
  otherIntervalCandles: number;
  duplicateCandles: number;
  outOfOrderCandles: number;
  warmupSkips: number;
  featureSnapshotsProduced: number;
  featureSnapshotsPersisted: number;
  scannerCandidates: number;
  scannerSkips: number;
  longSignals: number;
  shortSignals: number;
  neutralSignals: number;
  errors: number;
}

export interface AnalyticsDiagnostic {
  readonly type:
    | "feature.snapshot"
    | "scanner.result"
    | "candle.duplicate"
    | "candle.out_of_order"
    | "candle.warmup"
    | "analytics.error";
  readonly contract: string;
  readonly detail: string;
}

export interface AnalyticsServiceOptions {
  readonly connection: DatabaseConnection;
  /** Sumber waktu untuk metadata persistensi saja; TIDAK masuk hash riset. */
  readonly clock: { nowMs(): number };
  readonly featureConfig?: FeatureConfig;
  readonly scannerConfig?: ScannerConfig;
  readonly onDiagnostic?: (event: AnalyticsDiagnostic) => void;
  /**
   * Hook observasional setelah ScannerResult dipersist. Dipakai lapisan
   * keputusan (Phase 10) untuk mengevaluasi sinyal. Kegagalannya TIDAK boleh
   * mengganggu analitik maupun ingest pasar.
   */
  readonly onScannerResult?: (input: {
    snapshot: FeatureSnapshot;
    result: ScannerResult;
    /** Konteks BTC pada saat sinyal lahir (null untuk kandidat BTC sendiri). */
    btcContext: BtcContext | null;
  }) => void;
  readonly persist?: boolean;
}

/**
 * AnalyticsService — lapisan intelijen pasar (Phase 9).
 *
 * OBSERVASIONAL. Tidak menyentuh OrderService/PositionService/LedgerRepository/
 * saldo, tidak pernah menempatkan order, dan tidak pernah melempar ke luar:
 * kegagalan analitik tidak boleh menghentikan ingest pasar atau risk
 * processing (§35). Satu instance dipakai bersama oleh jalur LIVE dan REPLAY —
 * tidak ada ReplayFeatureEngine atau BacktestScanner terpisah.
 */
export class AnalyticsService {
  readonly #clock: { nowMs(): number };
  readonly #featureConfig: FeatureConfig;
  readonly #scannerConfig: ScannerConfig;
  readonly #scannerConfigHash: string;
  readonly #onDiagnostic: ((event: AnalyticsDiagnostic) => void) | undefined;
  #onScannerResult:
    | ((input: { snapshot: FeatureSnapshot; result: ScannerResult; btcContext: BtcContext | null }) => void)
    | undefined;
  readonly #persist: boolean;
  readonly #states = new Map<string, EngineState>();
  readonly #snapshots: FeatureSnapshot[] = [];
  readonly #results: ScannerResult[] = [];
  readonly #btcContexts = new Map<string, BtcContext>();
  readonly #features: FeatureSnapshotRepository;
  readonly #scanner: ScannerResultRepository;
  #btcLatest: BtcContext | null = null;
  #counters: AnalyticsCounters = {
    candlesProcessed: 0,
    otherIntervalCandles: 0,
    duplicateCandles: 0,
    outOfOrderCandles: 0,
    warmupSkips: 0,
    featureSnapshotsProduced: 0,
    featureSnapshotsPersisted: 0,
    scannerCandidates: 0,
    scannerSkips: 0,
    longSignals: 0,
    shortSignals: 0,
    neutralSignals: 0,
    errors: 0,
  };

  constructor(options: AnalyticsServiceOptions) {
    this.#clock = options.clock;
    this.#featureConfig = options.featureConfig ?? DEFAULT_FEATURE_CONFIG;
    this.#scannerConfig = options.scannerConfig ?? DEFAULT_SCANNER_CONFIG;
    this.#scannerConfigHash = scannerConfigHash(this.#scannerConfig);
    this.#onDiagnostic = options.onDiagnostic;
    this.#onScannerResult = options.onScannerResult;
    this.#persist = options.persist ?? true;
    this.#features = new FeatureSnapshotRepository(options.connection);
    this.#scanner = new ScannerResultRepository(options.connection);
  }

  get featureConfig(): FeatureConfig {
    return this.#featureConfig;
  }

  get scannerConfig(): ScannerConfig {
    return this.#scannerConfig;
  }

  get scannerConfigHashValue(): string {
    return this.#scannerConfigHash;
  }

  /**
   * Pasang handler hasil scanner (dipakai lapisan keputusan).
   *
   * Diset belakangan karena penyusunan keputusan butuh provider kutipan milik
   * runtime, yang baru ada setelah runtime dibangun. Jalur live dan replay
   * memakai mekanisme yang sama.
   */
  setScannerResultHandler(
    handler: (input: {
      snapshot: FeatureSnapshot;
      result: ScannerResult;
      btcContext: BtcContext | null;
    }) => void,
  ): void {
    this.#onScannerResult = handler;
  }

  /** Titik masuk tunggal untuk LIVE dan REPLAY. Tidak pernah melempar. */
  onClosedCandle(candle: Candle): void {
    try {
      this.#process(candle);
    } catch (error) {
      // Analitik observasional: jangan pernah menjatuhkan ingest/risk (§35).
      this.#counters.errors += 1;
      this.#diagnostic("analytics.error", candle.contract, String(error));
    }
  }

  #process(candle: Candle): void {
    if (candle.interval !== this.#featureConfig.timeframe) {
      this.#counters.otherIntervalCandles += 1;
      return;
    }
    this.#counters.candlesProcessed += 1;

    let state = this.#states.get(candle.contract);
    if (state === undefined) {
      state = createEngineState(candle.contract, this.#featureConfig);
      this.#states.set(candle.contract, state);
    }

    const outcome: ApplyOutcome = applyClosedCandle(state, candle, this.#featureConfig);
    let snapshot: FeatureSnapshot;
    switch (outcome.status) {
      case "duplicate":
        this.#counters.duplicateCandles += 1;
        this.#diagnostic("candle.duplicate", candle.contract, `t=${candle.openTimeSeconds}`);
        return;
      case "out_of_order":
        this.#counters.outOfOrderCandles += 1;
        this.#diagnostic(
          "candle.out_of_order",
          candle.contract,
          `t=${candle.openTimeSeconds} < ${outcome.lastOpenTimeSeconds}`,
        );
        return;
      case "wrong_contract":
      case "not_closed":
      case "wrong_interval":
        return;
      case "applied":
        snapshot = outcome.snapshot;
        break;
    }

    this.#snapshots.push(snapshot);
    // "Produced" menghitung snapshot yang DIHASILKAN (jalan walau persistensi
    // dimatikan, mis. pada alat analisis); "persisted" hanya baris baru di DB.
    this.#counters.featureSnapshotsProduced += 1;
    if (this.#persist && this.#features.insertIfAbsent(snapshot, this.#clock.nowMs())) {
      this.#counters.featureSnapshotsPersisted += 1;
    }
    this.#diagnostic(
      "feature.snapshot",
      snapshot.contract,
      `t=${snapshot.candleOpenTimeMs} close=${snapshot.close} warmup=${snapshot.warmupComplete}`,
    );

    if (snapshot.contract === BTC_CONTRACT) {
      this.#btcLatest = btcContextFromBtcFeatures(snapshot);
      this.#btcContexts.set(snapshot.contract, this.#btcLatest);
    }

    if (!snapshot.warmupComplete) {
      this.#counters.warmupSkips += 1;
      this.#diagnostic("candle.warmup", snapshot.contract, `remaining=${snapshot.warmupRemaining}`);
      return;
    }

    const btcContext =
      snapshot.contract === BTC_CONTRACT
        ? null
        : (this.#btcContexts.get(BTC_CONTRACT) ?? this.#btcLatest);

    const result = scan(snapshot, this.#scannerConfig, this.#scannerConfigHash, btcContext);
    this.#results.push(result);
    if (this.#persist) {
      this.#scanner.insertIfAbsent(result, this.#clock.nowMs());
    }
    if (result.status === "candidate") {
      this.#counters.scannerCandidates += 1;
    } else {
      this.#counters.scannerSkips += 1;
    }
    if (result.signal === "long") {
      this.#counters.longSignals += 1;
    } else if (result.signal === "short") {
      this.#counters.shortSignals += 1;
    } else {
      this.#counters.neutralSignals += 1;
    }
    this.#diagnostic(
      "scanner.result",
      result.contract,
      `${result.signal} [${result.reasonCodes.join(",")}]`,
    );

    // Pintu masuk lapisan keputusan. Dibungkus terpisah supaya kegagalan
    // keputusan tidak pernah menggagalkan analitik (§24, §39).
    try {
      this.#onScannerResult?.({ snapshot, result, btcContext });
    } catch (error) {
      this.#counters.errors += 1;
      this.#diagnostic("analytics.error", result.contract, `decision hook: ${String(error)}`);
    }
  }

  #diagnostic(type: AnalyticsDiagnostic["type"], contract: string, detail: string): void {
    this.#onDiagnostic?.({ type, contract, detail });
  }

  counters(): AnalyticsCounters {
    return { ...this.#counters };
  }

  snapshots(): readonly FeatureSnapshot[] {
    return [...this.#snapshots];
  }

  results(): readonly ScannerResult[] {
    return [...this.#results];
  }

  latestSnapshot(contract: string): FeatureSnapshot | null {
    for (let index = this.#snapshots.length - 1; index >= 0; index -= 1) {
      if (this.#snapshots[index]!.contract === contract) {
        return this.#snapshots[index]!;
      }
    }
    return null;
  }

  btcContext(): BtcContext | null {
    return this.#btcLatest;
  }

  /** Hash kanonik deterministik atas seluruh keluaran riset sesi ini. */
  digest(): ResearchDigest {
    return buildResearchDigest({
      snapshots: this.#snapshots,
      results: this.#results,
      counters: this.#counters as unknown as Record<string, number>,
    });
  }

  persistedFeatureCount(): number {
    return this.#features.count();
  }

  persistedScannerCount(): number {
    return this.#scanner.count();
  }

  resetCounters(): void {
    for (const key of Object.keys(this.#counters) as Array<keyof AnalyticsCounters>) {
      this.#counters[key] = 0;
    }
  }
}
