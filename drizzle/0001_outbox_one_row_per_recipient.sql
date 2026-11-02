DROP INDEX "email_outbox_inquiry_kind_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_inquiry_kind_to_idx" ON "email_outbox" USING btree ("inquiry_id","kind","to_address");