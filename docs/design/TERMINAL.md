# Terminal — Layout, Komponen, dan Aliran Data

Aplikasi: `apps/web` (Svelte 5 runes + Vite + Tailwind 4 + lightweight-charts).
Basis API: `/api/v1` (diprokси oleh Vite ke backend). WebSocket: `/ws`.

> **PAPER ONLY.** Badge `PAPER` persisten di header. Tidak ada jalur yang
> mengirim order ke exchange.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ ☰ | crypastra | PAPER | BTC_USDT | LIVE MARKET · PAPER | ● LIVE │ ◐ │
├─────────────┬──────────────────────────────┬─────────────────┤
│ Watchlist   │ Market Header                │ Paper Account   │
│ (cari/      │ (mark, last, index, funding, │ (saldo, equity, │
│  pilih)     │  bid/ask, freshness)         │  margin, aksi)  │
│             ├──────────────────────────────┼─────────────────┤
│             │ Chart 5m (candlestick)       │ Trade (7B)      │
├─────────────┴──────────────────────────────┴─────────────────┤
│ Positions | Orders | Fills | History | Ledger                 │
└──────────────────────────────────────────────────────────────┘
```

Breakpoint: ≥1280px layout penuh; ≤1400px kolom menyempit; ≤1180px watchlist
dan panel kanan turun (prioritas desktop, mobile bukan blocker).

## Hierarki komponen

```
App.svelte
├── TopBar              (brand, PAPER, kontrak, mode, feed status, tema)
├── Watchlist           (daftar kontrak, filter, pilih)
├── MarketHeader        (mark/last/index/funding/bid/ask + staleness)
├── PriceChart          (lightweight-charts; instance persisten)
├── AccountPanel        (read model akun + deposit/withdraw/reset)
├── TradePanelPreview   (shell; kontrol order = Phase 7B)
└── BottomWorkspace     (tab)
    ├── PositionsTable  ├── OrdersTable  ├── FillsTable
    ├── HistoryTable    └── LedgerTable
    (StateMessage dipakai di semua panel: loading/empty/error/stale/disconnected)
```

## Aliran data

```
GET /summary ─┐
GET /market/state ─┐
WS /ws subscribe(accountId, afterSeq) ─┐
WS /ws subscribe_market(contracts) ─┐
        ↓
   App.svelte (state runes)
        ↓
   komponen (props, satu arah)
```

- **Peristiwa domain** (ber-`seq`, durable) TIDAK dipakai untuk harga; ia hanya
  memicu pemuatan ulang ringkasan akun (di-debounce 120 ms, karena satu perintah
  menghasilkan banyak event).
- **Peristiwa pasar** (ephemeral) mengalir ke store pasar saja, dan diterapkan
  per frame `requestAnimationFrame` dengan coalescing per `(kontrak, jenis)`.
- Tabel bawah TIDAK dirender ulang oleh tick pasar: hanya header pasar/chart yang
  terpengaruh.

## Keadaan feed

`LIVE` hanya bila **mark segar** dan feed terbuka. Status WebSocket browser
sendirian tidak pernah dianggap "LIVE" (pernah menjadi sumber kebohongan di
terminal lain). Turunannya: `LIVE | SIMULATION | RECONNECTING | STALE | DEGRADED |
OFFLINE`. Saat `STALE`, nilai mark diberi warna peringatan dan panel menampilkan
pesan eksplisit.

## Chart

`lightweight-charts` (bukan widget hosted TradingView). Data 5m dari
`GET /api/v1/market/candles`. Chart dibuat sekali dan dipertahankan; candle
terakhir di-`update()`, `setData()` hanya saat kontrak/interval berubah.
Browser **tidak pernah** menyentuh Gate.io: arsitekturnya Gate → server → browser.

## Realtime klien

- `DomainStream`: `subscribe(accountId, afterSeq)`, dedupe berdasarkan `seq`
  (pengiriman at-least-once), `resync_required` → ambil snapshot baru lalu lanjut
  dari `latestEventSeq` baru.
- `MarketStream`: `subscribe_market(contracts)`, hanya kontrak yang terlihat.
- `CommandBook`: `commandId` dibuat sekali per aksi dan **dipakai ulang saat
  retry** aksi yang sama; dibuang setelah sukses definitif.

## Aksi akun

Deposit/withdraw/reset/create memakai `commandId` dari `CommandBook`. Nilai input
dibersihkan (`toApiDecimal`) sebelum dikirim — nilai yang sudah diformat
(`"1,000.00"`) tidak pernah menjadi input API.

## Order ticket (Phase 7B)

`OrderTicket` menggantikan placeholder 7A. Isi: pemilih **▲ LONG / ▼ SHORT**
(teks + ikon, bukan hanya warna), **MARKET / LIMIT**, size (string mentah),
leverage (input + slider tersinkron), limit price (saat LIMIT), TP/SL opsional,
kutipan bid/ask/mark, dan ringkasan konfirmasi. Tombol utama berbunyi
`OPEN LONG · PAPER` / `OPEN SHORT · PAPER`; panel selalu menyebut
`PAPER · VIRTUAL FUNDS`. Tidak ada teks `LIVE TRADING`/`REAL ORDER`/`SEND TO GATE` —
kata "LIVE" hanya untuk data pasar.

**Nilai mentah vs tampilan.** Input disimpan sebagai string mentah dan dikirim
apa adanya (`toApiDecimal` membersihkan pemisah ribuan). Nilai yang sudah
diformat (`"80,498.40"`) tidak pernah menjadi input API. Size adalah **cacah
kontrak bulat** (`^\d+$`) karena `OrderIntent.size` bertipe integer; kontrak
dengan `enableDecimal=true` tetap dibatasi bentuk itu oleh DTO backend.

**Preview vs otoritatif.** `buildOrderPreview` (murni, `lib/trade/preview.ts`)
menghitung estimasi memakai decimal.js dengan aturan pembulatan core (margin/fee
ke atas, 8 dp). Ia TIDAK mengimplementasikan mesin exchange kedua: tanpa transisi
posisi, settlement PnL, likuidasi, funding, atau mutasi dompet. Semua angka
estimasi diberi label "Est." dan `~`. Backend tetap otoritatif.

**Validasi dari ContractSpec**: `enableDecimal`, `orderSizeMin/Max`, `priceTick`
(tick 11 dp OK), `leverageMin/Max`, `makerFeeRate`/`takerFeeRate`,
`quantoMultiplier` — tidak ada asumsi BTC.

**Marketability** (preview saja): LONG marketable bila `limit >= ask`; SHORT bila
`limit <= bid`; batas kesetaraan inklusif. Marketable → taker tanpa reservasi;
resting → maker + `RESERVING` margin.

## Status pengiriman & retry

```
idle → submitting → succeeded
                  → definitively_failed   (4xx: payload boleh diubah)
                  → outcome_uncertain     (timeout/5xx: JANGAN bilang "gagal")
