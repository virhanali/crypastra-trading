import { InvalidBookError } from "../errors.js";
import { Decimal } from "../money.js";
import type { BookLevel, BookSnapshot } from "../market.js";

/**
 * Buku kedalaman lokal (L2) dengan algoritma sinkronisasi Gate.io.
 *
 * `futures.order_book_update` mengirim ukuran ABSOLUT per level (bukan delta).
 * `size == 0` berarti level DIHAPUS.
 *
 * Prosedur (diverifikasi dari payload nyata, lihat docs/gateio-market-data.md):
 *   1. subscribe WS lebih dulu, tampung update sementara
 *   2. ambil snapshot REST dengan id
 *   3. buang update dengan `u <= id`
 *   4. update pertama yang diterapkan harus memenuhi `U <= id + 1 <= u`
 *   5. terapkan update berikutnya dengan `U == prev_u + 1` (kontinu)
 *   6. gap terdeteksi → UNSYNCED, buku TIDAK dipakai untuk eksekusi
 *   7. resync dari snapshot REST
 *
 * Hanya kontrak yang dikonfigurasi butuh kedalaman yang memakai ini.
 */

export type BookStatus = "syncing" | "synced" | "unsynced";

export interface DepthUpdate {
  readonly contract: string;
  readonly firstUpdateId: number;
  readonly lastUpdateId: number;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

export interface DepthSnapshot {
  readonly contract: string;
  /** `id` dari REST /futures/usdt/order_book?with_id=true */
  readonly updateId: number;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

export interface DepthBookState {
  readonly contract: string;
  readonly status: BookStatus;
  readonly updateId: number | null;
  readonly bidCount: number;
  readonly askCount: number;
  readonly lastGapAt: number | null;
  readonly resyncCount: number;
}

export class DepthBook {
  readonly #contract: string;
  #status: BookStatus = "unsynced";
  // Nilai = ukuran kontrak (cacah bulat), sama seperti BookLevel.size di domain.
  #bids = new Map<string, number>();
  #asks = new Map<string, number>();
  #updateId: number | null = null;
  #buffered: DepthUpdate[] = [];
  #lastGapAt: number | null = null;
  #resyncCount = 0;

  constructor(contract: string) {
    this.#contract = contract;
  }

  get contract(): string {
    return this.#contract;
  }

  get status(): BookStatus {
    return this.#status;
  }

  /** Hanya buku SYNCED yang boleh dipakai untuk eksekusi. */
  isExecutable(): boolean {
    return this.#status === "synced";
  }

  state(): DepthBookState {
    return {
      contract: this.#contract,
      status: this.#status,
      updateId: this.#updateId,
      bidCount: this.#bids.size,
      askCount: this.#asks.size,
      lastGapAt: this.#lastGapAt,
      resyncCount: this.#resyncCount,
    };
  }

  /** Mulai (ulang) sinkronisasi: buffer dibersihkan, buku tidak diekspos. */
  beginSync(): void {
    this.#status = "syncing";
    this.#buffered = [];
    this.#bids.clear();
    this.#asks.clear();
    this.#updateId = null;
  }

  /** Tandai buku tidak tersinkron (mis. setelah disconnect). */
  markUnsynced(nowMs: number): void {
    if (this.#status !== "unsynced") {
      this.#lastGapAt = nowMs;
    }
    this.#status = "unsynced";
    this.#bids.clear();
    this.#asks.clear();
    this.#updateId = null;
  }

  /**
   * Terapkan snapshot REST. Bila ada update yang tertampung dan menyambung,
   * buku langsung menjadi SYNCED; jika belum, buku tetap SYNCING sampai update
   * yang menyambung tiba.
   */
  applySnapshot(snapshot: DepthSnapshot, nowMs: number): BookStatus {
    if (snapshot.contract !== this.#contract) {
      throw new InvalidBookError(
        `Snapshot ${snapshot.contract} tidak cocok dengan buku ${this.#contract}`,
      );
    }
    this.#bids = toLevelMap(snapshot.bids, "bid");
    this.#asks = toLevelMap(snapshot.asks, "ask");
    this.#updateId = snapshot.updateId;
    this.#resyncCount += 1;

    // Buang update yang sudah tercakup snapshot.
    this.#buffered = this.#buffered.filter((update) => update.lastUpdateId > snapshot.updateId);
    this.#status = "syncing";
    return this.#activateFromBuffer(nowMs);
  }

  /**
   * Terapkan update WS. Saat SYNCING, update ditampung lalu dicoba diaktifkan
   * (termasuk saat snapshot sudah ada tetapi belum ada update yang menyambung).
   * Saat SYNCED, update harus kontinu; gap → UNSYNCED.
   */
  applyUpdate(update: DepthUpdate, nowMs: number): BookStatus {
    if (update.contract !== this.#contract) {
      throw new InvalidBookError(
        `Update ${update.contract} tidak cocok dengan buku ${this.#contract}`,
      );
    }
    if (this.#status === "unsynced") {
      // Tunggu resync eksplisit; jangan menebak.
      return this.#status;
    }
    if (this.#status === "syncing") {
      this.#buffered.push(update);
      return this.#activateFromBuffer(nowMs);
    }
    if (!this.#applyContinuity(update)) {
      this.markUnsynced(nowMs);
    }
    return this.#status;
  }

