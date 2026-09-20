import { Decimal } from "../money.js";
import type { MarketEvent } from "../market.js";

/**
 * Model observasi pasar ternormalisasi untuk rekam/putar-ulang (Phase 8).
 *
 * Observasi adalah SATU-SATUNYA bentuk yang disimpan. Kita tidak menyimpan
 * payload mentah Gate, dan replay TIDAK mem-parse ulang payload Gate: jalur
 * live dan jalur replay melewati observasi yang sama (ADR 0011).
 *
 * Dua kelas data (jangan dicampur):
 *
 *   EKONOMI   — menentukan perilaku paper exchange:
 *               `mark` (valuasi/UPnL/likuidasi/TP-SL), `quote` (harga eksekusi),
 *               `funding` (arus kas periodik).
 *   ANALITIK  — `candle` tertutup: bukan pengganti mark maupun quote yang dapat
 *               dieksekusi; nanti dipakai indikator/strategy/scanner.
 *
 * `sourceTimestampMs` = jam EXCHANGE (atau jam sumber), `observedAtMs` = jam
 * LOKAL kita saat observasi diterima. Keduanya disimpan terpisah karena
 * staleness dihitung sebagai `observedAtMs − sourceTimestampMs`, persis seperti
 * saat live.
 */

export const OBSERVATION_KINDS = ["mark", "quote", "funding", "candle"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export interface ObservationBase {
  readonly contract: string;
  /** Jam sumber (exchange), epoch ms. */
  readonly sourceTimestampMs: number;
  /** Jam lokal saat diterima, epoch ms. Ini yang menggerakkan VirtualClock. */
  readonly observedAtMs: number;
}

export interface MarkObservation extends ObservationBase {
  readonly kind: "mark";
  readonly markPrice: string;
  readonly lastPrice: string | null;
  readonly indexPrice: string | null;
}

export interface QuoteObservation extends ObservationBase {
  readonly kind: "quote";
  readonly bestBid: string | null;
  readonly bestBidSize: number | null;
  readonly bestAsk: string | null;
  readonly bestAskSize: number | null;
}

/**
 * Observasi funding WAJIB membawa mark saat itu.
 *
 * Alasannya: `MarkToMarketService` menghitung funding dari notional pada MARK,
 * dan replay harus mandiri (self-contained) — bukan merekonstruksi funding dari
 * API hari ini, dan bukan memakai mark terakhir yang kebetulan tersimpan.
 */
export interface FundingRecord extends ObservationBase {
  readonly kind: "funding";
  readonly fundingRate: string;
  readonly fundingTimestampMs: number;
  readonly intervalSeconds: number;
  readonly markPrice: string;
}

export interface CandleObservation extends ObservationBase {
  readonly kind: "candle";
  readonly interval: string;
  readonly openTimeSeconds: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: number;
  readonly closed: boolean;
}

export type MarketObservation =
  | MarkObservation
  | QuoteObservation
  | FundingRecord
  | CandleObservation;

// ─────────────────────────────────────────────────────────────
// Konversi observasi → MarketEvent (SATU jalur untuk live & replay)
// ─────────────────────────────────────────────────────────────

/**
 * Ubah observasi menjadi event ternormalisasi yang dikonsumsi `MarketRuntime`.
 *
 * Live DAN replay memakai fungsi ini, sehingga tidak ada "jalur parser A untuk
 * live, jalur parser B untuk replay".
 *
 * - `mark` dan `funding` → event `ticker` (membawa mark; funding hanya terisi
 *   bila observasinya funding), sehingga alur funding live dan replay identik.
 * - `quote` → event `book_ticker`.
 * - `candle` → event `candle`.
 */
export function observationToEvents(observation: MarketObservation): MarketEvent[] {
  switch (observation.kind) {
    case "mark":
      return [
        {
          type: "ticker",
          ticker: {
            contract: observation.contract,
            lastPrice: observation.lastPrice ?? observation.markPrice,
            markPrice: observation.markPrice,
            indexPrice: observation.indexPrice ?? observation.markPrice,
            fundingRate: null,
            fundingRateIndicative: null,
            fundingNextApplySeconds: null,
            fundingIntervalSeconds: null,
            eventTsMs: observation.sourceTimestampMs,
          },
        },
      ];
    case "funding":
      return [
        {
          type: "ticker",
          ticker: {
            contract: observation.contract,
            lastPrice: observation.markPrice,
            markPrice: observation.markPrice,
            indexPrice: observation.markPrice,
            fundingRate: observation.fundingRate,
            fundingRateIndicative: observation.fundingRate,
            fundingNextApplySeconds: Math.floor(observation.fundingTimestampMs / 1000),
            fundingIntervalSeconds: observation.intervalSeconds,
            eventTsMs: observation.sourceTimestampMs,
          },
        },
      ];
    case "quote":
      return [
        {
          type: "book_ticker",
          bookTicker: {
            contract: observation.contract,
            bestBid: observation.bestBid,
            bestBidSize: observation.bestBidSize,
            bestAsk: observation.bestAsk,
            bestAskSize: observation.bestAskSize,
            updateId: null,
            eventTsMs: observation.sourceTimestampMs,
          },
        },
      ];
    case "candle":
      return [
        {
          type: "candle",
          candle: {
            contract: observation.contract,
            interval: observation.interval,
            openTimeSeconds: observation.openTimeSeconds,
            o: observation.open,
            h: observation.high,
            l: observation.low,
            c: observation.close,
            v: observation.volume,
            sum: "0",
            windowClosed: observation.closed,
          },
        },
      ];
    default:
      return [];
  }
}

/**
 * Bentuk observasi dari event ternormalisasi (dipakai RECORDER saat live).
 *
 * `observedAtMs` = jam LOKAL saat event diterima, dan HARUS diberikan pemanggil.
 * Ini berbeda dari `sourceTimestampMs` (jam exchange): waktu exchange antar
 * kanal (ticker vs book_ticker) bisa saling mendahului, sedangkan waktu lokal
 * mengikuti urutan penerimaan dan karenanya tidak pernah mundur. Staleness
 * dihitung dari `observedAtMs − sourceTimestampMs`, jadi keduanya wajib benar.
 *
 * Mengembalikan `[]` bila event tidak perlu direkam (mis. ticker tanpa mark,
 * candle yang belum tertutup, atau quote yang tidak berubah — pemanggil yang
 * memutuskan dedupe "tidak berubah", lihat `shouldRecordObservation`).
 */
export function observationsFromEvent(event: MarketEvent, observedAtMs: number): MarketObservation[] {
  switch (event.type) {
    case "ticker": {
      const ticker = event.ticker;
      const result: MarketObservation[] = [];
      // Mark kosong/spasi diperlakukan sebagai TIDAK ADA, bukan nilai nol.
      if (isPresent(ticker.markPrice)) {
        result.push({
          kind: "mark",
          contract: ticker.contract,
          sourceTimestampMs: ticker.eventTsMs,
          observedAtMs,
          markPrice: String(ticker.markPrice),
          lastPrice: ticker.lastPrice === null ? null : String(ticker.lastPrice),
          indexPrice: ticker.indexPrice === null ? null : String(ticker.indexPrice),
        });
      }
      if (isPresent(ticker.fundingRate) && ticker.fundingNextApplySeconds !== null) {
        result.push({
          kind: "funding",
          contract: ticker.contract,
          sourceTimestampMs: ticker.eventTsMs,
          observedAtMs,
          fundingRate: String(ticker.fundingRate),
          fundingTimestampMs: ticker.fundingNextApplySeconds * 1000,
          intervalSeconds: ticker.fundingIntervalSeconds ?? 28800,
          // Funding wajib membawa mark saat itu; fallback ke last bila mark kosong
          // tidak dilakukan — mark yang tidak ada berarti observasi funding tidak
          // dapat berdiri sendiri, jadi dilewati.
          markPrice: String(ticker.markPrice),
        });
      }
      return result;
    }
    case "book_ticker": {
      const tick = event.bookTicker;
      return [
        {
          kind: "quote",
          contract: tick.contract,
          sourceTimestampMs: tick.eventTsMs,
          observedAtMs,
          bestBid: tick.bestBid,
          bestBidSize: tick.bestBidSize,
          bestAsk: tick.bestAsk,
          bestAskSize: tick.bestAskSize,
        },
      ];
    }
    case "candle": {
      const candle = event.candle;
      // Hanya candle TERTUTUP yang direkam (analitik): candle berjalan berubah
      // dan bukan keadaan final.
      if (!candle.windowClosed) {
        return [];
      }
      return [
        {
          kind: "candle",
          contract: candle.contract,
          sourceTimestampMs: candle.openTimeSeconds * 1000,
          observedAtMs,
          interval: candle.interval,
          openTimeSeconds: candle.openTimeSeconds,
          open: candle.o,
          high: candle.h,
          low: candle.l,
          close: candle.c,
          volume: candle.v,
          closed: true,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Apakah observasi layak ditulis, dibandingkan observasi TERAKHIR kontrak+jenis
 * yang sama.
 *
 * Kebijakan volume (ADR 0011):
 *  - `mark`  : SELALU ditulis. Frekuensi ticker rendah (~0.7/detik/kontrak), dan
 *              menulis setiap tick penting agar staleness replay identik dengan
 *              live (mark yang tidak berubah TETAP memperbarui waktunya).
 *  - `quote` : hanya saat best bid/ask/ukuran BERUBAH.
 *  - `funding`: hanya saat rate atau jadwal berubah.
 *  - `candle`: hanya candle tertutup (sudah difilter di atas).
 *
 * "Harga sama dua kali" pada waktu berbeda BUKAN duplikat: hanya nilai yang
 * benar-benar identik pada jenis yang bersifat keadaan (quote/funding) yang
 * dianggap tidak perlu ditulis ulang.
 */
export function shouldRecordObservation(
  next: MarketObservation,
  previous: MarketObservation | null,
): boolean {
  if (next.kind === "mark" || next.kind === "candle") {
    return true;
  }
  if (previous === null || previous.kind !== next.kind) {
    return true;
  }
  if (next.kind === "quote" && previous.kind === "quote") {
    return (
      next.bestBid !== previous.bestBid ||
      next.bestAsk !== previous.bestAsk ||
      next.bestBidSize !== previous.bestBidSize ||
      next.bestAskSize !== previous.bestAskSize
    );
  }
  if (next.kind === "funding" && previous.kind === "funding") {
    return (
      next.fundingRate !== previous.fundingRate ||
      next.fundingTimestampMs !== previous.fundingTimestampMs
    );
  }
  return true;
}

/**
 * Kunci identitas observasi untuk dedupe ingest.
 *
 * Berbasis identitas SUMBER (waktu sumber + jenis + kontrak + pembeda), bukan
 * berbasis nilai, sehingga nilai yang sah terulang pada waktu berbeda tetap
 * tersimpan. `discriminator` membedakan event dalam jenis yang sama (mis. id
 * candle = openTime).
 */
export function observationDedupeKey(observation: MarketObservation): string {
  const base = `${observation.contract}:${observation.kind}:${observation.sourceTimestampMs}`;
  if (observation.kind === "candle") {
    return `${base}:${observation.openTimeSeconds}`;
  }
  return base;
}

/** Nilai dianggap ada bila bukan null/undefined dan tidak kosong. */
function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Validasi ringan: nilai finansial harus string, bukan number. */
export function assertObservationsAreStrings(observation: MarketObservation): void {
  const values: unknown[] = [];
  switch (observation.kind) {
    case "mark":
      values.push(observation.markPrice, observation.lastPrice, observation.indexPrice);
      break;
    case "quote":
      values.push(observation.bestBid, observation.bestAsk);
      break;
    case "funding":
      values.push(observation.fundingRate, observation.markPrice);
      break;
    case "candle":
      values.push(observation.open, observation.high, observation.low, observation.close);
      break;
  }
  for (const value of values) {
    if (value === null) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Observasi ${observation.kind} memuat nilai finansial non-string`);
    }
    // Parse untuk memastikan bentuk desimalnya sah (bukan Number, bukan format).
    new Decimal(value);
  }
}
