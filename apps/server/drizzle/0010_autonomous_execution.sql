CREATE TABLE `decision_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`account_id` text NOT NULL,
	`command_id` text NOT NULL,
	`order_id` text,
	`position_id` text,
	`status` text NOT NULL,
	`error_code` text,
	`error_detail` text,
	`planned_reference` text,
	`actual_fill_price` text,
	`attempted_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decision_executions_decision_idx` ON `decision_executions` (`decision_id`);--> statement-breakpoint
CREATE INDEX `decision_executions_status_idx` ON `decision_executions` (`status`);--> statement-breakpoint
CREATE TABLE `trade_records` (
	`trade_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`contract` text NOT NULL,
	`side` text NOT NULL,
	`decision_time` integer NOT NULL,
	`entry_time` integer NOT NULL,
	`exit_time` integer,
	`planned_reference` text NOT NULL,
	`actual_entry` text NOT NULL,
	`size` integer NOT NULL,
	`leverage` text NOT NULL,
	`stop_loss` text NOT NULL,
	`take_profit` text NOT NULL,
	`planned_risk` text NOT NULL,
	`actual_initial_risk` text NOT NULL,
	`gross_realized_pnl` text NOT NULL,
	`fees` text NOT NULL,
	`funding` text NOT NULL,
	`net_pnl` text NOT NULL,
	`exit_reason` text NOT NULL,
	`mae` text NOT NULL,
	`mfe` text NOT NULL,
	`mae_r` text,
	`mfe_r` text,
	`r_multiple` text,
	`holding_duration` integer,
	`feature_version` text NOT NULL,
	`scanner_version` text NOT NULL,
	`scanner_config_hash` text NOT NULL,
	`decision_version` text NOT NULL,
	`risk_policy_version` text NOT NULL,
	`risk_policy_hash` text NOT NULL,
	`evaluation_version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trade_records_decision_idx` ON `trade_records` (`decision_id`);--> statement-breakpoint
CREATE INDEX `trade_records_account_exit_idx` ON `trade_records` (`account_id`,`exit_time`);--> statement-breakpoint
CREATE INDEX `trade_records_contract_exit_idx` ON `trade_records` (`contract`,`exit_time`);
