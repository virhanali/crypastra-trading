# 0008 — Runtime risiko & settlement: mark-to-market, funding, TP/SL, likuidasi

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0003 (mark price), 0005 (persistensi), 0006 (kernel matematika), 0007 (siklus order)

## Konteks

Phase 4 menambahkan pemrosesan runtime deterministik untuk posisi yang sudah ada:
satu snapshot mark price eksplisit → valuasi → aksi risiko (likuidasi/SL/TP) →
funding. Tanpa loop, tanpa WebSocket, tanpa scheduler; pemanggil menentukan kapan.

Requirement yang membentuk keputusan:

- Unrealized PnL bersifat TURUNAN, bukan entri ledger per tick.
- Mark price otoritatif untuk valuasi/likuidasi/funding/TP-SL; harga eksekusi
  berasal dari kutipan yang diberikan terpisah.
- A3 (dasar funding) dan A6 (formula likuidasi) tetap belum terverifikasi.
- Isolated margin: likuidasi adalah peristiwa per-posisi.
- Setiap efek akuntansi harus atomik dan idempoten.

## Keputusan

### 1. Valuasi turunan, tanpa ledger

Mark-to-market TIDAK menulis ledger. `valuatePosition`/`valuateAccount` (core,
murni) menghitung:

```
wallet_balance    = kas realisasi (hanya berubah oleh deposit/withdrawal/fee/
                    funding/PnL realisasi)
unrealized_pnl    = Σ PnL posisi terbuka pada MARK price
equity            = wallet_balance + unrealized_pnl
position_margin   = Σ margin awal posisi terbuka (= `used_margin`)
reserved_margin   = Σ reservasi order resting
available_balance = floor8(wallet_balance − position_margin − reserved_margin)
```

`available_balance` TIDAK memasukkan unrealized PnL. Keuntungan belum realisasi
bukan uang yang bisa dibelanjakan. Unrealized LOSS tetap menurunkan `equity` dan
menaikkan `margin_ratio`, dan itulah dasar likuidasi.

`valuateAccount` mendelegasikan ke `deriveAccount` (Phase 2) supaya hanya ada satu
implementasi aritmatika akun.

### 2. Mark price otoritatif, dan staleness eksplisit

`MarkSnapshot { contract, markPrice, observedAtMs, sourceTimestampMs, funding }`.
`markFreshness` mengembalikan umur dan status basi. **Timestamp sumber di masa
depan dianggap basi** (clock tertinggal dari exchange).

Kebijakan simulator: mark basi/tidak valid → valuasi tetap dilaporkan, tetapi
**tidak ada** likuidasi, TP/SL, maupun funding. Tidak ada fallback diam-diam ke
last price.

### 3. Presedensi runtime (satu snapshot)

```
1. validitas data (staleness gate)
2. likuidasi
3. stop loss
4. take profit
5. funding / valuasi normal
```

Likuidasi MENDAHULUI exit protektif: aturan lama "SL menang atas TP" tidak berlaku
saat posisi sudah likuidatable. Konsekuensi urutan funding yang dipilih dan
didokumentasikan: **funding diterapkan SETELAH aksi risiko pada snapshot yang
sama**, sehingga posisi yang ditutup pada snapshot itu tidak dikenakan funding
periode tersebut. A6/A3 belum terverifikasi, jadi ini aturan simulator, bukan
klaim paritas Gate.io. Ada test khusus untuk kedua sisi kebijakan ini.

### 4. TP/SL: trigger ≠ harga eksekusi

Trigger memakai `triggerReached` (core) terhadap MARK price, inklusif pada
kesetaraan. Harga eksekusi berasal dari `ExecutionQuote` yang diberikan
terpisah (`executionPriceFor`: LONG ditutup di BID, SHORT di ASK). Gap TIDAK
dipalsukan: SL 78000 dengan mark gap ke 75000 dan bid 74900 dieksekusi di
**74900**, bukan 78000.

TP/SL dipersist di kolom `positions.tp_price`/`sl_price` yang sudah ada
(DATA-MODEL), diisi dari `OrderIntent.tpPrice/slPrice` saat posisi dibuka atau
di-flip. Tidak ada trailing stop (sesuai lingkup). Tidak ada migration baru.

### 5. Settlement isolated dan semantik defisit

Karena model ledger Phase 1+ memisahkan margin posisi dari `wallet_balance`,
helper Phase 2 `liquidationOutcome` (yang mengasumsikan margin ada di dalam kas)
TIDAK dipakai untuk settlement runtime. Penggantinya, `settleIsolatedClose` (core,
murni):

```
realizedPnl        = qty × (exit − entry) × dir
releasedMargin     = initialMargin posisi
pnlAppliedToWallet = max(realizedPnl, −releasedMargin)
deficit            = max(0, −realizedPnl − releasedMargin)
```

