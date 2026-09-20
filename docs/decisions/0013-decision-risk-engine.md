# ADR 0013 — Decision/Risk Engine deterministik yang terpisah dan tanpa eksekusi

Status: diterima (Phase 10)
Tanggal: 2026-09-21

## Konteks

Phase 9 menghasilkan `FeatureSnapshot` + `ScannerResult` yang deterministik, dan
secara eksplisit berhenti sebelum sizing, leverage, SL/TP, dan keputusan sadar
akun. Phase 10 harus mengisi celah itu tanpa mengeksekusi order, dan tanpa
menyeret logika akun masuk ke Scanner.

## Keputusan

1. **Tiga tanggung jawab terpisah.** Scanner: setup pasar. Decision Engine:
   layak dipertimbangkan atau tidak. Risk Engine: trade apa yang diizinkan.
   OrderService tetap satu-satunya eksekutor.
2. **Inti murni di `packages/core/src/decision/`.** Hanya menerima fitur,
   scanner result, konteks pasar, `AccountRiskState`, `ContractSpec`, dan
   `RiskPolicy`. Dilarang DB/repository/service ekonomi/waktu/acak. Ditegakkan
   guard impor. Scanner tidak boleh melihat wallet/posisi/margin/leverage.
3. **Risiko dulu, bukan notional.** `size = riskBudget / (multiplier × stopDistance)`.
   Leverage tidak dipakai untuk menentukan ukuran, dan tidak diturunkan dari
   keyakinan sinyal (maupun, nantinya, dari Jev).
4. **Stop dari ATR, pembulatan arah-sadar.** SL dibulatkan menjauh dari risiko
   (LONG ceil, SHORT floor), TP menjauh dari harapan (LONG floor, SHORT ceil),
   sehingga rencana tidak pernah melebihi risiko terencana atau membesarkan
   reward. Sizing memakai jarak stop hasil pembulatan.
5. **SKIP dipersist.** Peluang yang ditolak dan alasannya adalah data yang
   dibutuhkan evaluasi berikutnya.
6. **`decisions` diperluas, bukan diduplikasi.** Tabel Phase 1 belum pernah
   ditulis dan tidak punya `account_id`/waktu candle/reason codes; migrasi 0009
   membangunnya ulang dengan kunci idempotensi
   `(account, contract, interval, candle_close_t, decision_version,
   scanner_version, scanner_config_hash, risk_policy_hash)` dan id deterministik.
7. **Satu engine untuk live dan replay.** `DecisionCoordinator` merakit input
   dari provider kutipan; jalur live dan replay memakai perakitan yang sama.
8. **Default OFF di live.** `CRYPASTRA_DECISIONS=1` + akun eksplisit. Lapisan ini
   observasional: kegagalannya tidak menghentikan ingest, risiko, atau trading
   manual, dan ia tidak menulis tabel ekonomi mana pun.

## Konsekuensi

- Replay dengan keputusan menghasilkan `decisionHash`/`combinedHash` yang
  identik antar dua run, dan hash ekonomi replay tidak berubah dibanding replay
  tanpa keputusan.
- TradePlan dapat diuji sebagai invarian matematis (risk ≤ budget, margin ≤
  saldo, RR ≥ minimum, SL/TP di sisi benar).
- Karena Phase 10 tidak mengeksekusi, keadaan akun konstan sepanjang replay;
  batas posisi tidak pernah terisi. Ini didokumentasikan sebagai keterbatasan.
- Baseline ini menjadi kelompok kontrol untuk membandingkan Jev di fase
  berikutnya, tanpa field keyakinan apa pun di tipe baseline.

## Alternatif yang ditolak

- **Sizing `wallet × leverage`**: leverage bukan risiko; ukuran bisa jauh
  melebihi anggaran risiko saat stop lebar.
- **Pembulatan tick netral**: bisa membuat stop lebih jauh dari rencana
  (risiko aktual > terencana) atau TP lebih jauh (reward dibesar-besarkan).
- **Menyimpan hanya TradePlan yang disetujui**: menghapus informasi peluang yang
  ditolak, yang justru dibutuhkan untuk evaluasi.
- **Mengganti stop ATR dengan persentase saat ATR patologis**: menyembunyikan
  model; lebih jujur menolak dengan reason code.
