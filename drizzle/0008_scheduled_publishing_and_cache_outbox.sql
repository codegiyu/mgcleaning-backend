CREATE TABLE "cache_revalidations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tags" jsonb NOT NULL,
	"mode" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "publish_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "cache_revalidations_status_available_at_idx" ON "cache_revalidations" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "blog_posts_status_publish_at_idx" ON "blog_posts" USING btree ("status","publish_at");