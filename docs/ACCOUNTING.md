# crypastra — Aturan Akuntansi (Paper Exchange)

Paper Exchange adalah **sistem akuntansi**, bukan simulator. Dokumen ini adalah
kontrak uang. Setiap perubahan di sini = perubahan berisiko tinggi.

## 1. Tipe uang

```ts
// packages/core/src/money.ts
type DecimalString = string;            // batas I/O saja
// Semua aritmetika memakai Decimal (decimal.js) dengan konfigurasi:
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,      // pembulatan eksplisit, bukan implisit
  toExpNeg: -30,
  toExpPos: 40,
});
```

- **Dilarang** `number` pada: harga, size-notional, margin, PnL, fee, funding, saldo,
  rate. `eslint`/review menolak `Number(...)`/`parseFloat` pada nilai uang.
- Konversi `string → Decimal` hanya di parser adapter/repository.
- Konversi `Decimal → string` hanya di serialisasi/UI.
- `Number(decimal)` hanya boleh untuk charting/plot di UI, tidak pernah untuk
  keputusan trading atau penulisan DB.

Skala kanonik per besaran (dibulatkan eksplisit di setiap operasi, bukan hanya di akhir):

| Besaran | dp |
|---|---|
| Harga order/fill | sesuai `order_price_round` kontrak |
| Mark price (internal) | 8 |
| Notional / PnL / fee / funding / margin | 8 |
| Rate (funding_rate, mmr, fee_rate) | 18 |
| Saldo tersimpan | 8 |

Aturan pembulatan (dipusatkan di `packages/core/src/exchange/rounding.ts`;
modul exchange lain dilarang memanggil `toDecimalPlaces`/`Decimal.ROUND_*`):

| Besaran | Fungsi | Arah |
|---|---|---|
| Fee | `roundFeeAmount` | CEIL 8 dp (pada amount bertanda) |
| PnL & funding | `roundMoneyNeutral` | HALF_UP 8 dp |
| Initial & maintenance margin | `roundMarginUp` | CEIL 8 dp |
| Available balance | `roundAvailableDown` | FLOOR 8 dp |
| Harga order | `quantizeToTick` | HALF_UP ke `order_price_round` |
| Harga likuidasi | `quantizeLiquidationPrice` | CEIL (long) / FLOOR (short) ke `mark_price_round` |
| Rate | `scaleRate` | HALF_UP 18 dp |
| Cacah kontrak | `floorToContractCount` | FLOOR 0 dp (cacah, bukan uang) |

**Harga TIDAK memakai 8 dp.** `order_price_round` Gate.io sampai **11 dp**
(`SATS_USDT` = `0.00000000001`). Hanya uang akuntansi yang 8 dp.

Akibat skala uang 8 dp: PnL di bawah setengah satuan 8 dp (5e-9) dibulatkan ke 0.
Kontrak bertick sangat kecil butuh cacah kontrak lebih besar agar PnL terwakili.

## 2. Konversi ukuran

Gate.io memakai ukuran **kontrak** (integer, `size`), bukan base quantity:

```
qty_base = size × quanto_multiplier          (mis. 1 × 0.0001 = 0.0001 BTC)
notional = qty_base × price                  (USDT)
size     = notional / (quanto_multiplier × price)   → dibulatkan ke integer size
```

Validasi wajib sebelum order diterima:
`size` integer, `order_size_min ≤ size ≤ order_size_max`, dan
`size × quanto_multiplier × price ≥ min_notional` (bila `min_notional` tersedia;
saat ini **tidak** ada di payload kontrak Gate.io → assumption A5).

## 2b. Satuan (WAJIB dibaca sebelum rumus apa pun)

```
contracts            × base_asset_per_contract = base_asset_quantity
base_asset_quantity  × quote_per_base          = quote notional (USDT)
quote notional       × rate                    = quote fee / funding
```

`quanto_multiplier` = **base asset per 1 kontrak**, dan HETEROGEN. Terverifikasi
20 Sep 2026 (997 kontrak USDT): `0.0001` (BTC), `0.01` (ETH), `1` (SOL/XRP-River),
`10` (XRP), `100` (ARIA/TRX), `10000000` (PEPE/SATS). Jangan pernah mengasumsikan
nilai BTC secara global.

`size` adalah **cacah kontrak** (INTEGER di DB), bukan kuantitas base asset.
`enable_decimal` menentukan apakah cacah boleh desimal (14/997 kontrak true).

