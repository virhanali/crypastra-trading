CREATE TABLE `market_observations` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`contract` text NOT NULL,
	`kind` text NOT NULL,
	`source_timestamp_ms` integer NOT NULL,
	`observed_at_ms` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`data_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `market_recording_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_observations_dedupe_idx` ON `market_observations` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `market_observations_session_seq_idx` ON `market_observations` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `market_observations_session_kind_idx` ON `market_observations` (`session_id`,`kind`,`seq`);--> statement-breakpoint
CREATE INDEX `market_observations_session_contract_idx` ON `market_observations` (`session_id`,`contract`,`seq`);--> statement-breakpoint
CREATE TABLE `market_recording_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`contracts_json` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`metadata_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recording_sessions_status_idx` ON `market_recording_sessions` (`status`,`started_at`);