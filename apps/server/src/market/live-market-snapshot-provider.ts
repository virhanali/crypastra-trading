import {
  markFreshness,
  type BookSnapshot,
  type Clock,
  type DepthBook,
  type MarketStateStore,
  type MarkSnapshot,
  type StalenessPolicy,
} from "@crypastra/core";
import type { MarketSnapshotProvider } from "./market-snapshot-provider.js";

/**
 * Provider pasar LIVE (Phase 6) yang memenuhi interface Phase 5 tanpa mengubah
 * DTO maupun pemanggil service.
 *
 * Prinsip:
 *  - `getMark` mengembalikan mark DARI EXCHANGE saja. Bila mark belum ada,
 *    hasilnya `null` — tidak pernah disubstitusi dengan last/index.
 *  - `getBook` mengembalikan buku yang dapat dieksekusi: buku kedalaman lokal
 *    bila SYNCED, atau top-of-book dari book_ticker bila KEDUA sisi ada.
 *    Buku yang belum sinkron TIDAK pernah diekspos untuk eksekusi.
 *  - Staleness dihitung dari jam exchange (`sourceTimestampMs`), bukan dari
 *    waktu terima, sehingga keterlambatan sumber terlihat apa adanya.
 */
export interface LiveMarketSnapshotProviderOptions {
  readonly state: MarketStateStore;
  readonly clock: Clock;
  readonly staleness: StalenessPolicy;
  /** Buku kedalaman lokal per kontrak (hanya yang dikonfigurasi). */
  readonly depth?: ReadonlyMap<string, DepthBook>;
  /** Kedalaman level yang diekspos ke matching. */
  readonly depthLevels?: number;
}

export class LiveMarketSnapshotProvider implements MarketSnapshotProvider {
  readonly #state: MarketStateStore;
  readonly #clock: Clock;
  readonly #staleness: StalenessPolicy;
  readonly #depth: ReadonlyMap<string, DepthBook>;
  readonly #depthLevels: number;

  constructor(options: LiveMarketSnapshotProviderOptions) {
    this.#state = options.state;
    this.#clock = options.clock;
    this.#staleness = options.staleness;
    this.#depth = options.depth ?? new Map();
    this.#depthLevels = options.depthLevels ?? 20;
  }

  getMark(contract: string): MarkSnapshot | null {
    const state = this.#state.get(contract);
    if (state === null || state.markPrice === null || state.markPriceAtMs === null) {
      return null;
    }
    return {
      contract,
      markPrice: state.markPrice.toString(),
      // `observedAtMs` = jam kita saat ditanya; `sourceTimestampMs` = jam exchange.
      observedAtMs: this.#clock.nowMs(),
      sourceTimestampMs: state.markPriceAtMs,
      funding:
        state.fundingRate === null || state.fundingNextApplyMs === null
          ? null
          : {
              fundingRate: state.fundingRate.toString(),
              fundingTimestampMs: state.fundingNextApplyMs,
              intervalSeconds: state.fundingIntervalSeconds ?? 28800,
            },
    };
  }

  getMarks(contracts: readonly string[]): Map<string, MarkSnapshot> {
    const result = new Map<string, MarkSnapshot>();
    for (const contract of contracts) {
      const mark = this.getMark(contract);
      if (mark !== null) {
        result.set(contract, mark);
      }
    }
    return result;
  }

  getBook(contract: string): BookSnapshot | null {
    // Buku kedalaman lokal diprioritaskan, tetapi HANYA bila SYNCED.
    const book = this.#depth.get(contract);
    if (book !== undefined && book.isExecutable()) {
      return book.toBookSnapshot(this.#depthLevels, this.#clock.nowMs());
    }
    // Fallback: top-of-book dari book_ticker, hanya bila kedua sisi ada.
    const top = this.#state.topOfBook(contract);
    if (top === null) {
      return null;
    }
    return {
      contract,
      updateId: this.#state.get(contract)?.bookTickerUpdateId ?? 0,
      eventTsMs: this.#clock.nowMs(),
      bids: [top.bid],
      asks: [top.ask],
    };
  }

  contracts(): string[] {
    return this.#state.contracts();
  }

  /** Apakah mark kontrak ini basi/tidak ada — dipakai health & API. */
  markStatus(contract: string): "fresh" | "stale" | "missing" {
    const mark = this.getMark(contract);
    if (mark === null) {
      return "missing";
    }
    return markFreshness(mark, this.#staleness).stale ? "stale" : "fresh";
  }

  staleContracts(): string[] {
    return this.#state
      .contracts()
      .filter((contract) => this.markStatus(contract) !== "fresh");
  }

  unsyncedBooks(): string[] {
    return [...this.#depth.entries()]
      .filter(([, book]) => !book.isExecutable())
      .map(([contract]) => contract)
      .sort();
  }
}
