import {
  buildJevInput,
  jevInputHash,
  type BookSnapshot,
  type BtcContext,
  type CandidateTreatment,
  type FeatureSnapshot,
  type ScannerResult,
  type TreatmentResult,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import type { ContractRepository } from "../repositories/contract-repository.js";
import { buildAccountRiskState, type DecisionService } from "./decision-service.js";
import type { TradeExecutionService } from "../execution/trade-execution-service.js";
import type { AutonomousTradeTracker } from "../execution/autonomous-trade-tracker.js";

/** Sumber kutipan/mark minimal yang sama untuk live dan replay. */
export interface DecisionQuoteProvider {
  getBook(contract: string): BookSnapshot | null;
  getMark(contract: string): { markPrice: string; stale?: boolean } | null;
}

export interface DecisionCoordinatorOptions {
  readonly connection: DatabaseConnection;
  readonly decisions: DecisionService;
  readonly provider: DecisionQuoteProvider;
  readonly contracts: ContractRepository;
  readonly accountId: string;
  /** Kontrak yang dipantau; dipakai untuk peta mark valuasi akun. */
  readonly watchedContracts: readonly string[];
  /** Waktu logis untuk eksekusi (jam virtual pada replay). */
  readonly clock?: { nowMs(): number };
  /** Bila ada DAN gate eksekusi ON, keputusan disetujui langsung dieksekusi. */
  readonly execution?: TradeExecutionService;
  readonly tracker?: AutonomousTradeTracker;
  /**
   * Perlakuan intelijen opsional (Phase 12). Bila tidak dipasang (CONTROL),
   * perilaku persis seperti sebelumnya. Bila dipasang dan statusnya bukan
   * `allow`, kandidat dilewati SEBELUM DecisionEngine dipanggil.
   */
  readonly treatment?: CandidateTreatment;
  readonly onTreatment?: (result: TreatmentResult) => void;
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * DecisionCoordinator — perakit input untuk engine murni.
 *
 * Menyatukan FeatureSnapshot + ScannerResult + kutipan pasar + keadaan akun +
 * ContractSpec, lalu memanggil `DecisionService.evaluate`. Dipakai IDENTIK oleh
 * jalur live dan replay: tidak ada ReplayDecisionEngine.
 *
 * TIDAK memanggil OrderService dan tidak menulis tabel ekonomi (§30).
 */
export class DecisionCoordinator {
  readonly #connection: DatabaseConnection;
  readonly #decisions: DecisionService;
  readonly #provider: DecisionQuoteProvider;
  readonly #contracts: ContractRepository;
  readonly #accountId: string;
  readonly #watched: readonly string[];
  readonly #clock: { nowMs(): number } | undefined;
  readonly #execution: TradeExecutionService | undefined;
  readonly #tracker: AutonomousTradeTracker | undefined;
  readonly #treatment: CandidateTreatment | undefined;
  readonly #onTreatment: ((result: TreatmentResult) => void) | undefined;
  readonly #onDiagnostic: ((message: string) => void) | undefined;

  constructor(options: DecisionCoordinatorOptions) {
    this.#connection = options.connection;
    this.#decisions = options.decisions;
    this.#provider = options.provider;
    this.#contracts = options.contracts;
    this.#accountId = options.accountId;
    this.#watched = options.watchedContracts;
    this.#clock = options.clock;
    this.#execution = options.execution;
    this.#tracker = options.tracker;
    this.#treatment = options.treatment;
    this.#onTreatment = options.onTreatment;
    this.#onDiagnostic = options.onDiagnostic;
  }

  onScannerResult(input: {
    snapshot: FeatureSnapshot;
    result: ScannerResult;
    btcContext?: BtcContext | null;
  }): void {
    const { snapshot, result } = input;
    const spec = this.#contracts.find(result.contract);
    if (spec === null) {
      this.#onDiagnostic?.(`kontrak ${result.contract} tidak dikenal; keputusan dilewati`);
      return;
    }

    const book = this.#provider.getBook(result.contract);
    const mark = this.#provider.getMark(result.contract);

    // Mark hanya untuk valuasi akun; harga masuk tetap bid/ask.
    const marks = new Map<string, { markPrice: string; stale: boolean }>();
    for (const contract of this.#watched) {
      const observed = this.#provider.getMark(contract);
      if (observed !== null) {
        marks.set(contract, {
          markPrice: String(observed.markPrice),
          stale: observed.stale ?? false,
        });
      }
    }

    const account = buildAccountRiskState({
      connection: this.#connection,
      accountId: this.#accountId,
      contracts: this.#contracts,
      marks,
    });

    // ── Perlakuan intelijen (SEBELUM risiko) ──────────────────────
    // Hanya untuk kandidat scanner; warmup/skip biasa tidak memanggil Jev (§3).
    if (this.#treatment !== undefined && result.status === "candidate" && result.signal !== "neutral") {
      const treatmentResult = this.#treatment.evaluate({
        input: buildJevInput({
          features: snapshot,
          scanner: result,
          btcContext: input.btcContext ?? null,
          direction: result.signal,
        }),
        inputHash: jevInputHash(
          buildJevInput({
            features: snapshot,
            scanner: result,
            btcContext: input.btcContext ?? null,
            direction: result.signal,
          }),
        ),
        direction: result.signal,
      });
      this.#onTreatment?.(treatmentResult);
      if (treatmentResult.status !== "allow") {
        // Fail closed / veto: tidak ada keputusan, tidak ada eksekusi.
        this.#onDiagnostic?.(
          `treatment ${treatmentResult.status} ${result.contract} [${treatmentResult.reasons.join(",")}]`,
        );
        return;
      }
    }

    const decision = this.#decisions.evaluate({
      contract: result.contract,
      timeframe: result.timeframe,
      candleCloseTimeMs: result.candleCloseTimeMs,
      accountId: this.#accountId,
      features: snapshot,
      scanner: result,
      spec,
      market: {
        bestBid: book === null ? null : (book.bids[0]?.price ?? null),
        bestAsk: book === null ? null : (book.asks[0]?.price ?? null),
        markPrice: mark === null ? null : String(mark.markPrice),
        sourceTimestampMs: book?.eventTsMs ?? null,
      },
      account,
    });

    if (decision === null || this.#execution === undefined) {
      return;
    }
    if (decision.action !== "trade" || decision.tradePlan === null) {
      return;
    }

    const nowMs = this.#clock?.nowMs() ?? result.candleCloseTimeMs;
    const outcome = this.#execution.executeApprovedDecision({
      decision,
      spec,
      book,
      nowMs,
    });
    if (outcome === null || outcome.positionId === null || outcome.status !== "filled") {
      return;
    }
    // Exit TIDAK dikelola di sini: TP/SL/likuidasi tetap milik Paper Exchange.
    this.#tracker?.register({
      positionId: outcome.positionId,
      decision,
      entryPrice: outcome.actualFillPrice ?? decision.tradePlan.referencePrice,
      size: decision.tradePlan.size,
      leverage: decision.tradePlan.leverage,
      stopLoss: decision.tradePlan.stopLoss,
      takeProfit: decision.tradePlan.takeProfit,
      nowMs,
    });
  }
}
