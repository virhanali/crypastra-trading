import {
  Decimal,
  type BookLevel,
  type Clock,
  type ConnectionState,
  type ContractSpec,
  type MarketDataProvider,
  type MarketEventHandler,
} from "@crypastra/core";

export interface SimMarketDataProviderOptions {
  readonly contract: ContractSpec;
  readonly clock: Clock;
  readonly initialPrice?: string;
}

/**
 * Provider simulasi: harga disuntik manual. Dipakai untuk test deterministik
 * dan mode SIMULATION. Tidak ada I/O.
 */
export class SimMarketDataProvider implements MarketDataProvider {
  readonly id = "sim";
  readonly mode = "simulation" as const;
  readonly clock: Clock;
  readonly #spec: ContractSpec;
  readonly #handlers = new Set<MarketEventHandler>();
  #state: ConnectionState = "idle";

  constructor(options: SimMarketDataProviderOptions) {
    this.#spec = options.contract;
    this.clock = options.clock;
  }

  state(): ConnectionState {
    return this.#state;
  }

  onEvent(handler: MarketEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #broadcast(event: Parameters<MarketEventHandler>[0]): void {
    for (const handler of this.#handlers) {
      handler(event);
    }
  }

  async connect(): Promise<void> {
    this.#state = "open";
  }

  async disconnect(): Promise<void> {
    this.#state = "closed";
  }

  async subscribeTicker(): Promise<void> {}
  async subscribeCandles(): Promise<void> {}
  async subscribeTrades(): Promise<void> {}
  async subscribeBook(): Promise<void> {}
  async unsubscribe(): Promise<void> {}

  setPrice(price: string, bookDepth = 100): void {
    const current = new Decimal(price);
    const bids: BookLevel[] = [
      { price: current.toFixed(), size: bookDepth },
      { price: current.minus(1).toFixed(), size: bookDepth },
    ];
    const asks: BookLevel[] = [
      { price: current.plus(this.#spec.orderPriceRound).toFixed(), size: bookDepth },
      { price: current.plus(1).toFixed(), size: bookDepth },
    ];
    const ts = this.clock.nowMs();

    this.#broadcast({
      type: "book_snapshot",
      snapshot: {
        contract: this.#spec.contract,
        updateId: ts,
        eventTsMs: ts,
        bids,
        asks,
      },
    });
    this.#broadcast({
      type: "ticker",
      ticker: {
        contract: this.#spec.contract,
        lastPrice: current.toFixed(),
        markPrice: current.toFixed(),
        indexPrice: current.toFixed(),
        fundingRate: "0",
        fundingRateIndicative: "0",
        fundingNextApplySeconds: null,
        fundingIntervalSeconds: this.#spec.fundingIntervalSeconds,
        eventTsMs: ts,
      },
    });
  }

  async loadContract(): Promise<ContractSpec> {
    return this.#spec;
  }

  async loadCandles(): Promise<[]> {
    return [];
  }
}