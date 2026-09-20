CREATE TABLE `domain_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text,
	`command_id` text,
	`data_json` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `domain_events_account_seq_idx` ON `domain_events` (`account_id`,`seq`);--> statement-breakpoint
ALTER TABLE `trade_commands` ADD `request_hash` text;