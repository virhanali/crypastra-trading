import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import { assertValidPrice } from "./contract-math.js";
import { pnlFor } from "./pnl.js";
import type { Direction } from "./types.js";

/**
 * Settlement penutupan paksa (TP/SL/likuidasi) untuk margin ISOLATED.
 *
 * Perbedaan penting dari `liquidationOutcome` (helper Phase 2): pada model ledger
 * Phase 1+, margin posisi TERPISAH dari `wallet_balance`. Margin tidak pernah
 * dipotong dari kas; ia hanya terkunci di `used_margin`. Karena itu kerugian
 * realisasi harus dibatasi oleh margin posisi yang dilepas, BUKAN oleh
 * `initial_margin + upnl` yang mengasumsikan margin ada di dalam kas.
 *
 * Konsekuensinya:
 *   pnlAppliedToWallet = max(realizedPnl, −releasedMargin)
 *   deficit            = max(0, −realizedPnl − releasedMargin)
 *
 * `deficit` adalah kerugian yang melebihi kolateral isolated dan tidak dapat
 * ditagih (gap melewati harga likuidasi). Nilai ini TIDAK dihapus: ia dicatat
 * eksplisit sebagai entri ledger `liquidation_loss` (lihat ADR 0008).
 */

export type ForcedCloseReason = "manual" | "take_profit" | "stop_loss" | "liquidation";

export interface ForcedCloseSettlementInput {
  readonly spec: ContractSpec;
  readonly direction: Direction;
  readonly size: number;
  readonly entryPrice: Decimal.Value;
  readonly exitPrice: Decimal.Value;
  /** Margin awal posisi yang ditutup (akan dilepas seluruhnya). */
  readonly initialMargin: Decimal.Value;
}

export interface ForcedCloseSettlement {
  /** PnL realisasi sebenarnya dari ukuran yang ditutup. */
  readonly realizedPnl: Decimal;
  /** Margin posisi yang dilepas kembali ke available. */
  readonly releasedMargin: Decimal;
  /** Porsi PnL yang benar-benar dibebankan ke wallet (sudah dibatasi). */
  readonly pnlAppliedToWallet: Decimal;
  /** Kerugian melebihi kolateral isolated; >= 0. */
  readonly deficit: Decimal;
  readonly insolvent: boolean;
}

export function settleIsolatedClose(input: ForcedCloseSettlementInput): ForcedCloseSettlement {
  const realizedPnl = pnlFor(
    input.spec,
    input.direction,
    input.size,
    input.entryPrice,
    input.exitPrice,
  );
  const releasedMargin = new Decimal(input.initialMargin);
  const floorForWallet = releasedMargin.negated();

  const pnlAppliedToWallet = realizedPnl.lessThan(floorForWallet)
    ? floorForWallet
    : realizedPnl;
  const deficit = realizedPnl.lessThan(floorForWallet)
    ? floorForWallet.minus(realizedPnl)
    : new Decimal(0);

  return {
    realizedPnl,
    releasedMargin,
    pnlAppliedToWallet,
    deficit,
    insolvent: deficit.greaterThan(0),
  };
}

/**
 * Harga eksekusi untuk penutupan paksa TIDAK boleh diasumsikan sama dengan harga
 * trigger. Panggilan ini hanya memvalidasi harga eksekusi yang diberikan
 * pemanggil (dari buku/snapshot eksekusi eksplisit).
 */
export function assertExecutablePrice(price: Decimal.Value, label = "Harga eksekusi"): Decimal {
  return assertValidPrice(price, label);
}

/**
 * Kutipan eksekusi eksplisit. Harga penutupan paksa TIDAK diambil dari harga
 * trigger; ia diambil dari kutipan ini (buku/last yang benar-benar tersedia).
 */
export interface ExecutionQuote {
  readonly contract: string;
  readonly bidPrice: Decimal.Value;
  readonly askPrice: Decimal.Value;
}

/**
 * Harga eksekusi untuk menutup posisi:
 *   LONG  ditutup dengan SELL → memakai BID (harga beli terbaik lawan)
 *   SHORT ditutup dengan BUY  → memakai ASK
 *
 * Ini yang membuat gap jujur: kalau mark sudah melewati trigger, harga eksekusi
 * tetap berasal dari kutipan yang diberikan, bukan dari harga trigger.
 */
export function executionPriceFor(direction: Direction, quote: ExecutionQuote): Decimal {
  const bid = assertValidPrice(quote.bidPrice, "Harga bid eksekusi");
  const ask = assertValidPrice(quote.askPrice, "Harga ask eksekusi");
  return direction === "long" ? bid : ask;
}

/** Sisi order yang menutup posisi: long ditutup dengan sell, short dengan buy. */
export function closingSide(direction: Direction): "buy" | "sell" {
  return direction === "long" ? "sell" : "buy";
}
