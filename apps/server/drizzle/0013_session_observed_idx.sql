-- Indeks freshness O(log n) untuk market_observations: hot loop recorder
-- dan healthcheck menanyakan "observasi terakhir sesi X" tiap detik/menit.
-- Tanpa indeks ini, max(observed_at_ms) memindai seluruh sesi (jutaan baris)
-- dan memblokir event loop perekam di SQLite sinkron selama bermenit-menit.
CREATE INDEX `market_observations_session_observed_idx` ON `market_observations` (`session_id`,`observed_at_ms`);
