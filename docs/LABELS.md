# Label hasil (`outcome-label-v1`)

Implementasi: `packages/core/src/labels/outcome-label.ts`. OFFLINE.

Label adalah **hasil masa depan** setelah kandidat lahir. Label TIDAK PERNAH
dikirim ke Jev dan tidak boleh dibaca jalur keputusan/eksekusi hidup.

## Sumber harga

**Satu sumber saja**: OHLC candle (`priceSource = "candle_ohlc"`). Mark tidak
dipakai, supaya sumber harga tidak tercampur diam-diam. Label riset ini
**terpisah** dari MAE/MFE `TradeRecord` yang diukur dari mark untuk posisi yang
benar-benar dieksekusi.

## Horizon

`LABEL_HORIZONS = [1, 3, 6, 12]` candle — konstanta berversi, bukan hasil
optimasi terhadap hasil.

## Definisi per horizon H

Ambil H candle pertama setelah `T` (buka ≥ waktu tutup kandidat):

- `futureClose` = close candle ke-H
- **Return berarah**: LONG `(futureClose − ref)/ref`; SHORT `(ref − futureClose)/ref`
- **MFE** (berarah, satuan harga, ≥ 0): LONG `max(high) − ref`; SHORT `ref − min(low)`
- **MAE** (berarah, satuan harga, ≥ 0): LONG `ref − min(low)`; SHORT `max(high) − ref`

Target biner (dihitung dari nilai di atas):

| Target | Definisi | Ambang |
|---|---|---|
| `trendTarget` | 1 bila `directionalReturn ≥ TREND_TARGET_THRESHOLD_PCT/100` | `0.25` % |
| `momentumTarget` | 1 bila `directionalReturn > 0` DAN `MAE ≤ ATR14 × MOMENTUM_ADVERSE_LIMIT_ATR` | `1` × ATR |
| `reversalTarget` | 1 bila `MAE ≥ ATR14 × REVERSAL_ATR_MULTIPLIER` | `1.5` × ATR |

`momentumTarget` menangkap "kontinuasi dengan ekskursi adverse terbatas" —
bukan sekadar "harga naik". `reversalTarget` memakai gerak adverse
**dinormalisasi ATR** karena volatilitas kandidat berbeda-beda, dan menyatakan
"reversal material terhadap arah kandidat".

Bila `ATR14` tidak tersedia/tidak valid, `momentumTarget` dan `reversalTarget`
bernilai `null` — **bukan 0** — karena tidak dapat dinormalisasi. `trendTarget`
tetap dihitung.

Semua ambang **FIXED** dan tidak disetel dari hasil Jev.

## Ketersediaan

Kandidat di dekat akhir rekaman mungkin belum punya cukup candle masa depan.
Horizon seperti itu diberi `null` dan label ditandai:

- `status = "complete"` bila semua horizon tersedia
- `status = "incomplete"` + `incompleteReason` bila ada yang kurang

Tidak ada pemotongan atau penggantian diam-diam.

## Label BTC

Bila `btc_regime` nanti dievaluasi, labelnya harus memakai perilaku masa depan
**BTC saja** — bukan hasil trade altcoin. Implementasi V1 belum membuat label
BTC terpisah; `btc_regime` disimpan sebagai probabilitas pada `jev_evaluations`
dan belum dilabeli.

## Persistensi

Tabel `candidate_outcome_labels`, unik per `(input_hash, label_version)`.
Terpisah total dari `jev_evaluations`: **baris Jev tidak pernah dimutasi dengan
informasi masa depan.**

## Batas kebocoran

Guard sumber membuktikan `packages/core/src/treatment`,
`packages/core/src/decision`, `apps/server/src/treatment`,
`apps/server/src/decision`, dan `apps/server/src/execution` **tidak** mengimpor
modul label atau tipe label. Labeler hanya hidup di `apps/server/src/research/`.
