import type { TicketSide, TicketType } from "./preview.js";

/**
 * Bentuk `OrderIntent` yang dikirim ke backend — cerminan server, nilai mentah
 * (string desimal), bukan hasil format tampilan.
 *
 * SENGAJA tanpa field asal/produsen: Paper Exchange tetap origin-agnostic
 * (ADR 0004). Label apa pun hanya untuk audit dan tidak mengubah perilaku.
 */
export interface OrderIntent {
  readonly contract: string;
  readonly side: TicketSide;
  readonly type: TicketType;
  readonly size: number;
  readonly price: string | null;
  readonly leverage: string;
  readonly timeInForce: "gtc" | "ioc" | "fok" | "post_only";
  readonly reduceOnly: boolean;
  readonly tpPrice: string | null;
  readonly slPrice: string | null;
}

/** Time in force default yang mengikuti tipe order (sama dengan server). */
export function defaultTimeInForce(type: TicketType): OrderIntent["timeInForce"] {
  return type === "market" ? "ioc" : "gtc";
}