## 3. Margin isolated — per posisi

```
dir                = +1 (long) | −1 (short)
notional_entry     = size × quanto_multiplier × entry_price
initial_margin     = ceil8(notional_entry / leverage)
maintenance_margin = ceil8(size × quanto_multiplier × mark_price × maintenance_rate)
upnl               = size × quanto_multiplier × (mark_price − entry_price) × dir
position_equity    = initial_margin + upnl − protocol_losses
protocol_losses    = fees_paid + accumulated_funding   (funding >0 = biaya bagi trader)
```

Contoh BTC_USDT terverifikasi (`size=1`, `price=80000`, `leverage=10`):
notional 8 USDT, initial margin **0.8**, maintenance (mmr 0.003) **0.024**.

Akun (semua dalam USDT):

```
wallet_balance    = initial + deposit − withdrawal + realized_pnl − fees − funding
                    (+ liquidation losses, + adjustment)
used_margin       = Σ initial_margin(posisi open)
reserved_margin   = Σ reserved_margin(order limit open)
available_balance = floor8(wallet_balance − used_margin − reserved_margin)
equity            = wallet_balance + Σ upnl(posisi open)
margin_ratio      = used_margin / equity          (guard: equity ≤ 0 → likuidasi paksa)
```

**Penting:** `unrealized_pnl` TIDAK pernah masuk `wallet_balance`. Ia hanya muncul di
`equity`. Ini mencegah PnL belum direalisasi bisa ditarik.

## 4. Fee

```
fee = notional_fill × rate        rate = taker_fee_rate | maker_fee_rate
```

Rate bisa **negatif** (rebate). Terverifikasi: `maker_fee_rate` negatif untuk
**seluruh 997** kontrak USDT Gate.io (`-0.0001`), `taker_fee_rate` `0.00075`.

Pembulatan: **`ROUND_CEIL` 8 dp pada amount bertanda** (`roundFeeAmount`).
Ini memberi dua hal sekaligus tanpa kasus khusus:

| Kasus | Eksak | Hasil | Efek |
|---|---|---|---|
| Biaya | `0.0000000375` | `0.00000004` | trader membayar lebih |
| Rebate | `−0.000000805` | `−0.00000080` | trader menerima lebih sedikit |

Trader tidak pernah mendapat hasil lebih baik dari nilai eksak. Rebate **tidak**
di-clamp ke nol. Contoh BTC_USDT: taker `8 × 0.00075 = 0.006`, maker
`8 × −0.0001 = −0.0008`.

Gate.io BTC_USDT: `maker_fee_rate = -0.0001` (rebate 0.01%), `taker_fee_rate = 0.00075`
(0.075%). **Maker fee bisa negatif** → ledger harus mendukung fee bernilai negatif
(kredit). Ini kasus uji wajib.

Aturan likuiditas fill:
- Order `market` selalu `taker`.
- Order `limit` yang mengisi order book internal saat masuk = `maker`.
- Order `limit` yang menyapu level lawan saat masuk = `taker` (dan bisa partial
  maker + taker dalam satu fill → simpan `liquidity` per **fill**, bukan per order).

Fee dicatat sebagai entri ledger terpisah (`type='fee'`) yang mereferensikan `fill.id`,
dan juga `fills.fee` sebagai nilai turunan (denormalisasi untuk tampilan).

## 5. Funding

```
funding_amount = size × quanto_multiplier × mark_price × funding_rate
```

- `funding_rate > 0` → LONG **membayar** SHORT. `funding_rate < 0` → sebaliknya.
- Nilai `funding_rate` diambil dari `futures.tickers.funding_rate` (rate periode
  berjalan) atau `contracts.funding_rate`, dan dibekukan saat tick funding.
- Jadwal dari `funding_next_apply` (epoch detik) dan `funding_interval` (28800 dtk).
- Idempotensi: `funding:{contract}:{funding_next_apply}:{position_id}`.
- Funding diterapkan pada posisi **open** saat tick. Posisi yang dibuka beberapa detik
  sebelum tick **tetap** membayar penuh (perilaku exchange nyata) → assumption A7.

**Assumption yang harus diverifikasi (A3, A7):** apakah Gate.io memakai mark price
saat tick atau rata-rata time-weighted; apakah ada prorata. Model awal: mark price
saat tick, tanpa prorata, biaya penuh.

