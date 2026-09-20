import {
  Decimal,
  deriveAccount,
  unrealizedPnlFor,
  type AccountValuation,
  type Clock,
  type ContractSpec,
} from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { IdempotencyConflictError, InsufficientFundsError, ValidationError } from "../db/errors.js";
import { AccountRepository, type AccountRecord } from "../repositories/account-repository.js";
import { CommandRepository, type TradeCommandKind } from "../repositories/command-repository.js";
import { ContractRepository } from "../repositories/contract-repository.js";
import { DomainEventRepository } from "../repositories/domain-event-repository.js";
import { LedgerRepository } from "../repositories/ledger-repository.js";
import { OrderRepository } from "../repositories/order-repository.js";
import { PositionRepository } from "../repositories/position-repository.js";
import { newId } from "../repositories/ids.js";

const ZERO = new Decimal(0);

/**
 * AccountService — operasi akun paper (ADR 0009).
 *
 * Semua mutasi kas masuk lewat ledger append-only. TIDAK ADA penghapusan atau
 * penulisan ulang riwayat ledger: "reset" direpresentasikan sebagai entri
 * `reset` bertanda yang diaudit, bukan pembersihan tabel.
 *
 * Idempotensi: setiap perintah membawa `commandId`, dan sidik jari payload
 * disimpan sehingga commandId sama + payload BERBEDA ditolak sebagai konflik.
 */

export interface AccountServiceDeps {
  readonly connection: DatabaseConnection;
  readonly clock: Clock;
  readonly accountIdFactory?: () => string;
}

export interface CommandOutcome<T> {
  readonly result: T;
  /** true = perintah ini sudah pernah dijalankan; tidak ada efek baru. */
  readonly duplicate: boolean;
}

export interface AccountSummary {
  readonly accountId: string;
  readonly name: string;
  readonly mode: string;
  readonly baseCurrency: string;
  readonly valuation: AccountValuation;
  readonly openPositionCount: number;
  readonly openOrderCount: number;
  readonly unvaluedContracts: readonly string[];
  readonly valuationStatus: "fresh" | "stale" | "partial" | "unvalued";
  /** Batas snapshot realtime: event dengan seq > nilai ini belum termasuk. */
  readonly latestEventSeq: number;
  readonly asOf: number;
}

export class AccountService {
  readonly #conn: DatabaseConnection;
  readonly #accounts: AccountRepository;
  readonly #ledger: LedgerRepository;
  readonly #positions: PositionRepository;
  readonly #orders: OrderRepository;
  readonly #contracts: ContractRepository;
  readonly #commands: CommandRepository;
  readonly #events: DomainEventRepository;
  readonly #clock: Clock;
  readonly #newAccountId: () => string;

  constructor(deps: AccountServiceDeps) {
    this.#conn = deps.connection;
    this.#accounts = new AccountRepository(deps.connection);
    this.#ledger = new LedgerRepository(deps.connection);
    this.#positions = new PositionRepository(deps.connection);
    this.#orders = new OrderRepository(deps.connection);
    this.#contracts = new ContractRepository(deps.connection);
    this.#commands = new CommandRepository(deps.connection);
    this.#events = new DomainEventRepository(deps.connection);
    this.#clock = deps.clock;
    this.#newAccountId = deps.accountIdFactory ?? newId;
  }

