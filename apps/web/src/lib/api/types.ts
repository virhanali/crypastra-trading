/**
 * DTO publik — cerminan docs/API.md.
 *
 * SEMUA nilai finansial adalah `string`. Tidak ada tipe persistensi server
 * yang diimpor ke frontend (batas yang disengaja).
 */

export interface AccountDto {
  readonly accountId: string;
  readonly name: string;
  readonly mode: string;
  readonly baseCurrency: string;
  readonly initialBalance: string;
  readonly createdAt: number;
  readonly resetAt: number | null;
}

export interface AccountSummaryDto {
  readonly accountId: string;
  readonly name: string;
  readonly mode: string;
  readonly baseCurrency: string;
  readonly walletBalance: string;
  readonly unrealizedPnl: string;
  readonly equity: string;
  readonly availableBalance: string;
  readonly reservedMargin: string;
  readonly positionMargin: string;
  readonly marginRatio: string | null;
  readonly openPositionCount: number;
  readonly openOrderCount: number;
  readonly valuationStatus: "fresh" | "stale" | "partial" | "unvalued";
  readonly unvaluedContracts: readonly string[];
  readonly latestEventSeq: number;
  readonly asOf: number;
}

export interface ContractDto {
  readonly contract: string;
  readonly base: string;
  readonly quote: string;
  readonly quantoMultiplier: string;
  readonly orderSizeMin: number;
  readonly orderSizeMax: number;
  readonly enableDecimal: boolean;
  readonly priceTick: string;
  readonly markPriceTick: string;
  readonly leverageMin: string;
  readonly leverageMax: string;
  readonly maintenanceRate: string;
  readonly makerFeeRate: string;
  readonly takerFeeRate: string;
  readonly fundingIntervalSeconds: number;
  readonly status: string;
}

export interface PositionDto {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly side: "long" | "short";
  readonly status: string;
  readonly size: string;
  readonly leverage: string;
  readonly entryPrice: string;
  readonly markPrice: string | null;
  readonly initialMargin: string;
  readonly maintenanceMargin: string | null;
  readonly unrealizedPnl: string | null;
  readonly realizedPnl: string;
  readonly accumulatedFunding: string;
  readonly feesPaid: string;
  readonly liquidationPrice: string | null;
  readonly liquidationState: string | null;
  readonly takeProfitPrice: string | null;
  readonly stopLossPrice: string | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly valuationStatus: "fresh" | "stale" | "unvalued";
}

export interface OrderDto {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly side: "buy" | "sell";
  readonly type: "market" | "limit";
  readonly timeInForce: string;
  readonly size: string;
  readonly price: string | null;
  readonly reduceOnly: boolean;
  readonly leverage: string;
  readonly status: string;
  readonly rejectReason: string | null;
  readonly filledSize: string;
  readonly remainingSize: string;
  readonly avgFillPrice: string | null;
  readonly reservedMargin: string;
  readonly takeProfitPrice: string | null;
  readonly stopLossPrice: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FillDto {
  readonly id: string;
  readonly orderId: string | null;
  readonly positionId: string | null;
  readonly contract: string;
  readonly side: "buy" | "sell";
  readonly size: string;
  readonly price: string;
  readonly liquidity: "maker" | "taker";
  readonly fee: string;
  readonly feeRate: string;
  readonly feeAsset: string;
  readonly realizedPnl: string;
  readonly isLiquidation: boolean;
  readonly isTpSl: boolean;
  readonly timestamp: number;
}

export interface HistoryEntryDto {
  readonly id: string;
  readonly contract: string;
  readonly side: "long" | "short";
  readonly status: string;
  readonly size: string;
  readonly entryPrice: string;
  readonly realizedPnl: string;
  readonly accumulatedFunding: string;
  readonly feesPaid: string;
  readonly closeReason: string | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
}

export interface LedgerEntryDto {
  readonly seq: number;
  readonly type: string;
  readonly amount: string;
  readonly balanceAfter: string;
  readonly marginDelta: string;
  readonly reservedDelta: string;
  readonly reference: { readonly type: string | null; readonly id: string | null };
  readonly timestamp: number;
}

export interface DomainEventDto {
  readonly seq: number;
  readonly type: string;
  readonly accountId: string;
  readonly aggregateType: string;
  readonly aggregateId: string | null;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export interface MarketStateDto {
  readonly contract: string;
  readonly markPrice: string | null;
  readonly markSourceTimestampMs: number | null;
  readonly markStatus: "fresh" | "stale" | "missing";
  readonly lastPrice: string | null;
  readonly indexPrice: string | null;
  readonly fundingRate: string | null;
  readonly fundingNextApplyMs: number | null;
  readonly bestBid: string | null;
  readonly bestBidSize: number | null;
  readonly bestAsk: string | null;
  readonly bestAskSize: number | null;
  readonly depthStatus: "syncing" | "synced" | "unsynced" | null;
}

export interface MarketStateResponseDto {
  readonly mode: "simulation" | "live";
  readonly asOf: number;
  readonly contracts: readonly MarketStateDto[];
}

export interface CandleDto {
  readonly openTime: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly closed: boolean;
}

export interface CandleResponseDto {
  readonly contract: string;
  readonly interval: string;
  readonly candles: readonly CandleDto[];
}

export interface FeedHealthDto {
  readonly state: string;
  readonly ready: boolean;
  readonly connectedSinceMs?: number | null;
  readonly lastMessageAtMs?: number | null;
  readonly reconnectCount?: number;
  readonly staleContracts?: readonly string[];
  readonly unsyncedBooks?: readonly string[];
  readonly [key: string]: unknown;
}

export interface MarketHealthResponseDto {
  readonly mode: "simulation" | "live";
  readonly feed: FeedHealthDto | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
