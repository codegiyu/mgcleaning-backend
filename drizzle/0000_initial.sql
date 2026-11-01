CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" varchar(64) NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" varchar(64),
	"request_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" varchar(200),
	"ip_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(180) NOT NULL,
	"title" varchar(180) NOT NULL,
	"excerpt" varchar(320) NOT NULL,
	"body" text NOT NULL,
	"category" varchar(80) NOT NULL,
	"author_name" varchar(120) DEFAULT 'M&G Cleaning Services' NOT NULL,
	"service_slug" varchar(120),
	"cover_media_id" uuid,
	"cover_image_url" text,
	"cover_image_alt" varchar(250),
	"seo_title" varchar(180),
	"seo_description" varchar(320),
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"publish_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
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
CREATE TABLE "channel_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" varchar(16) NOT NULL,
	"placement" varchar(16) DEFAULT 'page' NOT NULL,
	"page_path" varchar(200),
	"utm_source" varchar(120),
	"utm_medium" varchar(120),
	"utm_campaign" varchar(120),
	"utm_content" varchar(120),
	"landing_path" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_clicks_channel" CHECK ("channel_clicks"."channel" IN ('whatsapp', 'instagram', 'phone')),
	CONSTRAINT "channel_clicks_placement" CHECK ("channel_clicks"."placement" IN ('header', 'page', 'footer'))
);
--> statement-breakpoint
CREATE TABLE "contact_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(40) NOT NULL,
	"email" varchar(320),
	"public_reference" varchar(32) NOT NULL,
	"idempotency_key" varchar(80) NOT NULL,
	"inquiry_type" varchar(24) DEFAULT 'contact' NOT NULL,
	"topic" varchar(120),
	"preferred_contact_method" varchar(24),
	"service_interest" varchar(120),
	"preferred_date" varchar(40),
	"preferred_time" varchar(80),
	"location" varchar(240),
	"space_type" varchar(120),
	"message" text NOT NULL,
	"source" varchar(120) DEFAULT 'website' NOT NULL,
	"utm_source" varchar(120),
	"utm_medium" varchar(120),
	"utm_campaign" varchar(120),
	"utm_content" varchar(120),
	"landing_path" varchar(200),
	"status" varchar(32) DEFAULT 'new' NOT NULL,
	"internal_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_inquiries_public_reference_unique" UNIQUE("public_reference"),
	CONSTRAINT "contact_inquiries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"to_address" varchar(320) NOT NULL,
	"subject" varchar(240) NOT NULL,
	"title" varchar(180) NOT NULL,
	"message" text NOT NULL,
	"reply_to" varchar(320),
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(512) NOT NULL,
	"public_url" text NOT NULL,
	"intent" varchar(32) NOT NULL,
	"content_type" varchar(64) NOT NULL,
	"declared_bytes" integer NOT NULL,
	"byte_size" integer,
	"alt_text" varchar(250),
	"original_filename" varchar(200),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"failure_reason" varchar(120),
	"uploaded_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"object_removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"inquiry_notification_email" varchar(320),
	"default_author_name" varchar(120),
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_settings_single_row" CHECK (id = 1)
);
--> statement-breakpoint
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
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_id_admin_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_cover_media_id_media_assets_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_inquiry_id_contact_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."contact_inquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_admin_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_consent_confirmed_by_admin_users_id_fk" FOREIGN KEY ("consent_confirmed_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_events_entity_idx" ON "admin_audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_events_actor_idx" ON "admin_audit_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_events_created_at_idx" ON "admin_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_user_id_idx" ON "admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "blog_posts_status_published_at_idx" ON "blog_posts" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "blog_posts_category_idx" ON "blog_posts" USING btree ("category");--> statement-breakpoint
CREATE INDEX "blog_posts_service_slug_idx" ON "blog_posts" USING btree ("service_slug");--> statement-breakpoint
CREATE INDEX "blog_posts_cover_media_id_idx" ON "blog_posts" USING btree ("cover_media_id");--> statement-breakpoint
CREATE INDEX "blog_posts_status_publish_at_idx" ON "blog_posts" USING btree ("status","publish_at");--> statement-breakpoint
CREATE INDEX "cache_revalidations_status_available_at_idx" ON "cache_revalidations" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "channel_clicks_created_at_idx" ON "channel_clicks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "channel_clicks_channel_created_at_idx" ON "channel_clicks" USING btree ("channel","created_at");--> statement-breakpoint
CREATE INDEX "contact_inquiries_status_created_at_idx" ON "contact_inquiries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "contact_inquiries_utm_source_created_at_idx" ON "contact_inquiries" USING btree ("utm_source","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_inquiry_kind_idx" ON "email_outbox" USING btree ("inquiry_id","kind");--> statement-breakpoint
CREATE INDEX "email_outbox_status_available_at_idx" ON "email_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "media_assets_status_created_at_idx" ON "media_assets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_status_expires_at_idx" ON "media_assets" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "reviews_public_order_idx" ON "reviews" USING btree ("status","featured","received_on");--> statement-breakpoint
CREATE INDEX "reviews_status_published_at_idx" ON "reviews" USING btree ("status","published_at");