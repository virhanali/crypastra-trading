import { Decimal, type Clock } from "@crypastra/core";
import type { MarkToMarketService } from "../services/mark-to-market-service.js";
import type { PositionRepository } from "../repositories/position-repository.js";

/**
 * Pemroses risiko pasar — SOURCE-AGNOSTIC (Phase 8).
 *
 * Nama lama `LiveRiskProcessor` menyesatkan: kelas ini tidak bergantung pada
 * sumber data mana pun. Ia menerima mark terbaru per kontrak dan memprosesnya
 * lewat `MarkToMarketService`, sehingga live DAN replay memakai jalur yang sama
 * persis (tidak ada "replay risk engine" terpisah).
 *
 * Dipanggil oleh runtime pasar dengan mark TERBARU per kontrak (sudah
 * di-coalesce). Alih-alih memindai seluruh akun, ia hanya memproses akun yang
 * benar-benar punya posisi terbuka pada kontrak tersebut.
 *
 * Idempotensi: id perintah diturunkan dari (akun, kontrak, waktu sumber mark,
 * harga mark) — BUKAN UUID acak. Update Gate yang terduplikasi atau diputar
 * ulang setelah reconnect menghasilkan id yang sama, sehingga funding,
 * likuidasi, TP/SL, dan efek ledger tidak pernah berlipat.
 */
export interface MarketRiskProcessorDeps {
  readonly positions: PositionRepository;
  readonly markToMarket: MarkToMarketService;
  readonly clock: Clock;
}

export interface RiskTickResult {
  readonly contract: string;
  readonly accountsProcessed: readonly string[];
  readonly skipped: number;
}

export class MarketRiskProcessor {
  readonly #positions: PositionRepository;
  readonly #markToMarket: MarkToMarketService;
  readonly #clock: Clock;

  constructor(deps: MarketRiskProcessorDeps) {
    this.#positions = deps.positions;
    this.#markToMarket = deps.markToMarket;
    this.#clock = deps.clock;
  }

  /** Id perintah deterministik dari identitas mark, bukan acak. */
  static commandId(input: {
    accountId: string;
    contract: string;
    sourceTimestampMs: number;
    markPrice: string;
  }): string {
    return `live-mark:${input.accountId}:${input.contract}:${input.sourceTimestampMs}:${input.markPrice}`;
  }

  /**
   * Proses satu mark untuk kontrak tertentu.
   *
   * `mark` adalah `Ticker` yang diterima runtime; hanya mark price dan waktu
   * sumbernya yang dipakai, sehingga identitas perintah stabil.
   */
  handleMark(contract: string, mark: { markPrice: string; eventTsMs: number }): RiskTickResult {
    const open = this.#positions.listOpenByContract(contract);
    if (open.length === 0) {
      return { contract, accountsProcessed: [], skipped: 0 };
    }

    const byAccount = new Map<string, typeof open>();
    for (const position of open) {
      const list = byAccount.get(position.accountId);
      if (list === undefined) {
        byAccount.set(position.accountId, [position]);
      } else {
        list.push(position);
      }
    }

    const accountsProcessed: string[] = [];
    let skipped = 0;

    for (const [accountId, positions] of byAccount) {
      const commandId = MarketRiskProcessor.commandId({
        accountId,
        contract,
        sourceTimestampMs: mark.eventTsMs,
        markPrice: mark.markPrice,
      });
      try {
        this.#markToMarket.processMark({
          commandId,
          accountId,
          mark: {
            contract,
            markPrice: mark.markPrice,
            observedAtMs: this.#clock.nowMs(),
            sourceTimestampMs: mark.eventTsMs,
            funding: null,
          },
          execution: this.#executionFor(contract, mark.markPrice),
          nowMs: this.#clock.nowMs(),
        });
        accountsProcessed.push(accountId);
      } catch {
        // Mark duplikat (idempotent) atau posisi sudah tertutup: lanjutkan saja.
        skipped += 1;
      }
      void positions;
    }

    return { contract, accountsProcessed, skipped };
  }

  /**
   * Kutipan eksekusi untuk penutupan paksa. Runtime risiko memakai mark sebagai
   * referensi; penyedia kutipan sebenarnya (buku) diisi oleh provider pasar.
   * Di sini sengaja memakai mark dengan spread nol dan itu DIDOKUMENTASIKAN
   * sebagai kebijakan simulator untuk jalur risiko otomatis — bukan klaim bahwa
   * Gate akan mengisi di harga itu.
   */
  #executionFor(contract: string, markPrice: string): { contract: string; bidPrice: string; askPrice: string } {
    const mark = new Decimal(markPrice);
    return { contract, bidPrice: mark.toString(), askPrice: mark.toString() };
  }
}

/**
 * Alias lama supaya pemanggil Phase 6/7 tidak putus. Gunakan nama
 * `MarketRiskProcessor` untuk kode baru.
 */
export { MarketRiskProcessor as LiveRiskProcessor };
export type LiveRiskProcessorDeps = MarketRiskProcessorDeps;
