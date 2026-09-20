import {
  Decimal,
  EVALUATION_VERSION,
  actualInitialRiskFor,
  emptyExcursion,
  netPnlFor,
  rMultipleFor,
  updateExcursion,
  type Decision,
  type ExitReason,
  type TradeRecord,
  type ExcursionState,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { ContractRepository } from "../repositories/contract-repository.js";
import { PositionRepository } from "../repositories/position-repository.js";
import { TradeRecordRepository } from "../repositories/trade-record-repository.js";
import { DecisionRepository } from "../repositories/decision-repository.js";

interface OpenTrade {
  readonly positionId: string;
  readonly decision: Decision;
  readonly decisionId: string;
  readonly plannedRiskAmount: string;
  readonly entryPrice: string;
  readonly size: number;
  readonly leverage: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
  readonly plannedReference: string;
  readonly decisionTimeMs: number;
  readonly entryTimeMs: number;
  readonly contract: string;
  readonly side: "long" | "short";
  excursion: ExcursionState;
}

export interface TrackerCounters {
  tradesOpened: number;
  tradesClosed: number;
  tradesOpen: number;
}

/**
 * AutonomousTradeTracker — siklus hidup trade otonom (Phase 11).
 *
 * OBSERVASIONAL: ia hanya membaca posisi/fills/ledger dan menulis
 * `trade_records` (materialisasi riset). Ia TIDAK menutup posisi dan TIDAK
 * membangun mesin exit kedua: exit tetap milik Paper Exchange (TP/SL/likuidasi)
 * dan penutupan manual (§11).
 *
 * MAE/MFE diperbarui INKREMENTAL dari mark yang sudah terjadi — tidak ada
 * look-ahead.
 */
export class AutonomousTradeTracker {
  readonly #connection: DatabaseConnection;
  readonly #positions: PositionRepository;
  readonly #contracts: ContractRepository;
  readonly #records: TradeRecordRepository;
  readonly #clock: { nowMs(): number } | undefined;
  readonly #open = new Map<string, OpenTrade>();
  readonly #closed: TradeRecord[] = [];
  #counters: TrackerCounters = { tradesOpened: 0, tradesClosed: 0, tradesOpen: 0 };

  constructor(input: {
    connection: DatabaseConnection;
    contracts?: ContractRepository;
    clock?: { nowMs(): number };
  }) {
    this.#connection = input.connection;
    this.#clock = input.clock;
    this.#positions = new PositionRepository(input.connection);
    this.#contracts = input.contracts ?? new ContractRepository(input.connection);
    this.#records = new TradeRecordRepository(input.connection);
  }

  /** Daftarkan posisi yang baru dibuka oleh eksekusi otonom. */
  register(input: {
    positionId: string;
    decision: Decision;
    entryPrice: string;
    size: number;
    leverage: string;
    stopLoss: string;
    takeProfit: string;
    nowMs: number;
  }): void {
    if (input.decision.tradePlan === null || input.decision.direction === null) {
      return;
    }
    const plan = input.decision.tradePlan;
    this.#open.set(input.positionId, {
      positionId: input.positionId,
      decision: input.decision,
      decisionId: DecisionRepository.decisionIdFor(input.decision),
      plannedRiskAmount: plan.riskAmount,
      entryPrice: input.entryPrice,
      size: input.size,
      leverage: input.leverage,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      plannedReference: plan.referencePrice,
      decisionTimeMs: input.decision.candleCloseTimeMs,
      entryTimeMs: input.nowMs,
      contract: input.decision.contract,
      side: input.decision.direction,
      excursion: emptyExcursion(),
    });
    // Baris TERBUKA disisipkan sekarang supaya linkage ada sejak entry, dan
    // idempoten: percobaan ulang tidak menggandakan trade.
    const open = this.#open.get(input.positionId)!;
    this.#records.insertIfAbsent(this.#openRecord(open, input.nowMs), this.#clock?.nowMs() ?? input.nowMs);
    this.#counters.tradesOpened += 1;
    this.#counters.tradesOpen = this.#open.size;
  }

  #openRecord(trade: OpenTrade, nowMs: number): TradeRecord {
    const spec = this.#contracts.require(trade.contract);
    const actualRisk = actualInitialRiskFor({
      side: trade.side,
      actualEntry: trade.entryPrice,
      stopLoss: trade.stopLoss,
      multiplier: spec.quantoMultiplier,
      size: trade.size,
    });
    return {
      tradeId: `trade:${trade.decisionId}`,
      accountId: trade.decision.accountId,
      decisionId: trade.decisionId,
      contract: trade.contract,
      side: trade.side,
      decisionTimeMs: trade.decisionTimeMs,
      entryTimeMs: trade.entryTimeMs,
      exitTimeMs: null,
      plannedReference: trade.plannedReference,
      actualEntry: trade.entryPrice,
      size: trade.size,
      leverage: trade.leverage,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      plannedRiskAmount: trade.plannedRiskAmount,
      actualInitialRiskAmount: actualRisk.toString(),
      grossRealizedPnl: "0",
      fees: "0",
      funding: "0",
      netPnl: "0",
      exitReason: "open",
      mae: "0",
      mfe: "0",
      maeR: null,
      mfeR: null,
      rMultiple: null,
      holdingDurationMs: null,
      featureVersion: trade.decision.featureVersion,
      scannerVersion: trade.decision.scannerVersion,
      scannerConfigHash: trade.decision.scannerConfigHash,
      decisionVersion: trade.decision.decisionVersion,
      riskPolicyVersion: trade.decision.riskPolicyVersion,
      riskPolicyHash: trade.decision.riskPolicyHash,
      evaluationVersion: EVALUATION_VERSION,
    };
  }

  /**
   * Perbarui MAE/MFE dari satu mark untuk seluruh posisi otonom terbuka pada
   * kontrak itu, lalu finalisasi yang sudah tertutup.
   */
  onMark(contract: string, markPrice: string, nowMs: number): void {
    for (const trade of this.#open.values()) {
      if (trade.contract !== contract) {
        continue;
      }
      trade.excursion = updateExcursion(trade.excursion, trade.side, trade.entryPrice, markPrice);
    }
    this.settle(nowMs);
  }

  /** Finalisasi posisi otonom yang sudah tertutup menjadi TradeRecord. */
  settle(nowMs: number): void {
    for (const [positionId, trade] of [...this.#open.entries()]) {
      const position = this.#positions.find(positionId);
      if (position === null || position.status !== "closed") {
        continue;
      }
      const record = this.#buildRecord(trade, position);
      this.#records.update(record, nowMs);
      this.#closed.push(record);
      this.#open.delete(positionId);
      this.#counters.tradesClosed += 1;
    }
    this.#counters.tradesOpen = this.#open.size;
  }

  #buildRecord(trade: OpenTrade, position: ReturnType<PositionRepository["find"]>): TradeRecord {
    if (position === null) {
      throw new Error("posisi hilang saat finalisasi");
    }
    const spec = this.#contracts.require(trade.contract);
    const actualEntry = position.entryPrice.toString();
    // PENTING: `position.size` sudah dinolkan saat posisi ditutup, jadi risiko
    // awal harus dihitung dari ukuran ENTRY yang tercatat saat registrasi.
    const actualRisk = actualInitialRiskFor({
      side: trade.side,
      actualEntry,
      stopLoss: trade.stopLoss,
      multiplier: spec.quantoMultiplier,
      size: trade.size,
    });
    const grossRealizedPnl = position.realizedPnl;
    const fees = position.feesPaid;
    const funding = position.accumulatedFunding;
    const netPnl = netPnlFor({ grossRealizedPnl, fees, funding });
    const exitTimeMs = position.closedAtMs;
    const holdingDurationMs = exitTimeMs === null ? null : exitTimeMs - trade.entryTimeMs;
    const rMultiple = rMultipleFor(netPnl, actualRisk);
    const maeR = ratioOrNull(trade.excursion.mae, actualRisk);
    const mfeR = ratioOrNull(trade.excursion.mfe, actualRisk);

    const record: TradeRecord = {
      tradeId: `trade:${trade.decisionId}`,
      accountId: position.accountId,
      decisionId: trade.decisionId,
      contract: trade.contract,
      side: trade.side,
      decisionTimeMs: trade.decisionTimeMs,
      entryTimeMs: trade.entryTimeMs,
      exitTimeMs,
      plannedReference: trade.plannedReference,
      actualEntry,
      size: trade.size,
      leverage: trade.leverage,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      plannedRiskAmount: trade.plannedRiskAmount,
      actualInitialRiskAmount: actualRisk.toString(),
      grossRealizedPnl: grossRealizedPnl.toString(),
      fees: fees.toString(),
      funding: funding.toString(),
      netPnl: netPnl.toString(),
      exitReason: mapExitReason(position.closeReason),
      mae: trade.excursion.mae.toString(),
      mfe: trade.excursion.mfe.toString(),
      maeR: maeR?.toString() ?? null,
      mfeR: mfeR?.toString() ?? null,
      rMultiple: rMultiple?.toString() ?? null,
      holdingDurationMs,
      featureVersion: trade.decision.featureVersion,
      scannerVersion: trade.decision.scannerVersion,
      scannerConfigHash: trade.decision.scannerConfigHash,
      decisionVersion: trade.decision.decisionVersion,
      riskPolicyVersion: trade.decision.riskPolicyVersion,
      riskPolicyHash: trade.decision.riskPolicyHash,
      evaluationVersion: EVALUATION_VERSION,
    };
    return record;
  }

  counters(): TrackerCounters {
    return { ...this.#counters };
  }

  closedRecords(): readonly TradeRecord[] {
    return [...this.#closed];
  }
}

function ratioOrNull(value: Decimal, risk: Decimal): Decimal | null {
  if (risk.lessThanOrEqualTo(0)) {
    return null;
  }
  return value.div(risk);
}

function mapExitReason(closeReason: string | null): ExitReason {
  switch (closeReason) {
    case "take_profit":
      return "take_profit";
    case "stop_loss":
      return "stop_loss";
    case "liquidation":
      return "liquidation";
    case "manual":
      return "manual";
    default:
      return "manual";
  }
}
