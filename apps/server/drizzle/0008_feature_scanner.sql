CREATE UNIQUE INDEX `feature_snapshots_unique_idx` ON `feature_snapshots` (`contract`,`interval`,`t`,`engine_version`);--> statement-breakpoint
CREATE TABLE `scanner_results` (
	`id` text PRIMARY KEY NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`feature_version` text NOT NULL,
	`scanner_version` text NOT NULL,
	`scanner_config_hash` text NOT NULL,
	`status` text NOT NULL,
	`direction` text NOT NULL,
	`setup_type` text NOT NULL,
	`signal` text NOT NULL,
	`facts_json` text NOT NULL,
	`reason_codes_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scanner_results_unique_idx` ON `scanner_results` (`contract`,`interval`,`t`,`feature_version`,`scanner_version`,`scanner_config_hash`);--> statement-breakpoint
CREATE INDEX `scanner_results_contract_t_idx` ON `scanner_results` (`contract`,`t`);--> statement-breakpoint
CREATE INDEX `scanner_results_signal_idx` ON `scanner_results` (`signal`,`t`);