Kas tidak pernah dibebani lebih dari margin posisi (isolated). Kerugian yang
melebihi kolateral (gap melewati harga likuidasi) TIDAK dihapus: `deficit`
dicatat sebagai entri ledger `liquidation_loss` dengan `meta.deficit` dan
`meta.absorbedBy = "simulator"`, plus `insolvent: true` di detail
`position_events`. Ledger tetap memenuhi `Σ amount = wallet_balance`, dan defisit
tetap terlihat. Identitas: `realizedPnl = pnlAppliedToWallet − deficit`.

### 6. Funding sebagai kebijakan eksplisit

Rumus funding tetap di `fee.ts`; KEBIJAKAN-nya di `funding-policy.ts`. A3 belum
terverifikasi, jadi kebijakan simulator didokumentasikan dan diuji:

1. Diterapkan SEKALI per `fundingTimestampMs` per posisi.
2. Posisi dikenakan bila `openedAtMs <= fundingTimestampMs` (inklusif).
3. Hanya posisi `open` yang dikenakan; posisi yang ditutup tepat pada T sudah
   tidak `open` saat snapshot diproses, jadi tidak dikenakan.
4. Dasar notional memakai MARK price, bukan entry/last.
5. Tanpa prorata; biaya penuh untuk periode tersebut.

Kunci idempotensi `funding:{contract}:{fundingTimestampMs}:{positionId}` dan
ditegakkan oleh UNIQUE `ledger.idempotency_key`, jadi retry, restart, maupun
replay tidak menggandakan.

### 7. Path penutupan paksa tidak mendistorsi OrderIntent

Penutupan paksa tidak dibuat sebagai `OrderIntent` (yang harus tetap
origin-agnostic dan tidak punya konsep alasan risiko). `MarkToMarketService`
memiliki path settlement internal yang memakai primitif core yang sama
(`planPositionTransition`, `feeFor`, `settleIsolatedClose`) dan repository yang
sama, tetapi menulis fill dengan `order_id = NULL` dan flag
`is_liquidation`/`is_tp_sl` yang sudah tersedia di DATA-MODEL. Alasan penutupan
(`take_profit`/`stop_loss`/`liquidation`/`manual`) dicatat di
`positions.close_reason`, `position_events`, dan `fills` flag — di LUAR intent
ekonomi, dan tidak pernah mengubah matematika PnL.

### 8. Idempotensi dan transaksionalitas runtime

Dua lapis:

1. **Perintah**: `trade_commands.command_id` (`process_mark`, `settle_position`).
   Retry dengan commandId sama tidak menjalankan ulang efek apa pun.
2. **Keadaan**: kunci ledger deterministik per efek (`funding:...`,
   `settle:{positionId}:{reason}:{effect}`) dan pemeriksaan status posisi
   (`hanya posisi open yang bisa ditutup`). Snapshot duplikat dengan commandId
   BERBEDA tetap tidak menggandakan efek karena posisi sudah tertutup dan kunci
   ledger sudah ada.

Setiap aksi yang mengubah keadaan berjalan dalam SATU transaksi
`BEGIN IMMEDIATE`. Test injeksi kegagalan membuktikan rollback penuh untuk
kegagalan pada penulisan ledger funding, ledger PnL settlement, dan
`position_events` close — posisi tetap terbuka, ledger/saldo/event tidak berubah.

### 9. Isolated, bukan cross

Likuidasi adalah peristiwa per-posisi: kerugian satu posisi tidak melikuidasi
posisi lain, dan margin posisi lain tetap terkunci. Diuji dengan dua posisi di
kontrak berbeda.

## Konsekuensi

- Tidak ada migration baru: kolom `tp_price`/`sl_price`/`close_reason` dan flag
  `is_liquidation`/`is_tp_sl` sudah ada sejak Phase 1.
- `liquidationOutcome` (Phase 2) tetap ada untuk kompatibilitas test, tetapi
  **bukan** jalur settlement runtime. Perbedaannya didokumentasikan di sini dan
  di `ACCOUNTING.md`.
- `fills.order_id` jadi benar-benar nullable dalam praktik (fill penutupan paksa).
- Parameter `RuntimeConfig` (staleness, enableLiquidation/enableTpSl/enableFunding)
  eksplisit; default terdokumentasi di `DEFAULT_RUNTIME_CONFIG`.
- Runtime belum dijalankan otomatis oleh apa pun: belum ada loop, scheduler, atau
  WebSocket. Wiring itu milik fase berikutnya.

## Verifikasi

- `bun test` → 419 pass (325 Phase 0–3 tanpa perubahan + 94 Phase 4), 0 fail.
- `bun run check` → core build, adapters check, server check hijau.
- Pemindaian unused/dead-code bersih (core, server).
- Skenario runtime 1500 langkah deterministik: reproducible byte-per-byte dengan
  seed sama, invariant (kas non-negatif, isolasi margin, rekonsiliasi ledger,
  identitas equity) diperiksa berkala.
