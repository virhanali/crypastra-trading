import { Decimal } from "../money.js";
import type { BookLevel, Candle } from "../market.js";

/**
 * MarketState milik server (Phase 6).
 *
 * Semua nilai finansial adalah `Decimal`/string; tidak pernah `number`.
 * Field yang belum tersedia tetap `null` — TIDAK pernah diisi dengan harga lain
 * (mark tidak pernah disubstitusi dengan last, dan sebaliknya).
 *
 * `sourceTimestampMs` (waktu exchange) dan `receivedAtMs` (waktu kita) disimpan
 * terpisah supaya staleness dapat dinilai terhadap jam exchange, bukan asumsi.
 */

export interface DepthBookView {
  readonly status: "syncing" | "synced" | "unsynced";
  readonly updateId: number | null;
  readonly bidCount: number;
  readonly askCount: number;
}

export interface ContractMarketState {
  readonly contract: string;

  lastPrice: Decimal | null;
  lastPriceAtMs: number | null;

  markPrice: Decimal | null;
  markPriceAtMs: number | null;

  indexPrice: Decimal | null;
  indexPriceAtMs: number | null;

  fundingRate: Decimal | null;
  fundingNextApplyMs: number | null;
  fundingIntervalSeconds: number | null;

  bestBid: Decimal | null;
  bestBidSize: number | null;
  bestAsk: Decimal | null;
  bestAskSize: number | null;
  bookTickerUpdateId: number | null;
  bookTickerAtMs: number | null;

  depth: DepthBookView | null;

  /** Candle 5m terakhir: terbaru (mungkin masih berjalan) dan terakhir tertutup. */
  latestCandle: Candle | null;
  latestClosedCandle: Candle | null;

  lastReceivedAtMs: number | null;
}

export interface MarketStateSnapshot {
  readonly contract: string;
  readonly markPrice: Decimal | null;
  readonly markSourceTimestampMs: number | null;
  readonly markReceivedAtMs: number | null;
  readonly lastPrice: Decimal | null;
  readonly indexPrice: Decimal | null;
}

export class MarketStateStore {
  readonly #contracts = new Map<string, ContractMarketState>();

  constructor(contracts: readonly string[]) {
    for (const contract of contracts) {
      this.#contracts.set(contract, emptyState(contract));
    }
  }

  contracts(): string[] {
    return [...this.#contracts.keys()].sort();
  }

  get(contract: string): ContractMarketState | null {
    return this.#contracts.get(contract) ?? null;
  }

  /** Kontrak yang dilacak (dikonfigurasi). */
  tracked(): string[] {
    return this.contracts();
  }

  #require(contract: string): ContractMarketState {
    const state = this.#contracts.get(contract);
    if (state === undefined) {
      throw new Error(`Kontrak ${contract} tidak dilacak oleh MarketState`);
    }
    return state;
  }

  applyTicker(input: {
    contract: string;
    lastPrice: string | null;
    markPrice: string | null;
    indexPrice: string | null;
    fundingRate: string | null;
    fundingNextApplySeconds: number | null;
    fundingIntervalSeconds: number | null;
    sourceTimestampMs: number;
    receivedAtMs: number;
  }): void {
    const state = this.#require(input.contract);
    // Setiap harga disimpan apa adanya; yang tidak ada tetap null.
    if (input.lastPrice !== null) {
      state.lastPrice = new Decimal(input.lastPrice);
      state.lastPriceAtMs = input.sourceTimestampMs;
    }
    if (input.markPrice !== null) {
      state.markPrice = new Decimal(input.markPrice);
      state.markPriceAtMs = input.sourceTimestampMs;
    }
    if (input.indexPrice !== null) {
      state.indexPrice = new Decimal(input.indexPrice);
      state.indexPriceAtMs = input.sourceTimestampMs;
    }
    if (input.fundingRate !== null) {
      state.fundingRate = new Decimal(input.fundingRate);
    }
    if (input.fundingNextApplySeconds !== null) {
      state.fundingNextApplyMs = input.fundingNextApplySeconds * 1000;
    }
    if (input.fundingIntervalSeconds !== null) {
      state.fundingIntervalSeconds = input.fundingIntervalSeconds;
    }
    state.lastReceivedAtMs = input.receivedAtMs;
  }

