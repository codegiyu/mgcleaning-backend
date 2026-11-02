# MG Cleaning Services backend

Dedicated Hono API and worker repository for MG Cleaning Services. The customer-facing Next.js app lives in [`../mgcleaning`](../mgcleaning).

## Stack

- Hono on Node.js for the versioned HTTP API (`/api/v1`)
- PostgreSQL with Drizzle ORM and generated SQL migrations
- Redis with BullMQ for background work
- React Email templates processed by a BullMQ worker started in the Hono API process
- Resend API delivery in production, with SMTP/Mailpit retained for local previews
- Docker Compose for local PostgreSQL, Redis, and Mailpit

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Start local services with `docker compose up -d`.
4. Apply database migrations with `npm run db:migrate`.
5. Start the API and its in-process email worker together with `npm run dev`.

The API listens on `http://localhost:4000`; its liveness route is `GET /api/v1/health`. Mailpit captures local mail at [http://localhost:8025](http://localhost:8025).

Mailpit is a local SMTP sink for development and automated tests: with `EMAIL_PROVIDER=smtp`, the in-process worker sends email to Mailpit so you can inspect its rendered HTML, text, headers, and links at `http://localhost:8025` without contacting real recipients. The local Compose file exposes SMTP on `1025` and the UI on `8025`. Production uses Resend’s API instead; Mailpit is not an email provider and is not included in the Coolify stack.

## Docker and Coolify

`Dockerfile` builds one production backend image. The API process starts both Hono and the BullMQ email worker, and the image runs as an unprivileged user. On start it applies the checked-in Drizzle migrations (already-applied ones are skipped), then starts the API, so a failed migration stops the new container while the previous one keeps serving. `admin:bootstrap:runtime` creates the first owner from the bootstrap environment variables.

**Recommended: Dockerfile application with Coolify-managed databases.**
1. Create a PostgreSQL 18 and a Redis resource in Coolify, in the same project and network as the API.
2. Set Redis's `maxmemory-policy` to `noeviction` in its custom configuration. BullMQ loses jobs if Redis evicts keys.
3. Create a Dockerfile application from this repository. Set its port to `4100` (the container listens on `0.0.0.0:4100`) and assign the public API domain.
4. Set `DATABASE_URL` and `REDIS_URL` to the resources' internal URLs, plus the variables below and `EMAIL_PROVIDER=resend`, the `R2_*` settings, and `NODE_ENV=production`.

The image's `HEALTHCHECK` calls `/api/v1/health/ready`, so the container reports unhealthy if it loses Postgres or Redis. Neither database needs a published host port. Configure PostgreSQL backups in Coolify; a volume alone is not a backup.

**Alternative: everything in one Compose stack.** `compose.coolify.yaml` (Git-based Docker Compose, normal mode) runs PostgreSQL 18, Redis, a one-shot `migrate` service and the API. Assign the domain to the `api` service with its internal port (`https://api.<your-domain>:4100`), and none to the others.

Set these variables in Coolify before deployment:

- `FRONTEND_ORIGIN`: exact HTTPS origin of the website, with no path (for example, `https://www.<your-domain>`).
- `RESEND_API_KEY`: API key from Resend, stored as a Coolify secret.
- `EMAIL_FROM`: sender address on a domain verified with Resend.
- `INQUIRY_NOTIFICATION_TO`: real inbox that should receive inquiry alerts.
- `INQUIRY_SECURITY_SECRET`: random secret used to hash rate-limit and duplicate-detection identifiers.
- `TRUST_PROXY_HOPS`: number of trusted reverse-proxy hops used to resolve visitor IPs; use `1` behind the documented Coolify proxy and keep it `0` for direct local requests. The client IP is read that many entries from the right of `X-Forwarded-For`, so client-supplied entries are ignored.
- `LOG_LEVEL` (optional): pino log level, `info` by default.
- `REVALIDATE_SECRET`: random 32+ character secret shared with the website's runtime `REVALIDATE_SECRET`, used to sign cache purges. Optionally set `FRONTEND_REVALIDATE_URL` if the website should be reached on an internal address.
- `TURNSTILE_MODE` and `TURNSTILE_SECRET_KEY`: leave Turnstile off until abuse warrants it, then configure the server secret and the matching frontend site key.
- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`: set only for the initial bootstrap. The email may list several addresses separated by commas; every new account is an owner with the one password, and when there are several, each person must choose their own at first sign-in.
- `HIDDEN_ADMIN_EMAILS` (optional): comma-separated admin emails kept out of the Users list and the activity log's actor names, unless that admin is the one signed in. Default `codegiyu@gmail.com`; set it empty to hide nobody.

After the first deployment and successful migrations, run `node dist/scripts/bootstrapAdmin.js` in the API container, then remove the two bootstrap variables and redeploy. The script is idempotent and will not reset an existing password. Keep the website and API on the same registrable domain (for example `mgcleaning.firefalltechnologies.ng` and `mgcleaning-api.firefalltechnologies.ng`; a `*.vercel.app` website address does not qualify) so the existing `SameSite=Lax` HttpOnly session cookie works with credentialed cross-origin requests. The frontend origin must also match `FRONTEND_ORIGIN` exactly.

**Sample reviews for pre-launch demos.** Set `SEED_SAMPLE_REVIEWS=true` and the API seeds eight placeholder reviews on startup (six published, two drafts), each with a context line starting "Sample ·". It does so only while the reviews table is empty, so restarts never duplicate them and never bring them back once the team has started managing reviews. The owners replace or delete them in **Admin → Reviews** before announcing the site. Then set the variable back to `false`: if every review were later deleted with the flag still on, the next restart would seed the samples again.

The public Next.js app is deployed separately from the `mgcleaning` repository as a Dockerfile application. Configure `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_SITE_URL` as build variables there; the former must point to the public HTTPS API URL.

`POST /api/v1/inquiries` validates and stores website inquiries in PostgreSQL, assigns a public request reference, and uses the `Idempotency-Key` header to prevent duplicate submissions. Booking requests require an email address and preferred contact method. Public requests are body-limited, rate-limited through Redis, checked with a honeypot, scored for obvious spam, and protected by a short-lived normalized fingerprint. Turnstile is supported behind `TURNSTILE_MODE=on` but is disabled by default. The API writes internal and customer email records to the transactional outbox, then queues them for the in-process worker. In local development, the worker sends through Mailpit; in Coolify it sends through Resend. Set the recipient to the real M&G inbox only in the appropriate deployment environment. The team alert is built so it can be acted on from a phone:
- **Buttons at the top:** "Reply on WhatsApp" (to the customer's Nigerian number, prefilled with the request reference only), "Call", and "Open in dashboard" (`${FRONTEND_ORIGIN}/admin/inquiries/<id>`). A customer who asked for a phone call gets Call first and no WhatsApp button.
- **Reply-To:** set to the customer's email when they gave one.
- **Plain text:** the plain-text part repeats the links.
- **Storage and rendering:** the buttons are stored on the outbox row (`actions`) when the inquiry is saved, and the template renders only `https://`, `tel:`, and local `http://localhost` links.

A request reference confirms receipt only; it does not confirm availability, pricing, or an appointment.

The admin API includes session login/logout, an inquiry inbox with private status/notes, and blog draft/publish operations. Create the first admin(s) after migrations: set `BOOTSTRAP_ADMIN_EMAIL` (one address, or several separated by commas) and a unique `BOOTSTRAP_ADMIN_PASSWORD` of at least 12 characters in `.env`, then run `npm run admin:bootstrap`. The command stores a scrypt password hash; remove the bootstrap password from `.env` after it succeeds. It will not reset an existing account. Sessions are random opaque values stored as hashes, expire after 12 hours, and are returned only in an HttpOnly cookie. Admin writes require the configured `FRONTEND_ORIGIN`.

Published articles are exposed at `GET /api/v1/blog` and `GET /api/v1/blog/:slug`. Public reads only return published posts. Admin post content is plain text with limited headings, bold, and bullet-list conventions; raw HTML is not interpreted. Each article records an author name and optional related service slug. Publishing requires an author, related service, a verified cover upload, and cover-image alt text. Posts reference their cover by `coverMediaId`; the public cover URL is copied from the verified media asset on the server, and client-supplied cover URLs are rejected.

## Inquiry attribution

`POST /api/v1/inquiries` accepts optional first-touch attribution from the website: `utmSource`, `utmMedium`, `utmCampaign`, `utmContent`, and `landingPath`. These values come from the visitor's URL, so they are normalised to lowercase tokens (`[a-z0-9._~+-]`, at most 120 characters) and same-site paths, and malformed values are dropped instead of rejecting the enquiry. They are stored on `contact_inquiries`, included as a "Came from" line in the internal alert email, and returned to admins. `GET /api/v1/admin/inquiries?source=instagram` filters by source, and `source=direct` lists enquiries with no campaign source.

## Admin account, activity, and settings

- **Accounts and roles:** `admin_users.role` is `owner` or `staff`.
  - **Staff** handle enquiries, reviews, the journal and media.
  - **Owners** can also change site settings (`PATCH /admin/settings`) and manage accounts at `/api/v1/admin/users`: list, create with a role, change role, deactivate or reactivate, and reset a password. These routes return 403 for staff.
  - **Temporary passwords:** a new or reset account gets a server-generated temporary password, returned once to the owner. Its `mustChangePassword` flag blocks every route except changing the password and signing out until it is replaced.
  - **Deactivation:** deactivating an account revokes its sessions and blocks sign-in.
  - **Owner safety:** owners can't change their own role or access, and the last active owner can't be removed.
  - **First account:** `admin:bootstrap` creates the first account as an owner.
- **Sign-in limits:** each attempt must pass three counters:
  - 5 per 15 minutes per email and client address (a keyed IP hash);
  - 20 per 15 minutes per address;
  - 50 per hour per email.

  Wrong guesses from one place therefore can't lock the real owner out from another.
- **Password hashing:** hashes record their scrypt parameters (currently N=2^16, r=8, p=2). Older hashes are upgraded at the next successful sign-in.
- **Retention:** a pass at start-up and every six hours deletes or scrubs old data; the periods and the deletion-request procedure are in the runbook. Owners can delete one enquiry (and its emails) with `DELETE /api/v1/admin/inquiries/:id`; the audit keeps only its reference.
- **Password change:** `POST /api/v1/admin/account/password` with `{ currentPassword, newPassword }`. The new password must be 12–200 characters and different from the current one; attempts are rate-limited (5 per 15 minutes per account). On success every other session for the account is signed out, and the change is audited.
- **Sessions:** `GET /api/v1/admin/account/sessions` lists the signed-in admin's active sessions (created, last used, browser) and marks the current one. `DELETE /api/v1/admin/account/sessions/:id` signs out one of the admin's own other sessions, and `POST /api/v1/admin/account/sessions/revoke-others` signs out all of them. Session IDs never reach the browser in the session check.
- **Operator reset:** if an admin is locked out, set `ADMIN_RESET_EMAIL` and `ADMIN_RESET_PASSWORD` in the API container and run `node dist/scripts/resetAdminPassword.js` (`npm run admin:reset-password` locally). It sets the new password, revokes every session for that account, writes an audit event, and should be followed by removing the variables. The password is read from the environment rather than arguments so it does not appear in shell history or process lists. There is no emailed reset link by design.
- **Activity:** `GET /api/v1/admin/audit` lists audit events newest first, filterable by `entityType` and `entityId`, with the acting admin's email. IP hashes are not returned.
- **Reviews:** `GET`/`POST /api/v1/admin/reviews` and `GET`/`PATCH`/`DELETE /api/v1/admin/reviews/:id` manage customer reviews; the list also returns `counts` (`published`, `publishedThisYear` in WAT, `draft`). Reviews are plain text: one-line names and context with no markup or links, and a 20–600 character quote. Publishing needs `consentConfirmed: true` (422 otherwise), which records who confirmed the customer's agreement and when; consent cannot be withdrawn while a review is live, and the database enforces the same rule. `PATCH` takes `expectedUpdatedAt` in the body and `DELETE` takes it as a query parameter; a newer row returns 409 so concurrent edits are never silently overwritten. Delete is a hard delete, and its audit event keeps only the review id and previous status. Publishing, editing a live review, unpublishing, and deleting queue a purge of the website's `reviews` cache tag (unpublish and delete expire it immediately). `GET /api/v1/reviews` is public and returns up to 50 published reviews, featured first, with public fields only.
- **Message taps:** `POST /api/v1/events/channel-click` counts taps on the website's WhatsApp, Instagram, and call links.
  - The website sends it with `navigator.sendBeacon` as `text/plain` JSON, so there is no CORS preflight.
  - The body may hold the `channel`, the `placement` (header, page, or footer), the page path, and the tab's first-touch UTM tags. Unknown fields are rejected, and campaign values are normalised or dropped.
  - Requests must come from `FRONTEND_ORIGIN` (403 otherwise), the body is capped at 2 KB, and each hashed IP gets 30 taps per 10 minutes (429 beyond that).
  - Responses are 204. If Redis is down, the tap is dropped rather than stored unchecked.
  - Nothing that identifies a visitor is stored: no IP, user agent, or contact detail.
  - The admin overview's `channelClicks` reports the last 30 days by channel and top sources.
- **Settings:** `GET`/`PATCH /api/v1/admin/settings` holds operational values only: the inquiry-alert inbox (falling back to `INQUIRY_NOTIFICATION_TO` when cleared) and the default author for new articles. New inquiries read the inbox inside their own transaction. Public business facts and claims stay in the web app's governed content files.

## Scheduled publishing and website cache

Posts can be `draft`, `scheduled`, `published`, or `archived`. Scheduling (`PATCH /admin/blog/posts/:id` with `status: "scheduled"` and an ISO `publishAt` that includes a UTC offset) applies the same checks as publishing, and the time must be in the future and at most a year ahead. Every 30 seconds the API publishes due posts with one conditional `UPDATE … WHERE status = 'scheduled' AND publish_at <= now()`. It uses the database clock, and running it twice publishes a post once. Moving a post out of `scheduled` cancels the schedule.

The website caches published-article reads for up to an hour and purges them on demand. Any change that affects the public site (publish, edit while live, unpublish, archive, slug change, or a scheduled publish) writes a row to `cache_revalidations` in the same transaction. A dispatcher in the API process claims due rows (`FOR UPDATE SKIP LOCKED`) and POSTs them to the website's `/api/revalidate` with an HMAC-SHA256 signature over `timestamp.body` using `REVALIDATE_SECRET`. Purges that remove a public article expire the cache immediately; other changes refresh in the background. Failed deliveries retry with backoff (10 seconds doubling up to 15 minutes) and become `dead_letter` after 8 attempts; the admin overview reports pending and dead-lettered purges. If the website stays unreachable, the hourly cache lifetime bounds staleness.

## Media uploads (Cloudflare R2)

Blog covers are uploaded straight from the admin browser to R2 with short-lived presigned URLs, following the pattern used in the oj backend:

1. `POST /api/v1/admin/media/uploads` with `{ intent: "blog-cover", fileExtension, byteSize, filename?, altText? }`. The API accepts JPG, PNG, and WebP only (no SVG), derives the content type from the extension, generates the key `{R2_FOLDER_PREFIX}/blog-cover/{yyyy}/{mm}/{random}.{ext}`, stores a `pending` row in `media_assets`, and returns a 10-minute `PUT` URL plus the exact headers the browser must send. The URL signs `Content-Length`, `Content-Type`, and `Cache-Control`, so R2 rejects a body of a different size or type.
2. The browser `PUT`s the file to that URL with those headers.
3. `POST /api/v1/admin/media/:id/verify` checks the stored object exists, matches the declared size and type, and starts with a real JPG/PNG/WebP signature. Only then does the row become `verified` (audited as `media.upload`). Rejected objects are deleted.

`GET /api/v1/admin/media` lists verified images for reuse, `PATCH /api/v1/admin/media/:id` updates default alt text, and `DELETE /api/v1/admin/media/:id` refuses images that are still an article cover. The API process runs a cleanup pass every 10 minutes that expires abandoned uploads and removes objects for expired, failed, and deleted rows. Verified images are never removed automatically.

One-time Cloudflare setup:

- Create one bucket for all environments; `R2_FOLDER_PREFIX` keeps them apart (`development-files`, `staging-files`, `production-files`).
- Create an R2 API token scoped to that bucket with Object Read & Write, and set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`.
- Connect a custom domain (for example `media.<your-domain>`) to the bucket and set `R2_PUBLIC_URL` to it. Do not use the rate-limited `r2.dev` URL in production.
- Add a bucket CORS rule allowing `PUT` and `HEAD` from the exact admin origins (local, staging, production) with allowed headers `Content-Type` and `Cache-Control`.

Without the R2 variables, local development still runs; upload endpoints return 503. With `NODE_ENV=production` the API refuses to start, listing every problem, unless:
- all of `DATABASE_URL`, `REDIS_URL`, the R2 variables, and `REVALIDATE_SECRET` are set;
- `INQUIRY_SECURITY_SECRET` is a random value of 32+ characters (not the development default);
- `EMAIL_FROM` and `INQUIRY_NOTIFICATION_TO` are real addresses rather than `example.com`;
- `FRONTEND_ORIGIN` is `https://`;
- `RESEND_API_KEY` is set when `EMAIL_PROVIDER=resend`.

The rules live in `parseEnv` (`src/env.ts`), with tests in `src/env.test.ts`.

Logs are structured JSON (pino) with contact details and credentials redacted. Every response carries an `X-Request-Id` header (a well-formed incoming ID is reused), and each request log line includes it. Admin sign-ins, sign-outs, inquiry changes, and blog post changes are written to the append-only `admin_audit_events` table in the same transaction as the change; audit metadata records field names and status transitions, never contact details or note text, and IPs are stored only as keyed hashes.

Release, smoke-test, backup, restore, and rollback procedures are in [`docs/operations-runbook.md`](docs/operations-runbook.md). Run the staging smoke test (`npm run smoke`, or `node dist/scripts/smoke.js` in the API container) twice before promoting a release, and run `scripts/restore-drill.sh` after setting up backups and then monthly. `GET /api/v1/admin/inquiries/:id` also returns each inquiry email's delivery status (`notifications`) without addresses or provider errors.

Run `npm test`, `npm run typecheck`, and `npm run build` for checks.

`npm run test:integration` runs `src/**/*.int.test.ts` against real Postgres and Redis. It covers enquiry storage and alert rows, the account and session flow, reviews with cache purges, enquiry deletion, retention, and the database's own checks.
- It empties every table, so it refuses any database whose name does not contain `test`. For example: `DATABASE_URL=postgres://…/mgcleaning_test REDIS_URL=redis://… npm run test:integration`.
- CI (`.github/workflows/ci.yml`) runs the unit checks and audit, plus this suite against service containers. Generate a migration after schema changes with `npm run db:generate`, then review and apply it with `npm run db:migrate`. The schema starts from one migration, `drizzle/0000_initial.sql`, merged from the pre-launch history. Never edit or merge migrations once a database has applied them. Keep `npm audit --omit=dev` free of high and critical advisories. As of November 2026 the only remaining items are three moderate `glob`/`minimatch` advisories reached through `react-email`'s CLI tooling, which the email render path does not use (npm's suggested fix is a downgrade to `react-email` 1.x).

Compose credentials and endpoints are for local development only. Configure database, Redis, and Resend credentials through deployment environment variables; do not commit `.env` files.

## Initial data model

The Drizzle schema includes a `contact_inquiries` table used by `POST /api/v1/inquiries`. It records whether a submission is a contact message or cleaning request, a public request reference, an idempotency key, preferred contact method, and request preference fields. The `email_outbox` table records customer and internal notifications for retryable delivery. Outbox attempts are bounded and permanently failing messages move to `dead_letter`; the admin overview exposes failed notification counts. Service interest remains free text so the schema does not lock MG into unconfirmed service categories.
