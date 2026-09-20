import {
  assertValidLeverage,
  assertValidSize,
  Decimal,
  canCancel,
  deriveAccount,
  directionForSide,
  eligibleLevels,
  feeFor,
  initialMarginFor,
  InvalidOrderError,
  isImmediate,
  planLevelConsumption,
  planPositionTransition,
  reduceOnlySize,
  reservationFor,
  restsOnBook,
  roundMarginReleaseDown,
  type BookSnapshot,
  type ContractSpec,
  type LevelTake,
  type Liquidity,
  type OrderIntent,
  type OrderSide,
  type OrderStatus,
  type PositionSnapshot,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { IdempotencyConflictError, ValidationError } from "../db/errors.js";
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
import { OrderRepository, type OrderRecord } from "../repositories/order-repository.js";
import { PositionRepository, type PositionRecord } from "../repositories/position-repository.js";
import { newId } from "../repositories/ids.js";
import { fingerprint } from "./account-service.js";
import { canonicalContractSize } from "@crypastra/core";

const ZERO = new Decimal(0);

/**
 * OrderService — batas aplikasi Phase 3.
 *
 * Semua efek ekonomi satu perintah (order, fill, posisi, event, ledger, cache
 * saldo) commit dalam SATU transaksi BEGIN IMMEDIATE. Kegagalan di titik mana
 * pun menggulung semuanya.
 *
 * Service ini ORIGIN-AGNOSTIC. `OrderIntent` tidak punya field asal. Label
 * `auditSource` hanya disimpan untuk observability dan TIDAK PERNAH dibaca
 * logika ekonomi mana pun (dibuktikan tests/phase3-origin-agnostic.test.ts).
 */

export interface IdFactory {
  (): string;
}

export interface SubmitOrderCommand {
  readonly commandId: string;
  readonly accountId: string;
  readonly intent: OrderIntent;
  /** Snapshot buku lawan yang eksplisit. Tidak ada likuiditas yang dikarang. */
  readonly book: BookSnapshot;
  readonly nowMs: number;
  /** Observability saja. Tidak memengaruhi ekonomi. */
  readonly auditSource?: string;
}

export interface EvaluateOrderCommand {
  readonly commandId: string;
  readonly orderId: string;
  readonly book: BookSnapshot;
  readonly nowMs: number;
}

export interface CancelOrderCommand {
  readonly commandId: string;
  readonly orderId: string;
  readonly nowMs: number;
  readonly reason?: string;
}

export interface FillResult {
  readonly fillId: string;
  readonly size: number;
  readonly price: Decimal;
  readonly liquidity: Liquidity;
  readonly fee: Decimal;
  readonly realizedPnl: Decimal;
}

export interface OrderResult {
  readonly order: OrderRecord;
  readonly fills: readonly FillResult[];
  readonly position: PositionRecord | null;
  /** true = perintah ini pernah dijalankan; tidak ada efek ekonomi baru. */
  readonly duplicate: boolean;
}

export interface OrderServiceDeps {
  readonly connection: DatabaseConnection;
  readonly orderIdFactory?: IdFactory;
  readonly fillIdFactory?: IdFactory;
  readonly positionIdFactory?: IdFactory;
}

interface PlannedFill {
  readonly size: number;
  readonly price: Decimal;
  readonly liquidity: Liquidity;
  readonly fee: Decimal;
  readonly feeRate: Decimal;
  readonly realizedPnl: Decimal;
  readonly openedMargin: Decimal;
  readonly releasedPositionMargin: Decimal;
  /** Porsi reservasi order yang dikonversi menjadi margin posisi. */
  readonly reservedConsumed: Decimal;
  readonly kind: string;
}

interface ExecutionPlan {
  readonly fills: readonly PlannedFill[];
  readonly totalFilled: number;
  /** Margin bersih baru yang perlu dikunci dari kas (>= 0). */
  readonly netNewMargin: Decimal;
}

export class OrderService {
  readonly #conn: DatabaseConnection;
  readonly #orders: OrderRepository;
  readonly #fills: FillRepository;
  readonly #positions: PositionRepository;
  readonly #accounts: AccountRepository;
  readonly #ledger: LedgerRepository;
  readonly #contracts: ContractRepository;
  readonly #commands: CommandRepository;
  readonly #events: DomainEventRepository;
  /**
   * commandId perintah yang sedang berjalan. Dipakai HANYA untuk menandai event
   * outbox dengan perintah asalnya. Instance ini sinkron dan satu transaksi per
   * perintah, jadi tidak ada percampuran antar perintah.
   */
  #activeCommandId: string | null = null;
  readonly #newOrderId: IdFactory;
  readonly #newFillId: IdFactory;
  readonly #newPositionId: IdFactory;

  constructor(deps: OrderServiceDeps) {
    this.#conn = deps.connection;
    this.#orders = new OrderRepository(deps.connection);
    this.#fills = new FillRepository(deps.connection);
    this.#positions = new PositionRepository(deps.connection);
    this.#accounts = new AccountRepository(deps.connection);
    this.#ledger = new LedgerRepository(deps.connection);
    this.#contracts = new ContractRepository(deps.connection);
    this.#commands = new CommandRepository(deps.connection);
    this.#events = new DomainEventRepository(deps.connection);
    this.#newOrderId = deps.orderIdFactory ?? newId;
    this.#newFillId = deps.fillIdFactory ?? newId;
    this.#newPositionId = deps.positionIdFactory ?? newId;
  }

  // ────────────────────────────────────────────────────────────────
  // SUBMIT
  // ────────────────────────────────────────────────────────────────

  submitOrder(command: SubmitOrderCommand): OrderResult {
    return this.#runCommand(
      "submit_order",
      command.commandId,
      command.accountId,
      command.nowMs,
      () => this.#executeSubmit(command),
      undefined,
      // Identitas perintah = intent ekonomi yang sudah dinormalkan + akun.
      // Buku pasar TIDAK ikut: ia keadaan ambien, bukan bagian dari perintah,
      // sehingga retry di bawah data pasar yang bergerak tidak dianggap konflik.
      orderCommandFingerprint(command.accountId, command.intent),
    );
  }

  #executeSubmit(command: SubmitOrderCommand): OrderResult {
    const { intent, nowMs, accountId } = command;
    const spec = this.#contracts.require(intent.contract);
    this.#accounts.require(accountId);

    const orderId = this.#newOrderId();
    const source = command.auditSource ?? "unspecified";

    // Order dibuat lebih dulu (status `created`) supaya penolakan pun terekam
    // untuk audit. Penolakan TIDAK menghasilkan efek ekonomi apa pun: tidak ada
    // fill, posisi, fee, margin lock, atau perubahan saldo.
    const created = this.#orders.insert({
      id: orderId,
      accountId,
      contract: spec.contract,
      intent,
      source,
      tsMs: nowMs,
    });
    this.#commands.attachOrder(command.commandId, orderId);
    this.#emit(
      accountId,
      "order.created",
      "order",
      orderId,
      {
        contract: created.contract,
        side: created.side,
        type: created.type,
        size: String(created.size),
        leverage: created.leverage.toFixed(),
        timeInForce: created.timeInForce,
        reduceOnly: created.reduceOnly,
      },
      nowMs,
    );

    const rejection = this.#validateIntent(spec, accountId, intent);
    if (rejection !== null) {
      this.#reject(orderId, rejection, nowMs);
      return this.#resultOf(orderId, false);
    }
    this.#setStatus({ orderId, to: "validated", tsMs: nowMs });

    const resting = restsOnBook(intent.type, intent.timeInForce);
    const crossing = this.#crosses(intent, command.book);

    // post_only dilarang mengambil likuiditas: bila ia akan langsung
    // tereksekusi, order ditolak tanpa efek ekonomi apa pun.
    if (resting && crossing && intent.timeInForce === "post_only") {
      this.#reject(orderId, "post_only akan langsung tereksekusi", nowMs);
      return this.#resultOf(orderId, false);
    }

    // Limit yang tidak menyentuh buku: resting, reservasi margin, tanpa fill.
    if (resting && !crossing) {
      const reservation = reservationFor(spec, intent.size, intent.price!, intent.leverage);
      const available = this.#available(accountId);
      if (reservation.greaterThan(available)) {
        this.#reject(
          orderId,
          `Margin tidak cukup: butuh ${reservation.toFixed(8)}, tersedia ${available.toFixed(8)}`,
          nowMs,
        );
        return this.#resultOf(orderId, false);
      }
      this.#orders.setReservedMargin({ orderId, reservedMargin: reservation, tsMs: nowMs });
      this.#ledgerPost({
        accountId,
        tsMs: nowMs,
        type: "margin_lock",
        reservedDelta: reservation,
        refType: "order",
        refId: orderId,
        idempotencyKey: `order:${orderId}:reserve`,
        meta: { orderId, kind: "reserve" },
      });
      this.#setStatus({
        orderId,
        to: "open",
        tsMs: nowMs,
        detail: { reservedMargin: reservation.toFixed(8) },
      });
      return this.#resultOf(orderId, false);
    }

    return this.#executeAgainstBook({ orderId, spec, accountId, intent, book: command.book, nowMs, isNewOrder: true });
  }

  // ────────────────────────────────────────────────────────────────
  // EVALUATE (resting order terhadap snapshot baru)
  // ────────────────────────────────────────────────────────────────

  evaluateOrder(command: EvaluateOrderCommand): OrderResult {
    return this.#runCommand(
      "evaluate_order",
      command.commandId,
      this.#orders.require(command.orderId).accountId,
      command.nowMs,
      () => {
        const order = this.#orders.require(command.orderId);
        if (!canCancel(order)) {
          throw new InvalidOrderError(`Order ${order.id} berstatus ${order.status} tidak bisa dievaluasi`);
        }
        const spec = this.#contracts.require(order.contract);
        const remaining = order.size - order.filledSize;
        if (remaining <= 0) {
          throw new InvalidOrderError(`Order ${order.id} tidak punya sisa ukuran`);
        }
        return this.#executeAgainstBook({
          orderId: order.id,
          spec,
          accountId: order.accountId,
          intent: { ...intentFromOrder(order), size: remaining },
          book: command.book,
          nowMs: command.nowMs,
          isNewOrder: false,
        });
      },
      command.orderId,
      fingerprint({ op: "evaluate_order", orderId: command.orderId, bidPrice: command.book.bids[0]?.price ?? null, askPrice: command.book.asks[0]?.price ?? null }),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // CANCEL
  // ────────────────────────────────────────────────────────────────

  cancelOrder(command: CancelOrderCommand): OrderResult {
    return this.#runCommand(
      "cancel_order",
      command.commandId,
      this.#orders.require(command.orderId).accountId,
      command.nowMs,
      () => {
        const order = this.#orders.require(command.orderId);
        if (!canCancel(order)) {
          throw new InvalidOrderError(`Order ${order.id} berstatus ${order.status} tidak bisa dibatalkan`);
        }
        this.#releaseReservation(order, command.nowMs, "cancel");
        this.#setStatus({
          orderId: order.id,
          to: "cancelled",
          tsMs: command.nowMs,
          detail: { reason: command.reason ?? "user_cancel" },
        });
        return this.#resultOf(order.id, false);
      },
      command.orderId,
      fingerprint({ op: "cancel_order", orderId: command.orderId, reason: command.reason ?? null }),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Eksekusi terhadap buku (dry-run lalu apply, satu transaksi)
  // ────────────────────────────────────────────────────────────────

  #executeAgainstBook(input: {
    orderId: string;
    spec: ContractSpec;
    accountId: string;
    intent: OrderIntent;
    book: BookSnapshot;
    nowMs: number;
    isNewOrder: boolean;
  }): OrderResult {
    const { orderId, spec, accountId, intent, book, nowMs } = input;
    const order = this.#orders.require(orderId);

    const levels = intent.side === "buy" ? book.asks : book.bids;
    const eligible = eligibleLevels(intent.side, levels, intent.price);

    const existing = this.#positions.findOpen(accountId, spec.contract);
    let requested = intent.size;
    if (intent.reduceOnly) {
      if (existing === null || existing.size === 0) {
        throw new InvalidOrderError("Order reduce_only tanpa posisi terbuka");
      }
      const closable = reduceOnlySize({
        spec,
        existing: snapshotOf(existing),
        fillSide: intent.side,
        requestedSize: requested,
      });
      if (closable <= 0) {
        throw new InvalidOrderError("Order reduce_only searah posisi (akan menambah eksposur)");
      }
      requested = closable;
    }

    const consumption = planLevelConsumption(requested, eligible);
    // Order baru selalu mengambil likuiditas (taker). Order yang sudah resting
    // dan baru terisi dari snapshot berikutnya adalah maker.
    const liquidity: Liquidity = input.isNewOrder ? "taker" : "maker";

    // FOK: seluruhnya atau tidak sama sekali.
    if (intent.timeInForce === "fok" && consumption.filledSize < requested) {
      this.#setStatus({
        orderId,
        to: "cancelled",
        tsMs: nowMs,
        detail: { reason: "fok_unfillable", requested, filled: consumption.filledSize },
      });
      return this.#resultOf(orderId, false);
    }

    const plan = this.#planExecution({
      spec,
      accountId,
      side: intent.side,
      leverage: intent.leverage,
      takes: consumption.takes,
      liquidity,
      order,
      isNewOrder: input.isNewOrder,
    });

    // Risk gate: margin baru tidak boleh melebihi saldo tersedia. Diperiksa
    // SEBELUM efek apa pun, jadi penolakan tidak meninggalkan jejak ekonomi.
    if (plan.netNewMargin.greaterThan(this.#available(accountId))) {
      this.#reject(
        orderId,
        `Margin tidak cukup: butuh ${plan.netNewMargin.toFixed(8)}, tersedia ${this.#available(accountId).toFixed(8)}`,
        nowMs,
      );
      return this.#resultOf(orderId, false);
    }

    const fillResults = this.#applyPlan({
      orderId,
      spec,
      accountId,
      side: intent.side,
      leverage: intent.leverage,
      plan,
      nowMs,
      // TP/SL dari intent dipindahkan ke posisi saat dibuka/di-flip.
      protection: {
        tpPrice: intent.tpPrice === null ? null : new Decimal(intent.tpPrice),
        slPrice: intent.slPrice === null ? null : new Decimal(intent.slPrice),
      },
    });

    const afterFills = this.#orders.require(orderId);
    // Status dihitung dari TOTAL filled order, bukan hanya fill pada panggilan ini.
    const newStatus = this.#orders.statusAfterFilled({ orderId, filledSize: afterFills.filledSize });

    // Sisa order immediate dibatalkan; reservasi (bila ada) dilepas untuk sisa.
    if (isImmediate(intent.type, intent.timeInForce) && afterFills.filledSize < order.size) {
      this.#releaseReservation(afterFills, nowMs, "ioc_remainder");
    }

    this.#setStatus({ orderId, to: newStatus, tsMs: nowMs, detail: { filledTotal: fillResults.reduce((sum, fill) => sum + fill.size, 0) } });

    return this.#resultOf(orderId, false, fillResults);
  }

  /** Dry run: rencanakan fill beserta efek margin, tanpa menulis apa pun. */
  #planExecution(input: {
    spec: ContractSpec;
    accountId: string;
    side: OrderSide;
    leverage: string;
    takes: readonly LevelTake[];
    liquidity: Liquidity;
    order: OrderRecord;
    isNewOrder: boolean;
  }): ExecutionPlan {
    const { spec, accountId, side, takes, liquidity } = input;

    const existing = this.#positions.findOpen(accountId, spec.contract);
    let simulated: PositionSnapshot | null = existing === null ? null : snapshotOf(existing);

    // Reservasi yang masih tersedia untuk order ini.
    let remainingReservation = input.order.reservedMargin;
    let remainingOrderSize = input.order.size - input.order.filledSize;

    const fills: PlannedFill[] = [];
    let netNewMargin = ZERO;

    for (const take of takes) {
      const { fee, rate } = feeFor(spec, take.size, take.price, liquidity);
      const transition = planPositionTransition({
        spec,
        leverage: input.leverage,
        existing: simulated,
        fillSide: side,
        fillSize: take.size,
        fillPrice: take.price,
      });

      // Porsi reservasi yang dikonversi: proporsional terhadap sisa ukuran,
      // dan SELURUHNYA saat fill ini menghabiskan sisa order.
      const consumesAll = take.size >= remainingOrderSize;
      const reservedConsumed = consumesAll
        ? remainingReservation
        : roundMarginReleaseDown(
            remainingReservation.times(take.size).div(new Decimal(remainingOrderSize)),
          );

      // Margin bersih baru = margin eksposur baru − reservasi yang dikonversi
      // − margin posisi lama yang dilepas.
      const opened = transition.openedMargin;
      const released = transition.releasedMargin;
      netNewMargin = netNewMargin.plus(opened).minus(reservedConsumed).minus(released);

      remainingReservation = remainingReservation.minus(reservedConsumed);
      remainingOrderSize -= take.size;

      fills.push({
        size: take.size,
        price: take.price,
        liquidity,
        fee,
        feeRate: rate,
        realizedPnl: transition.realizedPnl,
        openedMargin: opened,
        releasedPositionMargin: released,
        reservedConsumed,
        kind: transition.kind,
      });

      simulated =
        transition.result === null
          ? null
          : { ...transition.result, leverage: new Decimal(input.leverage) };
    }

    return { fills, totalFilled: fills.reduce((sum, fill) => sum + fill.size, 0), netNewMargin };
  }

  /** Terapkan rencana: fill, reservasi→margin, posisi, PnL, fee. */
  #applyPlan(input: {
    orderId: string;
    spec: ContractSpec;
    accountId: string;
    side: OrderSide;
    leverage: string;
    plan: ExecutionPlan;
    nowMs: number;
    protection: { tpPrice: Decimal | null; slPrice: Decimal | null };
  }): FillResult[] {
    const { orderId, spec, accountId, side, leverage, nowMs } = input;
    const results: FillResult[] = [];
    // Reservasi order berkurang seiring porsi yang dikonversi menjadi margin posisi.
    let reservedRemaining = this.#orders.require(orderId).reservedMargin;

    for (const planned of input.plan.fills) {
      const fillId = this.#newFillId();
      const existing = this.#positions.findOpen(accountId, spec.contract);

      // 1) Fill (append-only) + event publik
      this.#fills.append({
        id: fillId,
        orderId,
        positionId: existing?.id ?? null,
        contract: spec.contract,
        side,
        size: planned.size,
        price: planned.price,
        liquidity: planned.liquidity,
        fee: planned.fee,
        feeRate: planned.feeRate,
        realizedPnl: planned.realizedPnl,
        tsMs: nowMs,
      });

      this.#emit(
        accountId,
        "fill.created",
        "fill",
        fillId,
        {
          orderId,
          contract: spec.contract,
          side,
          size: String(planned.size),
          price: planned.price.toFixed(),
          liquidity: planned.liquidity,
          fee: planned.fee.toFixed(8),
          realizedPnl: planned.realizedPnl.toFixed(8),
        },
        nowMs,
      );

      // 2) Reservasi → margin posisi dalam SATU entri ledger.
      //    reservedDelta negatif (melepas reservasi), marginDelta positif
      //    (mengunci sebagai margin posisi). `amount` = 0, jadi wallet tidak
      //    tersentuh dan invariant Σamount = wallet_balance tetap terjaga.
      if (planned.reservedConsumed.greaterThan(0)) {
        this.#ledgerPost({
          accountId,
          tsMs: nowMs,
          type: "margin_release",
          reservedDelta: planned.reservedConsumed.negated(),
          marginDelta: planned.openedMargin,
          refType: "fill",
          refId: fillId,
          idempotencyKey: `fill:${fillId}:reserve-to-margin`,
          meta: { orderId, fillId, kind: "reserve_to_position_margin" },
        });
      } else if (planned.openedMargin.greaterThan(0)) {
        this.#ledgerPost({
          accountId,
          tsMs: nowMs,
          type: "margin_lock",
          marginDelta: planned.openedMargin,
          refType: "fill",
          refId: fillId,
          idempotencyKey: `fill:${fillId}:margin`,
          meta: { orderId, fillId },
        });
      }

      // Reservasi order yang dikonsumsi dibukukan di sini supaya
      // orders.reserved_margin selalu cocok dengan cache akun.
      if (planned.reservedConsumed.greaterThan(0)) {
        reservedRemaining = reservedRemaining.minus(planned.reservedConsumed);
        this.#orders.setReservedMargin({
          orderId,
          reservedMargin: Decimal.max(reservedRemaining, ZERO),
          tsMs: nowMs,
        });
      }

      // 3) Posisi
      const positionId = this.#applyPositionTransition({
        spec,
        accountId,
        side,
        leverage,
        existing,
        planned,
        fillId,
        nowMs,
        protection: input.protection,
      });
      if (positionId !== null) {
        this.#fills.setPositionId(fillId, positionId);
        const kind = planned.kind;
        const positionEvent: DomainEventType =
          kind === "open"
            ? "position.opened"
            : kind === "close"
              ? "position.closed"
              : "position.updated";
        const resulting = this.#positions.findOpen(accountId, spec.contract);
        this.#emit(
          accountId,
          positionEvent,
          "position",
          positionId,
          {
            contract: spec.contract,
            transition: kind,
            closedSize: String(transitionSize(planned.size, kind, "closed")),
            size: resulting === null ? "0" : String(resulting.size),
            entryPrice: resulting === null ? null : resulting.entryPrice.toFixed(),
            markPrice: planned.price.toFixed(),
            realizedPnl: planned.realizedPnl.toFixed(8),
          },
          nowMs,
        );
        if (kind === "flip") {
          // Flip = close + open; sisi open harus terlihat klien juga.
          this.#emit(
            accountId,
            "position.opened",
            "position",
            positionId,
            { contract: spec.contract, transition: "flip-open", size: resulting === null ? "0" : String(resulting.size) },
            nowMs,
          );
        }
      }

      // 4) PnL realisasi
      if (!planned.realizedPnl.isZero()) {
        this.#ledgerPost({
          accountId,
          tsMs: nowMs,
          type: "pnl_realized",
          amount: planned.realizedPnl,
          refType: "fill",
          refId: fillId,
          idempotencyKey: `fill:${fillId}:realized-pnl`,
          meta: { orderId, fillId },
        });
      }

      // 5) Fee. amount = −fee: biaya positif mengurangi kas, rebate menambah.
      this.#ledgerPost({
        accountId,
        tsMs: nowMs,
        type: "fee",
        amount: planned.fee.negated(),
        refType: "fill",
        refId: fillId,
        idempotencyKey: `fill:${fillId}:fee`,
        meta: { orderId, fillId, liquidity: planned.liquidity },
      });

      // 6) Margin posisi lama yang dilepas (reduce/close/flip)
      if (planned.releasedPositionMargin.greaterThan(0)) {
        this.#ledgerPost({
          accountId,
          tsMs: nowMs,
          type: "margin_release",
          marginDelta: planned.releasedPositionMargin.negated(),
          refType: "fill",
          refId: fillId,
          idempotencyKey: `fill:${fillId}:release-position-margin`,
          meta: { orderId, fillId },
        });
      }

      this.#orders.recordFill({
        orderId,
        fillSize: planned.size,
        fillPrice: planned.price,
        priceRound: spec.orderPriceRound,
        tsMs: nowMs,
        fillId,
      });

      results.push({
        fillId,
        size: planned.size,
        price: planned.price,
        liquidity: planned.liquidity,
        fee: planned.fee,
        realizedPnl: planned.realizedPnl,
      });
    }

    void input.plan;
    return results;
  }

  /** Tulis efek posisi dari satu fill terencana. Mengembalikan id posisi terkait. */
  #applyPositionTransition(input: {
    spec: ContractSpec;
    accountId: string;
    side: OrderSide;
    leverage: string;
    existing: PositionRecord | null;
    planned: PlannedFill;
    fillId: string;
    nowMs: number;
    protection: { tpPrice: Decimal | null; slPrice: Decimal | null };
  }): string | null {
    const { spec, accountId, side, leverage, existing, planned, fillId, nowMs } = input;

    // Hitung ulang transisi terhadap keadaan posisi saat ini (idempoten terhadap
    // urutan karena setiap fill diterapkan satu per satu).
    const transition = planPositionTransition({
      spec,
      leverage,
      existing: existing === null ? null : snapshotOf(existing),
      fillSide: side,
      fillSize: planned.size,
      fillPrice: planned.price,
    });
    const detail = { fillId, kind: transition.kind, closedSize: transition.closedSize, openedSize: transition.openedSize };

    if (transition.kind === "open") {
      const created = this.#positions.create({
        id: this.#newPositionId(),
        accountId,
        contract: spec.contract,
        direction: directionForSide(side),
        size: transition.result!.size,
        entryPrice: transition.result!.entryPrice,
        leverage: new Decimal(leverage),
        initialMargin: transition.result!.initialMargin,
        tpPrice: input.protection.tpPrice,
        slPrice: input.protection.slPrice,
        tsMs: nowMs,
      });
      return created.id;
    }

    if (existing === null) {
      throw new InvalidOrderError("Rencana posisi non-open tanpa posisi lama");
    }

    if (transition.kind === "increase") {
      this.#positions.applyIncrease({
        positionId: existing.id,
        newSize: transition.result!.size,
        newEntryPrice: transition.result!.entryPrice,
        newInitialMargin: transition.result!.initialMargin,
        addedMargin: transition.openedMargin,
        fee: ZERO,
        tsMs: nowMs,
        detail,
      });
      return existing.id;
    }

    if (transition.kind === "reduce") {
      this.#positions.applyReduce({
        positionId: existing.id,
        newSize: transition.result!.size,
        newInitialMargin: transition.result!.initialMargin,
        releasedMargin: transition.releasedMargin,
        realizedPnl: transition.realizedPnl,
        fee: ZERO,
        tsMs: nowMs,
        detail,
      });
      return existing.id;
    }

    if (transition.kind === "close") {
      this.#positions.applyClose({
        positionId: existing.id,
        realizedPnl: transition.realizedPnl,
        fee: ZERO,
        releasedMargin: transition.releasedMargin,
        closeReason: "order",
        tsMs: nowMs,
        detail,
      });
      return existing.id;
    }

    // flip
    this.#positions.applyClose({
      positionId: existing.id,
      realizedPnl: transition.realizedPnl,
      fee: ZERO,
      releasedMargin: transition.releasedMargin,
      closeReason: "flip",
      tsMs: nowMs,
      detail,
    });
    const opened = this.#positions.create({
      id: this.#newPositionId(),
      accountId,
      contract: spec.contract,
      direction: transition.result!.direction,
      size: transition.result!.size,
      entryPrice: transition.result!.entryPrice,
      leverage: new Decimal(leverage),
      initialMargin: transition.result!.initialMargin,
      tpPrice: input.protection.tpPrice,
      slPrice: input.protection.slPrice,
      tsMs: nowMs,
    });
    return opened.id;
  }

  // ────────────────────────────────────────────────────────────────
  // Helper
  // ────────────────────────────────────────────────────────────────

  #runCommand(
    kind: TradeCommandKind,
    commandId: string,
    accountId: string,
    nowMs: number,
    execute: () => OrderResult,
    /** Order yang terkait, supaya retry bisa merekonstruksi hasilnya. */
    attachOrderId?: string,
    /** Sidik jari payload perintah; mendeteksi commandId sama + payload beda. */
    requestHash?: string,
  ): OrderResult {
    if (commandId.trim() === "") {
      throw new ValidationError("commandId wajib diisi");
    }
    return this.#conn.transaction(() => {
      const claim = this.#commands.claim({ commandId, kind, accountId, tsMs: nowMs, requestHash });
      if (!claim.claimed) {
        if (claim.conflict) {
          throw new IdempotencyConflictError(
            `commandId ${commandId} sudah dipakai dengan payload berbeda`,
          );
        }
        return this.#replay(claim.existing.orderId ?? attachOrderId ?? null);
      }
      // Ikat order sejak awal untuk perintah yang sudah tahu order-nya
      // (evaluate/cancel), sehingga retry dapat merekonstruksi hasil.
      if (attachOrderId !== undefined) {
        this.#commands.attachOrder(commandId, attachOrderId);
      }
      this.#activeCommandId = commandId;
      try {
        return execute();
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

  /** Ledger append + event outbox `ledger.created` untuk akun terkait. */
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

  /** setStatus + event outbox yang sesuai. */
  #setStatus(input: {
    orderId: string;
    to: OrderStatus;
    tsMs: number;
    reason?: string;
    detail?: Record<string, unknown>;
  }): OrderRecord {
    const before = this.#orders.require(input.orderId);
    const updated = this.#orders.setStatus(input);
    if (updated.status !== before.status) {
      const eventType: DomainEventType =
        updated.status === "filled"
          ? "order.filled"
          : updated.status === "cancelled"
            ? "order.cancelled"
            : "order.updated";
      this.#emit(
        updated.accountId,
        eventType,
        "order",
        updated.id,
        {
          status: updated.status,
          previousStatus: before.status,
          filledSize: String(updated.filledSize),
          remainingSize: String(updated.size - updated.filledSize),
          reason: input.reason ?? null,
        },
        input.tsMs,
      );
    }
    return updated;
  }

  /** Hasil untuk perintah yang sudah pernah dijalankan: baca ulang, tanpa efek baru. */
  #replay(orderId: string | null): OrderResult {
    if (orderId === null) {
      throw new ValidationError("Perintah ini sudah diproses sebelumnya tanpa menghasilkan order");
    }
    return this.#resultOf(orderId, true);
  }

  #resultOf(orderId: string, duplicate: boolean, fills?: readonly FillResult[]): OrderResult {
    const order = this.#orders.require(orderId);
    const fillResults =
      fills ??
      this.#fills.listByOrder(orderId).map((fill) => ({
        fillId: fill.id,
        size: fill.size,
        price: fill.price,
        liquidity: fill.liquidity,
        fee: fill.fee,
        realizedPnl: fill.realizedPnl,
      }));
    return {
      order,
      fills: fillResults,
      position: this.#positions.findOpen(order.accountId, order.contract),
      duplicate,
    };
  }

  #reject(orderId: string, reason: string, nowMs: number): void {
    this.#setStatus({ orderId, to: "rejected", tsMs: nowMs, reason });
  }

  #validateIntent(spec: ContractSpec, accountId: string, intent: OrderIntent): string | null {
    try {
      assertValidSize(spec, intent.size);
      assertValidLeverage(spec, intent.leverage);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (intent.type === "limit" && intent.price === null) {
      return "Order limit wajib punya harga";
    }
    if (intent.type === "market" && intent.price !== null) {
      return "Order market tidak boleh punya harga";
    }
    if (intent.reduceOnly) {
      const existing = this.#positions.findOpen(accountId, spec.contract);
      if (existing === null || existing.size === 0) {
        return "Order reduce_only tanpa posisi terbuka";
      }
      const closable = reduceOnlySize({
        spec,
        existing: snapshotOf(existing),
        fillSide: intent.side,
        requestedSize: intent.size,
      });
      if (closable <= 0) {
        return "Order reduce_only searah posisi (akan menambah eksposur)";
      }
    }
    return null;
  }

  /** Saldo tersedia menurut kontrak akuntansi (floor 8 dp). */
  #available(accountId: string): Decimal {
    const balances = this.#ledger.balances(accountId);
    return deriveAccount(
      {
        walletBalance: balances.walletBalance,
        usedMargin: balances.usedMargin,
        reservedMargin: balances.reservedMargin,
      },
      ZERO,
    ).availableBalance;
  }

  #crosses(intent: OrderIntent, book: BookSnapshot): boolean {
    const levels = intent.side === "buy" ? book.asks : book.bids;
    return eligibleLevels(intent.side, levels, intent.price).length > 0;
  }

  /** Lepas sisa reservasi order (cancel atau sisa IOC). Sekali per order+alasan. */
  #releaseReservation(order: OrderRecord, nowMs: number, reason: string): void {
    const remaining = order.reservedMargin;
    if (remaining.lessThanOrEqualTo(0)) {
      return;
    }
    this.#orders.setReservedMargin({ orderId: order.id, reservedMargin: ZERO, tsMs: nowMs });
    this.#ledgerPost({
      accountId: order.accountId,
      tsMs: nowMs,
      type: "margin_release",
      reservedDelta: remaining.negated(),
      refType: "order",
      refId: order.id,
      idempotencyKey: `order:${order.id}:release:${reason}`,
      meta: { orderId: order.id, reason },
    });
  }
}

