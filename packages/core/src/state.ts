import type { BookSnapshot, MarketEvent, Ticker } from "./market.js";
import type { ContractSpec } from "./contract.js";
import type { Direction } from "./exchange/types.js";
import { unrealizedPnl } from "./exchange/pnl.js";
import { Decimal } from "./money.js";
import { deriveAccount, type AccountInput, type AccountValuation } from "./exchange/margin.js";

/**
 * MarketState — objek pasif, tanpa I/O. Dibangun dari stream MarketEvent dan
 * dibaca oleh Strategy/Jev/Decision. Tidak menyimpan referensi ke provider.
 * Lihat docs/decisions/0004.
 */
export class MarketState {
  #ticker: Ticker | null = null;
  #book: BookSnapshot | null = null;
  #lastEventTsMs = 0;

  constructor(readonly contract: string) {}

  apply(event: MarketEvent): void {
    switch (event.type) {
      case "ticker":
        if (event.ticker.contract === this.contract) {
          this.#ticker = event.ticker;
          this.#lastEventTsMs = event.ticker.eventTsMs;
        }
        return;
      case "book_snapshot":
        if (event.snapshot.contract === this.contract) {
          this.#book = event.snapshot;
          this.#lastEventTsMs = event.snapshot.eventTsMs;
        }
        return;
      default:
        return;
    }
  }

  get ticker(): Ticker | null {
    return this.#ticker;
  }

  get book(): BookSnapshot | null {
    return this.#book;
  }

  get markPrice(): string | null {
    return this.#ticker?.markPrice ?? null;
  }

  get lastPrice(): string | null {
    return this.#ticker?.lastPrice ?? null;
  }

  get lastEventTsMs(): number {
    return this.#lastEventTsMs;
  }

  /** Mark price basi tidak boleh dipakai untuk likuidasi. Lihat ADR 0003. */
  isMarkStale(nowMs: number, staleAfterMs: number): boolean {
    if (this.#lastEventTsMs === 0) {
      return true;
    }
    return nowMs - this.#lastEventTsMs > staleAfterMs;
  }
}

export interface OpenPositionForValuation {
  readonly spec: ContractSpec;
  readonly direction: Direction;
  readonly size: number;
  readonly entryPrice: string;
}

/** Nilai akun dari posisi terbuka pada mark price saat ini (murni). */
export function valueAccount(
  account: AccountInput,
  positions: readonly OpenPositionForValuation[],
  markPrice: Decimal.Value,
): AccountValuation {
  const unrealized = positions.reduce(
    (total, position) => total.plus(unrealizedPnl(position.spec, position, markPrice)),
    new Decimal(0),
  );
  return deriveAccount(account, unrealized);
}