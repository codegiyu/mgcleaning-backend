CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"context" varchar(80),
	"quote" text NOT NULL,
	"rating" smallint,
	"service_slug" varchar(120),
	"source" varchar(24) NOT NULL,
	"received_on" date,
	"featured" boolean DEFAULT false NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"consent_confirmed_at" timestamp with time zone,
	"consent_confirmed_by" uuid,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" IS NULL OR "reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_published_needs_consent" CHECK ("reviews"."status" <> 'published' OR "reviews"."consent_confirmed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_consent_confirmed_by_admin_users_id_fk" FOREIGN KEY ("consent_confirmed_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_public_order_idx" ON "reviews" USING btree ("status","featured","received_on");--> statement-breakpoint
CREATE INDEX "reviews_status_published_at_idx" ON "reviews" USING btree ("status","published_at");