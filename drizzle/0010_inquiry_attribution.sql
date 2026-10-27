ALTER TABLE "contact_inquiries" ADD COLUMN "utm_source" varchar(120);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "utm_medium" varchar(120);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "utm_campaign" varchar(120);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "utm_content" varchar(120);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "landing_path" varchar(200);--> statement-breakpoint
CREATE INDEX "contact_inquiries_utm_source_created_at_idx" ON "contact_inquiries" USING btree ("utm_source","created_at");