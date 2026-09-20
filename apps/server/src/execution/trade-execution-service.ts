import {
  Decimal,
  type BookSnapshot,
  type ContractSpec,
  type Decision,
  type OrderIntent,
  type OrderStatus,
} from "@crypastra/core";
import { ValidationError } from "../db/errors.js";
import type { DatabaseConnection } from "../db/database.js";
import { IdempotencyConflictError, InsufficientFundsError } from "../db/errors.js";
import { OrderService } from "../services/order-service.js";
import { DecisionRepository } from "../repositories/decision-repository.js";
import {
  DecisionExecutionRepository,
  TERMINAL_STATUSES,
  type ExecutionStatus,
} from "../repositories/decision-execution-repository.js";

export interface ExecutionCounters {
  executionAttempts: number;
  executionSubmitted: number;
  executionFilled: number;
  executionRejected: number;
  executionFailed: number;
  executionDuplicates: number;
  executionRefused: number;
}

export interface ExecutionOutcome {
  readonly status: ExecutionStatus;
  readonly decisionId: string;
  readonly commandId: string;
  readonly orderId: string | null;
  readonly positionId: string | null;
  readonly actualFillPrice: string | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly duplicate: boolean;
}

export interface TradeExecutionServiceOptions {
  readonly connection: DatabaseConnection;
  readonly accountId: string;
  /**
   * Gate eksekusi otonom. false = LAPISAN INERT: tidak menyentuh OrderService
   * dan tidak menulis baris apa pun, termasuk linkage.
   */
  readonly enabled: boolean;
  /**
   * Factory id order/fill/posisi. Replay menyuntikkan factory deterministik
   * supaya ekonomi otonom dapat direproduksi; live memakai default.
   */
  readonly idFactories?: {
    readonly orderIdFactory?: () => string;
    readonly fillIdFactory?: () => string;
    readonly positionIdFactory?: () => string;
  };
  readonly onDiagnostic?: (event: { type: string; decisionId: string; detail: string }) => void;
}

/**
 * TradeExecutionService — orkestrasi tipis Decision → OrderService (Phase 11).
 *
 * TANGGUNG JAWAB: memvalidasi bahwa keputusan boleh dieksekusi, menurunkan
 * command id deterministik, memetakan TradePlan → OrderIntent APA ADANYA, lalu
 * memanggil OrderService PAPER yang sudah ada.
 *
 * DILARANG: menghitung ulang indikator, memindai ulang, mengubah ukuran,
 * mengubah leverage, mengubah SL/TP, atau menghitung ulang kebijakan risiko.
 * TradePlan dari Phase 10 adalah input perencanaan yang otoritatif.
 */
export class TradeExecutionService {
  readonly #orders: OrderService;
  readonly #executions: DecisionExecutionRepository;
  readonly #accountId: string;
  readonly #enabled: boolean;
  readonly #onDiagnostic: TradeExecutionServiceOptions["onDiagnostic"];
  #counters: ExecutionCounters = blank();

