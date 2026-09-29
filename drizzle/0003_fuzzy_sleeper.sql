CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"to_address" varchar(320) NOT NULL,
	"subject" varchar(240) NOT NULL,
	"title" varchar(180) NOT NULL,
	"message" text NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "public_reference" varchar(32);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "idempotency_key" varchar(80);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "preferred_contact_method" varchar(24);--> statement-breakpoint
UPDATE "contact_inquiries"
SET "public_reference" = 'MG-LEGACY-' || substr(replace("id"::text, '-', ''), 1, 8),
    "idempotency_key" = 'legacy-' || replace("id"::text, '-', '')
WHERE "public_reference" IS NULL OR "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ALTER COLUMN "public_reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_inquiry_id_contact_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."contact_inquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_inquiry_kind_idx" ON "email_outbox" USING btree ("inquiry_id","kind");--> statement-breakpoint
CREATE INDEX "email_outbox_status_available_at_idx" ON "email_outbox" USING btree ("status","available_at");--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD CONSTRAINT "contact_inquiries_public_reference_unique" UNIQUE("public_reference");--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD CONSTRAINT "contact_inquiries_idempotency_key_unique" UNIQUE("idempotency_key");
