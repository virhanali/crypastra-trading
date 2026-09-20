import { parseMarkSnapshot, type BookSnapshot, type ExecutionQuote, type MarkSnapshot } from "@crypastra/core";

/**
 * Sumber snapshot pasar milik SERVER (Phase 5, disiapkan untuk Phase 6).
 *
 * API baca (account/positions) TIDAK boleh menerima mark price dari query
 * parameter klien. Nilai pasar harus datang dari abstraksi ini.
 *
 * Implementasi Phase 5 adalah in-memory yang diisi lewat endpoint simulasi
 * (atau langsung oleh test). Phase 6 akan menggantinya dengan MarketState yang
 * digerakkan WebSocket Gate.io tanpa mengubah pemanggilnya.
 */
export interface MarketSnapshot {
  readonly mark: MarkSnapshot;
  /** Buku terakhir yang diketahui. Dipakai untuk harga eksekusi. */
  readonly book: BookSnapshot | null;
}

export interface MarketSnapshotProvider {
  /** Snapshot terakhir untuk kontrak, atau null bila belum ada. */
  getMark(contract: string): MarkSnapshot | null;
  /** Snapshot untuk banyak kontrak sekaligus; kontrak tanpa data tidak disertakan. */
  getMarks(contracts: readonly string[]): Map<string, MarkSnapshot>;
  getBook(contract: string): BookSnapshot | null;
  /** Kontrak yang punya snapshot. */
  contracts(): string[];
}

/** Kutipan eksekusi dari puncak buku; null bila buku tidak tersedia/kosong. */
export function executionQuoteFrom(book: BookSnapshot | null): ExecutionQuote | null {
  if (book === null) {
    return null;
  }
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (bid === undefined || ask === undefined) {
    return null;
  }
  return { contract: book.contract, bidPrice: bid.price, askPrice: ask.price };
}

/**
 * Provider in-memory deterministik. Dipakai endpoint simulasi dan test.
 *
 * Sengaja menyimpan snapshot apa adanya: tidak ada interpolasi, tidak ada
 * fallback mark → last. Kalau tidak ada mark, kontrak dilaporkan tanpa nilai.
 */
export class InMemoryMarketSnapshotProvider implements MarketSnapshotProvider {
  readonly #snapshots = new Map<string, MarketSnapshot>();

  set(input: {
    mark: MarkSnapshot | unknown;
    book?: BookSnapshot | null;
  }): MarketSnapshot {
    const mark = parseMarkSnapshot(input.mark);
    const snapshot: MarketSnapshot = {
      mark,
      book: input.book ?? null,
    };
    this.#snapshots.set(mark.contract, snapshot);
    return snapshot;
  }

  setBook(contract: string, book: BookSnapshot): void {
    const existing = this.#snapshots.get(contract);
    if (existing === undefined) {
      throw new Error(`Tidak ada mark untuk ${contract}; set mark sebelum book`);
    }
    this.#snapshots.set(contract, { mark: existing.mark, book });
  }

  getMark(contract: string): MarkSnapshot | null {
    return this.#snapshots.get(contract)?.mark ?? null;
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
    return this.#snapshots.get(contract)?.book ?? null;
  }

  get(contract: string): MarketSnapshot | null {
    return this.#snapshots.get(contract) ?? null;
  }

  contracts(): string[] {
    return [...this.#snapshots.keys()].sort();
  }

  clear(): void {
    this.#snapshots.clear();
  }
}

/** Provider kosong: semua kontrak tanpa mark. Berguna untuk produksi tanpa feed. */
export class EmptyMarketSnapshotProvider implements MarketSnapshotProvider {
  getMark(): MarkSnapshot | null {
    return null;
  }
  getMarks(): Map<string, MarkSnapshot> {
    return new Map();
  }
  getBook(): BookSnapshot | null {
    return null;
  }
  contracts(): string[] {
    return [];
  }
}