Konsekuensi akuntansi: funding menggerakkan `wallet_balance` (realized) **dan**
mengurangi `position_equity` untuk keperluan likuidasi. Karena `initial_margin` tetap,
implikasi: funding kumulatif tinggi bisa memicu likuidasi walau harga tidak bergerak.
Fitur ini wajib — bukan bug.

## 6. Likuidasi

Dipicu saat `position_equity ≤ maintenance_margin` (isolated).

**Model berada di belakang batas eksplisit** (`LiquidationModel`), dengan
implementasi default `SimpleIsolatedLiquidationModel` yang menyatakan
`provenance: "simulator"`. Ini **BUKAN** replika formula Gate.io — A6 masih
belum terverifikasi. Jangan menyebutnya "formula likuidasi Gate.io".

```
notional_entry = size × quanto_multiplier × entry_price
initial_margin = ceil8(notional_entry / leverage)
maintenance_at_entry = ceil8(notional_entry × maintenance_rate)
buffer         = initial_margin − maintenance_at_entry
distance/unit  = buffer / (size × quanto_multiplier)
liq_long       = entry − distance      (dikuantisasi CEIL ke mark_price_round)
liq_short      = entry + distance      (dikuantisasi FLOOR ke mark_price_round)
```

**Domain sah: `buffer > 0`, yaitu `1/leverage > maintenance_rate`.**
Terverifikasi untuk 997 kontrak USDT Gate.io: `1/leverage_max − maintenance_rate`
selalu > 0 (minimum 0.002; ARIA_USDT 1/10 − 0.08 = 0.02). Pada domain ini harga
likuidasi **selalu ada dan > 0**, dan memenuhi `liq_long < entry < liq_short`.

Di luar domain itu (kasus salah konfigurasi) model mengembalikan hasil bertipe
`{ kind: "no_price", reason: "initial_margin_not_above_maintenance" }` — keadaan
pasar yang sah tapi degenerate. Ini **tidak** di-clamp menjadi harga 0, karena
clamp akan menyembunyikan masalah.

Contoh BTC_USDT: `leverage=10` → liq_long `72240` (= 80000 − 80000×0.097);
`leverage=1` → liq_long `240` (= 80000 × 0.003).

Saat likuidasi dieksekusi:

1. Trigger diperiksa pada setiap update mark price dan setiap funding tick.
2. Posisi ditutup; harga penutup = harga likuidasi bila mark sudah melewatinya,
   selain itu mark price (worst case).
3. Fee taker likuidasi diterapkan (A6: apakah Gate.io memakai fee khusus likuidasi).
4. `realized_pnl = size × quanto_multiplier × (exit − entry) × dir`
5. Kerugian dibatasi oleh margin posisi (isolated): `wallet_delta =
   max(0, initial_margin + realized_pnl − funding − fees − liquidation_fee)`.
   Bila terpaksa di-clamp, `insolvent = true` dicatat untuk audit.

Penting: clamp di langkah 5 berlaku pada **settlement dompet**, bukan pada harga
likuidasi. Harga likuidasi yang tidak valid tidak pernah di-clamp.

## 7. TP/SL

- Trigger berbasis **mark price** (assumption A4 — Gate.io juga punya trigger
  berbasis last price; kita awali mark price).
- `tp`/`sl` disimpan di `positions` (dan opsional di `orders` untuk attached TP/SL).
- Saat terpenuhi → membuat fill penutup dengan `is_tp_sl = 1`, dan **fee taker**.
- Untuk SHORT: `tp` bila `mark ≤ tp_price`, `sl` bila `mark ≥ sl_price`.
- Urutan evaluasi bila TP dan SL **sama-sama** terpenuhi: SL diprioritaskan
  (konservatif). Koreksi Phase 2: ini BUKAN akibat "gap" — untuk LONG, TP
  terpenuhi saat `observed ≥ tp` dan SL saat `observed ≤ sl`, sehingga keduanya
  saling eksklusif pada satu harga selama `tp > sl`. Keduanya hanya bisa
  terpenuhi bersamaan bila harga trigger **bersilangan** (`tp ≤ sl` untuk long),
  yaitu salah konfigurasi. Prioritas SL tetap dipertahankan.
- Perbandingan trigger INKLUSIF pada kesetaraan (`≥`/`≤`).
- Reduce-only: fill TP/SL tidak boleh membalik arah posisi.

## 8. Order lifecycle & reservasi margin

State machine (ditegakkan `packages/core/src/exchange/order-state.ts`,
transisi ilegal melempar `InvalidOrderError`):