```

Saat `submitting`, payload **dibekukan** (`frozen: {commandId, intent}`). Retry
memakai commandId DAN payload yang sama; menyunting field tidak mengubah perintah
yang belum pasti. `outcome_uncertain` menampilkan "Memeriksa status order…" dengan
tombol **Cek ulang (commandId sama)** dan **Batalkan aksi**. Hanya setelah
`definitively_failed` atau `abandon` pengguna boleh mengirim payload berbeda
(commandId baru).

Kebenaran idempotensi tetap di backend (`trade_commands.request_hash`); UI hanya
memastikan klien tidak pernah membuat perintah baru untuk aksi logis yang sama.

**Kebijakan sukses:** pertahankan `side`, `type`, `leverage`; kosongkan `size`,
TP, dan SL (mencegah kirim ulang tak sengaja). Tidak ada reload halaman; state
diperbarui lewat peristiwa domain + refresh read model.

## Aksi posisi & order

- **Cancel** (Orders): hanya untuk status `open`/`partially_filled`, memakai
  commandId baru, tombol menampilkan `Membatalkan…` selama pending. Tidak ada
  pelepasan margin optimistis di klien — refresh akun yang menentukan.
- **Close** (Positions): penuh (backend belum mendukung partial). Popover
  menampilkan arah, size, entry, UPnL, dan **harga eksekusi** (LONG → bid, SHORT →
  ask). Bila kutipan tidak tersedia, tombol dinonaktifkan dengan pesan
  `Waiting for executable market quote…` — penutupan tidak pernah memakai harga
  karangan.
- **Edit Protection** (Positions): popover TP/SL. Kosong = hapus, tidak disentuh =
  pertahankan. Tiap amandemen memakai commandId sendiri. Label `MARK-triggered`
  ditampilkan di dekat kontrol.
- Aksi memakai popover/panel kanan, bukan modal besar; chart tetap terlihat.

## Keadaan aksi tabel

idle → pending (`Membatalkan…`/`Menutup…`/`Menyimpan…`) → sukses (refresh) →
error (pesan + kode). Baris tidak pernah dihapus optimistis sebelum backend
mengonfirmasi.

## Dogfood live (opt-in)

`bun run smoke:live-api` menembak endpoint yang sama dengan terminal terhadap
server `MODE=live`:

```
akun → deposit → market order PAPER di kutipan Gate → posisi → TP/SL →
tunggu mark bergerak → close → ledger → integritas
```

Hasil terakhir (BTC_USDT, live): fill di 81325.2 (kutipan ask), fee 0.00609939,
TP/SL 82951.7/79698.7, mark bergerak ke 81387 dengan UPnL berubah, close di
81391.2, realized +0.0066, wallet `999.99439627` yang rekonsiliasi **persis**
dengan `1000 − fee_open + PnL − fee_close`, ledger
`deposit,margin_lock,fee,pnl_realized,margin_release`, integritas OK.
Tidak ada order yang dikirim ke Gate.

## Keadaan panel

Setiap panel memakai `StateMessage`:
loading · empty (`No open positions`, `No resting orders`, …) ·
error (pesan + kode dari backend) · stale (harga basi) · disconnected
(feed belum ada). Tidak ada persegi kosong.
