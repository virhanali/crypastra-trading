# Evaluasi Baseline (`evaluation-v1`)

Implementasi murni: `packages/core/src/evaluation/`.
Materialisasi: `trade_records` (DERIVED, lihat bawah).

Tujuan: mengukur kinerja **baseline kontrol** secara deterministik sebelum Jev
hadir sebagai perlakuan. Metrik ini **deskriptif** — bukan klaim signifikansi
statistik dan bukan hasil optimasi.

## TradeRecord

```
tradeId, accountId, decisionId, contract, side
decisionTimeMs, entryTimeMs, exitTimeMs
plannedReference, actualEntry
size, leverage, stopLoss, takeProfit
plannedRiskAmount, actualInitialRiskAmount
grossRealizedPnl, fees, funding, netPnl
exitReason, mae, mfe, maeR, mfeR, rMultiple, holdingDurationMs
featureVersion, scannerVersion, scannerConfigHash
decisionVersion, riskPolicyVersion, riskPolicyHash, evaluationVersion
```

Semua nilai uang/analitik adalah **string desimal**.

`trade_records` adalah materialisasi **DERIVED**: sumber kebenaran ekonomi tetap
`orders`/`fills`/`positions`/`ledger`. Barisnya boleh dibangun ulang dan tidak
dipakai logika ekonomi apa pun.

Identitas trade: `tradeId = "trade:" + decisionId` — terikat ke keputusan, order
masuk, posisi, fill, dan efek ledger. Bukan hanya kontrak, karena satu kontrak
bisa ditradingkan berkali-kali secara berurutan.

## Siklus hidup

1. Eksekusi terisi → posisi terbuka → `TradeRecord` disisipkan dengan
   `exitTimeMs = null`, `exitReason = "open"`.
2. Setiap mark yang sudah terjadi memperbarui MAE/MFE secara **inkremental**.
3. Posisi ditutup (TP/SL/likuidasi/manual oleh Paper Exchange) → record
   difinalisasi: `exitTimeMs`, `exitReason`, PnL, `rMultiple`, durasi.

`exitReason`: `take_profit` | `stop_loss` | `liquidation` | `manual` | `open`.

## MAE / MFE

Diperbarui dari **mark** (konsisten dengan valuasi/risiko simulator). Tidak ada
look-ahead: hanya mark yang sudah terjadi.

```
LONG : MFE = max(mark − entry), MAE = max(entry − mark)
SHORT: MFE = max(entry − mark), MAE = max(mark − entry)
```

Keduanya selalu ≥ 0 dan monoton naik (mark yang lebih baik tidak mengecilkan
MFE). Selain nilai harga, disimpan `maeR`/`mfeR` = MAE/MFE dibagi risiko awal
aktual (null bila risiko 0).

## Net PnL

```
netPnl = grossRealizedPnl − fees − funding
```

`fees` dan `funding` memakai konvensi **BIAYA POSITIF** (rebate bernilai
negatif), konsisten dengan `fees_paid`/`accumulated_funding` di ledger. Nilainya
**tidak** disimpulkan dari delta wallet, karena wallet juga bergerak oleh efek
lain (deposit, penarikan, margin meta).

## R multiple

```
rMultiple = netPnl / actualInitialRiskAmount
```

`null` bila risiko awal aktual ≤ 0 (dilaporkan sebagai `tradesWithValidR`
terpisah, bukan dibagi nol). R membuat hasil dapat dibandingkan lintas ukuran
akun.

## Metrik agregat

Hanya trade **tertutup** yang masuk metrik realisasi. Trade yang masih terbuka
tidak dicampur ke kurva ekuitas realisasi.

| Metrik | Definisi |
|---|---|
| `tradeCount` | jumlah trade tertutup |
| `wins` / `losses` / `breakeven` | `netPnl` > 0 / < 0 / = 0 |
| `winRate` | `wins / tradeCount × 100`, null bila 0 trade |
| `grossProfit` | jumlah `netPnl` positif |
| `grossLoss` | nilai absolut jumlah `netPnl` negatif |
| `netPnl` | jumlah seluruh `netPnl` |
| `averageWin` / `averageLoss` | rata-rata pada kelompoknya, null bila kosong |
| `expectancyPerTrade` | `netPnl / tradeCount`, null bila 0 trade |
| `expectancyR` | `totalR / tradesWithValidR`, null bila tidak ada R valid |
| `profitFactor` | `grossProfit / grossLoss`; **null** bila `grossLoss = 0` |
| `averageR` / `totalR` | atas trade dengan R valid |
| `maxDrawdown` / `maxDrawdownPct` | peak-to-trough kurva ekuitas realisasi |
| `averageHoldingDurationMs` | rata-rata `exitTimeMs − entryTimeMs` |
| `averageMae` / `averageMfe` | rata-rata ekskursi harga |
| `longTrades` / `shortTrades` | berdasarkan sisi |
| `tpExits` / `slExits` / `liquidationExits` / `manualExits` | distribusi alasan keluar |