```
created → validated → { open | partially_filled | filled | cancelled | rejected }
open → partially_filled → { partially_filled | filled | cancelled | expired }
filled | cancelled | rejected | expired = TERMINAL
```

`partially_filled` bersifat **terminal untuk order immediate** (sisa dibatalkan saat
itu juga) dan **live untuk limit gtc/post_only**. Liveness ditentukan
`isOrderLive(type, timeInForce, status)`.

Sisa yang tidak terisi pada order immediate tidak membuat status `cancelled` bila
order masih bisa resting: order resting yang tidak tersentuh snapshot TETAP `open`.
(Koreksi bug Phase 3 — kalau salah, order kehilangan status live sementara
reservasinya masih tertahan.)

Reservasi margin (hanya order resting):
```
reserved_margin = ceil8(size × quanto_multiplier × limit_price / leverage)
```
- Direservasi saat order menjadi `open`.
- Dikonsumsi proporsional terhadap ukuran yang terisi; SELURUHNYA saat fill
  menghabiskan sisa order.
- Dilepas seluruhnya saat cancel.
- `reduce_only` tidak butuh reservasi baru (margin sudah ada di posisi).
- Market dan limit marketable tidak menahan reservasi; dieksekusi langsung (taker).

Konversi reservasi → margin posisi ditulis sebagai SATU entri ledger
(`margin_release` dengan `reserved_delta = −R_f`, `margin_delta = +required`,
`amount = 0`), sehingga `Δavailable = R_f − required` dan wallet tidak tersentuh.

Invariant: `available_balance ≥ 0` pada setiap transisi. Order yang akan membuat
`available_balance < 0` **ditolak** (bukan dipartial). Untuk market order besar yang
tidak muat di buku → partial fill, sisa dibatalkan (IOC).

**Risk gate.** Margin baru dihitung lewat dry-run seluruh rencana fill SEBELUM efek
apa pun. Ini menutup order market (yang tidak punya reservasi untuk diperiksa).

**Idempotensi.** Setiap perintah punya `commandId`; retry tidak menggandakan efek
ekonomi (tabel `trade_commands`, ADR 0007).

## 8b. Transisi posisi (one-way) dan klasifikasi fee

Satu posisi netto per (account, contract). Hedge mode tidak didukung. Flip arah
SELALU close penuh + open baru (dua baris posisi), tidak pernah ukuran negatif.

| Kondisi | Hasil | PnL | Margin |
|---|---|---|---|
| tanpa posisi | `open` | 0 | `ceil8(fill_notional / leverage)` ditambah |
| searah | `increase` | 0 | margin fill ditambah; entry = rata-rata tertimbang |
| berlawanan, lebih kecil | `reduce` | dari porsi tertutup | proporsional dilepas (FLOOR 8 dp) |
| berlawanan, sama besar | `close` | dari seluruh posisi | seluruh margin dilepas |
| berlawanan, lebih besar | `flip` | dari posisi lama | seluruh margin lama dilepas + margin baru |

Entry rata-rata (eksak, tanpa pembulatan antara):
```
(qty_lama × entry_lama + qty_fill × harga_fill) / (qty_lama + qty_fill)
```
`entry_price` posisi adalah rata-rata akuntansi, bukan harga yang dapat
ditransaksikan, jadi tidak dikuantisasi ke tick.

Klasifikasi fee per fill:
- order baru (market / limit marketable) → **taker**
- order resting yang terisi dari snapshot berikutnya → **maker**

Rebate maker tetap negatif (`amount` ledger positif), tidak pernah di-clamp.

`reduce_only` membatasi ukuran pada eksposur yang bisa ditutup (tidak menambah dan
tidak membalik); order `reduce_only` tanpa posisi atau searah posisi ditolak.

## 8c. Valuasi runtime, funding, TP/SL, dan likuidasi (Phase 4)

### Istilah (jangan overload "balance")

```
wallet_balance    = kas realisasi. Berubah HANYA oleh deposit/withdrawal/fee/
                    funding/PnL realisasi.
unrealized_pnl    = Σ PnL posisi terbuka pada MARK price. TURUNAN, bukan saldo.
equity            = wallet_balance + unrealized_pnl
position_margin   = Σ margin awal posisi terbuka (= used_margin)
reserved_margin   = Σ reservasi order resting
available_balance = floor8(wallet_balance − position_margin − reserved_margin)
margin_ratio      = position_margin / equity
```

