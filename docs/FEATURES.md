# Feature Engine (`features-v1`)

Lapisan intelijen pasar Phase 9. Menjawab "apa yang sedang terjadi di pasar ini",
BUKAN "berapa uang yang harus ditradingkan".

Implementasi: `packages/core/src/analytics/features.ts` (murni, tanpa DB/HTTP/waktu/acak).

## Batas arsitektur

Modul ini hanya boleh menerima:

- candle TERTUTUP (`windowClosed = true`)
- konfigurasi (`FeatureConfig`)

Dan hanya boleh mengeluarkan `FeatureSnapshot`. Dilarang: database, repository,
`OrderService`/`PositionService`, ledger, saldo, leverage, ukuran posisi, HTTP,
WebSocket, `Date.now()`, `Math.random()`. Larangan ini ditegakkan test
(`tests/phase9-scanner.test.ts` → "isolasi arsitektur") yang memindai kode sumber
analytics setelah komentar dibuang.

## Semantik candle tertutup

Timeframe V1: **5m**. Fitur hanya dihitung saat candle 5m ditutup. Candle yang
belum tertutup (`windowClosed = false`) diabaikan (`not_closed`), sehingga tidak
ada sinyal intrabar. Mark/bid/ask tidak dipakai untuk fitur V1 — keduanya milik
lapisan eksekusi/risiko.

Waktu tutup candle: `candleCloseTimeMs = openTimeSeconds * 1000 + timeframeMs`.
Ini adalah batas look-ahead: snapshot di `T` hanya memakai candle dengan waktu
tutup `<= T`.

## Definisi indikator (eksak)

Semua aritmetika memakai `Decimal` presisi 40 (`decimal.js`). Tidak ada
`Number()` pada jalur ini.

### EMA(20), EMA(50), EMA(200)

- Seed: `SMA(p)` dari `p` close pertama → awal rekursi ada di candle ke-`p`.
- `alpha = 2 / (p + 1)`
- `EMA_t = alpha * close_t + (1 - alpha) * EMA_{t-1}`

EMA 12 dan 26 juga dipelihara secara internal karena MACD membutuhkannya, tetapi
tidak diekspos sebagai indikator terbit. EMA bersifat rekursif terhadap seed-nya,
jadi engine menyimpan keadaan, bukan menghitung ulang riwayat.

### RSI(14) — Wilder

- `change_t = close_t - close_{t-1}`, `gain = max(change, 0)`, `loss = max(-change, 0)`.
- Seed: 14 perubahan pertama → `avgGain = SMA(14, gain)`, `avgLoss = SMA(14, loss)`.
- Rekursi Wilder: `avg = (avg * 13 + x) / 14`.
- `RS = avgGain / avgLoss`, `RSI = 100 - 100 / (1 + RS)`.
- Kasus batas (eksplisit):
  - `avgLoss == 0` dan `avgGain == 0` → **RSI = 50** (pasar datar = netral;
    nilai 100 akan salah menyatakan overbought pada pasar yang tidak bergerak).
  - `avgLoss == 0` dan `avgGain > 0` → **RSI = 100**.

### ATR(14) — Wilder

- `TR_t = max(h_t - l_t, |h_t - close_{t-1}|, |l_t - close_{t-1}|)`; candle pertama
  `TR = h - l` (belum ada close sebelumnya).
- Seed: `SMA(14)` dari 14 TR pertama.
- Rekursi Wilder: `ATR = (ATR * 13 + TR) / 14`.
- `atrPercent = ATR / close * 100`.

### MACD(12, 26, 9)

- `MACD = EMA(12) - EMA(26)` (tersedia saat candle ke-26).
- `signal = EMA(9)` atas deret MACD; seed = `SMA(9)` dari 9 nilai MACD pertama
  (tersedia saat candle ke-34), lalu `alpha = 2/10`.
- `histogram = MACD - signal`.

### Return

Return **aritmetik** (bukan logaritmik):

- `return_n = (close_t - close_{t-n}) / close_{t-n}`

Lookback V1: 1, 3, 12 candle. Bila `close_{t-n} == 0` → `null`.
Bila riwayat belum cukup → `null`.

### Volume

- `volume = v_t` (candle saat ini, integer)
- `volumeMa20 = SMA(20)` atas 20 volume terakhir
- `volumeRatio = v_t / volumeMa20` (`null` bila MA 0 atau belum cukup)

### Jarak dari EMA