  /**
   * Membuat akun baru. Urutannya penting: cek perintah DULU, baru buat akun,
   * supaya retry tidak pernah menghasilkan akun kedua.
   */
  create(input: {
    commandId: string;
    name: string;
    mode: "live" | "simulation" | "replay";
    baseCurrency: string;
    initialBalance: string;
    nowMs: number;
  }): CommandOutcome<AccountRecord> {
    this.#requireCommandId(input.commandId);
    const requestHash = fingerprint({
      op: "create_account",
      name: input.name,
      mode: input.mode,
      baseCurrency: input.baseCurrency,
      initialBalance: input.initialBalance,
    });

    return this.#conn.transaction(() => {
      const existing = this.#commands.find(input.commandId);
      if (existing !== null) {
        this.#assertNotConflict(existing.requestHash, existing.kind, "submit_order", requestHash, input.commandId);
        return { result: this.#accounts.require(existing.accountId), duplicate: true };
      }

      const account = this.#accounts.create({
        id: this.#newAccountId(),
        name: input.name,
        mode: input.mode,
        baseCurrency: input.baseCurrency,
        initialBalance: input.initialBalance,
        createdAtMs: input.nowMs,
      });

      this.#commands.claim({
        commandId: input.commandId,
        kind: "submit_order",
        accountId: account.id,
        tsMs: input.nowMs,
        requestHash,
      });

      this.#events.append({
        accountId: account.id,
        type: "account.created",
        aggregateType: "account",
        aggregateId: account.id,
        commandId: input.commandId,
        data: {
          name: account.name,
          mode: account.mode,
          baseCurrency: account.baseCurrency,
          initialBalance: account.initialBalance.toFixed(8),
        },
        tsMs: input.nowMs,
      });

      return { result: account, duplicate: false };
    });
  }

  deposit(input: {
    accountId: string;
    commandId: string;
    amount: string;
    note?: string;
    nowMs: number;
  }): CommandOutcome<AccountRecord> {
    return this.#cashMovement({ ...input, op: "deposit", type: "deposit", sign: 1 });
  }

  withdraw(input: {
    accountId: string;
    commandId: string;
    amount: string;
    note?: string;
    nowMs: number;
  }): CommandOutcome<AccountRecord> {
    return this.#cashMovement({ ...input, op: "withdraw", type: "withdrawal", sign: -1 });
  }

  /**
   * Reset/reseed saldo simulasi.
   *
   * Riwayat ledger TIDAK dihapus dan TIDAK ditulis ulang. Reset adalah entri
   * `reset` bertanda yang membawa saldo ke nilai target, sehingga audit penuh
   * tetap ada. Posisi terbuka dan order live harus diselesaikan lebih dulu.
   */
  reset(input: {
    accountId: string;
    commandId: string;
    balance: string;
    note?: string;
    nowMs: number;
  }): CommandOutcome<AccountRecord> {
    const requestHash = fingerprint({ op: "reset", accountId: input.accountId, balance: input.balance, note: input.note ?? null });
    return this.#run("settle_position", input.commandId, input.accountId, input.nowMs, requestHash, () => {
      const account = this.#accounts.require(input.accountId);
      const openPositions = this.#positions.listOpen(input.accountId);
      if (openPositions.length > 0) {
        throw new ValidationError(
          `Reset ditolak: masih ada ${openPositions.length} posisi terbuka. Tutup posisi lebih dulu.`,
        );
      }
      const liveOrders = this.#orders.listLive(input.accountId);
      if (liveOrders.length > 0) {
        throw new ValidationError(
          `Reset ditolak: masih ada ${liveOrders.length} order terbuka. Batalkan order lebih dulu.`,
        );
      }
      const target = new Decimal(input.balance);
      if (target.isNegative()) {
        throw new ValidationError(`Saldo reset tidak boleh negatif: ${input.balance}`);
      }
      const balances = this.#ledger.balances(input.accountId);
      const delta = target.minus(balances.walletBalance);

      const appended = this.#ledger.append({
        accountId: input.accountId,
        tsMs: input.nowMs,
        type: "reset",
        amount: delta,
        refType: "admin",
        refId: account.id,
        idempotencyKey: `reset:${input.commandId}`,
        meta: { note: input.note ?? "", target: target.toFixed(8), previous: balances.walletBalance.toFixed(8) },
      });
      this.#accounts.markReset(input.accountId, input.nowMs);
      this.#emitLedger(input.accountId, appended.entry.seq, input.commandId, input.nowMs, "reset");
      this.#emitAccountUpdated(input.accountId, input.commandId, "reset", delta, input.nowMs);
      return account;
    });
  }

  get(accountId: string): AccountRecord {
    return this.#accounts.require(accountId);
  }

  list(): AccountRecord[] {
    return this.#accounts.list();
  }

  balances(accountId: string) {
    return this.#ledger.balances(accountId);
  }

  /**
   * Ringkasan siap-UI.
   *
   * Kas dan `latestEventSeq` dibaca dalam SATU transaksi sehingga batas
   * snapshot konsisten: klien boleh memakai `latestEventSeq` sebagai `afterSeq`
   * tanpa risiko kehilangan event (lihat docs/REALTIME.md).
   *
   * Posisi tanpa mark dilaporkan di `unvaluedContracts` dan PnL-nya TIDAK
   * ditebak; `valuationStatus` menjelaskan kondisinya.
   */
  summary(input: {
    accountId: string;
    marks: ReadonlyMap<string, { markPrice: Decimal.Value; stale: boolean }>;
  }): AccountSummary {
    return this.#conn.transaction(() => {
      const account = this.#accounts.require(input.accountId);
      const balances = this.#ledger.balances(input.accountId);
      const latestEventSeq = this.#events.latestSeq(input.accountId);

      const openPositions = this.#positions.listOpen(input.accountId);
      const openOrders = this.#orders.listLive(input.accountId);

      let unrealized = ZERO;
      const unvaluedContracts: string[] = [];
      let anyStale = false;
      let valued = 0;

      for (const position of openPositions) {
        const observed = input.marks.get(position.contract);
        if (observed === undefined) {
          unvaluedContracts.push(position.contract);
          continue;
        }
        if (observed.stale) {
          anyStale = true;
        }
        const spec: ContractSpec = this.#contracts.require(position.contract);
        unrealized = unrealized.plus(
          unrealizedPnlFor(spec, position.direction, position.size, position.entryPrice, observed.markPrice),
        );
        valued += 1;
      }

      const valuation = deriveAccount(
        {
          walletBalance: balances.walletBalance,
          usedMargin: balances.usedMargin,
          reservedMargin: balances.reservedMargin,
        },
        unrealized,
      );

      const valuationStatus: AccountSummary["valuationStatus"] =
        openPositions.length === 0
          ? "fresh"
          : anyStale
            ? "stale"
            : unvaluedContracts.length > 0
              ? "partial"
              : valued === 0
                ? "unvalued"
                : "fresh";

      return {
        accountId: account.id,
        name: account.name,
        mode: account.mode,
        baseCurrency: account.baseCurrency,
        valuation,
        openPositionCount: openPositions.length,
        openOrderCount: openOrders.length,
        unvaluedContracts,
        valuationStatus,
        latestEventSeq,
        asOf: this.#clock.nowMs(),
      };
    });
  }

  // ── internal ───────────────────────────────────────────────────

  #cashMovement(input: {
    accountId: string;
    commandId: string;
    amount: string;
    note?: string;
    nowMs: number;
    op: string;
    type: "deposit" | "withdrawal";
    sign: 1 | -1;
  }): CommandOutcome<AccountRecord> {
    const requestHash = fingerprint({
      op: input.op,
      accountId: input.accountId,
      amount: input.amount,
      note: input.note ?? null,
    });
    return this.#run("submit_order", input.commandId, input.accountId, input.nowMs, requestHash, () => {
      this.#accounts.require(input.accountId);
      const amount = new Decimal(input.amount);
      if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
        throw new ValidationError(`Amount harus positif: ${input.amount}`);
      }
      const delta = input.sign === 1 ? amount : amount.negated();

      if (delta.isNegative()) {
        const balances = this.#ledger.balances(input.accountId);
        const available = balances.walletBalance.minus(balances.usedMargin).minus(balances.reservedMargin);
        if (amount.greaterThan(available)) {
          throw new InsufficientFundsError(
            `Penarikan melebihi saldo tersedia: diminta ${amount.toFixed(8)}, tersedia ${available.toFixed(8)}`,
          );
        }
      }

      const appended = this.#ledger.append({
        accountId: input.accountId,
        tsMs: input.nowMs,
        type: input.type,
        amount: delta,
        refType: "admin",
        refId: input.accountId,
        idempotencyKey: `${input.type}:${input.commandId}`,
        meta: { note: input.note ?? "" },
      });
      this.#emitLedger(input.accountId, appended.entry.seq, input.commandId, input.nowMs, input.type);
      this.#emitAccountUpdated(input.accountId, input.commandId, input.type, delta, input.nowMs);
      return this.#accounts.require(input.accountId);
    });
  }

  #run<T>(
    kind: TradeCommandKind,
    commandId: string,
    accountId: string,
    nowMs: number,
    requestHash: string,
    execute: () => T,
  ): CommandOutcome<T> {
    this.#requireCommandId(commandId);
    return this.#conn.transaction(() => {
      const claim = this.#commands.claim({ commandId, kind, accountId, tsMs: nowMs, requestHash });
      if (!claim.claimed) {
        if (claim.conflict) {
          throw new IdempotencyConflictError(
            `commandId ${commandId} sudah dipakai dengan payload berbeda`,
          );
        }
        // Retry sah: kembalikan hasil lama tanpa efek baru.
        return { result: this.#replay<T>(kind, accountId, claim.existing.orderId), duplicate: true };
      }
      return { result: execute(), duplicate: false };
    });
  }

  /** Rekonstruksi hasil untuk perintah yang sudah dijalankan. */
  #replay<T>(kind: TradeCommandKind, accountId: string, _orderId: string | null): T {
    void kind;
    return this.#accounts.require(accountId) as unknown as T;
  }

  #requireCommandId(commandId: string): void {
    if (commandId.trim() === "") {
      throw new ValidationError("commandId wajib diisi");
    }
  }

  /** Konflik = jenis perintah berbeda, atau sidik jari payload berbeda. */
  #assertNotConflict(
    existingHash: string | null,
    existingKind: string,
    incomingKind: string,
    incomingHash: string,
    commandId: string,
  ): void {
    const kindDiffers = existingKind !== incomingKind;
    const hashDiffers = existingHash !== null && existingHash !== incomingHash;
    if (kindDiffers || hashDiffers) {
      throw new IdempotencyConflictError(
        `commandId ${commandId} sudah dipakai dengan payload berbeda`,
      );
    }
  }

  #emitAccountUpdated(
    accountId: string,
    commandId: string,
    reason: string,
    delta: Decimal,
    nowMs: number,
  ): void {
    const balances = this.#ledger.balances(accountId);
    this.#events.append({
      accountId,
      type: "account.updated",
      aggregateType: "account",
      aggregateId: accountId,
      commandId,
      data: {
        reason,
        amount: delta.toFixed(8),
        walletBalance: balances.walletBalance.toFixed(8),
        availableBalance: balances.walletBalance
          .minus(balances.usedMargin)
          .minus(balances.reservedMargin)
          .toFixed(8),
        equity: balances.walletBalance.toFixed(8),
      },
      tsMs: nowMs,
    });
  }

  #emitLedger(
    accountId: string,
    ledgerSeq: number,
    commandId: string,
    nowMs: number,
    reason: string,
  ): void {
    this.#events.append({
      accountId,
      type: "ledger.created",
      aggregateType: "ledger",
      aggregateId: String(ledgerSeq),
      commandId,
      data: { ledgerSeq, reason },
      tsMs: nowMs,
    });
  }
}

/** Sidik jari payload deterministik (urutan kunci stabil). */
export function fingerprint(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return keys.map((key) => `${key}=${JSON.stringify(payload[key])}`).join("&");
}
