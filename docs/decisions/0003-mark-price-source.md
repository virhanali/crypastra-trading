# 0003 — Mark price sebagai basis valuasi, likuidasi, funding, dan TP/SL

- Status: diterima
- Tanggal: 2026-09-20
- Perlu verifikasi ulang: assumption A3, A4, A6 di `docs/PLAN.md`

## Konteks

Probe langsung ke Gate.io (lihat `docs/gateio-market-data.md`) menunjukkan tiga harga
berbeda hidup berdampingan untuk `BTC_USDT` pada detik yang sama:

| Harga | Nilai |
|---|---|
| `last` | 80 444 |
| `mark_price` | 80 445.79 |
| `index_price` | 80 481.38 |

Selisih mark vs index ~0.05%. `contracts` juga menyatakan `mark_type: "index"`, jadi
mark price di Gate.io diturunkan dari index lintas bursa (probe
`index_constituents` mengonfirmasi: Binance, Bitget, Bybit, Gate, MEXC, weight 0.1667
masing-masing).

Temuan penting yang membentuk keputusan ini: **channel `futures.mark_price` TIDAK ADA**
di Gate.io futures WS USDT. Subscribe ditolak dengan `{"code":2,"message":"Unknown
channel futures.mark_price"}`. Mark price hanya tersedia lewat `futures.tickers`
(field `mark_price`) dan REST `contracts`/`contract_stats`. Dokumentasi yang beredar
sering keliru menyebut channel ini ada.

## Keputusan

1. `mark_price` adalah basis untuk: **unrealized PnL, likuidasi, funding, trigger
   TP/SL**.
2. `last_price` adalah basis untuk: **matching fill market/limit** dan candle.
3. `MarkPriceSource` adalah abstraksi terpisah dari `MarketDataProvider`. Sumber
   berprioritas:
   - `futures.tickers.mark_price` (WS, utama, ~0.7 update/detik)
   - REST `contracts/{contract}.mark_price` (cadangan saat ticker basi)
   - REST `contract_stats` (cadangan kedua, publik)
4. Engine menyimpan `mark_price` dengan `mark_ts`. Bila mark lebih tua dari ambang
   (mis. 5 detik di mode live), engine menandai `stale` dan **menolak** mengevaluasi
   likuidasi dari data basi (memilih menunggu, bukan menebak).
5. Model akuntansi internal tidak boleh menyamakan mark dan last, bahkan saat bernilai
   sama, karena divergensi adalah kejadian normal (terbukti ~0.05% saat probe).

## Alasan

- Exchange perpetual nyata memakai mark price untuk mencegah likuidasi yang
  dimanipulasi oleh wick di last price. Kalau paper exchange memakai last price, ia
  akan terlikuidasi jauh lebih sering daripada exchange nyata → tidak "sedekat mungkin
  dengan realitas" seperti yang diminta produk.
- Funding Gate.io secara eksplisit dikaitkan dengan mark/index; memakai last akan
  membuat pelanggaran no-arbitrase kecil yang menumpuk.

## Konsekuensi

- Karena mark price tidak punya channel sendiri, arsitektur ingest **wajib**
  berlangganan `futures.tickers` untuk setiap kontrak yang diminati. Ini berarti lebih
  sedikit kontrak simultan dibanding kalau mark price punya channel sendiri (tickers
  ~0.7/detik/kontrak). Untuk watchlist kecil ini tidak masalah; untuk 100+ kontrak
  perlu backoff/prioritas.
- Replay historis tanpa ticker tersimpan tidak punya mark price. Keputusan: saat
  ingest live, **simpan** `mark_price` bersama candle (kolom tambahan di
  `market_events`, dan materialisasi terpisah bila perlu). Replay tanpa mark price
  harus jatuh ke last price dengan flag `DEGRADED` yang terlihat di UI — bukan
  diam-diam.
- Staleness check butuh `mark_ts` dan clock yang benar; ini memperkuat keputusan
  `Clock` disuntik (bukan `Date.now()`).

## Verifikasi

- Probe: subscribe `futures.mark_price` → `result.status = "fail"`, `error.code = 2`.
- Probe: `futures.tickers` result memuat `mark_price`, `index_price`, `last`,
  `funding_rate`, `funding_next_apply`, `funding_interval`.
- Fixture akuntansi memakai mark ≠ last untuk membuktikan engine tidak salah pilih.