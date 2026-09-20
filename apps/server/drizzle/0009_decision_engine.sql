DROP INDEX IF EXISTS `decisions_contract_created_idx`;--> statement-breakpoint
DROP TABLE `decisions`;--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`candle_close_t` integer NOT NULL,
	`action` text NOT NULL,
	`direction` text,
	`size_text` text,
	`leverage` text,
	`reference_price` text,
	`tp_price` text,
	`sl_price` text,
	`notional` text,
	`initial_margin` text,
	`risk_amount` text,
	`risk_percent` text,
	`reward_amount` text,
	`reward_risk_ratio` text,
	`stop_distance` text,
	`stop_distance_pct` text,
	`reasons_json` text NOT NULL,
	`risk_json` text NOT NULL,
	`jev_evaluation_id` text,
	`decision_version` text NOT NULL,
	`feature_version` text NOT NULL,
	`scanner_version` text NOT NULL,
	`scanner_config_hash` text NOT NULL,
	`risk_policy_version` text NOT NULL,
	`risk_policy_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`jev_evaluation_id`) REFERENCES `jev_evaluations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_unique_idx` ON `decisions` (`account_id`,`contract`,`interval`,`candle_close_t`,`decision_version`,`scanner_version`,`scanner_config_hash`,`risk_policy_hash`);--> statement-breakpoint
CREATE INDEX `decisions_contract_created_idx` ON `decisions` (`contract`,`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_account_candle_idx` ON `decisions` (`account_id`,`candle_close_t`);--> statement-breakpoint
CREATE INDEX `decisions_action_idx` ON `decisions` (`action`,`direction`);
