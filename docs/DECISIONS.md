# Decision Engine (`decision-v1`)

Lapisan keputusan otonom Phase 10. Menjawab:

> "Given this signal and account state, SHOULD we trade?"

dan, bila ya, merakit **TradePlan** paper yang diizinkan.

Implementasi murni: `packages/core/src/decision/`.

```
Feature Engine → Scanner → Candidate/Signal
                              ↓
                        Decision Engine   (haruskah?)
                              ↓
                          Risk Engine     (apa yang diizinkan?)
                              ↓
                          TradePlan
                              │
                              └── STOP (Phase 10 tidak mengeksekusi)
```

## Batas tanggung jawab

| Lapisan | Pertanyaan |
|---|---|
| Scanner | "setup pasar apa yang ada?" |
| Decision Engine | "apakah setup ini layak dipertimbangkan?" |
| Risk Engine | "trade apa yang diizinkan batasan akun/risiko?" |
| OrderService | "eksekusi intent yang sudah tervalidasi" |

Phase 10 berhenti sebelum OrderService. `TradePlan` **tidak** dikirim ke pasar.

Engine murni hanya boleh menerima: `FeatureSnapshot`, `ScannerResult`, konteks
pasar (`DecisionMarketContext`), `AccountRiskState`, `ContractSpec`, `RiskPolicy`.
Dilarang: DB, repository, `OrderService`/`PositionService`/`LedgerRepository`,
saldo langsung, HTTP, WebSocket, `Date.now()`, `Math.random()`. Ditegakkan test
yang memindai kode sumber `packages/core/src/decision/` (komentar dibuang).

Scanner tidak boleh melihat wallet/posisi/margin/leverage/budget risiko. Risk
Engine tidak boleh menghitung ulang EMA/RSI/MACD/ATR atau sinyal scanner.

## Skema Decision

```json
{
  "contract": "BTC_USDT",
  "timeframe": "5m",
  "candleCloseTimeMs": 1700000300000,
  "accountId": "acct-1",
  "decisionVersion": "decision-v1",
  "featureVersion": "features-v1",
  "scannerVersion": "scanner-v1",
  "scannerConfigHash": "dde5b8b7afef69d4",
  "riskPolicyVersion": "risk-v1",
  "riskPolicyHash": "…",
  "action": "trade",
  "direction": "long",
  "reasons": ["SIGNAL_LONG", "TRADE_APPROVED"],
  "tradePlan": { "…": "lihat di bawah" }
}
```

`action` = `trade` | `skip`. Untuk `skip`, `direction` dan `tradePlan` bernilai
`null`.

## Skema TradePlan

```json
{
  "contract": "BTC_USDT",
  "side": "long",
  "orderType": "market",
  "size": 125,
  "leverage": "10",
  "referencePrice": "80000",
  "stopLoss": "79200",
  "takeProfit": "81600",
  "notional": "1000",
  "initialMargin": "100",
  "riskAmount": "10",
  "riskPercent": "1",
  "rewardAmount": "20",
  "rewardRiskRatio": "2",
  "sourceSignal": "long",
  "stopDistance": "800",
  "stopDistancePct": "1"
}
```

Semua nilai uang/analitik adalah **string desimal**. `size` adalah cacah kontrak
(number, integer untuk kontrak non-desimal).

## Urutan evaluasi (deterministik)

1. sinyal (`SIGNAL_NEUTRAL` → skip)
2. batas posisi (`EXISTING_CONTRACT_POSITION`, `CONTRACT_POSITION_LIMIT`, `MAX_OPEN_POSITIONS`)
3. kutipan acuan (`QUOTE_UNAVAILABLE`)
4. ATR & jarak stop (`ATR_UNAVAILABLE`, `STOP_DISTANCE_TOO_TIGHT`, `STOP_DISTANCE_TOO_WIDE`)
5. normalisasi harga protektif ke tick
6. anggaran risiko (`RISK_BUDGET_TOO_SMALL`)
7. normalisasi ukuran (`SIZE_BELOW_MINIMUM`, `SIZE_FLOORED_INTEGER`, `SIZE_DECIMAL_FLOORED`)
8. cap notional & cap kontrak (`SIZE_CAPPED_NOTIONAL`, `SIZE_CAPPED_CONTRACT_MAX`)
9. leverage (`LEVERAGE_UNAVAILABLE`)
10. margin (`INSUFFICIENT_AVAILABLE_BALANCE`, `TOTAL_MARGIN_LIMIT`)
11. reward/risk setelah pembulatan (`REWARD_RISK_TOO_LOW`)
12. `TRADE_APPROVED`

## Reason codes

