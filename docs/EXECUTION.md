# Autonomous PAPER Execution (`execution-v1`)

Implementasi: `apps/server/src/execution/` (`TradeExecutionService`,
`AutonomousTradeTracker`), repositori `decision-executions` / `trade-records`.

```
Feature → Scanner → Decision → Risk → TradePlan
                                          ↓
                                   Execution Gate
                                          ↓
                                    OrderService   (PAPER, sudah ada)
                                          ↓
                                    Paper Exchange
                                          ↓
                                 AccountRiskState yang berkembang
```

**PAPER ONLY.** Tidak ada endpoint privat Gate, tidak ada WebSocket privat, tidak
ada kredensial exchange, tidak ada order nyata. Gate tetap hanya sumber data
pasar publik.

## Gate eksekusi

Dua flag diperlukan, keduanya default OFF:

```
CRYPASTRA_DECISIONS=1        # evaluasi keputusan (Phase 10)
CRYPASTRA_EXECUTION=1        # eksekusi PAPER otonom (Phase 11)
CRYPASTRA_DECISION_ACCOUNT=<accountId>
```

- `CRYPASTRA_EXECUTION=1` tanpa `CRYPASTRA_DECISIONS=1` → eksekusi **tidak**
  aktif. Eksekusi tidak dapat hidup tanpa keputusan.
- Tanpa akun eksplisit → tidak ada eksekusi.
- Startup selalu mencetak `AUTONOMOUS PAPER EXECUTION: ON|OFF`. Tidak pernah
  "LIVE TRADING".

**Gate OFF bersifat inert.** `TradeExecutionService(enabled: false)` tidak
memanggil OrderService dan **tidak menulis baris apa pun** — termasuk tabel
linkage. Keputusan yang disetujui tetap dipersist oleh lapisan Phase 10.

## Pemetaan Decision → OrderIntent

Pemetaan langsung, tanpa perhitungan ulang:

| TradePlan | OrderIntent |
|---|---|
| `contract` | `contract` |
| `side` (`long`/`short`) | `side` (`buy`/`sell`) |
| `orderType` (`market`) | `type` |
| `size` | `size` |
| `leverage` | `leverage` |
| `takeProfit` | `tpPrice` |
| `stopLoss` | `slPrice` |

`timeInForce = "ioc"`, `price = null`, `reduceOnly = false`.

Dilarang di lapisan ini: menghitung ulang indikator, memindai ulang, mengubah
ukuran, mengubah leverage, mengubah SL/TP, atau menghitung ulang kebijakan
risiko. TradePlan Phase 10 otoritatif untuk perencanaan; OrderService otoritatif
untuk eksekusi.

## Idempotensi & keamanan restart

Command id deterministik:

```
commandId = "auto-entry:" + decisionId
decisionId = "dec:" + account + contract + interval + candleCloseT
             + decisionVersion + scannerVersion + scannerConfigHash + riskPolicyHash
```

Jaminan berlapis:

1. `decision_executions` unik per `decision_id` → satu keputusan disetujui =
   paling banyak satu entry.
2. OrderService sendiri idempoten pada `commandId` (`trade_commands`), sehingga
   percobaan ulang tidak menambah ekonomi baru.

Karena command id diturunkan dari identitas keputusan (bukan dari waktu atau
urutan proses), **restart proses aman**: instance baru menghasilkan command id
yang sama dan OrderService mengenalinya sebagai duplikat.

## Persistensi & linkage

Tabel `decision_executions` menjawab: keputusan X → dicoba? → command id? →
order id? → posisi? → status? → alasan gagal?

Kolom: `id`, `decision_id` (unik), `account_id`, `command_id`, `order_id`,
`position_id`, `status`, `error_code`, `error_detail`, `planned_reference`,
`actual_fill_price`, `attempted_at`, `updated_at`.

Bukan tabel ekonomi: ia tidak menyimpan ulang order/fill, dan kegagalan
mencatatnya tidak mengubah keputusan untuk tidak mengeksekusi.

## Status eksekusi

`pending` → `submitted` → `filled` | `resting` | `rejected` | `failed`, plus
`skipped`.

Pemetaan dari status order: `filled`→`filled`; `rejected`/`cancelled`/`expired`
→`rejected`; `open`/`partially_filled`→`resting`.

**Penolakan ekonomi ≠ kegagalan sistem.** Penolakan ekonomi (mis. ukuran
melanggar batas kontrak, dana kurang) dicatat `rejected` dengan
`error_code` seperti `ORDER_REJECTED` / `INSUFFICIENT_FUNDS`; kegagalan
sistem/persistensi dicatat `failed` dengan `EXECUTION_FAILED`. Sebuah order
`rejected` yang tersimpan **bukan** kegagalan infrastruktur.

## SKIP tidak pernah dieksekusi

`executeApprovedDecision` menolak secara struktural keputusan dengan
`action != "trade"` atau `tradePlan == null` → status `skipped`,
`error_code = DECISION_NOT_APPROVED`, tanpa pernah menyentuh OrderService.
Diuji dengan 10.000 evaluasi SKIP → nol order.