**Kebijakan:** `available_balance` TIDAK memasukkan unrealized PnL. Keuntungan
belum realisasi bukan uang yang bisa dibelanjakan. Unrealized loss tetap
menurunkan `equity` dan menaikkan `margin_ratio`, dan itu dasar likuidasi.

Mark-to-market TIDAK menulis ledger. Tidak ada entri per tick.

### Mark price dan staleness

`MarkSnapshot { contract, markPrice, observedAtMs, sourceTimestampMs, funding }`.
Mark basi (umur > `maxStalenessMs`, default 5000 ms, ATAU timestamp sumber di masa
depan) → valuasi tetap dilaporkan tetapi **tidak ada** likuidasi, TP/SL, maupun
funding. Tidak ada fallback diam-diam ke last price.

### Presedensi (satu snapshot)

```
1. validitas data (staleness)   4. take profit
2. likuidasi                    5. funding / valuasi
3. stop loss
```

Likuidasi mendahului exit protektif. **Kebijakan funding: diterapkan SETELAH aksi
risiko pada snapshot yang sama**, sehingga posisi yang ditutup pada snapshot itu
tidak dikenakan funding periode tersebut. Ini aturan simulator (A3/A6 belum
terverifikasi), bukan klaim paritas Gate.io.

### Funding (kebijakan simulator, A3 belum terverifikasi)

- Sekali per `fundingTimestampMs` per posisi; kunci
  `funding:{contract}:{fundingTimestampMs}:{positionId}`.
- Posisi dikenakan bila `openedAtMs <= fundingTimestampMs` (inklusif).
- Hanya posisi `open`; ditutup sebelum ATAU tepat pada T tidak dikenakan.
- Dasar notional = MARK price. Tanpa prorata.
- `amount` ledger = −payment: rate positif → long membayar, short menerima.
  Rebate/negatif tidak pernah di-clamp.

### TP/SL

- Trigger dari MARK price, inklinusif (`>=`/`<=`); SL menang atas TP bila keduanya
  terpicu (hanya mungkin bila harga trigger bersilangan).
- **Trigger ≠ harga eksekusi.** Eksekusi memakai `ExecutionQuote` eksplisit:
  LONG ditutup di BID, SHORT di ASK. Gap tidak dipalsukan (SL 78000 dengan gap ke
  74900 dieksekusi di 74900).
- TP/SL disimpan di `positions.tp_price`/`sl_price`, diisi dari intent saat
  posisi dibuka/di-flip. Tidak ada trailing stop.

### Likuidasi dan insolvensi (model simulator)

Model default `SimpleIsolatedLiquidationModel`, `provenance: "simulator"`. Bukan
formula Gate.io (A6).

```
realizedPnl        = qty × (exit − entry) × dir
releasedMargin     = initialMargin posisi
pnlAppliedToWallet = max(realizedPnl, −releasedMargin)
deficit            = max(0, −realizedPnl − releasedMargin)
```

Kas tidak pernah dibebani lebih dari margin posisi (isolated). Defisit yang
melebihi kolateral TIDAK dihapus: dicatat sebagai entri ledger
`liquidation_loss` dengan `meta.deficit` + `insolvent: true` di
`position_events`. Identitas: `realizedPnl = pnlAppliedToWallet − deficit`.

`liquidationOutcome` (helper Phase 2) mengasumsikan margin ada di dalam kas dan
**tidak** dipakai untuk settlement runtime; gunakan `settleIsolatedClose`.

Likuidasi bersifat per-posisi (isolated): kerugian satu posisi tidak
melikuidasi posisi lain dan tidak melepas marginnya.

## 8d. Replay: semantik yang harus tetap sama (Phase 8)

Replay memutar semantik simulator yang sudah berlaku, TIDAK mengubahnya:

| Peristiwa | Perilaku |
|---|---|
| Order market | eksekusi di **ASK (buy) / BID (sell)** dari kutipan, bukan mark |
| Penutupan MANUAL | kutipan buku (LONG → bid, SHORT → ask) |
| Penutupan OTOMATIS (TP/SL/likuidasi) | **mark saat pemicu** (kebijakan Phase 6) |
| TP/SL | terpicu dari mark; harga trigger ≠ harga eksekusi |
| Funding | basis mark, sekali per `fundingTimestampMs`, setelah aksi risiko |

