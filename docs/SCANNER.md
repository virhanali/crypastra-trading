# Hard Scanner (`scanner-v1`)

Implementasi: `packages/core/src/analytics/scanner.ts`.
Hashing riset: `packages/core/src/analytics/research.ts`.

Scanner mempersempit universe menjadi setup yang layak ditinjau. Ia menjawab
"setup ini layak dievaluasi lebih lanjut", bukan "beli sekian di leverage sekian".

## Yang TIDAK dilakukan scanner

- ukuran posisi, leverage, alokasi margin, batas jumlah posisi
- harga SL/TP
- akses saldo/ledger
- eksekusi order

Semua itu milik Decision/Risk Engine (Phase 10+) dan Jev. Ditegakkan test:
kunci `ScannerResult` diuji tidak memuat `size|leverage|notional|margin|quantity|balance`.

## Alur

```
closed candle 5m
  → FeatureEngine → FeatureSnapshot
  → scan(features, config, configHash, btcContext?)
  → ScannerResult { status, direction, setupType, facts, reasonCodes, signal }
```

`scan` adalah fungsi murni: keluarannya hanya fungsi dari `(fitur, config, btcContext)`.

## Konfigurasi V1 (default konservatif)

| Kunci | Default | Arti |
|---|---|---|
| `minVolumeRatio` | `"1.0"` | `volumeRatio` minimum agar volume dianggap terkonfirmasi |
| `minAtrPercent` | `"0.2"` | Volatilitas minimum; di bawah ini pasar terlalu mati |
| `maxAtrPercent` | `"5.0"` | Volatilitas maksimum; di atas ini terlalu ekstrem |
| `rsiLongMin` / `rsiLongMax` | `"50"` / `"70"` | Rentang RSI untuk sisi long |
| `rsiShortMin` / `rsiShortMax` | `"30"` / `"50"` | Rentang RSI untuk sisi short |
| `maxDistanceFromEma20` | `"3.0"` | Jarak (%) dari EMA20 sebelum dianggap *overextended* |
| `requireTrendAlignment` | `true` | Wajib tren selaras dengan arah |
| `useBtcContext` | `false` | Aktifkan pemakaian konteks BTC |
| `requireBtcAlignment` | `false` | BTC harus selaras, kalau tidak sinyal jadi netral |
| `minimumHistory` | `200` | Candle minimum sebelum scanner boleh memberi sinyal |

Default ini **tidak dioptimasi** terhadap sampel Phase 8 atau fixture mana pun.
Tidak ada pencarian ambang, tidak ada maksimalisasi profit/win-rate/Sharpe/PF.

## Keluaran

```json
{
  "contract": "ETH_USDT",
  "timeframe": "5m",
  "candleCloseTimeMs": 1700000300000,
  "featureVersion": "features-v1",
  "scannerVersion": "scanner-v1",
  "scannerConfigHash": "dde5b8b7afef69d4",
  "status": "candidate",
  "direction": "long",
  "setupType": "trend_continuation_long",
  "facts": {
    "trendAligned": true,
    "momentumAligned": true,
    "volatilityAcceptable": true,
    "volumeConfirmed": true,
    "overextended": false,
    "rsiInRange": true
  },
  "reasonCodes": ["TREND_BULLISH", "VOLUME_CONFIRMED", "VOLATILITY_OK", "MACD_POSITIVE", "RSI_LONG_RANGE", "MOMENTUM_LONG"],
  "signal": "long"
}
```

Tidak pernah: `"buy 500 at 10x"`.

## Kandidat vs Sinyal

Sengaja dipisah, bukan satu boolean:

- **Kandidat** (`status: "candidate"`): setup tren yang layak dievaluasi.
  `direction` mengikuti tumpukan EMA.
- **Sinyal baseline** (`signal`): konfluensi penuh aturan deterministik.
  `long` / `short` / `neutral`.

`status` mengikuti `signal`: sinyal netral berarti `skip`.

## Aturan sinyal baseline V1

LONG bila SEMUA benar:

1. `trendStructure == "bullish"`
2. `macdHistogram > 0`
3. `rsiLongMin <= rsi14 <= rsiLongMax`
4. `volumeRatio >= minVolumeRatio`
5. `minAtrPercent <= atrPercent <= maxAtrPercent`
6. `|distanceEma20Pct| <= maxDistanceFromEma20`

SHORT adalah cerminnya (`bearish`, histogram `< 0`, rentang RSI short).
Selain itu `neutral`. Ini kelompok kontrol untuk evaluasi Jev nanti — bukan
strategi yang dioptimasi.

## Reason codes

Daftar lengkap (`ReasonCode`):

