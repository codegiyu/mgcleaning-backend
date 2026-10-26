CREATE TABLE "site_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"inquiry_notification_email" varchar(320),
	"default_author_name" varchar(120),
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_settings_single_row" CHECK (id = 1)
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "user_agent" varchar(200);--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "ip_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;