Consequence: dalam rekaman golden, LONG dibuka di ask 80001 dan ditutup otomatis
oleh SL di mark 77500 (bukan di harga trigger 78000, dan bukan di bid buku),
sehingga realized PnL = `1 × 0.0001 × (77500 − 80001) = −0.2501`.

## 9. Rekonsiliasi

Karena ledger append-only dan saldo adalah cache:

```
rebuildBalances(accountId):
  wallet = initial
  for entry in ledger ORDER BY seq:
     wallet += entry.amount
     assert(wallet == entry.balance_after)   // deteksi korupsi
  assert(wallet == account_balances.wallet_balance)
```

Job rekonsiliasi ini dijalankan: saat boot, sebelum/ sesudah replay, dan di test.
Kalau mismatch → API mengembalikan `INTEGRITY_ERROR`, bukan angka karangan.

## 10. Kasus uji finansial wajib (ringkas; detail di PLAN.md §9)

1. Maker rebate (fee negatif) menambah saldo.
2. Fee dibulatkan ke atas pada notional kecil (dust).
3. Funding long saat rate positif mengurangi saldo; short menambah.
4. Funding idempoten: dua panggilan tick yang sama hanya sekali.
5. Partial fill: fee dan realized PnL dihitung per fill, agregat = nilai order.
6. Flip posisi (long → short) tidak menghasilkan `size` negatif.
7. Likuidasi tidak menghasilkan saldo negatif (clamp + flag insolvent).
8. TP dan SL terpicu pada tick yang sama → SL menang.
9. `available_balance` tidak pernah negatif; order yang melebihi saldo ditolak.
10. Reduce-only tidak menambah posisi.
11. Rebuild ledger byte-identik dengan saldo cache.
12. Replay determinisme: dua run dari state sama → ledger identik.
13. Mark price vs last price divergence: likuidasi pakai mark, fill pakai last.
14. Leverage 1 (tanpa pinjaman) → likuidasi hanya bila harga ≤ 0 (long).
15. Pembulatan initial margin ke atas mencegah overspend di batas saldo.

## Eksekusi otonom (Phase 11)

Eksekusi otonom **tidak menambah aturan akuntansi baru**. Ia memakai jalur
OrderService PAPER yang sama: fee, margin, PnL realisasi, funding, dan likuidasi
mengikuti semantik yang sudah ada di dokumen ini.

Yang ditambahkan hanya **pengukuran**:

- `grossRealizedPnl` = PnL realisasi posisi (sebelum biaya/funding)
- `fees` = `fees_paid` posisi (positif = beban, rebate negatif)
- `funding` = `accumulated_funding` posisi (positif = beban)
- `netPnl` = `grossRealizedPnl − fees − funding`

`netPnl` **tidak** disimpulkan dari delta wallet, karena wallet juga bergerak
oleh deposit/penarikan dan margin meta. Tidak ada tipe entri ledger baru, dan
tidak ada perubahan pada trigger append-only.

## Ukuran kontrak (Phase 11.5)

Cacah kontrak BUKAN nilai moneter dan tidak dibulatkan ke 8 dp. Representasinya:

- kontrak `enable_decimal=false` → cacah integer (mis. BTC_USDT 125)
- kontrak `enable_decimal=true` → cacah desimal (mis. ETH_USDT 1.25)

Validasi dipisah: bentuk sintaktis (desimal positif berhingga) diperiksa di
skema/DTO, sedangkan aturan kontrak (`enableDecimal`, `orderSizeMin`,
`orderSizeMax`) diperiksa `assertValidSize` di OrderService. Tidak ada
pembulatan diam-diam di OrderService: Phase 10 yang boleh membulatkan saat
perencanaan, eksekusi memvalidasi ukuran persis.

Seluruh aritmetika ukuran (konsumsi level buku, increase/reduce/close/flip,
reservation) memakai `Decimal` dengan satu titik konversi ke `number`
(`toContractCount`), sehingga rangkaian seperti `0.3 − 0.1 − 0.1 − 0.1` tepat
nol. Rumus ekonomi tidak berubah dan tidak ada rumus khusus kontrak desimal:
`baseQty = contracts × quantoMultiplier`, `notional = baseQty × price`,
`PnL = contracts × multiplier × priceDifference`, `fee = notional × rate`,
`margin = notional / leverage`.

Fingerprint perintah memakai bentuk kanonik cacah kontrak
(`canonicalContractSize`), sehingga `"1.5"`, `"1.50"`, dan `"1.500"` dianggap
perintah yang sama dan idempotensi tidak pecah karena format.
