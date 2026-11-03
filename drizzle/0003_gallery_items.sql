CREATE TABLE "gallery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(8) NOT NULL,
	"media_id" uuid NOT NULL,
	"poster_media_id" uuid,
	"alt_text" varchar(250) NOT NULL,
	"caption" varchar(200),
	"service_slug" varchar(120),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"layout" varchar(16) DEFAULT 'standard' NOT NULL,
	"position" integer NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"rights_confirmed_at" timestamp with time zone,
	"rights_confirmed_by" uuid,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gallery_items_type_valid" CHECK ("gallery_items"."type" IN ('image', 'video')),
	CONSTRAINT "gallery_items_layout_valid" CHECK ("gallery_items"."layout" IN ('featured', 'tall', 'standard', 'wide')),
	CONSTRAINT "gallery_items_status_valid" CHECK ("gallery_items"."status" IN ('draft', 'published')),
	CONSTRAINT "gallery_items_published_needs_rights" CHECK ("gallery_items"."status" <> 'published' OR "gallery_items"."rights_confirmed_at" IS NOT NULL),
	CONSTRAINT "gallery_items_published_video_needs_poster" CHECK ("gallery_items"."status" <> 'published' OR "gallery_items"."type" <> 'video' OR "gallery_items"."poster_media_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_poster_media_id_media_assets_id_fk" FOREIGN KEY ("poster_media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_rights_confirmed_by_admin_users_id_fk" FOREIGN KEY ("rights_confirmed_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gallery_items_media_id_unique" ON "gallery_items" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "gallery_items_poster_media_id_idx" ON "gallery_items" USING btree ("poster_media_id");--> statement-breakpoint
CREATE INDEX "gallery_items_public_order_idx" ON "gallery_items" USING btree ("status","position");