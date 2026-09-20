import {
  assertExecutablePrice,
  closingSide,
  DEFAULT_STALENESS_POLICY,
  Decimal,
  deriveAccount,
  executionPriceFor,
  feeFor,
  fundingDueFor,
  fundingIdempotencyKey,
  fundingPaymentAtMark,
  markFreshness,
  settleIsolatedClose,
  settlementIdempotencyKey,
  totalUnrealized,
  triggerReached,
  valuatePosition,
  type AccountValuation,
  type ExecutionQuote,
  type ForcedCloseReason,
  type MarkSnapshot,
  type PositionValuation,
  type StalenessPolicy,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { IdempotencyConflictError, NotFoundError, ValidationError } from "../db/errors.js";
import { AccountRepository } from "../repositories/account-repository.js";
import { CommandRepository, type TradeCommandKind } from "../repositories/command-repository.js";
import {
  DomainEventRepository,
  type AggregateType,
  type DomainEventType,
} from "../repositories/domain-event-repository.js";
import { ContractRepository } from "../repositories/contract-repository.js";
import { FillRepository } from "../repositories/fill-repository.js";
import { LedgerRepository } from "../repositories/ledger-repository.js";
import { PositionRepository, type PositionRecord } from "../repositories/position-repository.js";
import { newId } from "../repositories/ids.js";

const ZERO = new Decimal(0);

/**
 * MarkToMarketService — runtime deterministik Phase 4.
 *
 * Memproses SATU snapshot mark price eksplisit untuk satu akun. Tidak ada
 * `setInterval`, tidak ada subscriber WebSocket, tidak ada fetch. Pemanggil
 * (live wiring di fase berikutnya, replay, atau test) yang menentukan kapan.
 *
 * MARK PRICE menggerakkan: unrealized PnL, equity, maintenance margin, likuidasi,
 * dasar funding, dan trigger TP/SL. Harga eksekusi penutupan paksa berasal dari
 * `ExecutionQuote` yang diberikan terpisah, BUKAN dari harga trigger.
 *
 * Valuasi TIDAK menulis ledger (unrealized PnL bersifat turunan). Hanya funding
 * dan penutupan paksa yang menghasilkan efek akuntansi, dan keduanya atomik.
 */

export interface RuntimeConfig {
  readonly staleness: StalenessPolicy;
  readonly enableLiquidation: boolean;
  readonly enableTpSl: boolean;
  readonly enableFunding: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  staleness: DEFAULT_STALENESS_POLICY,
  enableLiquidation: true,
  enableTpSl: true,
  enableFunding: true,
};

export interface ProcessMarkCommand {
  readonly commandId: string;
  readonly accountId: string;
  /** Snapshot mark untuk SATU kontrak. */
  readonly mark: MarkSnapshot;
  /** Kutipan eksekusi eksplisit untuk penutupan paksa kontrak ini. */
  readonly execution: ExecutionQuote;
  readonly nowMs: number;
  readonly config?: Partial<RuntimeConfig>;
}

export interface ClosePositionCommand {
  readonly commandId: string;
  readonly positionId: string;
  readonly execution: ExecutionQuote;
  readonly nowMs: number;
  /** Alasan manual untuk penutupan yang diminta eksplisit. */
  readonly reason?: ForcedCloseReason;
}

export interface SettlementAction {
  readonly positionId: string;
  readonly reason: ForcedCloseReason;
  readonly fillId: string;
  readonly closedSize: number;
  /** Mark price yang memicu (null untuk penutupan manual). */
  readonly triggeredAtMark: Decimal | null;
  readonly executionPrice: Decimal;
  readonly realizedPnl: Decimal;
  readonly pnlAppliedToWallet: Decimal;
  readonly deficit: Decimal;
  readonly insolvent: boolean;
  readonly fee: Decimal;
  readonly releasedMargin: Decimal;
}

export interface FundingApplication {
  readonly positionId: string;
  readonly fundingTimestampMs: number;
  readonly rate: Decimal;
  readonly markPrice: Decimal;
  /** Positif = trader membayar. */
  readonly amount: Decimal;
  readonly ledgerKey: string;
  /** false = sudah pernah diterapkan; tidak ada efek baru. */
  readonly applied: boolean;
}

export interface ProcessMarkResult {
  readonly commandId: string;
  readonly accountId: string;
  readonly contract: string;
  readonly markPrice: Decimal | null;
  readonly markAgeMs: number | null;
  /** true = mark basi/tidak valid; TIDAK ada aksi risiko maupun funding. */
  readonly stale: boolean;
  readonly preValuations: readonly PositionValuation[];
  readonly actions: readonly SettlementAction[];
  readonly funding: readonly FundingApplication[];
  readonly accountValuation: AccountValuation;
  readonly duplicate: boolean;
}

export interface MarkToMarketDeps {
  readonly connection: DatabaseConnection;
  readonly fillIdFactory?: () => string;
}

export class MarkToMarketService {
  readonly #conn: DatabaseConnection;
  readonly #accounts: AccountRepository;
  readonly #contracts: ContractRepository;
  readonly #positions: PositionRepository;
  readonly #fills: FillRepository;
  readonly #ledger: LedgerRepository;
  readonly #commands: CommandRepository;
  readonly #events: DomainEventRepository;
  /** commandId perintah yang sedang berjalan (untuk menandai event outbox). */
  #activeCommandId: string | null = null;
  readonly #newFillId: () => string;

  constructor(deps: MarkToMarketDeps) {
    this.#conn = deps.connection;
    this.#accounts = new AccountRepository(deps.connection);
    this.#contracts = new ContractRepository(deps.connection);
    this.#positions = new PositionRepository(deps.connection);
    this.#fills = new FillRepository(deps.connection);
    this.#ledger = new LedgerRepository(deps.connection);
    this.#commands = new CommandRepository(deps.connection);
    this.#events = new DomainEventRepository(deps.connection);
    this.#newFillId = deps.fillIdFactory ?? newId;
  }

  // ────────────────────────────────────────────────────────────────
  // PROSES MARK
  // ────────────────────────────────────────────────────────────────

  processMark(command: ProcessMarkCommand): ProcessMarkResult {
    const config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, ...command.config };
    this.#accounts.require(command.accountId);
    this.#contracts.require(command.mark.contract);

    if (command.execution.contract !== command.mark.contract) {
      throw new ValidationError(
        `Kutipan eksekusi untuk ${command.execution.contract} tidak cocok dengan mark ${command.mark.contract}`,
      );
    }

    return this.#run("process_mark", command.commandId, command.accountId, command.nowMs, (duplicate) => {
      const freshness = markFreshness(command.mark, config.staleness);
      const markPrice = new Decimal(command.mark.markPrice);
      const openPositions = this.#positions
        .listOpen(command.accountId)
        .filter((position) => position.contract === command.mark.contract);

      // 1) Valuasi selalu dihitung (turunan, tanpa efek ledger).
      const preValuations = openPositions.map((position) =>
        valuatePosition({ spec: this.#spec(position), position, markPrice }),
      );

      const actions: SettlementAction[] = [];
      const funding: FundingApplication[] = [];

      // 2) Gerbang validitas data: mark basi/tidak valid tidak memicu apa pun.
      if (!freshness.stale) {
        for (const position of openPositions) {
          const valuation = valuatePosition({ spec: this.#spec(position), position, markPrice });

          // 3) Likuidasi MENDAHULUI exit protektif.
          if (config.enableLiquidation && valuation.liquidationState === "liquidatable") {
            actions.push(this.#settlePosition({
              position,
              reason: "liquidation",
              execution: command.execution,
              triggeredAtMark: markPrice,
              nowMs: command.nowMs,
            }));
            continue;
          }

          // 4) Stop loss (SL menang atas TP bila keduanya terpicu).
          if (config.enableTpSl && position.slPrice !== null) {
            const hit = triggerReached({
              direction: position.direction,
              kind: "stop_loss",
              triggerPrice: position.slPrice,
              observedPrice: markPrice,
            });
            if (hit) {
              actions.push(this.#settlePosition({
                position,
                reason: "stop_loss",
                execution: command.execution,
                triggeredAtMark: markPrice,
                nowMs: command.nowMs,
              }));
              continue;
            }
          }

          // 5) Take profit.
          if (config.enableTpSl && position.tpPrice !== null) {
            const hit = triggerReached({
              direction: position.direction,
              kind: "take_profit",
              triggerPrice: position.tpPrice,
              observedPrice: markPrice,
            });
            if (hit) {
              actions.push(this.#settlePosition({
                position,
                reason: "take_profit",
                execution: command.execution,
                triggeredAtMark: markPrice,
                nowMs: command.nowMs,
              }));
            }
          }
        }

        // 6) Funding untuk posisi yang MASIH terbuka setelah aksi risiko.
        if (config.enableFunding && command.mark.funding !== null) {
          const observation = command.mark.funding;
          for (const position of this.#positions.listOpen(command.accountId)) {
            if (position.contract !== command.mark.contract) {
              continue;
            }
            if (command.nowMs < observation.fundingTimestampMs) {
              continue;
            }
            if (!fundingDueFor({
              positionOpenedAtMs: position.openedAtMs,
              fundingTimestampMs: observation.fundingTimestampMs,
            })) {
              continue;
            }
            funding.push(this.#applyFunding({
              position,
              rate: observation.fundingRate,
              fundingTimestampMs: observation.fundingTimestampMs,
              markPrice,
              nowMs: command.nowMs,
            }));
          }
        }
      }

      return {
        commandId: command.commandId,
        accountId: command.accountId,
        contract: command.mark.contract,
        markPrice,
        markAgeMs: freshness.ageMs,
        stale: freshness.stale,
        preValuations,
        actions,
        funding,
        accountValuation: this.#accountValuation(command.accountId, command.mark.contract, markPrice, freshness.stale),
        duplicate,
      };
    });
  }

  // ────────────────────────────────────────────────────────────────
  // PENUTUPAN MANUAL
  // ────────────────────────────────────────────────────────────────

  closePosition(command: ClosePositionCommand): SettlementAction {
    const position = this.#positions.require(command.positionId);
    if (position.accountId === "") {
      throw new NotFoundError(`Posisi tanpa akun: ${command.positionId}`);
    }
    return this.#run(
      "settle_position",
      command.commandId,
      position.accountId,
      command.nowMs,
      () =>
        this.#settlePosition({
          position,
          reason: command.reason ?? "manual",
          execution: command.execution,
          triggeredAtMark: null,
          nowMs: command.nowMs,
        }),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Internal
  // ────────────────────────────────────────────────────────────────

  #run<T>(
    kind: TradeCommandKind,
    commandId: string,
    accountId: string,
    nowMs: number,
    execute: (duplicate: boolean) => T,
  ): T {
    if (commandId.trim() === "") {
      throw new ValidationError("commandId wajib diisi");
    }
    return this.#conn.transaction(() => {
      const claim = this.#commands.claim({ commandId, kind, accountId, tsMs: nowMs });
      if (!claim.claimed) {
        if (claim.conflict) {
          throw new IdempotencyConflictError(
            `commandId ${commandId} sudah dipakai dengan payload berbeda`,
          );
        }
        // Perintah ini sudah pernah dijalankan. Untuk process_mark, kembalikan
        // valuasi terkini tanpa efek baru; efek ekonomi sudah idempoten di
        // tingkat ledger/posisi.
        return execute(true);
      }
      this.#activeCommandId = commandId;
      try {
        return execute(false);
      } finally {
        this.#activeCommandId = null;
      }
    });
  }

  // ── outbox ─────────────────────────────────────────────────────

  #emit(
    accountId: string,
    type: DomainEventType,
    aggregateType: AggregateType,
    aggregateId: string | null,
    data: Record<string, unknown>,
    tsMs: number,
  ): void {
    this.#events.append({
      accountId,
      type,
      aggregateType,
      aggregateId,
      commandId: this.#activeCommandId,
      data,
      tsMs,
    });
  }

  /** Ledger append + event outbox `ledger.created`. */
  #ledgerPost(input: Parameters<LedgerRepository["append"]>[0]): ReturnType<LedgerRepository["append"]> {
    const appended = this.#ledger.append(input);
    if (!appended.duplicate) {
      this.#emit(
        input.accountId,
        "ledger.created",
        "ledger",
        String(appended.entry.seq),
        { ledgerSeq: appended.entry.seq, type: input.type, amount: appended.entry.amount.toString() },
        input.tsMs,
      );
    }
    return appended;
  }

  #spec(position: PositionRecord): ReturnType<ContractRepository["require"]> {
    return this.#contracts.require(position.contract);
  }

  /**
   * Penutupan paksa. WAJIB dipanggil di dalam transaksi yang sudah aktif.
   *
   * Urutan efek (semua dalam satu transaksi):
   *   fill → pnl_realized → (liquidation_loss bila defisit) → fee → margin_release
   *   → position close event
   */
  #settlePosition(input: {
    position: PositionRecord;
    reason: ForcedCloseReason;
    execution: ExecutionQuote;
    triggeredAtMark: Decimal | null;
    nowMs: number;
  }): SettlementAction {
    const { position, reason, execution, nowMs } = input;
    if (position.status !== "open" || position.size <= 0) {
      throw new ValidationError(
        `Posisi ${position.id} berstatus ${position.status} tidak bisa ditutup paksa`,
      );
    }

    const spec = this.#spec(position);
    const executionPrice = assertExecutablePrice(
      executionPriceFor(position.direction, execution),
      "Harga eksekusi penutupan",
    );

    // Penutupan paksa selalu mengambil likuiditas.
    const { fee } = feeFor(spec, position.size, executionPrice, "taker");

    const settlement = settleIsolatedClose({
      spec,
      direction: position.direction,
      size: position.size,
      entryPrice: position.entryPrice,
      exitPrice: executionPrice,
      initialMargin: position.initialMargin,
    });

    const fillId = this.#newFillId();
    const side = closingSide(position.direction);
    const isLiquidation = reason === "liquidation";
    const isTpSl = reason === "take_profit" || reason === "stop_loss";

    this.#fills.append({
      id: fillId,
      orderId: null,
      positionId: position.id,
      contract: position.contract,
      side,
      size: position.size,
      price: executionPrice,
      liquidity: "taker",
      fee,
      feeRate: new Decimal(0),
      realizedPnl: settlement.realizedPnl,
      isLiquidation,
      isTpSl,
      tsMs: nowMs,
    });

    this.#emit(
      position.accountId,
      "fill.created",
      "fill",
      fillId,
      {
        orderId: null,
        positionId: position.id,
        contract: position.contract,
        side,
        size: String(position.size),
        price: executionPrice.toFixed(),
        liquidity: "taker",
        fee: fee.toFixed(8),
        realizedPnl: settlement.realizedPnl.toFixed(8),
        reason,
      },
      nowMs,
    );

    // PnL realisasi sebenarnya dibebankan ke kas.
    this.#ledgerPost({
      accountId: position.accountId,
      tsMs: nowMs,
      type: "pnl_realized",
      amount: settlement.realizedPnl,
      refType: "fill",
      refId: fillId,
      idempotencyKey: settlementIdempotencyKey(reason, position.id, "pnl"),
      meta: { positionId: position.id, reason, executionPrice: executionPrice.toString() },
    });

    // Defisit yang melebihi kolateral isolated diampuni simulator, tetapi TIDAK
    // dihapus: dicatat sebagai entri ledger eksplisit agar
    // Σ ledger.amount = wallet_balance tetap terjaga dan defisit tetap terlihat.
    if (settlement.deficit.greaterThan(0)) {
      this.#ledgerPost({
        accountId: position.accountId,
        tsMs: nowMs,
        type: "liquidation_loss",
        amount: settlement.deficit,
        refType: "position",
        refId: position.id,
        idempotencyKey: settlementIdempotencyKey(reason, position.id, "deficit"),
        meta: {
          positionId: position.id,
          reason,
          deficit: settlement.deficit.toString(),
          absorbedBy: "simulator",
          note: "kerugian melebihi kolateral isolated; diampuni simulator dan dicatat sebagai defisit",
        },
      });
    }

    this.#ledgerPost({
      accountId: position.accountId,
      tsMs: nowMs,
      type: "fee",
      amount: fee.negated(),
      refType: "fill",
      refId: fillId,
      idempotencyKey: settlementIdempotencyKey(reason, position.id, "fee"),
      meta: { positionId: position.id, reason, liquidity: "taker" },
    });

    this.#ledgerPost({
      accountId: position.accountId,
      tsMs: nowMs,
      type: "margin_release",
      marginDelta: settlement.releasedMargin.negated(),
      refType: "position",
      refId: position.id,
      idempotencyKey: settlementIdempotencyKey(reason, position.id, "margin-release"),
      meta: { positionId: position.id, reason },
    });

    this.#positions.applyClose({
      positionId: position.id,
      realizedPnl: settlement.realizedPnl,
      fee,
      releasedMargin: settlement.releasedMargin,
      closeReason: reason,
      tsMs: nowMs,
      detail: {
        fillId,
        executionPrice: executionPrice.toString(),
        triggeredAtMark: input.triggeredAtMark === null ? null : input.triggeredAtMark.toString(),
        deficit: settlement.deficit.toString(),
        insolvent: settlement.insolvent,
        pnlAppliedToWallet: settlement.pnlAppliedToWallet.toString(),
      },
    });

    this.#emit(
      position.accountId,
      isLiquidation ? "position.liquidated" : "position.closed",
      "position",
      position.id,
      {
        contract: position.contract,
        reason,
        closedSize: String(position.size),
        executionPrice: executionPrice.toFixed(),
        triggeredAtMark: input.triggeredAtMark === null ? null : input.triggeredAtMark.toFixed(),
        realizedPnl: settlement.realizedPnl.toFixed(8),
        deficit: settlement.deficit.toFixed(8),
        insolvent: settlement.insolvent,
      },
      nowMs,
    );

    return {
      positionId: position.id,
      reason,
      fillId,
      closedSize: position.size,
      triggeredAtMark: input.triggeredAtMark,
      executionPrice,
      realizedPnl: settlement.realizedPnl,
      pnlAppliedToWallet: settlement.pnlAppliedToWallet,
      deficit: settlement.deficit,
      insolvent: settlement.insolvent,
      fee,
      releasedMargin: settlement.releasedMargin,
    };
  }

  /** Penerapan funding. Idempoten lewat idempotency key ledger. */
  #applyFunding(input: {
    position: PositionRecord;
    rate: string;
    fundingTimestampMs: number;
    markPrice: Decimal;
    nowMs: number;
  }): FundingApplication {
    const { position } = input;
    const spec = this.#spec(position);
    const amount = fundingPaymentAtMark({
      spec,
      direction: position.direction,
      size: position.size,
      markPrice: input.markPrice,
      rate: input.rate,
    });
    const key = fundingIdempotencyKey(spec.contract, input.fundingTimestampMs, position.id);

    // Positif = trader membayar → kas berkurang, jadi amount ledger = −amount.
    const result = this.#ledgerPost({
      accountId: position.accountId,
      tsMs: input.nowMs,
      type: "funding",
      amount: amount.negated(),
      refType: "funding_tick",
      refId: position.id,
      idempotencyKey: key,
      meta: {
        contract: spec.contract,
        positionId: position.id,
        fundingTimestampMs: input.fundingTimestampMs,
        fundingRate: input.rate,
        markPrice: input.markPrice.toString(),
        direction: position.direction,
      },
    });

    if (!result.duplicate) {
      this.#emit(
        position.accountId,
        "funding.applied",
        "position",
        position.id,
        {
          contract: spec.contract,
          fundingTimestamp: input.fundingTimestampMs,
          fundingRate: input.rate,
          markPrice: input.markPrice.toFixed(),
          amount: amount.toFixed(8),
          direction: position.direction,
        },
        input.nowMs,
      );
    }

    return {
      positionId: position.id,
      fundingTimestampMs: input.fundingTimestampMs,
      rate: new Decimal(input.rate),
      markPrice: input.markPrice,
      amount,
      ledgerKey: key,
      applied: !result.duplicate,
    };
  }

  /**
   * Nilai akun untuk kontrak ini. Untuk kontrak lain yang tidak punya mark pada
   * snapshot ini, margin posisinya tetap dihitung tetapi PnL-nya tidak
   * disertakan — dan itu dilaporkan eksplisit lewat `unvaluedContracts`.
   */
  #accountValuation(
    accountId: string,
    contract: string,
    markPrice: Decimal,
    stale: boolean,
  ): AccountValuation {
    const balances = this.#ledger.balances(accountId);
    const positions = this.#positions.listOpen(accountId);
    const valued = positions
      .filter((position) => position.contract === contract)
      .map((position) =>
        valuatePosition({
          spec: this.#spec(position),
          position,
          markPrice: stale ? position.entryPrice : markPrice,
        }),
      );
    const unrealized = totalUnrealized(valued);
    return deriveAccount(
      {
        walletBalance: balances.walletBalance,
        usedMargin: balances.usedMargin,
        reservedMargin: balances.reservedMargin,
      },
      unrealized,
    );
  }

  /**
   * Valuasi akun penuh dari beberapa mark price eksplisit (satu per kontrak).
   * Dipakai untuk akun multi-posisi; posisi tanpa mark dilaporkan sebagai
   * `unvaluedContracts` dan PnL-nya TIDAK ditebak.
   */
  evaluateAccount(input: {
    accountId: string;
    marks: ReadonlyMap<string, Decimal.Value>;
  }): {
    valuations: PositionValuation[];
    unvaluedContracts: string[];
    account: AccountValuation;
  } {
    this.#accounts.require(input.accountId);
    const balances = this.#ledger.balances(input.accountId);
    const positions = this.#positions.listOpen(input.accountId);

    const valuations: PositionValuation[] = [];
    const unvaluedContracts: string[] = [];

    for (const position of positions) {
      const mark = input.marks.get(position.contract);
      if (mark === undefined) {
        unvaluedContracts.push(position.contract);
        continue;
      }
      valuations.push(valuatePosition({ spec: this.#spec(position), position, markPrice: mark }));
    }

    return {
      valuations,
      unvaluedContracts,
      account: deriveAccount(
        {
          walletBalance: balances.walletBalance,
          usedMargin: balances.usedMargin,
          reservedMargin: balances.reservedMargin,
        },
        totalUnrealized(valuations),
      ),
    };
  }

  /**
   * Proyeksi valuasi satu posisi untuk API (mark price diberikan pemanggil dari
   * provider milik server). Aritmetika tetap di core; ini hanya pengambilan spec.
   */
  valuatePositionForApi(input: {
    position: PositionRecord;
    markPrice: Decimal.Value;
  }): {
    markPrice: Decimal;
    unrealizedPnl: Decimal;
    maintenanceMargin: Decimal;
    liquidationPrice: Decimal | null;
    liquidationState: string;
  } {
    const valuation = valuatePosition({
      spec: this.#spec(input.position),
      position: input.position,
      markPrice: input.markPrice,
    });
    return {
      markPrice: valuation.markPrice,
      unrealizedPnl: valuation.unrealizedPnl,
      maintenanceMargin: valuation.maintenanceMargin,
      liquidationPrice: valuation.liquidationPrice,
      liquidationState: valuation.liquidationState,
    };
  }

  /** Nilai akun tanpa mark (PnL = 0) — dipakai untuk pemeriksaan kas saja. */
  cashValuation(accountId: string): AccountValuation {
    this.#accounts.require(accountId);
    const balances = this.#ledger.balances(accountId);
    return deriveAccount(
      {
        walletBalance: balances.walletBalance,
        usedMargin: balances.usedMargin,
        reservedMargin: balances.reservedMargin,
      },
      ZERO,
    );
  }
}
