CREATE TABLE `account_balances` (
	`account_id` text PRIMARY KEY NOT NULL,
	`wallet_balance` text NOT NULL,
	`used_margin` text NOT NULL,
	`reserved_margin` text NOT NULL,
	`realized_pnl` text NOT NULL,
	`fees_paid` text NOT NULL,
	`funding_paid` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_config` (
	`account_id` text PRIMARY KEY NOT NULL,
	`default_leverage` text NOT NULL,
	`max_leverage` text NOT NULL,
	`max_position_notional` text NOT NULL,
	`risk_per_trade_pct` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`base_currency` text NOT NULL,
	`initial_balance` text NOT NULL,
	`created_at` integer NOT NULL,
	`reset_at` integer
);
--> statement-breakpoint
CREATE TABLE `candles` (
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`o` text NOT NULL,
	`h` text NOT NULL,
	`l` text NOT NULL,
	`c` text NOT NULL,
	`v` integer NOT NULL,
	`sum` text NOT NULL,
	`window_closed` integer NOT NULL,
	`provider` text NOT NULL,
	`ingested_at` integer NOT NULL,
	PRIMARY KEY(`contract`, `interval`, `t`)
);
--> statement-breakpoint
CREATE INDEX `candles_contract_interval_t_idx` ON `candles` (`contract`,`interval`,`t`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`quanto_multiplier` text NOT NULL,
	`order_size_min` integer NOT NULL,
	`order_size_max` integer NOT NULL,
	`order_price_round` text NOT NULL,
	`mark_price_round` text NOT NULL,
	`leverage_min` text NOT NULL,
	`leverage_max` text NOT NULL,
	`maintenance_rate` text NOT NULL,
	`maker_fee_rate` text NOT NULL,
	`taker_fee_rate` text NOT NULL,
	`funding_interval_seconds` integer NOT NULL,
	`market_order_slip_ratio` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`raw_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`jev_evaluation_id` text,
	`contract` text NOT NULL,
	`action` text NOT NULL,
	`direction` text,
	`size` integer,
	`leverage` text,
	`tp_price` text,
	`sl_price` text,
	`risk_json` text NOT NULL,
	`engine_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`jev_evaluation_id`) REFERENCES `jev_evaluations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `decisions_contract_created_idx` ON `decisions` (`contract`,`created_at`);--> statement-breakpoint
CREATE TABLE `feature_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`features_json` text NOT NULL,
	`engine_version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feature_snapshots_contract_t_idx` ON `feature_snapshots` (`contract`,`t`);--> statement-breakpoint
CREATE TABLE `fills` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text,
	`position_id` text,
	`contract` text NOT NULL,
	`side` text NOT NULL,
	`size` integer NOT NULL,
	`price` text NOT NULL,
	`liquidity` text NOT NULL,
	`fee` text NOT NULL,
	`fee_rate` text NOT NULL,
	`fee_asset` text NOT NULL,
	`realized_pnl` text NOT NULL,
	`is_liquidation` integer NOT NULL,
	`is_tp_sl` integer NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fills_order_idx` ON `fills` (`order_id`);--> statement-breakpoint
CREATE INDEX `fills_position_idx` ON `fills` (`position_id`);--> statement-breakpoint
CREATE TABLE `jev_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`p_trend` text NOT NULL,
	`p_momentum` text NOT NULL,
	`p_reversal` text NOT NULL,
	`btc_regime` text NOT NULL,
	`confidence` text NOT NULL,
	`model_version` text NOT NULL,
	`inputs_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jev_evaluations_contract_t_idx` ON `jev_evaluations` (`contract`,`t`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`amount` text NOT NULL,
	`margin_delta` text NOT NULL,
	`reserved_delta` text NOT NULL,
	`balance_after` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`idempotency_key` text NOT NULL,
	`meta_json` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_idempotency_key_idx` ON `ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ledger_account_seq_idx` ON `ledger` (`account_id`,`seq`);--> statement-breakpoint
CREATE TABLE `market_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`channel` text NOT NULL,
	`contract` text NOT NULL,
	`event_ts` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`ingested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_events_dedupe_key_idx` ON `market_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `market_events_contract_seq_idx` ON `market_events` (`contract`,`seq`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_events_order_seq_idx` ON `order_events` (`order_id`,`seq`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`contract` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`time_in_force` text NOT NULL,
	`size` integer NOT NULL,
	`price` text,
	`reduce_only` integer NOT NULL,
	`leverage` text NOT NULL,
	`status` text NOT NULL,
	`reject_reason` text,
	`filled_size` integer NOT NULL,
	`avg_fill_price` text,
	`reserved_margin` text,
	`tp_price` text,
	`sl_price` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_account_status_idx` ON `orders` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `orders_contract_idx` ON `orders` (`contract`);--> statement-breakpoint
CREATE TABLE `position_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` text NOT NULL,
	`type` text NOT NULL,
	`detail_json` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `position_events_position_seq_idx` ON `position_events` (`position_id`,`seq`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`contract` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`size` integer NOT NULL,
	`entry_price` text NOT NULL,
	`leverage` text NOT NULL,
	`initial_margin` text NOT NULL,
	`accumulated_funding` text NOT NULL,
	`fees_paid` text NOT NULL,
	`realized_pnl` text NOT NULL,
	`tp_price` text,
	`sl_price` text,
	`liquidation_price` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `positions_account_status_idx` ON `positions` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `positions_contract_idx` ON `positions` (`contract`);