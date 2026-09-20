# Dataset riset (`dataset-v1`)

Perintah: `bun run dataset:label`, `bun run dataset:status`, `bun run dataset:export`.
Versi label: `outcome-label-v1` (`docs/LABELS.md`).

## Baris dataset

Satu baris per kandidat scanner:

| Kelompok | Bidang |
|---|---|
| Identitas | `sessionId`, `contract`, `timeframe`, `candleCloseTimeMs`, `direction` |
| Versi | `datasetVersion`, `featureVersion`, `scannerVersion`, `scannerConfigHash` |
| Jev | `jevInputHash`, `evaluations[]` (evaluator, status, probability, regime, versi evaluator/prompt/skema, provider, model) |
| Perlakuan | `candidateStatus`, `treatmentStatus`, `treatmentReasons` |
| Label | `labels` (`outcome-label-v1`, per horizon) |

**DILARANG ada**: accountId, wallet, saldo, margin, ledger, API key, identifier
pengguna, atau id implementasi DB. Diuji pada output terserialisasi.

Format ekspor: **JSONL** dengan urutan kanonik
`(session, candleCloseTimeMs, contract, direction)`.

## Determinisme

Dua ekspor dari rekaman + evaluasi Jev + versi label yang sama menghasilkan
`combinedHash` **identik**. Hash hanya memuat baris kanonik — tanpa id baris DB,
tanpa jam dinding, tanpa UUID.

## `dataset:label` — pelabelan offline

`bun run dataset:label -- <sessionId>` menurunkan label `outcome-label-v1` untuk
setiap kandidat scanner pada rekaman. Idempoten: kandidat yang sudah berlabel
dilewati. Label hanya dibaca jalur riset.

## `dataset:status` — kesiapan & kualitas

Per sesi: durasi, bytes, distribusi observasi, dan per kontrak: jumlah candle 5m
tertutup, status **EMA200**, jumlah candle pasca-warmup, jumlah kandidat scanner,
cakupan Jev (`complete/total`), cakupan funding, dan jumlah gap candle.

Aturan kesiapan:

- **EMA200 tetap mengikat.** Rekaman dengan 199 candle **tidak** siap; warmup
  `features-v1` tidak pernah dilonggarkan untuk membuat dataset lebih cepat
  terpakai.
- Cakupan Jev dihitung hanya dari kandidat `complete`.

Laporan kualitas juga memuat:

- cakupan Jev: `complete` / `partial` / `missing` / `invalid` / `unavailable`
- cakupan label per horizon
- status label: `complete` / `incomplete` / `missing`
- **class balance** untuk target biner pada horizon 1
- distribusi kontrak dan arah
- **bucket probabilitas** (0.0–0.1 … 0.9–1.0) dengan jumlah observasi

Bucket bersifat **deskriptif**. Laporan ini **tidak** menghitung ambang terbaik,
tidak menyarankan parameter, dan tidak mengklaim kualitas kalibrasi — analisis
statistik/ kalibrasi adalah pekerjaan fase berikutnya.

## Cakupan funding

Observasi funding dipersist dengan rate, timestamp aplikasi, interval, dan mark
konteks dari aliran pasar **publik**. Bila sebuah field tidak tersedia dari jalur
publik, nilainya dipersist eksplisit sebagai null/unknown dan didokumentasikan;
replay **tidak pernah** mengarang funding nol.

## Batasan yang diketahui

- Tanpa rekaman nyata yang cukup panjang, seluruh angka berasal dari fixture
  sintetis (dilaporkan jujur).
- `dataset:status` membaca artefak analitik yang sudah ada; ia tidak menjalankan
  fitur/scanner sendiri.
- Label BTC belum diimplementasikan (lihat `docs/LABELS.md`).