/** Ukuran yang relevan untuk payload event (closed penuh = ukuran fill). */
function transitionSize(fillSize: number, kind: string, _field: string): number {
  return kind === "close" || kind === "reduce" || kind === "flip" ? fillSize : 0;
}

/**
 * Sidik jari perintah order: seluruh field intent yang dapat mengubah perilaku
 * ekonomi, dalam bentuk kanonik (string ternormalisasi, urutan kunci tetap).
 * Nilai desimal dibandingkan sebagai string ternormalisasi supaya `"1.0"` dan
 * `"1"` tidak dianggap berbeda.
 */
export function orderCommandFingerprint(accountId: string, intent: OrderIntent): string {
  return fingerprint({
    op: "submit_order",
    accountId,
    contract: intent.contract,
    side: intent.side,
    type: intent.type,
    // Bentuk kanonik: "1.50" dan "1.5" adalah perintah yang SAMA.
    size: canonicalContractSize(intent.size),
    price: normalizeDecimal(intent.price),
    leverage: normalizeDecimal(intent.leverage),
    timeInForce: intent.timeInForce,
    reduceOnly: intent.reduceOnly,
    tpPrice: normalizeDecimal(intent.tpPrice),
    slPrice: normalizeDecimal(intent.slPrice),
  });
}

function normalizeDecimal(value: string | null): string | null {
  return value === null ? null : new Decimal(value).toString();
}

function snapshotOf(position: PositionRecord): PositionSnapshot {
  return {
    direction: position.direction,
    size: position.size,
    entryPrice: position.entryPrice,
    initialMargin: position.initialMargin,
    leverage: position.leverage,
  };
}

function intentFromOrder(order: OrderRecord): OrderIntent {
  return {
    contract: order.contract,
    side: order.side,
    type: order.type,
    size: order.size,
    price: order.price === null ? null : order.price.toFixed(),
    leverage: order.leverage.toFixed(),
    timeInForce: order.timeInForce,
    reduceOnly: order.reduceOnly,
    tpPrice: order.tpPrice === null ? null : order.tpPrice.toFixed(),
    slPrice: order.slPrice === null ? null : order.slPrice.toFixed(),
  };
}

/** Margin awal untuk membuka eksposur baru (dipakai test & pemanggil luar). */
export function openingMargin(spec: ContractSpec, size: number, price: string, leverage: string): Decimal {
  return initialMarginFor({ spec, size, price, leverage });
}
