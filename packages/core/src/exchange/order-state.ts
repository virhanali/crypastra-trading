import { InvalidOrderError } from "../errors.js";
import type { OrderStatus, OrderType, TimeInForce } from "./types.js";

/**
 * State machine order. Transisi ilegal GAGAL EKSPLISIT — tidak ada perbaikan
 * diam-diam. Setiap transisi yang mengubah status harus menghasilkan
 * order_event (ditegakkan di OrderRepository).
 *
 * Alur (lihat ACCOUNTING.md §8):
 *   created → validated → { open | partially_filled | filled | cancelled | rejected }
 *   open → partially_filled → { partially_filled | filled | cancelled | expired }
 */

const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ["validated", "rejected"],
  validated: ["open", "partially_filled", "filled", "cancelled", "rejected", "expired"],
  open: ["partially_filled", "filled", "cancelled", "expired"],
  partially_filled: ["partially_filled", "filled", "cancelled", "expired"],
  // Terminal:
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "filled",
  "cancelled",
  "rejected",
  "expired",
];

/** Status yang tidak pernah berubah lagi. */
export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) {
    // partially_filled → partially_filled diizinkan (fill tambahan).
    if (from === "partially_filled") {
      return;
    }
    throw new InvalidOrderError(`Transisi order ${from} → ${to} tidak bermakna (tidak ada perubahan)`);
  }
  if (!canTransition(from, to)) {
    throw new InvalidOrderError(
      `Transisi order ilegal: ${from} → ${to}. Transisi ${from} yang sah: ${
        (TRANSITIONS[from] ?? []).join(", ") || "(terminal)"
      }`,
    );
  }
}

/**
 * Apakah order masih bisa terisi lagi.
 *
 * Order immediate (market, atau limit dengan TIF ioc/fok) TIDAK pernah resting,
 * jadi `partially_filled` untuk order seperti itu bersifat terminal — sisanya
 * sudah dibatalkan saat submit. Hanya limit gtc/post_only yang benar-benar live.
 */
export function isOrderLive(order: {
  readonly status: OrderStatus;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
}): boolean {
  if (order.status !== "open" && order.status !== "partially_filled") {
    return false;
  }
  return restsOnBook(order.type, order.timeInForce);
}

/** Apakah order dengan tipe/TIF ini bisa beristirahat di buku. */
export function restsOnBook(type: OrderType, timeInForce: TimeInForce): boolean {
  if (type !== "limit") {
    return false;
  }
  return timeInForce === "gtc" || timeInForce === "post_only";
}

/** Apakah order dieksekusi segera (tidak resting). */
export function isImmediate(type: OrderType, timeInForce: TimeInForce): boolean {
  return !restsOnBook(type, timeInForce);
}

/**
 * Status setelah satu kesempatan eksekusi terhadap buku.
 *
 * - terisi penuh               → `filled`
 * - terisi sebagian            → `partially_filled`
 * - tidak terisi, RESTING      → tetap `open` (order masih hidup di buku)
 * - tidak terisi, immediate    → `cancelled`
 *
 * Kasus "tidak terisi, resting" penting: evaluasi snapshot yang tidak
 * menyentuh order TIDAK boleh membatalkannya. Kalau salah, order kehilangan
 * status live-nya sementara reservasi marginnya masih tertahan.
 */
export function statusAfterExecution(input: {
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly filledSize: number;
  readonly requestedSize: number;
}): OrderStatus {
  if (input.filledSize >= input.requestedSize) {
    return "filled";
  }
  if (input.filledSize > 0) {
    return "partially_filled";
  }
  return restsOnBook(input.type, input.timeInForce) ? "open" : "cancelled";
}

/** Status yang boleh dibatalkan pengguna. */
export function canCancel(order: {
  readonly status: OrderStatus;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
}): boolean {
  return isOrderLive(order);
}
