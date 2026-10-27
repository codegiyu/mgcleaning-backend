ALTER TABLE "email_outbox" ADD COLUMN "reply_to" varchar(320);--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "actions" jsonb DEFAULT '[]'::jsonb NOT NULL;