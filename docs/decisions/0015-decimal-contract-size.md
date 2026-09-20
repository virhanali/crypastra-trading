# ADR 0015 — Ukuran kontrak desimal di batas eksekusi

Status: diterima (Phase 11.5)
Tanggal: 2026-09-21

## Konteks

Phase 10 sudah menghasilkan ukuran kontrak desimal untuk kontrak Gate dengan
`enable_decimal = true` (14 dari 997; mis. ETH_USDT, SOL_USDT, XRP_USDT). Namun
batas eksekusi Phase 3 masih mengasumsikan cacah kontrak integer di beberapa
titik:

- `OrderIntentSchema.size` = `z.number().int().positive()`
- `planLevelConsumption` / `simulateFill` menolak ukuran non-integer
- DTO API `ContractCount` hanya menerima string digit
- `OrderRepository.insert`, `FillRepository.append`, `PositionRepository.create`
  menolak ukuran non-integer

Akibatnya rencana Phase 10 yang sah secara matematis mustahil dieksekusi:
rekaman ETH sintetis menghasilkan 40 keputusan disetujui dan 40
`SIZE_NOT_EXECUTABLE`. Ini membatasi universe sebelum eksperimen Jev.

## Keputusan

1. **Pisahkan validitas sintaktis dari validitas kontrak.**
   `OrderIntentSchema.size` menerima desimal positif berhingga (sintaktis).
   Apakah komponen pecahan boleh adalah aturan KONTRAK, ditegakkan
   `assertValidSize(spec, size)`:
   - `enable_decimal = false` → wajib integer
   - `enable_decimal = true` → pecahan diizinkan dalam `[orderSizeMin, orderSizeMax]`
2. **Representasi kanonik cacah kontrak tetap `number` di tipe domain**, tetapi
   seluruh ARITMETIKA ukuran memakai `Decimal`, dengan SATU titik konversi
   (`toContractCount` di `exchange/rounding.ts`). Tidak ada perubahan global pada
   representasi moneter lain, dan tidak ada perubahan pada `TradePlan` Phase 10.
3. **Aritmetika ukuran bebas drift.** `planLevelConsumption` dan
   `planPositionTransition` mengakumulasi dengan `Decimal`, sehingga
   `0.3 − 0.1 − 0.1 − 0.1` tepat nol, bukan `2.7e-17`.
4. **Kanonikalisasi sebelum fingerprint.** `orderCommandFingerprint` memakai
   `canonicalContractSize(size)`, sehingga `"1.5"`, `"1.50"`, dan `"1.500"`
   adalah perintah yang SAMA. Idempotensi tidak boleh pecah karena format.
5. **Aturan integer TIDAK ditegakkan di `OrderRepository.insert`.** Baris order
   dibuat lebih dulu (status `created`) supaya penolakan pun terekam untuk audit;
   menegakkan aturan kontrak di sana akan mengubah penolakan ber-audit menjadi
   exception. Aturan kontrak ditegakkan `#validateIntent` (OrderService) sesudah
   baris dibuat. `FillRepository`/`PositionRepository` — yang berjalan SESUDAH
   validasi — tetap sadar kontrak, dan hanya melakukan lookup kontrak bila
   ukurannya pecahan (jalur integer tetap secepat sebelumnya).
6. **DTO API tetap string.** `ContractCount` menerima string desimal
   (`"1"`, `"1.25"`); ukuran numerik JSON ditolak. Nilai uang tetap string.

## Konsekuensi

- Kontrak desimal kini dapat dieksekusi otonom melalui OrderService yang SAMA
  (tidak ada jalur replay khusus). Rekaman ETH sintetis: 1 entry terisi dengan
  ukuran pecahan `583.61239732`, sisa sinyal ditolak `EXISTING_CONTRACT_POSITION`
  karena keadaan akun kini berkembang.
- Kontrak integer tidak melemah: `"1.5"` untuk BTC_USDT tetap ditolak — tetapi
  sebagai order `rejected` ber-audit (`ORDER_REJECTED`), bukan exception.
- Golden BTC Phase 11 tidak berubah: `experimentHash c57b9ce21a93312d`,
  `combinedHash cd0b21520c4946b6`… (ukuran BTC selalu integer, dan bentuk
  kanoniknya identik dengan sebelumnya).
- SQLite menyimpan cacah kontrak pecahan sebagai REAL tanpa kehilangan presisi
  (diverifikasi); kolom tetap dideklarasikan numerik seperti sebelumnya.

## Alternatif yang ditolak

- **Mengubah seluruh `size` menjadi string/Decimal di semua tipe domain dan DB**:
  refactor besar di luar cakupan perbaikan kompatibilitas ini, dan tidak
  diperlukan untuk memperbaiki masalahnya.
- **Melonggarkan `assertValidSize` sehingga pecahan diterima semua kontrak**:
  akan melemahkan kontrak integer dan menyembunyikan intent yang salah.
- **Menegakkan aturan kontrak di `OrderRepository.insert`**: mengubah penolakan
  ber-audit menjadi exception, menghilangkan jejak `order.created → rejected`.
- **Membulatkan ukuran di OrderService**: menyembunyikan niat pemanggil; Phase 10
  yang boleh membulatkan saat PERENCANAAN, eksekusi memvalidasi ukuran persis.
