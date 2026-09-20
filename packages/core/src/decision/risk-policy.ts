import { z } from "zod";
import { fingerprint } from "../exchange/canonical.js";

/**
 * Kebijakan risiko `risk-v1` — PAPER BASELINE, bukan hasil optimasi.
 *
 * Seluruh ambang hidup di sini; tidak ada angka yang tersebar di kode. Config
 * dapat diserialisasi dan di-hash supaya eksperimen dapat dibandingkan jujur.
 *
 * Default dipilih KONSERVATIF dan TIDAK diklaim optimal atau menguntungkan.
 * Tidak ada pencarian parameter terhadap hasil replay (Phase 10 §37).
 */
export const RISK_POLICY_VERSION = "risk-v1";

export const RiskPolicySchema = z.object({
  /** Risiko per transaksi sebagai persen equity. 1% = kerugian bila SL kena. */
  riskPerTradePct: z.string().default("1"),
  /** Batas notional posisi terhadap equity. Menahan sizing berbasis risiko saat SL sangat rapat. */
  maxPositionNotionalPct: z.string().default("300"),
  /** Batas total margin (posisi + tertahan + rencana baru) terhadap equity. */
  maxTotalMarginPct: z.string().default("50"),
  /** Batas jumlah posisi terbuka lintas kontrak. */
  maxOpenPositions: z.number().int().positive().default(5),
  /** Batas jumlah posisi terbuka per kontrak. */
  maxPositionsPerContract: z.number().int().positive().default(1),
  /** Leverage default; TIDAK diturunkan dari keyakinan sinyal. */
  defaultLeverage: z.string().default("10"),
  /** Batas leverage tegas di samping batas kontrak. */
  maxLeverage: z.string().default("20"),
  /** Pengali ATR untuk jarak stop awal. */
  atrStopMultiplier: z.string().default("2"),
  /** Target reward terhadap risiko. */
  rewardRiskRatio: z.string().default("2"),
  /** RR minimum yang harus tetap terpenuhi SETELAH pembulatan tick. */
  minimumRewardRiskRatio: z.string().default("1.5"),
  /** Jarak stop minimum sebagai persen harga; ATR bisa menghasilkan stop patologis. */
  minimumStopDistancePct: z.string().default("0.2"),
  /** Jarak stop maksimum sebagai persen harga. */
  maximumStopDistancePct: z.string().default("5"),
});

export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export const DEFAULT_RISK_POLICY: RiskPolicy = RiskPolicySchema.parse({});

/** Hash urutan-kunci-independen atas kebijakan risiko. */
export function riskPolicyHash(policy: RiskPolicy): string {
  const parsed = RiskPolicySchema.parse(policy);
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed).sort()) {
    ordered[key] = (parsed as Record<string, unknown>)[key];
  }
  return fingerprint(JSON.stringify(ordered));
}
