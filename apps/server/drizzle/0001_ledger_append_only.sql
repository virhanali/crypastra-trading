-- Ledger append-only enforcement (Phase 1).
--
-- `ledger` adalah sumber kebenaran akuntansi. Immutability ditegakkan di level
-- database, bukan hanya konvensi repository, supaya UPDATE/DELETE tetap gagal
-- walau ada kode (atau operator sqlite3) yang mencoba melakukannya.
--
-- Koreksi tidak dilakukan dengan mengubah baris lama: tambahkan entri baru
-- bertipe `adjustment`.
CREATE TRIGGER `ledger_no_update`
BEFORE UPDATE ON `ledger`
BEGIN
	SELECT RAISE(ABORT, 'ledger is append-only: UPDATE rejected');
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_no_delete`
BEFORE DELETE ON `ledger`
BEGIN
	SELECT RAISE(ABORT, 'ledger is append-only: DELETE rejected');
END;
--> statement-breakpoint
-- market_events juga log mentah untuk replay: tidak boleh diubah atau dihapus.
CREATE TRIGGER `market_events_no_update`
BEFORE UPDATE ON `market_events`
BEGIN
	SELECT RAISE(ABORT, 'market_events is append-only: UPDATE rejected');
END;
--> statement-breakpoint
CREATE TRIGGER `market_events_no_delete`
BEFORE DELETE ON `market_events`
BEGIN
	SELECT RAISE(ABORT, 'market_events is append-only: DELETE rejected');
END;