`WARMUP_INCOMPLETE`, `INSUFFICIENT_HISTORY`, `TREND_BULLISH`, `TREND_BEARISH`,
`TREND_MIXED`, `TREND_NOT_ALIGNED`, `MACD_POSITIVE`, `MACD_NEGATIVE`,
`RSI_LONG_RANGE`, `RSI_SHORT_RANGE`, `RSI_OUT_OF_RANGE`, `VOLUME_CONFIRMED`,
`VOLUME_TOO_LOW`, `VOLATILITY_OK`, `VOLATILITY_TOO_LOW`, `VOLATILITY_TOO_HIGH`,
`OVEREXTENDED`, `MOMENTUM_LONG`, `MOMENTUM_SHORT`, `MOMENTUM_NEUTRAL`,
`BTC_CONTEXT_MISSING`, `BTC_CONTEXT_CONFLICT`, `BTC_CONTEXT_ALIGNED`.

Setiap hasil harus bisa dijelaskan dari `reasonCodes` — ini yang nanti dipakai
membandingkan keputusan baseline vs veto Jev. Contoh:

- kandidat LONG karena `TREND_BULLISH`, `MACD_POSITIVE`, `RSI_LONG_RANGE`, `VOLUME_CONFIRMED`
- skip karena `ATR_TOO_LOW` (diwakili `VOLATILITY_TOO_LOW`)
- skip karena `OVEREXTENDED`

Representasi utama adalah `reasonCodes` mesin-baca; prosa bukan representasi utama.

## Konteks BTC

Untuk kontrak non-BTC, `FeatureSnapshot`/scanner dapat menerima `BtcContext`:

```ts
{ contract, trendStructure, return1, return12, atrPercent, close }
```

Konteks BTC **tidak** dipakai kecuali `useBtcContext = true`, dan **tidak**
memveto kecuali `requireBtcAlignment = true`. Bila diminta dan tidak tersedia →
`BTC_CONTEXT_MISSING`; bila bertentangan → `BTC_CONTEXT_CONFLICT` dan sinyal jadi
netral. BTC dominance TIDAK diimplementasikan di fase ini (tidak ada sumber data
yang sudah ada, dan tidak ada provider baru yang ditambahkan).

## Versi & hashing

Setiap hasil memuat `featureVersion`, `scannerVersion`, `scannerConfigHash`.
`scannerConfigHash` adalah hash urutan-kunci-independen atas config sehingga
eksperimen dapat dibandingkan secara jujur.

`buildResearchDigest({ snapshots, results, counters })` menghasilkan
`combinedHash` (FNV-1a 16 hex) atas:

- hash setiap FeatureSnapshot (field analitik saja)
- hash setiap ScannerResult
- distribusi reasonCode

Hash TIDAK memuat id baris DB, timestamp jam dinding, UUID, atau id acak. Karena
itu dua replay atas rekaman yang sama menghasilkan `combinedHash` identik —
dibuktikan di `tests/phase9-replay.test.ts`.

## Persistensi

- `feature_snapshots` (sudah ada sejak Phase 1) — idempoten per
  `(contract, interval, t, engine_version)` lewat unique index migrasi 0008.
- `scanner_results` (baru, migrasi 0008) — idempoten per
  `(contract, interval, t, feature_version, scanner_version, scanner_config_hash)`.

Keduanya data **riset/analitik**, bukan `domain_events` (peristiwa ekonomi) dan
bukan `decisions` (keputusan ekonomi dengan ukuran posisi).

## Observability

`AnalyticsService.counters()`:

`candlesProcessed`, `otherIntervalCandles`, `duplicateCandles`, `outOfOrderCandles`,
`warmupSkips`, `featureSnapshotsProduced`, `featureSnapshotsPersisted`,
`scannerCandidates`, `scannerSkips`, `longSignals`, `shortSignals`,
`neutralSignals`, `errors`.

## Keterbatasan rekaman saat ini

Sesi rekaman Phase 8 (mis. smoke 20 detik) terlalu pendek untuk warmup EMA200.
Syarat warmup **tidak** dilonggarkan supaya sesi pendek menghasilkan sinyal.
Untuk test dipakai fixture sintetis >= 250 candle; untuk analisis nyata
diperlukan sesi dengan riwayat candle yang cukup.

## Alat analisis (opt-in)

```
bun run analyze:recording -- <sessionId> [--db <path>] [--json]
```

Memuat candle 5m tertutup dari rekaman, menjalankan FeatureEngine + Scanner yang
sama seperti live, lalu mencetak kontrak, jumlah candle, warmup skip, kandidat,
sinyal long/short/netral, distribusi reasonCode, dan hash riset. Tidak menempatkan
order dan tidak mengklaim PnL.
