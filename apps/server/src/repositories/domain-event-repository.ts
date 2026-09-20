import type { DatabaseConnection } from "../db/database.js";
import { ValidationError } from "../db/errors.js";
import { domainEvents } from "../db/schema.js";
import { and, asc, eq, gt, desc } from "drizzle-orm";

/** Tipe event publik. Envelope-nya didokumentasikan di docs/REALTIME.md. */
export type DomainEventType =
  | "account.created"
  | "account.updated"
  | "order.created"
  | "order.updated"
  | "order.filled"
  | "order.cancelled"
  | "position.opened"
  | "position.updated"
  | "position.closed"
  | "position.liquidated"
  | "fill.created"
  | "ledger.created"
  | "funding.applied";

export type AggregateType = "account" | "order" | "position" | "fill" | "ledger";

export interface AppendDomainEventInput {
  readonly accountId: string;
  readonly type: DomainEventType;
  readonly aggregateType: AggregateType;
  readonly aggregateId?: string | null;
  readonly commandId?: string | null;
  readonly data: Record<string, unknown>;
  readonly tsMs: number;
}

export interface DomainEventRecord {
  readonly seq: number;
  readonly accountId: string;
  readonly type: DomainEventType;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string | null;
  readonly commandId: string | null;
  readonly data: Record<string, unknown>;
  readonly tsMs: number;
}

/**
 * DomainEventRepository — outbox transaksional (ADR 0009).
 *
 * TIDAK membuka transaksi sendiri: pemanggil WAJIB sudah berada di dalam
 * transaksi yang sama dengan perubahan keadaan finansialnya, supaya
 * "state berubah" dan "event terbit" commit bersama. Kalau proses mati di
 * antaranya, keduanya batal — tidak ada event hantu maupun event hilang.
 *
 * `seq` adalah urutan global monoton (INTEGER PRIMARY KEY AUTOINCREMENT),
 * satu-satunya urutan yang dipakai klien realtime untuk resume.
 */
export class DomainEventRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  append(input: AppendDomainEventInput): DomainEventRecord {
    if (input.accountId.trim() === "") {
      throw new ValidationError("accountId wajib diisi untuk domain event");
    }
    const inserted = this.#conn.db
      .insert(domainEvents)
      .values({
        accountId: input.accountId,
        type: input.type,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId ?? null,
        commandId: input.commandId ?? null,
        dataJson: JSON.stringify(input.data),
        ts: input.tsMs,
      })
      .returning()
      .get();
    return mapRow(inserted);
  }

  /** Event setelah `afterSeq`, urut naik, dibatasi `limit` (paginasi replay). */
  listAfter(
    accountId: string,
    afterSeq: number,
    limit = 500,
  ): DomainEventRecord[] {
    if (limit <= 0) {
      throw new ValidationError(`limit harus positif: ${limit}`);
    }
    return this.#conn.db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.accountId, accountId), gt(domainEvents.seq, afterSeq)))
      .orderBy(asc(domainEvents.seq))
      .limit(limit)
      .all()
      .map(mapRow);
  }

  /** `seq` event terakhir untuk akun (batas snapshot). 0 bila belum ada. */
  latestSeq(accountId: string): number {
    const row = this.#conn.db
      .select({ seq: domainEvents.seq })
      .from(domainEvents)
      .where(eq(domainEvents.accountId, accountId))
      .orderBy(desc(domainEvents.seq))
      .limit(1)
      .get();
    return row?.seq ?? 0;
  }

  /** `seq` terakhir lintas akun — dipakai untuk liveness/monitoring. */
  latestSeqGlobal(): number {
    const row = this.#conn.db
      .select({ seq: domainEvents.seq })
      .from(domainEvents)
      .orderBy(desc(domainEvents.seq))
      .limit(1)
      .get();
    return row?.seq ?? 0;
  }

  count(): number {
    return this.#conn.db.select({ seq: domainEvents.seq }).from(domainEvents).all().length;
  }
}

function mapRow(row: typeof domainEvents.$inferSelect): DomainEventRecord {
  const parsed: unknown = JSON.parse(row.dataJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("data_json domain event harus objek JSON");
  }
  return {
    seq: row.seq,
    accountId: row.accountId,
    type: row.type as DomainEventType,
    aggregateType: row.aggregateType as AggregateType,
    aggregateId: row.aggregateId,
    commandId: row.commandId,
    data: parsed as Record<string, unknown>,
    tsMs: row.ts,
  };
}
