import { Decimal } from "../money.js";
import type { ExitReason, TradeRecord } from "./trade-record.js";

/**
 * Metrik evaluasi baseline (Phase 11). Deterministik dan DESKRIPTIF.
 *
 * Tidak ada Sharpe/rasio statistik lain: semantik sampling return belum
 * didefinisikan dengan benar, dan baseline ini bukan klaim signifikansi.
 */
export interface BaselineMetrics {
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  readonly winRate: string | null;

  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly netPnl: string;
  readonly averageWin: string | null;
  readonly averageLoss: string | null;
  readonly expectancyPerTrade: string | null;
  readonly expectancyR: string | null;
  /** null bila grossLoss = 0 (tidak ada kerugian). Bukan angka besar palsu. */
  readonly profitFactor: string | null;

  readonly averageR: string | null;
  readonly totalR: string;
  readonly tradesWithValidR: number;

  readonly startingEquity: string;
  readonly endingEquity: string;
  readonly maxDrawdown: string;
  readonly maxDrawdownPct: string | null;

  readonly averageHoldingDurationMs: string | null;
  readonly averageMae: string | null;
  readonly averageMfe: string | null;

  readonly longTrades: number;
  readonly shortTrades: number;

  readonly tpExits: number;
  readonly slExits: number;
  readonly liquidationExits: number;
  readonly manualExits: number;

  readonly evaluationVersion: string;
}

export interface EvaluateTradesInput {
  readonly trades: readonly TradeRecord[];
  readonly startingEquity: Decimal.Value;
  readonly evaluationVersion: string;
}

function averageOf(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}

/**
 * Hitung metrik dari trade yang SUDAH ditutup.
 *
 * Trade dengan `exitTimeMs === null` (masih terbuka) TIDAK dihitung dalam
 * metrik realisasi, karena akan mencampur ekuitas belum terealisasi ke kurva
 * realisasi. Jumlahnya dilaporkan terpisah lewat `tradeCount` yang hanya
 * menghitung trade tertutup.
 */
export function evaluateTrades(input: EvaluateTradesInput): BaselineMetrics {
  const closed = input.trades
    .filter((trade) => trade.exitTimeMs !== null)
    .slice()
    .sort((a, b) => (a.exitTimeMs! - b.exitTimeMs!) || a.tradeId.localeCompare(b.tradeId));

  const nets = closed.map((trade) => new Decimal(trade.netPnl));
  const positives = nets.filter((value) => value.greaterThan(0));
  const negatives = nets.filter((value) => value.lessThan(0));
  const zeros = nets.filter((value) => value.isZero());

  const grossProfit = positives.reduce((sum, value) => sum.plus(value), new Decimal(0));
  const grossLossAbs = negatives.reduce((sum, value) => sum.plus(value.abs()), new Decimal(0));
  const netTotal = nets.reduce((sum, value) => sum.plus(value), new Decimal(0));

  const rs = closed
    .map((trade) => trade.rMultiple)
    .filter((value): value is string => value !== null)
    .map((value) => new Decimal(value));
  const totalR = rs.reduce((sum, value) => sum.plus(value), new Decimal(0));

  // Kurva ekuitas realisasi: hanya netPnl trade tertutup, urut waktu keluar.
  let equity = new Decimal(input.startingEquity);
  let peak = equity;
  let maxDrawdown = new Decimal(0);
  let maxDrawdownPct = new Decimal(0);
  for (const net of nets) {
    equity = equity.plus(net);
    if (equity.greaterThan(peak)) {
      peak = equity;
    }
    const drawdown = peak.minus(equity);
    if (drawdown.greaterThan(maxDrawdown)) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak.isZero() ? new Decimal(0) : drawdown.div(peak).times(100);
    }
  }

  const holdingDurations = closed
    .map((trade) => trade.holdingDurationMs)
    .filter((value): value is number => value !== null)
    .map((value) => new Decimal(value));

  const exitCounts = (reason: ExitReason): number =>
    closed.filter((trade) => trade.exitReason === reason).length;

  const averageWin = averageOf(positives);
  const averageLoss = averageOf(negatives);

  return {
    tradeCount: closed.length,
    wins: positives.length,
    losses: negatives.length,
    breakeven: zeros.length,
    winRate:
      closed.length === 0
        ? null
        : new Decimal(positives.length).div(closed.length).times(100).toString(),

    grossProfit: grossProfit.toString(),
    grossLoss: grossLossAbs.toString(),
    netPnl: netTotal.toString(),
    averageWin: averageWin?.toString() ?? null,
    averageLoss: averageLoss?.toString() ?? null,
    expectancyPerTrade: closed.length === 0 ? null : netTotal.div(closed.length).toString(),
    expectancyR: rs.length === 0 ? null : totalR.div(rs.length).toString(),
    profitFactor: grossLossAbs.isZero() ? null : grossProfit.div(grossLossAbs).toString(),

    averageR: averageOf(rs)?.toString() ?? null,
    totalR: totalR.toString(),
    tradesWithValidR: rs.length,

    startingEquity: new Decimal(input.startingEquity).toString(),
    endingEquity: equity.toString(),
    maxDrawdown: maxDrawdown.toString(),
    maxDrawdownPct:
      maxDrawdown.isZero() ? "0" : maxDrawdownPct.toString(),

    averageHoldingDurationMs: averageOf(holdingDurations)?.toString() ?? null,
    averageMae: averageOf(closed.map((trade) => new Decimal(trade.mae)))?.toString() ?? null,
    averageMfe: averageOf(closed.map((trade) => new Decimal(trade.mfe)))?.toString() ?? null,

    longTrades: closed.filter((trade) => trade.side === "long").length,
    shortTrades: closed.filter((trade) => trade.side === "short").length,

    tpExits: exitCounts("take_profit"),
    slExits: exitCounts("stop_loss"),
    liquidationExits: exitCounts("liquidation"),
    manualExits: exitCounts("manual"),

    evaluationVersion: input.evaluationVersion,
  };
}
