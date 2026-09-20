DROP INDEX IF EXISTS `jev_evaluations_contract_t_idx`;--> statement-breakpoint
DROP TABLE `jev_evaluations`;--> statement-breakpoint
CREATE TABLE `jev_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`input_hash` text NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`direction` text NOT NULL,
	`evaluator` text NOT NULL,
	`evaluator_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`probability` text,
	`regime_json` text,
	`confidence` text,
	`status` text NOT NULL,
	`reason_codes_json` text NOT NULL,
	`output_json` text NOT NULL,
	`metadata_json` text NOT NULL,
	`inputs_json` text NOT NULL,
	`latency_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jev_evaluations_cache_idx` ON `jev_evaluations` (`input_hash`,`evaluator`,`evaluator_version`,`prompt_version`,`schema_version`,`provider`,`model`);--> statement-breakpoint
CREATE INDEX `jev_evaluations_contract_t_idx` ON `jev_evaluations` (`contract`,`t`);--> statement-breakpoint
CREATE INDEX `jev_evaluations_status_idx` ON `jev_evaluations` (`status`);--> statement-breakpoint
CREATE TABLE `treatment_results` (
	`id` text PRIMARY KEY NOT NULL,
	`input_hash` text NOT NULL,
	`contract` text NOT NULL,
	`interval` text NOT NULL,
	`t` integer NOT NULL,
	`direction` text NOT NULL,
	`treatment_kind` text NOT NULL,
	`treatment_version` text NOT NULL,
	`treatment_config_hash` text NOT NULL,
	`status` text NOT NULL,
	`reasons_json` text NOT NULL,
	`evaluations_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `treatment_results_unique_idx` ON `treatment_results` (`input_hash`,`treatment_version`,`treatment_config_hash`);--> statement-breakpoint
CREATE INDEX `treatment_results_status_idx` ON `treatment_results` (`status`,`t`);--> statement-breakpoint
CREATE INDEX `treatment_results_contract_t_idx` ON `treatment_results` (`contract`,`t`);