## Quote drift (rencana vs isian)

`TradePlan.referencePrice` adalah **konteks perencanaan**, bukan harga isian.
OrderService memakai kutipan PAPER yang dapat dieksekusi SAAT ITU. Karena itu:

- harga isian aktual bisa berbeda dari acuan;
- `decision_executions.actual_fill_price` mencatat isian sebenarnya;
- `trade_records.planned_reference` dan `actual_entry` disimpan terpisah dan
  **tidak** diklaim sama.

Slippage masuk = `actualFill − plannedReference` (LONG) atau
`plannedReference − actualFill` (SHORT). Ini slippage **simulator**, bukan
slippage exchange nyata.

## Risiko: rencana vs aktual

Karena isian bisa bergerak, risiko awal aktual dihitung dari **isian sebenarnya**
dan SL yang dipersist:

```
actualInitialRisk = |actualEntry − stopLoss| × quantoMultiplier × size terisi
```

Ukuran **tidak** diubah setelah isian, dan SL **tidak** digeser untuk memulihkan
risiko 1% yang direncanakan. Drift hanya **diukur** (`plannedRiskAmount` vs
`actualInitialRiskAmount`).

## Exit tetap milik Paper Exchange

Autonomous V1 hanya membuka posisi (dengan TP/SL di intent). Penutupan tetap
ditangani Paper Exchange yang sudah ada: TP/SL berbasis mark, likuidasi, dan
penutupan manual. **Tidak ada mesin exit kedua.**

## Keadaan akun yang berkembang

Setelah setiap efek ekonomi, `AccountRiskState` dibangun ulang dari keadaan
CURRENT (bukan cache): saldo tersedia, margin, jumlah posisi terbuka. Karena itu
`maxOpenPositions`, batas satu posisi per kontrak, dan cap margin benar-benar
mengikat seiring waktu.

Selama posisi pada kontrak yang sama terbuka, sinyal berikutnya → SKIP
(`EXISTING_CONTRACT_POSITION`). V1 tidak menambah, mengurangi, membalik, atau
average-down. Setelah posisi tertutup, sinyal pada candle berikutnya boleh
membuat keputusan baru.

Satu peluang keputusan per `(account, contract, timeframe, closed candle,
decision version, scanner/risk config)`. Tidak ada re-entry intrabar dari ticker.

## Coexistence dengan trading manual

Trading paper manual memakai Paper Exchange yang sama, sehingga `AccountRiskState`
juga melihat posisi manual. Bila posisi manual sudah ada di BTC, keputusan
otonom BTC mengikuti aturan kontrak-sama dan akan SKIP. Tidak ada wallet
terpisah untuk otonom.

## Ukuran kontrak desimal (Phase 11.5)

Kelengkapan eksekusi kini **sadar kontrak** (ADR 0015):

- `OrderIntent.size` divalidasi secara **sintaktis** (desimal positif berhingga).
- Apakah pecahan boleh adalah aturan kontrak: `assertValidSize` mewajibkan
  integer bila `enable_decimal=false` dan mengizinkan pecahan bila `true`
  (dalam `[orderSizeMin, orderSizeMax]`).
- Kontrak integer tetap menolak `"1.5"`; penolakan terekam sebagai order
  `rejected` ber-audit (`error_code = ORDER_REJECTED`), bukan exception.
- `SIZE_NOT_EXECUTABLE` kini hanya untuk ukuran yang benar-benar tidak sah
  (nol, negatif, non-hingga) — bukan untuk semua ukuran pecahan.
- Aritmetika ukuran memakai `Decimal` dengan satu titik konversi
  (`toContractCount`), sehingga tidak ada drift float.
- Fingerprint perintah memakai bentuk kanonik, jadi `"1.5"` dan `"1.50"`
  adalah perintah yang sama.

## Keterbatasan saat ini

1. **Partial close belum didukung** untuk trade otonom; TP/SL menutup penuh.
2. **Funding** mengikuti perilaku Phase 8 apa adanya (lihat `docs/EVALUATION.md`).
3. Cacah kontrak disimpan di kolom numerik SQLite; nilai pecahan tersimpan
   sebagai REAL tanpa kehilangan presisi (diverifikasi), tetapi affinity
   kolomnya tidak menyatakan itu secara eksplisit.

## Perlakuan Jev dan eksekusi (Phase 12)

Perlakuan berjalan SEBELUM DecisionEngine: kandidat yang diveto (atau gagal
tertutup) tidak pernah sampai ke eksekusi. Perlakuan tidak dapat mengubah
TradePlan: `decide()` tidak menerima parameter perlakuan, dan kode perlakuan
dilarang mengimpor `OrderService`/`TradeExecutionService`/repositori ekonomi
(guard impor di `tests/phase12-treatment.test.ts`).

Perlakuan juga tidak pernah menyentuh risiko posisi yang sudah terbuka:
likuidasi, TP, SL, funding, dan penutupan manual tetap milik Paper Exchange.
