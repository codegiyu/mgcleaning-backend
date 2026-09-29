ALTER TABLE "blog_posts" ADD COLUMN "author_name" varchar(120) DEFAULT 'M&G Cleaning Service' NOT NULL;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD COLUMN "service_slug" varchar(120);--> statement-breakpoint
CREATE INDEX "blog_posts_service_slug_idx" ON "blog_posts" USING btree ("service_slug");