  constructor(options: TradeExecutionServiceOptions) {
    this.#orders = new OrderService({ connection: options.connection, ...(options.idFactories ?? {}) });
    this.#executions = new DecisionExecutionRepository(options.connection);
    this.#accountId = options.accountId;
    this.#enabled = options.enabled;
    this.#onDiagnostic = options.onDiagnostic;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Eksekusi satu keputusan yang disetujui.
   *
   * `book` adalah kutipan PAPER yang dapat dieksekusi SAAT INI. Harga acuan
   * TradePlan TIDAK dipaksakan sebagai harga isian: pasar bisa sudah bergerak,
   * dan selisihnya diukur, bukan disembunyikan (§13).
   */
  executeApprovedDecision(input: {
    decision: Decision;
    spec: ContractSpec;
    book: BookSnapshot | null;
    nowMs: number;
  }): ExecutionOutcome | null {
    try {
      return this.#execute(input);
    } catch (error) {
      // Jalur otonom OBSERVASIONAL: kegagalan tak terduga tidak boleh
      // menjatuhkan ingest pasar atau trading manual. Dilaporkan sebagai
      // kegagalan sistem, terpisah dari penolakan ekonomi.
      this.#counters.executionFailed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      this.#onDiagnostic?.({
        type: "execution.error",
        decisionId: DecisionRepository.decisionIdFor(input.decision),
        detail: `EXECUTION_FAILED: ${detail}`,
      });
      return {
        status: "failed",
        decisionId: DecisionRepository.decisionIdFor(input.decision),
        commandId: `auto-entry:${DecisionRepository.decisionIdFor(input.decision)}`,
        orderId: null,
        positionId: null,
        actualFillPrice: null,
        errorCode: "EXECUTION_FAILED",
        errorDetail: detail,
        duplicate: false,
      };
    }
  }

  #execute(input: {
    decision: Decision;
    spec: ContractSpec;
    book: BookSnapshot | null;
    nowMs: number;
  }): ExecutionOutcome | null {
    const { decision } = input;
    const decisionId = DecisionRepository.decisionIdFor(decision);
    const commandId = `auto-entry:${decisionId}`;

    // ── Gate keras ───────────────────────────────────────────────
    if (!this.#enabled) {
      this.#counters.executionRefused += 1;
      return null;
    }

    // ── SKIP tidak pernah dieksekusi (struktural, bukan disiplin pemanggil) ──
    if (decision.action !== "trade" || decision.tradePlan === null || decision.direction === null) {
      this.#counters.executionRefused += 1;
      return this.#record(decisionId, commandId, decision, {
        status: "skipped",
        errorCode: "DECISION_NOT_APPROVED",
        errorDetail: `action=${decision.action}`,
      }, input.nowMs, null);
    }

    const plan = decision.tradePlan;

    // ── Idempotensi: percobaan ulang tidak menambah ekonomi baru ──
    const existing = this.#executions.findByDecision(decisionId);
    if (existing !== null && TERMINAL_STATUSES.includes(existing.status)) {
      this.#counters.executionDuplicates += 1;
      return {
        status: existing.status,
        decisionId,
        commandId: existing.commandId,
        orderId: existing.orderId,
        positionId: existing.positionId,
        actualFillPrice: existing.actualFillPrice,
        errorCode: existing.errorCode,
        errorDetail: existing.errorDetail,
        duplicate: true,
      };
    }

    // ── Kelayakan ukuran ─────────────────────────────────────────
    // Kontrak desimal (enable_decimal=true) boleh memakai ukuran pecahan;
    // OrderService/ContractSpec yang menegakkan aturan integer per kontrak.
    // SIZE_NOT_EXECUTABLE kini hanya untuk ukuran yang benar-benar tidak sah
    // (non-hingga, nol, atau negatif).
    if (!new Decimal(plan.size).isFinite() || plan.size <= 0) {
      this.#counters.executionRefused += 1;
      return this.#record(decisionId, commandId, decision, {
        status: "skipped",
        errorCode: "SIZE_NOT_EXECUTABLE",
        errorDetail: `size=${plan.size} bukan cacah kontrak positif berhingga`,
      }, input.nowMs, null);
    }

    // ── Kutipan wajib ada; tidak ada likuiditas yang dikarang (§35) ──
    const side = plan.side === "long" ? "buy" : "sell";
    const requiredLevel = side === "buy" ? input.book?.asks?.[0] : input.book?.bids?.[0];
    if (input.book === null || requiredLevel === undefined) {
      this.#counters.executionRefused += 1;
      return this.#record(decisionId, commandId, decision, {
        status: "skipped",
        errorCode: "QUOTE_UNAVAILABLE",
        errorDetail: "buku paper tidak punya sisi yang dapat dieksekusi",
      }, input.nowMs, null);
    }

    // ── Pemetaan langsung TradePlan → OrderIntent (tanpa perhitungan ulang) ──
    const intent: OrderIntent = {
      contract: plan.contract,
      side,
      type: "market",
      size: plan.size,
      price: null,
      leverage: plan.leverage,
      timeInForce: "ioc",
      reduceOnly: false,
      tpPrice: plan.takeProfit,
      slPrice: plan.stopLoss,
    };

    this.#counters.executionAttempts += 1;
    try {
      // `begin` ada DI DALAM try: kegagalan persistensi linkage tidak boleh
      // lolos keluar sebagai exception yang tidak tertangani.
      this.#executions.begin({
        decisionId,
        accountId: this.#accountId,
        commandId,
        plannedReference: plan.referencePrice,
        nowMs: input.nowMs,
      });
      const result = this.#orders.submitOrder({
        commandId,
        accountId: this.#accountId,
        intent,
        book: input.book,
        nowMs: input.nowMs,
        auditSource: "autonomous",
      });
      const status = mapOrderStatus(result.order.status);
      const fillPrice = result.order.avgFillPrice === null ? null : result.order.avgFillPrice.toString();
      if (status === "filled") this.#counters.executionFilled += 1;
      else if (status === "rejected") this.#counters.executionRejected += 1;
      else this.#counters.executionSubmitted += 1;

      this.#executions.update({
        decisionId,
        status,
        orderId: result.order.id,
        positionId: result.position?.id ?? null,
        errorCode: result.order.rejectReason === null ? null : "ORDER_REJECTED",
        errorDetail: result.order.rejectReason,
        actualFillPrice: fillPrice,
        nowMs: input.nowMs,
      });
      this.#onDiagnostic?.({ type: "execution.result", decisionId, detail: `${status} order=${result.order.id}` });

      return {
        status,
        decisionId,
        commandId,
        orderId: result.order.id,
        positionId: result.position?.id ?? null,
        actualFillPrice: fillPrice,
        errorCode: result.order.rejectReason === null ? null : "ORDER_REJECTED",
        errorDetail: result.order.rejectReason,
        duplicate: result.duplicate,
      };
    } catch (error) {
      // Penolakan EKONOMI berbeda dari kegagalan sistem (§7).
      const economic =
        error instanceof InsufficientFundsError || error instanceof ValidationError;
      const status: ExecutionStatus = economic ? "rejected" : "failed";
      if (economic) this.#counters.executionRejected += 1;
      else this.#counters.executionFailed += 1;
      const errorCode = classifyError(error);
      const detail = error instanceof Error ? error.message : String(error);
      this.#executions.update({
        decisionId,
        status,
        errorCode,
        errorDetail: detail,
        nowMs: input.nowMs,
      });
      this.#onDiagnostic?.({ type: "execution.error", decisionId, detail: `${errorCode}: ${detail}` });
      return {
        status,
        decisionId,
        commandId,
        orderId: null,
        positionId: null,
        actualFillPrice: null,
        errorCode,
        errorDetail: detail,
        duplicate: false,
      };
    }
  }

  #record(
    decisionId: string,
    commandId: string,
    decision: Decision,
    result: { status: ExecutionStatus; errorCode: string; errorDetail: string },
    nowMs: number,
    actualFillPrice: string | null,
  ): ExecutionOutcome {
    try {
      this.#executions.begin({
        decisionId,
        accountId: this.#accountId,
        commandId,
        plannedReference: decision.tradePlan?.referencePrice ?? null,
        nowMs,
      });
      this.#executions.update({ decisionId, status: result.status, errorCode: result.errorCode, errorDetail: result.errorDetail, actualFillPrice, nowMs });
    } catch {
      // Linkage bersifat observasional: kegagalan mencatatnya tidak mengubah
      // keputusan untuk tidak mengeksekusi.
    }
    this.#onDiagnostic?.({ type: "execution.refused", decisionId, detail: result.errorCode });
    return {
      status: result.status,
      decisionId,
      commandId,
      orderId: null,
      positionId: null,
      actualFillPrice: null,
      errorCode: result.errorCode,
      errorDetail: result.errorDetail,
      duplicate: false,
    };
  }

  counters(): ExecutionCounters {
    return { ...this.#counters };
  }

  resetCounters(): void {
    this.#counters = blank();
  }
}

function blank(): ExecutionCounters {
  return {
    executionAttempts: 0,
    executionSubmitted: 0,
    executionFilled: 0,
    executionRejected: 0,
    executionFailed: 0,
    executionDuplicates: 0,
    executionRefused: 0,
  };
}

function mapOrderStatus(status: OrderStatus): ExecutionStatus {
  switch (status) {
    case "filled":
      return "filled";
    case "rejected":
    case "cancelled":
    case "expired":
      return "rejected";
    case "open":
    case "partially_filled":
      return "resting";
    default:
      return "submitted";
  }
}

function classifyError(error: unknown): string {
  if (error instanceof InsufficientFundsError) return "INSUFFICIENT_FUNDS";
  if (error instanceof IdempotencyConflictError) return "IDEMPOTENCY_CONFLICT";
  if (error instanceof ValidationError) return "VALIDATION_REJECTED";
  return "EXECUTION_FAILED";
}
