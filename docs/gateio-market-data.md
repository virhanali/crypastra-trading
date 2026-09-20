# Gate.io USDT Perpetual — Catatan Terverifikasi

Dokumen ini mencatat **fakta yang dibuktikan dengan probe langsung** ke API/WS
Gate.io pada 20 Sep 2026 (± 16:35 WIB). Situs dokumentasi Gate.io
(`gate.io/docs/developers/...`, `api-docs.gate.io`) **tidak dapat diakses** dari
environment ini (transport error pada semua URL), jadi verifikasi dilakukan
empiris terhadap endpoint publik langsung.

Semua fakta ber-tag **VERIFIED** berasal dari output probe. Yang ber-tag
**UNVERIFIED** harus dikonfirmasi ulang sebelum dipakai.

---

## 1. REST

Base: `https://api.gateio.ws/api/v4` — **VERIFIED** (HTTP 200, DNS resolve normal).

### `GET /futures/usdt/contracts/{contract}` — VERIFIED

Contoh respons nyata untuk `BTC_USDT` (dipendekkan):

```json
{
  "name": "BTC_USDT",
  "quanto_multiplier": "0.0001",
  "order_size_min": 1,
  "order_size_max": 12000000,
  "order_price_round": "0.1",
  "mark_price_round": "0.01",
  "maintenance_rate": "0.003",
  "leverage_min": "1",
  "leverage_max": "200",
  "maker_fee_rate": "-0.0001",
  "taker_fee_rate": "0.00075",
  "funding_rate": "0.000097",
  "funding_rate_indicative": "0.000097",
  "funding_interval": 28800,
  "funding_next_apply": 1789920000,
  "funding_rate_limit": "0.003",
  "funding_cap_ratio": "0.75",
  "funding_impact_value": "30000",
  "interest_rate": "0.0003",
  "index_price": "80481.38",
  "mark_price": "80445.79",
  "last_price": "80444",
  "mark_type": "index",
  "cross_leverage_default": "10",
  "risk_limit_base": "500000",
  "risk_limit_step": "1499500000",
  "risk_limit_max": "1500000000",
  "order_price_deviate": "0.03",
  "market_order_slip_ratio": "0.01",
  "market_order_size_max": "10000000",
  "orders_limit": 100,
  "status": "trading",
  "type": "direct",
  "enable_decimal": false,
  "is_pre_market": false,
  "funding_offset": 0
}
```

Catatan penting:
- **`enable_decimal: false`** → `size` adalah **integer**. Jangan kirim size fraksional.
- **`maker_fee_rate` negatif** (`-0.0001`) → maker menerima rebate.
- **`maintenance_rate`** = `0.003` (0.3%) — MMR untuk risk limit terendah.
- **`mark_type: "index"`** → mark price diturunkan dari index, bukan last trade.
- `risk_limit_base/step` → MMR berjenjang menurut ukuran posisi. Awal: pakai
  `maintenance_rate` tunggal (tier terendah). Multi-tier = Phase lanjutan.
- `funding_interval: 28800` detik = **8 jam**.
- **Tidak ada `min_notional`**, **tidak ada `order_size_round`**, **tidak ada
  `min_leverage` terpisah** di payload ini → assumption A5.

### `GET /futures/usdt/contracts` — VERIFIED

- `997` kontrak USDT perpetual pada saat probe.
- `quanto_multiplier` **heterogen** — wajib dibaca per kontrak, jangan diasumsikan.

### `GET /futures/usdt/candlesticks` — VERIFIED

```
params: contract, interval (5m), limit, from, to
respons: [{ "t": 1789897200, "o": "...", "h": "...", "l": "...", "c": "...",
            "v": 2331471, "sum": "18772822.1408" }, ...]
```

- `interval=5m` → candle 5 menit. **VERIFIED** menerima `5m`, `1m`, `1h`.
- `limit=2000` → mengembalikan tepat **2000** candle. **VERIFIED** limit 2000 diterima
  untuk 1m/5m/1h. Nilai maksimum resmi belum dikonfirmasi di luar 2000 (A9).
