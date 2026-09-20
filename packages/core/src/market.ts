export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export function virtualClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    nowMs: () => current,
    advance: (ms: number) => {
      if (ms < 0) {
        throw new Error("Clock virtual tidak boleh mundur");
      }
      current += ms;
    },
    set: (ms: number) => {
      if (ms < current) {
        throw new Error("Clock virtual tidak boleh mundur");
      }
      current = ms;
    },
  };
}

export interface Ticker {
  contract: string;
  lastPrice: string;
  markPrice: string;
  indexPrice: string;
  /** null = exchange tidak menyertakan field ini; JANGAN diisi "0" karangan. */
  fundingRate: string | null;
  fundingRateIndicative: string | null;
  fundingNextApplySeconds: number | null;
  fundingIntervalSeconds: number | null;
  eventTsMs: number;
}

export interface Candle {
  contract: string;
  interval: string;
  openTimeSeconds: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
  sum: string;
  windowClosed: boolean;
}

export interface Trade {
  contract: string;
  id: string;
  price: string;
  /** Ukuran absolut dalam kontrak. */
  size: number;
  /** Sisi taker. Gate.io mengirim `size` bertanda; tandanya dipindah ke sini. */
  takerSide: "buy" | "sell";
  eventTsMs: number;
}

export interface BookLevel {
  price: string;
  size: number;
}

export interface BookUpdate {
  contract: string;
  firstUpdateId: number;
  lastUpdateId: number;
  eventTsMs: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * Buku terbaik dari channel ringan `futures.book_ticker`.
 * `futures.order_book_update` TIDAK boleh dipakai untuk ini: payload-nya adalah
 * perubahan level (sering kosong), bukan best bid/ask.
 */
export interface BookTickerTick {
  contract: string;
  bestBid: string | null;
  bestBidSize: number | null;
  bestAsk: string | null;
  bestAskSize: number | null;
  updateId: number | null;
  eventTsMs: number;
}

export interface BookSnapshot {
  contract: string;
  updateId: number;
  eventTsMs: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export type MarketEvent =
  | { type: "ticker"; ticker: Ticker }
  | { type: "candle"; candle: Candle }
  | { type: "trade"; trade: Trade }
  | { type: "book_ticker"; bookTicker: BookTickerTick }
  | { type: "book_snapshot"; snapshot: BookSnapshot }
  | { type: "book_update"; update: BookUpdate };

export type MarketEventHandler = (event: MarketEvent) => void;

/**
 * Status koneksi feed.
 *  idle        = belum pernah/ sudah dihentikan secara sengaja (DISCONNECTED)
 *  connecting  = sedang membuka koneksi (CONNECTING)
 *  open        = tersambung (CONNECTED)
 *  reconnecting= terputus, menunggu percobaan ulang (RECONNECTING)
 *  degraded    = tersambung tetapi data tidak sehat (mis. tidak ada pesan/stall)
 *  closed      = ditutup
 */
export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "degraded"
  | "closed";

export interface MarketDataProvider {
  readonly id: string;
  readonly mode: "live" | "simulation" | "replay";
  readonly clock: Clock;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeTicker(contract: string): Promise<void>;
  subscribeCandles(contract: string, interval: string): Promise<void>;
  subscribeTrades(contract: string): Promise<void>;
  /** Opsional: channel ringan best bid/ask (mis. `futures.book_ticker`). */
  subscribeBookTicker?(contract: string): Promise<void>;
  subscribeBook(contract: string): Promise<void>;
  unsubscribe(contract: string): Promise<void>;
  onEvent(handler: MarketEventHandler): () => void;
  state(): ConnectionState;
  loadContract(contract: string): Promise<import("./contract.js").ContractSpec>;
  /** Observability opsional: perubahan status koneksi. */
  onStateChange?(handler: (state: ConnectionState, previous: ConnectionState) => void): () => void;
  /** Observability opsional: waktu pesan terakhir diterima (epoch ms). */
  lastMessageAtMs?(): number | null;
  /** Observability opsional: langganan yang DIINGINKAN, independen dari socket. */
  desiredSubscriptions?(): {
    tickers: string[];
    candles: Array<{ contract: string; interval: string }>;
    trades: string[];
    books: string[];
    bookTickers: string[];
  };
  loadCandles(contract: string, interval: string, limit: number): Promise<Candle[]>;
}