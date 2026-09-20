-- domain_events adalah outbox/audit append-only (Phase 5, ADR 0009).
-- Tidak ada UPDATE/DELETE: koreksi = event baru, bukan menulis ulang sejarah.
CREATE TRIGGER `domain_events_no_update`
BEFORE UPDATE ON `domain_events`
BEGIN
	SELECT RAISE(ABORT, 'domain_events is append-only: UPDATE rejected');
END;
--> statement-breakpoint
CREATE TRIGGER `domain_events_no_delete`
BEFORE DELETE ON `domain_events`
BEGIN
	SELECT RAISE(ABORT, 'domain_events is append-only: DELETE rejected');
END;
