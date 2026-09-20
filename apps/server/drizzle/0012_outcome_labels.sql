CREATE TABLE `candidate_outcome_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`input_hash` text NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`direction` text NOT NULL,
	`label_version` text NOT NULL,
	`price_source` text NOT NULL,
	`reference_close` text NOT NULL,
	`atr14` text,
	`horizons_json` text NOT NULL,
	`labels_json` text NOT NULL,
	`status` text NOT NULL,
	`incomplete_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_outcome_labels_unique_idx` ON `candidate_outcome_labels` (`input_hash`,`label_version`);--> statement-breakpoint
CREATE INDEX `candidate_outcome_labels_contract_t_idx` ON `candidate_outcome_labels` (`contract`,`t`);--> statement-breakpoint
CREATE INDEX `candidate_outcome_labels_status_idx` ON `candidate_outcome_labels` (`status`);