- `distanceEmaPct = (close - EMA(p)) / EMA(p) * 100` untuk `p` = 20/50/200.

## Trend structure

Turunan deterministik, bukan klasifikasi model:

- `bullish`: `EMA20 > EMA50 > EMA200`
- `bearish`: `EMA20 < EMA50 < EMA200`
- `mixed`: selain itu

Snapshot juga mengekspos fakta boolean (`aboveEma20`, `emaStackedBullish`, dsb)
supaya keputusan berikutnya tidak perlu menafsir ulang label.

## Warmup

`warmupComplete = true` hanya bila seluruh fitur wajib tersedia:
EMA20/50/200, RSI, MACD, MACD signal, ATR, volumeMa20, dan ketiga return.

Syarat pengikat adalah **EMA200**, jadi minimal **200 candle tertutup**. Pada
candle ke-200 `warmupComplete` menjadi `true` dan `warmupRemaining = 0`.

`FeatureSnapshot` selalu melaporkan `warmupComplete` dan `warmupRemaining`.
Scanner melewati (skip) snapshot yang belum warmup — tidak ada kandidat yang
dipaksakan dari riwayat yang kurang.

## Engine inkremental

Keadaan (`EngineState`) keyed per `contract + timeframe + featureVersion`, dan
dipelihara secara rekursif: seed SMA disimpan sampai periode terpenuhi, lalu
nilai EMA/RSI/ATR/MACD disimpan dan diperbarui. Riwayat hanya menyimpan buffer
kecil yang memang dibutuhkan (13 close untuk return 12; 20 volume untuk SMA20).

`applyClosedCandle(state, candle)` mengembalikan salah satu:

| status | arti |
|---|---|
| `applied` | candle baru diproses; keadaan dan snapshot diperbarui |
| `duplicate` | open time sama dengan candle terakhir; keadaan TIDAK berubah |
| `out_of_order` | candle lebih lama dari yang terakhir; DITOLAK, keadaan utuh |
| `not_closed` | candle belum tertutup; diabaikan |
| `wrong_interval` | interval ≠ timeframe engine; diabaikan |
| `wrong_contract` | kontrak ≠ kontrak keadaan; diabaikan |

`computeFeaturesBatch(contract, candles)` adalah orakel referensi (hitung ulang
dari nol). Test membuktikan hasil inkremental **identik** dengan batch.

## Presisi

Indikator adalah desimal **analitik**, bukan uang ledger. Nilai TIDAK dibulatkan
ke 8 dp; disimpan sebagai `Decimal.toString()` (hingga ~40 digit signifikan).
Pembulatan hanya boleh terjadi di lapisan tampilan. Test memverifikasi bahwa
nilai EMA pada deret geometris memiliki lebih dari 8 digit desimal.

## Contoh snapshot

```json
{
  "contract": "BTC_USDT",
  "timeframe": "5m",
  "featureVersion": "features-v1",
  "candleOpenTimeMs": 1700000000000,
  "candleCloseTimeMs": 1700000300000,
  "candleCount": 200,
  "close": "81234.5",
  "ema20": "81001.12345678901234567890",
  "ema50": "80500.98765432109876543210",
  "ema200": "79000.11111111111111111111",
  "rsi14": "63.50816581104923664441",
  "macd": "12.34567890123456789012",
  "macdSignal": "10.11111111111111111111",
  "macdHistogram": "2.23456789012345678901",
  "atr14": "645.5",
  "atrPercent": "0.79488037571577831571",
  "return1": "0.0015",
  "return3": "0.0031",
  "return12": "0.0082",
  "volume": 140,
  "volumeMa20": "110",
  "volumeRatio": "1.27272727272727272727",
  "distanceEma20Pct": "0.50968188040653920388",
  "distanceEma50Pct": "0.91000000000000000000",
  "distanceEma200Pct": "2.80000000000000000000",
  "trendStructure": "bullish",
  "facts": { "aboveEma20": true, "emaStackedBullish": true, "macdHistogramPositive": true },
  "warmupComplete": true,
  "warmupRemaining": 0
}
```

## Versi fitur

`featureVersion = "features-v1"`. Nilai ini ikut tersimpan di setiap snapshot dan
ikut di-hash. Dataset yang dibuat dengan definisi seed berbeda tidak boleh
tercampur diam-diam; versi dinaikkan bila definisi berubah.

Rencana perubahan berikutnya: `features-v2` bila seed/smoothing berubah, tanpa
mengubah fungsi `features-v1`.
