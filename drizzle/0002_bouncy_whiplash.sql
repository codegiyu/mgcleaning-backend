ALTER TABLE "contact_inquiries" ADD COLUMN "inquiry_type" varchar(24) DEFAULT 'contact' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "topic" varchar(120);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "preferred_date" varchar(40);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "preferred_time" varchar(80);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "location" varchar(240);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "space_type" varchar(120);