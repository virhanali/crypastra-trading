/**
 * Store terminal (Svelte 5 runes).
 *
 * Batas penting:
 *  - STATE PASAR (ephemeral) dan STATE AKUN (durable) dipisahkan. Tick pasar
 *    tidak pernah menulis ke state akun, dan event domain tidak pernah menimpa
 *    harga pasar.
 *  - Frontend TIDAK menghitung ulang akuntansi: seluruh angka akun berasal dari
 *    `GET /summary` dan peristiwa domain yang memicunya untuk memuat ulang.
 *  - Perubahan pasar di-coalesce per frame (`requestAnimationFrame`) supaya
 *    tick berfrekuensi tinggi tidak merender seluruh aplikasi.
 */
import type { AccountDto, AccountSummaryDto, ContractDto, CandleDto, MarketStateDto, PositionDto, OrderDto, FillDto, HistoryEntryDto, LedgerEntryDto } from "../api/types.js";

export type FeedStatus = "LIVE" | "RECONNECTING" | "STALE" | "DEGRADED" | "OFFLINE" | "SIMULATION";

export interface MarketStateView {
  readonly contract: string;
  markPrice: string | null;
  lastPrice: string | null;
  indexPrice: string | null;
  fundingRate: string | null;
  fundingNextApplyMs: number | null;
  bestBid: string | null;
  bestBidSize: number | null;
  bestAsk: string | null;
  bestAskSize: number | null;
  markStatus: "fresh" | "stale" | "missing";
  markSourceTimestampMs: number | null;
  /** Waktu kita menerima pembaruan terakhir (untuk indikator "stale" lokal). */
  receivedAtMs: number | null;
  depthStatus: string | null;
}

export function emptyMarketState(contract: string): MarketStateView {
  return {
    contract,
    markPrice: null,
    lastPrice: null,
    indexPrice: null,
    fundingRate: null,
    fundingNextApplyMs: null,
    bestBid: null,
    bestBidSize: null,
    bestAsk: null,
    bestAskSize: null,
    markStatus: "missing",
    markSourceTimestampMs: null,
    receivedAtMs: null,
    depthStatus: null,
  };
}

/**
 * Terapkan event pasar ke view. Hanya bidang yang benar-benar ada yang ditimpa;
 * yang tidak ada TIDAK diisi dengan harga lain.
 */
export function applyMarketEvent(
  current: MarketStateView,
  event: { type: string; contract: string; timestamp: number; data: Record<string, unknown> },
  receivedAtMs: number,
): MarketStateView {
  if (event.contract !== current.contract) {
    return current;
  }
  const next: MarketStateView = { ...current, receivedAtMs };

  if (event.type === "market.mark") {
    const mark = asStringOrNull(event.data.markPrice);
    const last = asStringOrNull(event.data.lastPrice);
    const index = asStringOrNull(event.data.indexPrice);
    if (mark !== null) {
      next.markPrice = mark;
      next.markSourceTimestampMs = event.timestamp;
      next.markStatus = "fresh";
    }
    if (last !== null) {
      next.lastPrice = last;
    }
    if (index !== null) {
      next.indexPrice = index;
    }
    const funding = asStringOrNull(event.data.fundingRate);
    if (funding !== null) {
      next.fundingRate = funding;
    }
    return next;
  }

  if (event.type === "market.book") {
    next.bestBid = asStringOrNull(event.data.bestBid);
    next.bestBidSize = asNumberOrNull(event.data.bestBidSize);
    next.bestAsk = asStringOrNull(event.data.bestAsk);
    next.bestAskSize = asNumberOrNull(event.data.bestAskSize);
    return next;
  }

  if (event.type === "market.status") {
    return next;
  }

  return next;
}

/** Gabungkan state server (otoritatif) dengan pembaruan realtime. */
export function mergeServerState(current: MarketStateView | null, server: MarketStateDto): MarketStateView {
  const base = current === null || current.contract !== server.contract ? emptyMarketState(server.contract) : current;
  return {
    ...base,
    markPrice: server.markPrice ?? base.markPrice,
    lastPrice: server.lastPrice ?? base.lastPrice,
    indexPrice: server.indexPrice ?? base.indexPrice,
    fundingRate: server.fundingRate ?? base.fundingRate,
    fundingNextApplyMs: server.fundingNextApplyMs ?? base.fundingNextApplyMs,
    bestBid: server.bestBid ?? base.bestBid,
    bestBidSize: server.bestBidSize ?? base.bestBidSize,
    bestAsk: server.bestAsk ?? base.bestAsk,
    bestAskSize: server.bestAskSize ?? base.bestAskSize,
    markStatus: server.markStatus,
    markSourceTimestampMs: server.markSourceTimestampMs ?? base.markSourceTimestampMs,
    depthStatus: server.depthStatus ?? base.depthStatus,
  };
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Status feed yang ditampilkan. Sengaja TIDAK memakai status socket browser:
 * WebSocket browser bisa "connected" sementara data pasar sudah basi.
 */
export function deriveFeedStatus(input: {
  mode: "simulation" | "live" | null;
  feedState: string | null;
  markStatus: "fresh" | "stale" | "missing";
  markReceivedAtMs: number | null;
  nowMs: number;
  staleAfterMs?: number;
}): FeedStatus {
  if (input.mode === "simulation") {
    return "SIMULATION";
  }
  if (input.markStatus === "missing") {
    return "OFFLINE";
  }
  const maxAge = input.staleAfterMs ?? 10_000;
  const age = input.markReceivedAtMs === null ? null : input.nowMs - input.markReceivedAtMs;
  if (input.markStatus === "stale" || age === null || age > maxAge) {
    return "STALE";
  }
  if (input.feedState === "reconnecting" || input.feedState === "degraded") {
    return input.feedState === "reconnecting" ? "RECONNECTING" : "DEGRADED";
  }
  if (input.feedState === "open") {
    return "LIVE";
  }
  return "OFFLINE";
}

/** Status pasar untuk ditampilkan; nilai basi ditandai, bukan disembunyikan. */
export function marketValueState(view: MarketStateView): "fresh" | "stale" | "missing" {
  return view.markStatus;
}

export type { AccountDto, AccountSummaryDto, ContractDto, CandleDto, PositionDto, OrderDto, FillDto, HistoryEntryDto, LedgerEntryDto };
