CREATE TABLE "contact_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(40) NOT NULL,
	"email" varchar(320),
	"service_interest" varchar(120),
	"message" text NOT NULL,
	"source" varchar(120) DEFAULT 'website' NOT NULL,
	"status" varchar(32) DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "contact_inquiries_status_created_at_idx" ON "contact_inquiries" USING btree ("status","created_at");