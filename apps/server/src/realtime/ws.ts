import type { Server } from "node:http";
import { z } from "zod";
import { WebSocketServer, type WebSocket } from "ws";
import type { DatabaseConnection } from "../db/database.js";
import { DomainEventRepository, type DomainEventRecord } from "../repositories/domain-event-repository.js";

/**
 * Hub realtime (ADR 0009).
 *
 * Prinsip:
 *  - Database adalah SUMBER KEBENARAN. `domain_events` adalah outbox
 *    transaksional; WebSocket hanyalah pengiriman.
 *  - Satu urutan global (`seq`) untuk resume. Tidak ada urutan sintetis dari
 *    penggabungan id tabel yang tidak berhubungan.
 *  - Pengiriman bersifat AT-LEAST-ONCE. Klien WAJIB melakukan dedupe
 *    berdasarkan `seq` (dan boleh memakai `seq` untuk mengurutkan).
 *  - Antrean keluar tiap koneksi TERBATAS. Klien lambat diputus dengan alasan
 *    `resync_required` supaya memori server tidak tumbuh tanpa batas.
 *  - Snapshot pasar (tick) TIDAK lewat outbox ini: itu aliran ephemeral
 *    terpisah (Phase 6). Outbox hanya untuk peristiwa finansial domain.
 */