  /**
   * Cari update pertama yang menyambung dengan `#updateId` (gate: `U <= id+1 <= u`),
   * lalu terapkan berurutan sampai ada gap. Hanya mengubah status bila berhasil.
   */
  #activateFromBuffer(nowMs: number): BookStatus {
    if (this.#updateId === null) {
      return this.#status;
    }
    this.#buffered.sort((left, right) => left.firstUpdateId - right.firstUpdateId);
    const base = this.#updateId;
    const index = this.#buffered.findIndex(
      (update) => update.firstUpdateId <= base + 1 && update.lastUpdateId >= base + 1,
    );
    if (index === -1) {
      return this.#status;
    }

    this.#status = "synced";
    const pending = this.#buffered.splice(index);
    for (const update of pending) {
      if (!this.#applyContinuity(update)) {
        this.markUnsynced(nowMs);
        break;
      }
    }
    return this.#status;
  }

  /** Terapkan level-level update setelah memastikan kontinuitas id. */
  #applyContinuity(update: DepthUpdate): boolean {
    const expected = this.#updateId === null ? update.firstUpdateId : this.#updateId + 1;
    if (update.firstUpdateId > expected) {
      // Ada lubang antar update: buku tidak dapat dipercaya.
      return false;
    }
    if (update.lastUpdateId <= expected - 1 && this.#updateId !== null) {
      // Update basi yang sudah tercakup; abaikan tanpa mengubah kontinuitas.
      return true;
    }
    for (const level of update.bids) {
      applyLevel(this.#bids, level, "bid");
    }
    for (const level of update.asks) {
      applyLevel(this.#asks, level, "ask");
    }
    this.#updateId = update.lastUpdateId;
    return true;
  }

  bestBid(): BookLevel | null {
    const top = this.#topLevel(this.#bids, "bid");
    return top;
  }

  bestAsk(): BookLevel | null {
    return this.#topLevel(this.#asks, "ask");
  }

  #topLevel(levels: Map<string, number>, side: "bid" | "ask"): BookLevel | null {
    let bestKey: string | null = null;
    let bestValue: Decimal | null = null;
    for (const [price, size] of levels) {
      if (size <= 0) {
        continue;
      }
      if (bestValue === null) {
        bestKey = price;
        bestValue = new Decimal(price);
        continue;
      }
      const candidate = new Decimal(price);
      // Perbandingan harga memakai Decimal, tidak pernah float.
      const better = side === "bid" ? candidate.greaterThan(bestValue) : candidate.lessThan(bestValue);
      if (better) {
        bestKey = price;
        bestValue = candidate;
      }
    }
    if (bestKey === null) {
      return null;
    }
    const size = levels.get(bestKey);
    return size === undefined ? null : { price: bestKey, size };
  }

  /** Snapshot terurut untuk matching: bid menurun, ask menaik. */
  toBookSnapshot(limit: number, nowMs: number): BookSnapshot | null {
    if (this.#status !== "synced") {
      return null;
    }
    return {
      contract: this.#contract,
      updateId: this.#updateId ?? 0,
      eventTsMs: nowMs,
      bids: this.#sorted(this.#bids, "bid", limit),
      asks: this.#sorted(this.#asks, "ask", limit),
    };
  }

  #sorted(levels: Map<string, number>, side: "bid" | "ask", limit: number): BookLevel[] {
    const entries = [...levels.entries()]
      .filter(([, size]) => size > 0)
      .map(([price, size]) => ({ price, size, value: new Decimal(price) }));
    // Perbandingan memakai Decimal, TIDAK pernah float.
    entries.sort((left, right) =>
      side === "bid" ? right.value.cmp(left.value) : left.value.cmp(right.value),
    );
    return entries.slice(0, limit).map(({ price, size }) => ({ price, size }));
  }
}

/** Ukuran absolut: > 0 set level, == 0 hapus level. */
function applyLevel(levels: Map<string, number>, level: BookLevel, side: "bid" | "ask"): void {
  const price = new Decimal(level.price);
  if (price.lessThanOrEqualTo(0)) {
    throw new InvalidBookError(`Harga level ${side} harus positif: ${level.price}`);
  }
  if (!Number.isInteger(level.size) || level.size < 0) {
    throw new InvalidBookError(`Ukuran level ${side} harus cacah bulat >= 0: ${level.size}`);
  }
  const key = price.toString();
  if (level.size === 0) {
    // Ukuran ABSOLUT: 0 berarti level dihapus.
    levels.delete(key);
    return;
  }
  levels.set(key, level.size);
}

function toLevelMap(levels: readonly BookLevel[], side: "bid" | "ask"): Map<string, number> {
  const map = new Map<string, number>();
  let previous: Decimal | null = null;
  for (const level of levels) {
    const price = new Decimal(level.price);
    if (previous !== null) {
      const ordered = side === "bid" ? previous.greaterThanOrEqualTo(price) : previous.lessThanOrEqualTo(price);
      if (!ordered) {
        throw new InvalidBookError(`Snapshot ${side} tidak terurut pada ${level.price}`);
      }
    }
    previous = price;
    applyLevel(map, level, side);
  }
  return map;
}