- `t` = epoch **detik** (bukan ms). `v` = ukuran kontrak (integer). `sum` = notional quote.
- `from`/`to` filter bekerja (probe `from=1789000000` mengembalikan candle paling awal
  yang tersedia, bukan error).
- **Catatan:** REST candle tidak punya flag `w` (window closed). Candle terakhir dari
  REST adalah candle **in-progress** yang tidak bisa dibedakan dari candle final
  kecuali dengan membandingkan `t + interval` terhadap waktu sekarang.

### `GET /futures/usdt/tickers` — VERIFIED

```json
{ "contract": "BTC_USDT", "last": "80444", "mark_price": "80445.79",
  "index_price": "80481.38", "funding_rate": "0.000097",
  "funding_rate_indicative": "0.000097",
  "volume_24h_settle": "2957921620", "low_24h": "...", "high_24h": "...",
  "change_percentage": "-1.05", "total_size": "639599102",
  "highest_bid": "80444", "highest_size": "53771",
  "lowest_ask": "80444.1", "lowest_size": "352410",
  "quanto_multiplier": "0.0001" }
```

Tiga harga berbeda hadir sekaligus: `last`, `mark_price`, `index_price`.
`mark_price` (80445.79) ≠ `last` (80444) ≠ `index` (80481.38) — divergensi nyata
terukur ~0.05% antara mark dan index. Model akuntansi **harus** memakai `mark_price`.

### `GET /futures/usdt/order_book` — VERIFIED

```json
{ "id": 125576002585, "current": 1789898130.372, "update": 1789898130.372,
  "asks": [{ "s": 22079, "p": "80436.8" }, ...],
  "bids": [{ "s": 16580, "p": "80436.7" }, ...] }
```

- `s` = **integer size (kontrak)**, `p` = harga string.
- `current`/`update` = epoch **detik** dengan fraksi desimal (bukan ms).
- `with_id=true` memberi `id` sequence buku.

### Endpoint yang **butuh autentikasi** — VERIFIED

- `GET /futures/usdt/contracts/{contract}/funding_rate` → `{"label":"INVALID_CREDENTIALS","message":"not authenticated"}`.
  **Funding rate history TIDAK publik.** → Konsekuensi: funding history untuk replay
  harus dibangun sendiri dengan merekam `funding_next_apply` + `funding_rate` dari
  `futures.tickers`/`contracts` selama ingest. Ini assumption A8 dan keputusan desain.
- `GET /futures/usdt/contract_stats` **berhasil** tanpa auth (publik) — berisi
  `mark_price`, `open_interest`, `lsr_*`, likuidasi agregat, `last_funding_rate`.
  Bisa dipakai sebagai sumber tambahan mark price & regime.
- `GET /futures/usdt/index_constituents/{index}` **publik** — komposisi index
  (Binance/Bitget/Bybit/Gate/MEXC, weight 0.1667 masing-masing). Berguna untuk
  penjelasan mark price dan fitur regime Jev.

## 2. WebSocket

Base: `wss://fx-ws.gateio.ws/v4/ws/usdt` — **VERIFIED** (koneksi terbuka, subscribe sukses).

Format pesan (VERIFIED):

```jsonc
// client → subscribe
{ "time": 1789898126, "channel": "futures.tickers", "event": "subscribe", "payload": ["BTC_USDT"] }

// server → ack
{ "time": ..., "time_ms": ..., "conn_id": "...", "trace_id": "...",
  "channel": "futures.tickers", "event": "subscribe",
  "payload": ["BTC_USDT"], "result": { "status": "success" } }
```

- `event: "unsubscribe"` untuk berhenti.
- `time` = epoch detik, `time_ms` = epoch ms. **VERIFIED keduanya hadir.**
- Error channel tak dikenal: `"error": {"code":2,"message":"Unknown channel ..."}, "result":{"status":"fail"}`.

### Ping/pong — VERIFIED

- **Client mengirim** `{"channel":"futures.ping","event":"subscribe","payload":[]}`,
  server menjawab `{"channel":"futures.pong","event":"","result":null}`.
- Pong datang ~setiap kali ping dikirim; selama 25 detik koneksi tanpa ping tetap hidup.
- **UNVERIFIED:** interval ping wajib, idle timeout server, dan payload ping alternatif
  (`event:"ping"`). → assumption A1. Implementasi: kirim ping periodik (mis. 20 s) +
  reconnect bila tidak ada pesan apa pun selama N detik.