  applyBookTicker(input: {
    contract: string;
    bestBid: string | null;
    bestBidSize: number | null;
    bestAsk: string | null;
    bestAskSize: number | null;
    updateId: number | null;
    sourceTimestampMs: number;
    receivedAtMs: number;
  }): void {
    const state = this.#require(input.contract);
    state.bestBid = input.bestBid === null ? null : new Decimal(input.bestBid);
    state.bestBidSize = input.bestBidSize;
    state.bestAsk = input.bestAsk === null ? null : new Decimal(input.bestAsk);
    state.bestAskSize = input.bestAskSize;
    state.bookTickerUpdateId = input.updateId;
    state.bookTickerAtMs = input.sourceTimestampMs;
    state.lastReceivedAtMs = input.receivedAtMs;
  }

  applyCandle(input: { candle: Candle; receivedAtMs: number }): void {
    const state = this.#require(input.candle.contract);
    const current = state.latestCandle;
    if (current === null || input.candle.openTimeSeconds >= current.openTimeSeconds) {
      // Candle sebelumnya yang tertutup menjadi referensi "terakhir tertutup".
      if (current !== null && input.candle.openTimeSeconds > current.openTimeSeconds) {
        state.latestClosedCandle = current;
      }
      state.latestCandle = input.candle;
    } else if (current.windowClosed) {
      state.latestClosedCandle = current;
    }
    if (input.candle.windowClosed) {
      state.latestClosedCandle = input.candle;
    }
    state.lastReceivedAtMs = input.receivedAtMs;
  }

  applyDepthView(contract: string, depth: DepthBookView): void {
    this.#require(contract).depth = depth;
  }

  /**
   * Snapshot pasar untuk konsumen (provider/mark processor).
   *
   * `markSourceTimestampMs` = jam exchange; `markReceivedAtMs` = jam kita.
   * Keduanya dibedakan eksplisit agar staleness tidak tertukar.
   */
  snapshot(contract: string): MarketStateSnapshot | null {
    const state = this.#contracts.get(contract);
    if (state === undefined) {
      return null;
    }
    return {
      contract,
      markPrice: state.markPrice,
      markSourceTimestampMs: state.markPriceAtMs,
      markReceivedAtMs: state.lastReceivedAtMs,
      lastPrice: state.lastPrice,
      indexPrice: state.indexPrice,
    };
  }

  /** Buku terbaik: hanya bila KEDUA sisi ada; kalau tidak, null (bukan karangan). */
  topOfBook(contract: string): { bid: BookLevel; ask: BookLevel } | null {
    const state = this.#contracts.get(contract);
    if (state === undefined || state.bestBid === null || state.bestAsk === null) {
      return null;
    }
    return {
      bid: { price: state.bestBid.toString(), size: state.bestBidSize ?? 0 },
      ask: { price: state.bestAsk.toString(), size: state.bestAskSize ?? 0 },
    };
  }
}

function emptyState(contract: string): ContractMarketState {
  return {
    contract,
    lastPrice: null,
    lastPriceAtMs: null,
    markPrice: null,
    markPriceAtMs: null,
    indexPrice: null,
    indexPriceAtMs: null,
    fundingRate: null,
    fundingNextApplyMs: null,
    fundingIntervalSeconds: null,
    bestBid: null,
    bestBidSize: null,
    bestAsk: null,
    bestAskSize: null,
    bookTickerUpdateId: null,
    bookTickerAtMs: null,
    depth: null,
    latestCandle: null,
    latestClosedCandle: null,
    lastReceivedAtMs: null,
  };
}