`SIGNAL_LONG`, `SIGNAL_SHORT`, `SIGNAL_NEUTRAL`, `SCANNER_SKIPPED`,
`WARMUP_INCOMPLETE`, `QUOTE_UNAVAILABLE`, `MARK_UNAVAILABLE`, `MARKET_STALE`,
`ATR_UNAVAILABLE`, `STOP_DISTANCE_TOO_TIGHT`, `STOP_DISTANCE_TOO_WIDE`,
`INVALID_STOP_DISTANCE`, `RISK_BUDGET_TOO_SMALL`, `SIZE_BELOW_MINIMUM`,
`SIZE_CAPPED_NOTIONAL`, `SIZE_CAPPED_CONTRACT_MAX`, `SIZE_FLOORED_INTEGER`,
`SIZE_DECIMAL_FLOORED`, `LEVERAGE_UNAVAILABLE`, `INSUFFICIENT_AVAILABLE_BALANCE`,
`TOTAL_MARGIN_LIMIT`, `MAX_OPEN_POSITIONS`, `CONTRACT_POSITION_LIMIT`,
`EXISTING_CONTRACT_POSITION`, `REWARD_RISK_TOO_LOW`, `TRADE_APPROVED`.

Keputusan selalu dapat dijelaskan dari `reasons` tanpa menafsir prosa.

## SKIP adalah warga kelas satu

SKIP **dipersist**. Evaluasi masa depan perlu tahu peluang apa yang ditolak dan
alasannya; menyimpan hanya rencana yang disetujui akan menghapus informasi itu.

## Persistensi & idempotensi

Tabel `decisions` (Phase 1, dibangun ulang di migrasi 0009). Idempoten per:

```
(account_id, contract, interval, candle_close_t,
 decision_version, scanner_version, scanner_config_hash, risk_policy_hash)
```

`id` diturunkan deterministik dari kunci itu (`dec:` + bagian-bagiannya) — bukan
UUID acak. Candle yang sama diproses berulang tetap menghasilkan satu baris
logis.

Kolom `risk_json` menyimpan `AccountRiskState` saat evaluasi (input risiko), dan
kolom rencana menyimpan hasil TradePlan. Tidak ada angka uang sebagai JSON number.

## Hashing kanonik

`decisionHash(decision)` memuat field bermakna ekonomi: action, direction, size,
leverage, harga acuan, SL, TP, notional, margin, risk amount, risk percent,
reward amount, RR, reason codes, dan semua versi/hash konfigurasi.

Tidak memuat: id baris DB, timestamp jam dinding, UUID, id acak.

`buildDecisionDigest(decisions)` menghasilkan `combinedHash` + distribusi
reasonCode untuk deret keputusan (dipakai uji determinisme replay).

## Mode observasi live

`CRYPASTRA_DECISIONS=1` + `CRYPASTRA_DECISION_ACCOUNT=<accountId>` menyalakan
evaluasi otonom di jalur live:

```
closed candle → FeatureEngine → Scanner → DecisionService → decisions (persisted)
```

Default **OFF**. Kegagalan keputusan tidak pernah menghentikan ingest pasar,
risk processing, atau trading paper manual. Tidak ada order yang ditempatkan.

## Batas replay

Replay menerima `DecisionService` dan memakai engine yang sama (tidak ada
`ReplayDecisionEngine`). Karena Phase 10 **tidak mengeksekusi**, keadaan akun
tidak berubah selama replay: akun awal deterministik tetap. Konsekuensinya
seluruh keputusan dievaluasi terhadap keadaan akun yang sama, dan batas posisi
tidak pernah "terisi". Keadaan akun otonom yang benar-benar berkembang baru ada
ketika eksekusi dinyalakan di fase berikutnya.

## Ini adalah KELOMPOK KONTROL

Decision Engine deterministik ini menjadi baseline untuk membandingkan evaluasi
Jev nanti:

```
Scanner ─┬─ baseline decision
         └─ Jev evaluation → modified/veto decision
```

Tidak ada hook Jev di Phase 10, dan tidak ada field seperti `aiConfidence` atau
`llmScore` di tipe baseline.

## Eksekusi (Phase 11)

Keputusan `trade` dengan gate eksekusi ON dan akun terpilih akan dieksekusi
PAPER oleh `TradeExecutionService` (`docs/EXECUTION.md`). Gate OFF: keputusan
tetap dipersist, tidak ada ekonomi yang dibuat. Keputusan `skip` tidak pernah
dapat dieksekusi. Satu keputusan = paling banyak satu entry, dengan command id
deterministik `auto-entry:<decisionId>`.

## Perlakuan opsional (Phase 12)

DecisionEngine tetap tidak tahu Jev. Orkestrasi di `DecisionCoordinator`:
kandidat scanner → perlakuan opsional → bila `allow` (atau tanpa perlakuan),
baru `DecisionService.evaluate`. Risk-v1 menerima jenis kandidat yang sama
seperti sebelumnya, dan TradePlan tidak pernah menerima masukan dari Jev.

Detail: `docs/JEV.md`, ADR 0016.
