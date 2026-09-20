import { assertValidPrice, Decimal, InvalidOrderError, type ContractSpec } from "@crypastra/core";
import type { DatabaseConnection } from "../db/database.js";
import { IdempotencyConflictError, NotFoundError, ValidationError } from "../db/errors.js";
import { CommandRepository, type TradeCommandKind } from "../repositories/command-repository.js";
import { ContractRepository } from "../repositories/contract-repository.js";
import { DomainEventRepository } from "../repositories/domain-event-repository.js";
import { PositionRepository, type PositionRecord } from "../repositories/position-repository.js";
import { fingerprint } from "./account-service.js";

/**
 * PositionService — operasi tingkat posisi yang bukan bagian dari siklus order
 * maupun runtime mark (Phase 5).
 *
 * Saat ini hanya amandemen TP/SL, yang di Phase 4 memang hanya bisa diset saat
 * posisi dibuka. Operasi ini:
 *  - idempoten per `commandId` (sidik jari payload mendeteksi konflik),
 *  - transaksional (satu transaksi),
 *  - auditable (`position_events` tipe `protection_updated`, tidak menulis ulang
 *    event lama).
 */
export interface PositionServiceDeps {
  readonly connection: DatabaseConnection;
}

export interface AmendProtectionInput {
  readonly commandId: string;
  readonly positionId: string;
  readonly takeProfitPrice: string | null | undefined;
  readonly stopLossPrice: string | null | undefined;
  readonly nowMs: number;
}

export class PositionService {
  readonly #conn: DatabaseConnection;
  readonly #positions: PositionRepository;
  readonly #contracts: ContractRepository;
  readonly #commands: CommandRepository;
  readonly #events: DomainEventRepository;

  constructor(deps: PositionServiceDeps) {
    this.#conn = deps.connection;
    this.#positions = new PositionRepository(deps.connection);
    this.#contracts = new ContractRepository(deps.connection);
    this.#commands = new CommandRepository(deps.connection);
    this.#events = new DomainEventRepository(deps.connection);
  }

  /**
   * Nilai `undefined` berarti "tidak diubah", `null` berarti "dikosongkan".
   * Membedakan keduanya penting supaya PATCH parsial tidak menghapus TP/SL
   * yang tidak disebut klien.
   */
  amendProtection(input: AmendProtectionInput): { position: PositionRecord; duplicate: boolean } {
    if (input.commandId.trim() === "") {
      throw new ValidationError("commandId wajib diisi");
    }
    const requestHash = fingerprint({
      op: "amend_protection",
      positionId: input.positionId,
      takeProfitPrice: input.takeProfitPrice ?? null,
      stopLossPrice: input.stopLossPrice ?? null,
    });

    return this.#conn.transaction(() => {
      const position = this.#positions.require(input.positionId);
      const claim = this.#commands.claim({
        commandId: input.commandId,
        kind: "settle_position" satisfies TradeCommandKind,
        accountId: position.accountId,
        tsMs: input.nowMs,
        requestHash,
      });
      if (!claim.claimed) {
        if (claim.conflict) {
          throw new IdempotencyConflictError(
            `commandId ${input.commandId} sudah dipakai dengan payload berbeda`,
          );
        }
        return { position: this.#positions.require(input.positionId), duplicate: true };
      }
      if (position.status !== "open") {
        throw new InvalidOrderError(
          `Posisi ${position.id} berstatus ${position.status}; TP/SL hanya untuk posisi terbuka`,
        );
      }

      const spec: ContractSpec = this.#contracts.require(position.contract);
      const nextTp = resolveProtection(input.takeProfitPrice, position.tpPrice);
      const nextSl = resolveProtection(input.stopLossPrice, position.slPrice);

      if (nextTp !== null) {
        const price = assertValidPrice(nextTp, "Harga take profit");
        // Aturan penempatan: TP harus di sisi yang masuk akal terhadap entry.
        if (position.direction === "long" && price.lessThanOrEqualTo(position.entryPrice)) {
          throw new InvalidOrderError(
            `TP LONG harus di atas entry ${position.entryPrice.toFixed()}, dapat ${price.toFixed()}`,
          );
        }
        if (position.direction === "short" && price.greaterThanOrEqualTo(position.entryPrice)) {
          throw new InvalidOrderError(
            `TP SHORT harus di bawah entry ${position.entryPrice.toFixed()}, dapat ${price.toFixed()}`,
          );
        }
      }
      if (nextSl !== null) {
        const price = assertValidPrice(nextSl, "Harga stop loss");
        if (position.direction === "long" && price.greaterThanOrEqualTo(position.entryPrice)) {
          throw new InvalidOrderError(
            `SL LONG harus di bawah entry ${position.entryPrice.toFixed()}, dapat ${price.toFixed()}`,
          );
        }
        if (position.direction === "short" && price.lessThanOrEqualTo(position.entryPrice)) {
          throw new InvalidOrderError(
            `SL SHORT harus di atas entry ${position.entryPrice.toFixed()}, dapat ${price.toFixed()}`,
          );
        }
      }

      const updated = this.#positions.applyProtection({
        positionId: position.id,
        takeProfitPrice: nextTp,
        stopLossPrice: nextSl,
        tsMs: input.nowMs,
        detail: { commandId: input.commandId, contract: spec.contract },
      });

      this.#events.append({
        accountId: position.accountId,
        type: "position.updated",
        aggregateType: "position",
        aggregateId: position.id,
        commandId: input.commandId,
        data: {
          contract: position.contract,
          change: "protection",
          takeProfitPrice: nextTp === null ? null : nextTp.toFixed(),
          stopLossPrice: nextSl === null ? null : nextSl.toFixed(),
        },
        tsMs: input.nowMs,
      });

      return { position: updated, duplicate: false };
    });
  }

  get(positionId: string): PositionRecord {
    const position = this.#positions.find(positionId);
    if (position === null) {
      throw new NotFoundError(`Posisi tidak ditemukan: ${positionId}`);
    }
    return position;
  }

  listOpen(accountId: string): PositionRecord[] {
    return this.#positions.listOpen(accountId);
  }

  listByAccount(accountId: string): PositionRecord[] {
    return this.#positions.listByAccount(accountId);
  }
}

/** undefined = pertahankan nilai lama; null = kosongkan; string = set baru. */
function resolveProtection(
  next: string | null | undefined,
  current: Decimal | null,
): Decimal | null {
  if (next === undefined) {
    return current;
  }
  if (next === null) {
    return null;
  }
  return new Decimal(next);
}
