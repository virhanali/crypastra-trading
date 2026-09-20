import { z } from "zod";
import { Decimal } from "../money.js";
import { ContractSpec, DecimalSchema } from "../contract.js";

export const DirectionSchema = z.enum(["long", "short"]);
export type Direction = z.infer<typeof DirectionSchema>;

export const OrderSideSchema = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["market", "limit"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const TimeInForceSchema = z.enum(["gtc", "ioc", "fok", "post_only"]);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

export const LiquiditySchema = z.enum(["maker", "taker"]);
export type Liquidity = z.infer<typeof LiquiditySchema>;

export const OrderStatusSchema = z.enum([
  "created",
  "validated",
  "rejected",
  "open",
  "partially_filled",
  "filled",
  "cancelled",
  "expired",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const PositionStatusSchema = z.enum(["open", "closed", "liquidated"]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

export type OrderOrigin = "human" | "strategy" | "jev" | "replay" | "test";

/**
 * `size` = cacah kontrak, divalidasi secara SINTAKTIS di sini (desimal positif
 * berhingga). Apakah komponen pecahan DIIZINKAN adalah urusan kontrak:
 * `assertValidSize` menolak pecahan bila `enableDecimal=false` dan menerimanya
 * bila `true`. Memisahkan keduanya mencegah skema menolak intent yang sah untuk
 * kontrak desimal, tanpa melemahkan kontrak integer.
 */
export const OrderIntentSchema = z
  .object({
    contract: z.string().min(1),
    side: OrderSideSchema,
    type: OrderTypeSchema,
    size: z.number().finite().positive(),
    price: DecimalSchema.nullable(),
    leverage: DecimalSchema,
    timeInForce: TimeInForceSchema,
    reduceOnly: z.boolean(),
    tpPrice: DecimalSchema.nullable(),
    slPrice: DecimalSchema.nullable(),
  })
  .strict();

export type OrderIntent = z.infer<typeof OrderIntentSchema>;

export interface ValidatedOrder {
  readonly intent: OrderIntent;
  readonly spec: ContractSpec;
  readonly origin: OrderOrigin;
  readonly createdAtMs: number;
}

export interface Fill {
  readonly orderId: string;
  readonly contract: string;
  readonly side: OrderSide;
  readonly size: number;
  readonly price: string;
  readonly liquidity: Liquidity;
  readonly fee: string;
  readonly feeRate: string;
  readonly realizedPnl: string;
  readonly isLiquidation: boolean;
  readonly isTpSl: boolean;
  readonly tsMs: number;
}

export interface Position {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly direction: Direction;
  readonly status: PositionStatus;
  readonly size: number;
  readonly entryPrice: string;
  readonly leverage: string;
  readonly initialMargin: string;
  readonly accumulatedFunding: string;
  readonly feesPaid: string;
  readonly realizedPnl: string;
  readonly tpPrice: string | null;
  readonly slPrice: string | null;
  readonly liquidationPrice: string | null;
  readonly openedAtMs: number;
}

export interface AccountSnapshot {
  readonly accountId: string;
  readonly walletBalance: Decimal;
  readonly usedMargin: Decimal;
  readonly reservedMargin: Decimal;
  readonly realizedPnl: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly feesPaid: Decimal;
  readonly fundingPaid: Decimal;
}

export interface DerivedAccount {
  readonly walletBalance: Decimal;
  readonly usedMargin: Decimal;
  readonly reservedMargin: Decimal;
  readonly availableBalance: Decimal;
  readonly equity: Decimal;
  readonly unrealizedPnl: Decimal;
  readonly marginRatio: Decimal | null;
}

export function directionOf(side: OrderSide): Direction {
  return side === "buy" ? "long" : "short";
}

export function sideToReduce(direction: Direction): OrderSide {
  return direction === "long" ? "sell" : "buy";
}