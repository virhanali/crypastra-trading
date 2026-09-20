-- market_observations adalah rekaman append-only: koreksi = observasi baru,
-- bukan menulis ulang sejarah. Purge per-sesi (retensi) HARUS melewati jalur
-- eksplisit dan didokumentasikan; trigger ini mencegah penghapusan diam-diam.
CREATE TRIGGER `market_observations_no_update`
BEFORE UPDATE ON `market_observations`
BEGIN
	SELECT RAISE(ABORT, 'market_observations is append-only: UPDATE rejected');
END;
--> statement-breakpoint
CREATE TRIGGER `market_observations_no_delete`
BEFORE DELETE ON `market_observations`
BEGIN
	SELECT RAISE(ABORT, 'market_observations is append-only: DELETE rejected');
END;
