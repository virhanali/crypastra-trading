import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { tradeCommands } from "../db/schema.js";

export type TradeCommandKind =
  | "submit_order"
  | "evaluate_order"
  | "cancel_order"
  | "process_mark"
  | "settle_position";

export interface TradeCommandRecord {
  readonly commandId: string;
  readonly kind: string;
  readonly accountId: string;
  readonly orderId: string | null;
  /** Sidik jari payload; null untuk baris lama sebelum Phase 5. */
  readonly requestHash: string | null;
  readonly createdAtMs: number;
}

/** Hasil klaim perintah. */
export interface ClaimResult {
  /** true = perintah baru diklaim; false = sudah ada. */
  readonly claimed: boolean;
  readonly existing: TradeCommandRecord;
  /**
   * true = commandId SAMA tetapi payload BERBEDA. Klien harus menerima konflik,
   * bukan sukses palsu (ADR 0009).
   */
  readonly conflict: boolean;
}

/**
 * CommandRepository — idempotensi tingkat PERINTAH (ADR 0007).
 *
 * Ledger sudah idempoten per entri, tapi satu perintah menghasilkan banyak efek
 * (reservasi, N fill, fee, PnL, posisi). Baris di tabel ini adalah klaim
 * "perintah ini sudah dijalankan". PRIMARY KEY pada `command_id` membuat klaim
 * itu atomik: penulis kedua mendapat pelanggaran UNIQUE, bukan efek ganda.
 */
export class CommandRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  find(commandId: string): TradeCommandRecord | null {
    const row = this.#conn.db
      .select()
      .from(tradeCommands)
      .where(eq(tradeCommands.commandId, commandId))
      .get();
    return row === undefined ? null : mapRow(row);
  }

  /**
   * Klaim perintah. Mengembalikan `{ claimed: false, existing }` bila perintah
   * sudah pernah dijalankan — pemanggil harus mengembalikan hasil lama tanpa
   * menjalankan efek ekonomi apa pun.
   */
  claim(input: {
    commandId: string;
    kind: TradeCommandKind;
    accountId: string;
    tsMs: number;
    /** Sidik jari payload perintah (opsional untuk kompatibilitas). */
    requestHash?: string;
  }): ClaimResult {
    const already = this.find(input.commandId);
    if (already !== null) {
      return { claimed: false, existing: already, conflict: isConflict(already, input) };
    }

    try {
      this.#conn.db
        .insert(tradeCommands)
        .values({
          commandId: input.commandId,
          kind: input.kind,
          accountId: input.accountId,
          orderId: null,
          requestHash: input.requestHash ?? null,
          createdAt: input.tsMs,
        })
        .run();
    } catch (error) {
      // Balapan: penulis lain menang. Perlakukan sebagai perintah yang sudah ada.
      const raced = this.find(input.commandId);
      if (raced !== null) {
        return { claimed: false, existing: raced, conflict: isConflict(raced, input) };
      }
      throw error;
    }

    const created = this.find(input.commandId);
    if (created === null) {
      throw new Error(`Perintah gagal diklaim: ${input.commandId}`);
    }
    return { claimed: true, existing: created, conflict: false };
  }

  attachOrder(commandId: string, orderId: string): void {
    this.#conn.db
      .update(tradeCommands)
      .set({ orderId })
      .where(eq(tradeCommands.commandId, commandId))
      .run();
  }

  count(): number {
    return this.#conn.db.select({ commandId: tradeCommands.commandId }).from(tradeCommands).all().length;
  }
}

/**
 * Konflik hanya dilaporkan bila sidik jari LAMA ada dan berbeda. Baris lama
 * tanpa sidik jari (sebelum Phase 5) diperlakukan cocok supaya data historis
 * tidak tiba-tiba dianggap konflik.
 */
function isConflict(
  existing: TradeCommandRecord,
  incoming: { kind: TradeCommandKind; accountId: string; requestHash?: string },
): boolean {
  if (existing.kind !== incoming.kind || existing.accountId !== incoming.accountId) {
    return true;
  }
  if (existing.requestHash === null || incoming.requestHash === undefined) {
    return false;
  }
  return existing.requestHash !== incoming.requestHash;
}

function mapRow(row: typeof tradeCommands.$inferSelect): TradeCommandRecord {
  return {
    commandId: row.commandId,
    kind: row.kind,
    accountId: row.accountId,
    orderId: row.orderId,
    requestHash: row.requestHash,
    createdAtMs: row.createdAt,
  };
}
