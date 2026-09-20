# crypastra — Requirement Produk & Arah Visual

## 1. Produk

Paper-trading terminal untuk crypto USDT perpetual futures. Berperilaku sedekat
mungkin dengan exchange perpetual nyata, **tetapi hanya uang virtual**.

Fitur yang harus didukung (semua ditargetkan, tidak semua di fase awal):

- market data futures crypto live
- paper wallet dengan saldo konfigurabel
- deposit / withdrawal / reset untuk simulasi
- posisi LONG dan SHORT
- order market dan limit
- margin isolated
- leverage
- fee maker/taker
- unrealized & realized PnL
- valuasi berbasis mark price
- TP/SL
- likuidasi
- pembayaran funding
- lifecycle order / fill / position
- riwayat transaksi / ledger
- mode simulasi manual
- mode replay historis (nanti)
- strategi otomatis (nanti)
- evaluasi probabilistik Jev (nanti)

Batasan keras:
- PAPER TRADING ONLY. Tidak ada eksekusi order ke exchange asli.
- Tidak ada integrasi private trading API.
- Jev tidak mengeksekusi trade, tidak memilih leverage, tidak mengubah saldo,
  tidak mengendalikan akuntansi.
- UI dan Jev tidak diimplementasikan di fase awal.

## 2. Prinsip pemisahan domain

```
Market Data → Market State → Strategy/Feature → Jev → Decision/Risk → Paper Exchange
```

Paper Exchange tidak boleh tahu asal order (manusia, Jev, strategy, replay, test).
Ia hanya menerima **validated paper orders**.

## 3. Arsitektur data pasar

Provider awal: Gate.io public USDT perpetual WebSocket.
Aplikasi **tidak boleh** terkoppel ke Gate.io. Abstraksi `MarketDataProvider`
harus memungkinkan Gate.io, Binance, replay, dan injeksi harga manual tanpa menulis
ulang trading engine.

Timeframe strategi awal: **5m candle**, dengan mark price / ticker bila diperlukan
paper exchange.

## 4. Arah visual: "Modern Soft Trading Terminal"

Karakteristik wajib:

- terminal trading profesional
- **dark theme default**
- light theme opsional
- permukaan dark navy / charcoal
- kedalaman soft/neumorphic yang halus
- shadow tertahan (restrained)
- keterbacaan tinggi
- kepadatan informasi tinggi tanpa terasa penuh
- border radius besar tapi terkontrol
- hijau/merah semantik **hanya** bila bermakna finansial
- hirarki tipografi kuat
- nyaman untuk sesi desktop panjang
- **bukan** dashboard admin generik
- tanpa gradien berlebihan
- tanpa glassmorphism berlebihan
- tanpa estetika neon crypto

### Layout desktop (perkiraan)

```
Navigation
│
├── Wallet / account summary
├── Watchlist
│
├── Main market area
│   ├── Symbol header
│   ├── market statistics
│   └── candlestick chart
│
├── Trading / Jev side panel
│
└── Bottom workspace
    ├── Positions
    ├── Orders
    ├── History
    ├── Ledger
    └── Jev Decisions
```

### Status implementasi (Phase 7A)

UI sudah ada di `apps/web` (Svelte 5 + Vite + Tailwind 4 + lightweight-charts).
Layout, token desain, dan komponennya didokumentasikan di `docs/design/TERMINAL.md`
dan `docs/design/DESIGN_SYSTEM.md`.

Phase 7A: baca/observasi. Phase 7B: **trade entry & position management** —
order ticket (LONG/SHORT, MARKET/LIMIT, leverage, size, TP/SL), cancel, close,
dan amandemen TP/SL. Seluruh eksekusi tetap **PAPER**: order dijalankan terhadap
data pasar (LIVE MARKET) tetapi tidak pernah dikirim ke exchange. Kata "LIVE"
hanya merujuk pada sumber data pasar.

### Status visual reference

User menyebut "attached visual references". **Tidak ada file gambar yang ditemukan**
di repo (`/home/esb/project/crypastra-trading` kosong saat inspeksi), `~/Downloads`, atau `~/Desktop`
(kedua direktori tidak ada di environment ini). Deskripsi tekstual di atas dipakai
sebagai kontrak desain sampai file referensi ditaruh di `docs/reference/`.

## 5. Definisi "selesai" untuk produk (utuh)

Sebuah sesi paper trading dianggap berhasil bila:

1. User bisa memilih kontrak (mis. `BTC_USDT`) dan melihat candle 5m live.
2. User bisa deposit saldo virtual dan melihatnya di ledger.
3. User bisa buka LONG/SHORT dengan leverage dan isolated margin, market atau limit.
4. Posisi menampilkan upnl berdasarkan mark price, bukan last price.
5. Fee maker/taker muncul di ledger dengan tanda yang benar (termasuk rebate).
6. Funding terpotong pada jadwal `funding_next_apply` dan tercatat.
7. TP/SL dan likuidasi bekerja dan terlihat di History.
8. Seluruh pergerakan saldo dapat dilacak append-only dan direkonsiliasi.
9. Mengubah mode ke replay menghasilkan perilaku engine yang sama.
10. Jev, bila aktif, hanya menggeser probabilitas keputusan — bukan memegang uang.