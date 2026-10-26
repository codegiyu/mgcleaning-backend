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
ALTER TABLE "blog_posts" ADD COLUMN "cover_media_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_admin_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_status_created_at_idx" ON "media_assets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_status_expires_at_idx" ON "media_assets" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_cover_media_id_media_assets_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blog_posts_cover_media_id_idx" ON "blog_posts" USING btree ("cover_media_id");