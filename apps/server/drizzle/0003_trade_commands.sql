CREATE TABLE `trade_commands` (
	`command_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text NOT NULL,
	`order_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trade_commands_order_idx` ON `trade_commands` (`order_id`);