export const ClientMessageSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), accountId: z.string().trim().min(1), afterSeq: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal("unsubscribe") }).strict(),
  z.object({ op: z.literal("ping") }).strict(),
  /**
   * Langganan pasar EPHEMERAL (bukan domain event). Tidak punya `seq`, tidak
   * dapat di-resume, dan boleh di-coalesce: hanya keadaan TERBARU per
   * (kontrak, jenis) yang dikirim.
   */
  z
    .object({
      op: z.literal("subscribe_market"),
      contracts: z.array(z.string().trim().min(1)).min(1).max(50),
    })
    .strict(),
  z.object({ op: z.literal("unsubscribe_market") }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface RealtimeOptions {
  readonly connection: DatabaseConnection;
  /** Interval polling outbox (ms). Default 150. */
  readonly pollIntervalMs?: number;
  /** Maksimum event per batch replay/poll. Default 500. */
  readonly maxBatch?: number;
  /** Maksimum antrean keluar per koneksi sebelum diputus. Default 1000. */
  readonly maxQueue?: number;
  /**
   * Ambang buffer socket (byte). Bila buffer kirim mencapai ambang ini,
   * pengurasan DIHENTIKAN sehingga antrean benar-benar menumpuk di server dan
   * `maxQueue` punya efek. Tanpa ini, menulis ke socket yang lambat hanya
   * memindahkan masalah ke buffer internal `ws` (memori tumbuh tanpa batas).
   * Nilai 0 berarti "jangan pernah menguras" (dipakai test deterministik).
   */
  readonly highWaterMarkBytes?: number;
  /** Maksimum ukuran pesan masuk (byte). Default 64 KiB. */
  readonly maxPayloadBytes?: number;
}

export interface RealtimeHub {
  attach(server: Server): void;
  /**
   * Terbitkan keadaan pasar ephemeral. TIDAK menulis apa pun ke database dan
   * TIDAK masuk outbox domain. Pengiriman di-coalesce per (kontrak, jenis).
   */
  publishMarket(event: { type: string; contract: string; timestamp: number; data: unknown }): void;
  /** Jalankan satu siklus polling secara sinkron (dipakai test deterministik). */
  tick(): void;
  /** Jumlah koneksi aktif (untuk observability/test). */
  connectionCount(): number;
  /** Metrik pengiriman pasar (coalescing). */
  metrics(): { marketEventsEmitted: number; marketEventsCoalesced: number };
  close(): Promise<void>;
}

interface Subscriber {
  readonly socket: WebSocket;
  accountId: string;
  deliveredSeq: number;
  queue: string[];
  draining: boolean;
  closed: boolean;
  /** Kontrak pasar yang dilanggan (ephemeral). */
  marketContracts: Set<string>;
  /**
   * Antrean pasar yang di-COALESCE: kunci `contract|type`, nilai frame terbaru.
   * Menumpuknya tanpa batas akan membuat klien lambat menelan memori server.
   */
  marketQueue: Map<string, string>;
}

export function createRealtimeHub(options: RealtimeOptions): RealtimeHub {
  const connection = options.connection;
  const events = new DomainEventRepository(connection);
  const pollIntervalMs = options.pollIntervalMs ?? 150;
  const maxBatch = options.maxBatch ?? 500;
  const maxQueue = options.maxQueue ?? 1000;
  const maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024;
  const highWaterMarkBytes = options.highWaterMarkBytes ?? 1024 * 1024;

  const subscribers = new Set<Subscriber>();
  const metrics = {
    marketEventsEmitted: 0,
    marketEventsCoalesced: 0,
  };
  let wss: WebSocketServer | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function enqueue(subscriber: Subscriber, payload: string): void {
    if (subscriber.closed) {
      return;
    }
    if (subscriber.queue.length >= maxQueue) {
      // Klien terlalu lambat: putuskan dan minta resync, jangan tumbuhkan memori.
      subscriber.closed = true;
      subscriber.socket.close(1013, "resync_required");
      return;
    }
    subscriber.queue.push(payload);
    drain(subscriber);
  }

  function drain(subscriber: Subscriber): void {
    if (subscriber.draining || subscriber.closed) {
      return;
    }
    subscriber.draining = true;
    try {
      while (subscriber.queue.length > 0) {
        if (subscriber.socket.readyState !== 1) {
          break;
        }
        // Berhenti menguras bila buffer socket sudah menumpuk; sisa tetap di
        // antrean sehingga `maxQueue` dapat memutus klien yang terlalu lambat.
        if (typeof subscriber.socket.bufferedAmount === "number" && subscriber.socket.bufferedAmount >= highWaterMarkBytes) {
          break;
        }
        const next = subscriber.queue.shift();
        if (next === undefined) {
          break;
        }
        subscriber.socket.send(next);
      }
    } finally {
      subscriber.draining = false;
    }
  }

  function frameOf(event: DomainEventRecord): string {
    return JSON.stringify({
      seq: event.seq,
      type: event.type,
      accountId: event.accountId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      timestamp: event.tsMs,
      data: event.data,
    });
  }

  /** Kirim keadaan pasar TERBARU per (kontrak, jenis); yang lama sudah dibuang. */
  function drainMarket(subscriber: Subscriber): void {
    if (subscriber.closed || subscriber.marketQueue.size === 0) {
      return;
    }
    if (
      typeof subscriber.socket.bufferedAmount === "number" &&
      subscriber.socket.bufferedAmount >= highWaterMarkBytes
    ) {
      // Pasar boleh menunggu; keadaan terbaru akan menggantikan yang antre.
      return;
    }
    const pending = [...subscriber.marketQueue.values()];
    subscriber.marketQueue.clear();
    for (const frame of pending) {
      if (subscriber.socket.readyState !== 1) {
        return;
      }
      subscriber.socket.send(frame);
    }
  }

  /** Kirim event untuk akun pelanggan setelah `deliveredSeq` (batas batch). */
  function pump(subscriber: Subscriber): void {
    if (subscriber.closed) {
      return;
    }
    let cursor = subscriber.deliveredSeq;
    let sent = 0;
    while (sent < maxBatch) {
      const batch = events.listAfter(subscriber.accountId, cursor, maxBatch);
      if (batch.length === 0) {
        break;
      }
      for (const event of batch) {
        enqueue(subscriber, frameOf(event));
        cursor = event.seq;
        sent += 1;
        if (sent >= maxBatch) {
          break;
        }
      }
      if (batch.length < maxBatch) {
        break;
      }
    }
    subscriber.deliveredSeq = cursor;
  }

  function handleSubscribe(subscriber: Subscriber, accountId: string, afterSeq: number): void {
    subscriber.accountId = accountId;
    subscriber.deliveredSeq = afterSeq;
    // Ack dulu supaya klien tahu langganan aktif, lalu replay historis, lalu live.
    subscriber.socket.send(
      JSON.stringify({ op: "subscribed", accountId, afterSeq }),
    );
    pump(subscriber);
    subscriber.socket.send(JSON.stringify({ op: "resumed", accountId, throughSeq: subscriber.deliveredSeq }));
  }

  function publishMarket(event: { type: string; contract: string; timestamp: number; data: unknown }): void {
    const frame = JSON.stringify(event);
    const key = `${event.contract}|${event.type}`;
    for (const subscriber of subscribers) {
      if (subscriber.closed || !subscriber.marketContracts.has(event.contract)) {
        continue;
      }
      const existed = subscriber.marketQueue.has(key);
      subscriber.marketQueue.set(key, frame);
      metrics.marketEventsCoalesced += existed ? 1 : 0;
      metrics.marketEventsEmitted += 1;
    }
    drainAll();
  }

  function drainAll(): void {
    for (const subscriber of subscribers) {
      drainMarket(subscriber);
    }
  }

  function tick(): void {
    for (const subscriber of subscribers) {
      if (subscriber.closed) {
        continue;
      }
      pump(subscriber);
      drainMarket(subscriber);
    }
  }

  return {
    attach(server: Server): void {
      if (wss !== null) {
        return;
      }
      wss = new WebSocketServer({ server, path: "/ws", maxPayload: maxPayloadBytes });

      wss.on("connection", (socket: WebSocket) => {
        const subscriber: Subscriber = {
          socket,
          accountId: "",
          deliveredSeq: 0,
          queue: [],
          draining: false,
          closed: false,
          marketContracts: new Set<string>(),
          marketQueue: new Map<string, string>(),
        };

        socket.on("message", (raw: Buffer) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString("utf8"));
          } catch {
            socket.send(JSON.stringify({ op: "error", code: "VALIDATION_ERROR", message: "Pesan bukan JSON" }));
            return;
          }
          const result = ClientMessageSchema.safeParse(parsed);
          if (!result.success) {
            socket.send(
              JSON.stringify({
                op: "error",
                code: "VALIDATION_ERROR",
                message: "Pesan klien tidak valid",
                details: {
                  issues: result.error.issues.map((issue) => ({
                    path: issue.path.join("."),
                    message: issue.message,
                  })),
                },
              }),
            );
            return;
          }
          const message = result.data;
          if (message.op === "ping") {
            socket.send(JSON.stringify({ op: "pong" }));
            return;
          }
          if (message.op === "subscribe_market") {
            for (const contract of message.contracts) {
              subscriber.marketContracts.add(contract);
            }
            if (subscriber.accountId === "") {
              subscribers.add(subscriber);
            }
            socket.send(
              JSON.stringify({ op: "market_subscribed", contracts: [...subscriber.marketContracts].sort() }),
            );
            return;
          }
          if (message.op === "unsubscribe_market") {
            subscriber.marketContracts.clear();
            subscriber.marketQueue.clear();
            socket.send(JSON.stringify({ op: "market_unsubscribed" }));
            return;
          }
          if (message.op === "unsubscribe") {
            subscribers.delete(subscriber);
            subscriber.accountId = "";
            return;
          }
          if (subscriber.accountId === "") {
            subscribers.add(subscriber);
          }
          handleSubscribe(subscriber, message.accountId, message.afterSeq);
        });

        socket.on("close", () => {
          subscriber.closed = true;
          subscribers.delete(subscriber);
        });
        socket.on("error", () => {
          subscriber.closed = true;
          subscribers.delete(subscriber);
        });
      });

      timer = setInterval(() => tick(), pollIntervalMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    },

    tick,

    publishMarket,

    metrics(): { marketEventsEmitted: number; marketEventsCoalesced: number } {
      return { ...metrics };
    },

    connectionCount(): number {
      return subscribers.size;
    },

    async close(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      for (const subscriber of subscribers) {
        subscriber.closed = true;
        subscriber.socket.close(1001, "server_shutdown");
      }
      subscribers.clear();
      if (wss !== null) {
        const server = wss;
        wss = null;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  };
}