### Channel — status VERIFIED

| Channel | Payload | Status | Isi |
|---|---|---|---|
| `futures.tickers` | `["BTC_USDT"]` | ✅ | `result` = **array**, berisi `last`, `mark_price`, `index_price`, `funding_rate`, `funding_rate_indicative`, `funding_interval`, `funding_next_apply`, `volume_24h_*`, `t` (ms), `price_type`, `change_from`, `quanto_base_rate` |
| `futures.candlesticks` | `["5m","BTC_USDT"]` | ✅ | `result` = array; `{t,o,h,l,c,v,a,n,w}`; `n` = `"5m_BTC_USDT"`, `w` = apakah window **sudah tertutup** |
| `futures.book_ticker` | `["BTC_USDT"]` | ✅ | `{t,u,s,b,B,a,A}` — best bid/ask, frekuensi tertinggi |
| `futures.order_book_update` | `["BTC_USDT","1000ms","5"]` | ✅ | `{t,U,u,s,a,b,l}` — **incremental**, `U`/`u` = sequence pertama/terakhir |
| `futures.trades` | `["BTC_USDT"]` | ✅ | `{id,size,price,create_time,create_time_ms,contract}` — `size` integer kontrak **bertanda** (negatif = taker sell) |
| `futures.order_book` | `["BTC_USDT","5","0"]` | ✅ | snapshot L2 (returned on subscribe) |
| `futures.mark_price` | — | ❌ **TIDAK ADA** | ditolak `code:2 Unknown channel`. Mark price **hanya** via `futures.tickers` atau REST. |

Frekuensi terukur dalam 25 detik untuk `BTC_USDT`:

```
order_book_update : 232
book_ticker       : 207
trades            :  76
tickers           :  18   (~0.7/detik)
candlesticks      :  11   (perubahan dalam 5m window)
pong              :   2
```

Implikasi desain: `book_ticker`/`order_book_update` sangat deras (~9/detik gabungan).
Jangan broadcast semua ke UI tanpa throttle/agregasi. `tickers` ~0.7/detik → cukup
untuk mark price & funding. Untuk 5m strategy, candle update yang relevan hanya saat
pergantian window.

### Detail payload yang mudah salah — VERIFIED

Ketiganya ditemukan lewat smoke test live, bukan dari dokumentasi:

1. **Nama candle `n` = `"<interval>_<contract>"`.** Karena kontrak sendiri mengandung
   `_`, `split("_")` akan memotong `"5m_BTC_USDT"` menjadi interval `"5m"` dan kontrak
   `"BTC"` — **salah**. Harus `slice` pada `_` pertama saja. Nama tanpa interval valid
   (mis. `"BTC_USDT"`) harus ditolak, bukan menghasilkan interval sampah.

2. **`trades.size` bertanda.** Negatif = taker sell, positif = taker buy. Contoh nyata:
   `{"id":838495138,"size":564,"price":"80265.9","takerSide":"sell"}`. Ukuran harus
   disimpan absolut dan tandanya dipindah ke field sisi, kalau tidak arah trade hilang.

3. **`candlesticks.w` = window SUDAH tertutup** (bukan "sedang berjalan"). Dibuktikan
   dengan probe 1m candle melintasi batas window:

   ```
   t=1789901940 w=false  windowEnd=1789902000 now=1789901971  inProgress=true
   t=1789901940 w=true   windowEnd=1789902000 now=1789902002  inProgress=false
   t=1789902000 w=false  windowEnd=1789902060 now=1789902003  inProgress=true
   t=1789902000 w=true   windowEnd=1789902060 now=1789902061  inProgress=false
   ```

   Jadi `windowClosed = (w === true)`. Implementasi pertama memakai `w === false` dan
   itu **terbalik** — candle yang masih berjalan ditandai final.

Catatan lain:
- WS candle **tidak** mengirim `sum` (hanya REST yang mengirim notional quote).
- `funding_next_apply` **tidak ada** di REST `/futures/usdt/tickers`; ia ada di
  `futures.tickers` (WS) dan di `/futures/usdt/contracts/{contract}`.