**Profit factor tanpa kerugian dilaporkan `null`**, bukan angka sangat besar
yang palsu.

**Drawdown** dihitung dari kurva ekuitas realisasi berurutan waktu keluar
(tie-break `tradeId` agar deterministik), dimulai dari `startingEquity`:

```
equity     += netPnl
peak        = max(peak, equity)
drawdown    = peak − equity
drawdownPct = drawdown / peak × 100
```

Ekuitas belum terealisasi di dalam trade tidak dicampur ke kurva ini.

**Sharpe dan rasio statistik lain tidak dihitung**: semantik sampling return
belum didefinisikan dengan benar untuk baseline ini.

## Versi & identitas eksperimen

Setiap hasil evaluasi memuat `evaluationVersion = "evaluation-v1"` beserta
`featureVersion`, `scannerVersion`, `scannerConfigHash`, `decisionVersion`,
`riskPolicyVersion`, `riskPolicyHash`.

`BaselineExperiment` + `experimentHash` (urutan-kunci-independen) merangkum:

```
recordingSession, startingAccountState,
featureVersion, scannerVersion, scannerConfigHash,
decisionVersion, riskPolicyHash,
executionVersion, evaluationVersion, execution ("on"|"off")
```

Nanti, ketika Jev menjadi perlakuan, satu-satunya perbedaan yang boleh ada
adalah konfigurasi perlakuan intelijen — bukan versi tersembunyi.

## Filtering

Metrik hanya memuat trade yang tertaut ke himpunan keputusan otonom terpilih
(difilter per `accountId`/`experiment`). Trade paper manual yang tidak tertaut
tidak ikut terhitung.

## Alat

```
bun run evaluate:baseline -- <sessionId> [--db <path>] [--account <id>]
                                [--equity 1000] [--execution on|off] [--json]
```

Menjalankan replay otonom penuh dan mencetak ringkasan kompak. Tidak menempatkan
order nyata dan tidak mengklaim PnL exchange.

## Keterbatasan

- **Funding**: observasi funding belum dipersist (celah Phase 8). Bila rekaman
  tidak memuat efek funding, `funding` bernilai 0 dan metrik yang bergantung
  padanya tidak lengkap. Tidak ada funding yang dikarang.
- Metrik didasarkan pada kurva ekuitas **realisasi** trade otonom, bukan ekuitas
  akun penuh (margin/posisi manual tidak termasuk).

## Cakupan kontrak desimal (Phase 11.5)

Sejak Phase 11.5, kontrak `enable_decimal=true` dapat masuk ke evaluasi baseline
lewat eksekusi PAPER yang sama. Sebelumnya seluruh keputusan pada kontrak
tersebut berhenti di `SIZE_NOT_EXECUTABLE`, sehingga universe evaluasi terbatas
pada kontrak integer.

Konsekuensi pada metrik: karena keadaan akun kini berkembang (Phase 11), satu
entry pada suatu kontrak membuat sinyal berikutnya pada kontrak yang sama
ditolak `EXISTING_CONTRACT_POSITION`. Jumlah trade pada rekaman pendek karena
itu bisa lebih kecil daripada jumlah keputusan yang disetujui — itu perilaku
yang benar, bukan regresi.

## Perbandingan A/B (Phase 12)

Metrik `evaluation-v1` yang sama dipakai untuk kedua arm. Harness
`bun run evaluate:ab` melaporkan metrik CONTROL vs TREATMENT berdampingan plus
analisis matched-trade (trade CONTROL yang kandidatnya diveto Jev: winners,
losers, breakeven, totalR). Perbedaan dilaporkan **deskriptif** — tidak ada
klaim kausal dan tidak ada skor tunggal "Jev bagus". Detail: `docs/EXPERIMENTS.md`.