## 3. Ringkasan angka acuan (BTC_USDT, saat probe)

| Besaran | Nilai |
|---|---|
| last | 80 444 |
| mark | 80 445.79 |
| index | 80 481.38 |
| quanto_multiplier | 0.0001 |
| order_size_min | 1 (= 0.0001 BTC ≈ $8.04) |
| order_price_round | 0.1 |
| maintenance_rate | 0.003 |
| leverage | 1–200 (default cross 10) |
| maker / taker fee | −0.0001 / 0.00075 |
| funding_interval | 28800 s |
| funding_rate | 0.000097 |

Contoh perhitungan acuan (wajib jadi fixture test):
`size=1`, `entry=80000`, `mark=80000`, `leverage=10`:
- notional = 1 × 0.0001 × 80000 = **8 USDT**
- initial_margin = 8 / 10 = **0.8 USDT** (= 0.8)
- maintenance = 1 × 0.0001 × 80000 × 0.003 = **0.024 USDT**
- taker fee = 8 × 0.00075 = **0.006 USDT**

Artinya `order_size_min=1` untuk BTC_USDT hanya bernilai ~$8 notional → saldo awal
harus cukup untuk setidaknya beberapa posisi minimum. Ini alasan kuat saldo awal
default ≥ 10 000 USDT.

## 3b. Verifikasi ulang Phase 6 (live)

Smoke test live Phase 6 (`tools/smoke-live-market.ts`, 20 detik, BTC_USDT)
mengonfirmasi ulang apa yang sudah terverifikasi Phase 0:

- `futures.tickers` memberi `last`, `mark_price`, `index_price`, `funding_rate`,
  `funding_next_apply`, `funding_interval` — ketiganya BERBEDA pada saat bersamaan
  (mis. last 80506.9, mark 80496.5, index 80530.9).
- `futures.book_ticker` memberi best bid/ask + ukuran; kutipan hanya dipakai bila
  KEDUA sisi ada.
- `futures.candlesticks` 5m mengalir dengan `w: false` untuk window berjalan.
- Mark age terukur ~1.5–1.8 detik dari `sourceTimestampMs`, jauh di bawah ambang
  staleness default (5 dtk).

**Tidak terverifikasi (tetap assumption):** jadwal/isi `futures.order_book_update`
saat pasar sibuk (A12), rate limit REST untuk snapshot kedalaman (A9), dan perilaku
privat/akun (di luar lingkup paper trading).

## 3c. Frekuensi kanal terukur (relevan untuk volume rekaman)

Rekaman Phase 8 (BTC_USDT, 25 detik) memberi angka nyata: 554 observasi
(22.5/detik) dengan **`quote` (book_ticker) ~96%** baris, `mark` (tickers) 21,
`funding` 1. Artinya `futures.book_ticker` jauh lebih deras daripada
`futures.tickers`, dan `futures.tickers` sangat murah. Lihat `docs/REPLAY.md` §13
untuk proyeksi penyimpanan.

## 4. Risiko & keterbatasan probe

1. Probe dijalankan sekali (snapshot 20 Sep 2026). Nilai pasar berubah; **field dan
   bentuk payload** yang stabil, **angka** tidak.
2. Koneksi dari IP ini lancar (~0.7 ticker/detik). Rate limit resmi REST belum
   diuji (belum ada 429 karena hanya ~10 request). → A9.
3. Testnet Gate.io tidak diuji. Karena kita paper trading, testnet tidak dibutuhkan.
4. Docs resmi tidak terbaca dari environment ini. Semua yang perlu dipastikan secara
   kontraktual harus diverifikasi ulang saat implementasi, idealnya lewat probe
   (pola yang sama seperti dokumen ini), bukan lewat halaman web.

## 5. Cara mereproduksi probe

Script probe disimpan sebagai artefak nyata di repo: `tools/probe-gateio.ts`
(REST + WS, output JSON + ringkasan). Jalankan `bun run tools/probe-gateio.ts` untuk
memverifikasi ulang semua fakta di dokumen ini kapan pun. Setiap fakta yang berubah
harus memperbarui dokumen ini dan `ContractSpec` di core.