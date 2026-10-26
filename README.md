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

`Dockerfile` builds one production backend image used by the API process and the migration job. The API process starts both Hono and the BullMQ email worker, and the image runs as an unprivileged user. `db:migrate:runtime` applies the checked-in Drizzle SQL migrations from that image; `admin:bootstrap:runtime` creates the initial administrator from the bootstrap environment variables.

Deploy the backend repository in Coolify as a **Git-based Docker Compose** application using `compose.coolify.yaml` (normal Compose mode, not Raw Compose). This stack contains PostgreSQL, Redis, a one-shot migration service, and the Hono API with its in-process BullMQ worker. Migrations must finish successfully before the API starts. PostgreSQL and Redis have persistent Docker volumes and no published host ports; configure independent PostgreSQL backups in Coolify or your backup system because a persistent volume alone is not a backup.

Assign the public API domain to the `api` service, including its internal port, for example `https://api.<your-domain>:4000`. Do not assign domains to `postgres`, `redis`, or `migrate`. The API listens on `0.0.0.0:4000` inside the container and has a Compose health check at `/api/v1/health`.

Set these Compose variables in Coolify before deployment:

- `FRONTEND_ORIGIN`: exact HTTPS origin of the website, with no path (for example, `https://www.<your-domain>`).
- `RESEND_API_KEY`: API key from Resend, stored as a Coolify secret.
- `EMAIL_FROM`: sender address on a domain verified with Resend.
- `INQUIRY_NOTIFICATION_TO`: real inbox that should receive inquiry alerts.
- `INQUIRY_SECURITY_SECRET`: random secret used to hash rate-limit and duplicate-detection identifiers.
- `TRUST_PROXY_HOPS`: number of trusted reverse-proxy hops used to resolve visitor IPs; use `1` behind the documented Coolify proxy and keep it `0` for direct local requests. The client IP is read that many entries from the right of `X-Forwarded-For`, so client-supplied entries are ignored.
- `LOG_LEVEL` (optional): pino log level, `info` by default.
- `TURNSTILE_MODE` and `TURNSTILE_SECRET_KEY`: leave Turnstile off until abuse warrants it, then configure the server secret and the matching frontend site key.
- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`: set only for the initial bootstrap.

After the first deployment and successful migrations, run `node dist/scripts/bootstrapAdmin.js` in the API container, then remove the two bootstrap variables and redeploy. The script is idempotent and will not reset an existing password. Keep the website and API on the same registrable domain so the existing `SameSite=Lax` HttpOnly session cookie works with credentialed cross-origin requests. The frontend origin must also match `FRONTEND_ORIGIN` exactly.

The public Next.js app is deployed separately from the `mgcleaning` repository as a Dockerfile application. Configure `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_SITE_URL` as build variables there; the former must point to the public HTTPS API URL.

`POST /api/v1/inquiries` validates and stores website inquiries in PostgreSQL, assigns a public request reference, and uses the `Idempotency-Key` header to prevent duplicate submissions. Booking requests require an email address and preferred contact method. Public requests are body-limited, rate-limited through Redis, checked with a honeypot, scored for obvious spam, and protected by a short-lived normalized fingerprint. Turnstile is supported behind `TURNSTILE_MODE=on` but is disabled by default. The API writes internal and customer email records to the transactional outbox, then queues them for the in-process worker. In local development, the worker sends through Mailpit; in Coolify it sends through Resend. Set the recipient to the real M&G inbox only in the appropriate deployment environment. A request reference confirms receipt only; it does not confirm availability, pricing, or an appointment.

The admin API includes session login/logout, an inquiry inbox with private status/notes, and blog draft/publish operations. Create the first admin after migrations: set `BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` of at least 12 characters in `.env`, then run `npm run admin:bootstrap`. The command stores a scrypt password hash; remove the bootstrap password from `.env` after it succeeds. It will not reset an existing account. Sessions are random opaque values stored as hashes, expire after 12 hours, and are returned only in an HttpOnly cookie. Admin writes require the configured `FRONTEND_ORIGIN`.

Published articles are exposed at `GET /api/v1/blog` and `GET /api/v1/blog/:slug`. Public reads only return published posts. Admin post content is plain text with limited headings, bold, and bullet-list conventions; raw HTML is not interpreted. Each article records an author name and optional related service slug. Publishing requires an author, related service, HTTPS cover image, and cover-image alt text. Cover images currently use HTTPS URLs because object storage has not yet been selected.

Logs are structured JSON (pino) with contact details and credentials redacted. Every response carries an `X-Request-Id` header (a well-formed incoming ID is reused), and each request log line includes it. Admin sign-ins, sign-outs, inquiry changes, and blog post changes are written to the append-only `admin_audit_events` table in the same transaction as the change; audit metadata records field names and status transitions, never contact details or note text, and IPs are stored only as keyed hashes.

Run `npm test`, `npm run typecheck`, and `npm run build` for checks. Generate a migration after schema changes with `npm run db:generate`, then review and apply it with `npm run db:migrate`.

Compose credentials and endpoints are for local development only. Configure database, Redis, and Resend credentials through deployment environment variables; do not commit `.env` files.

## Initial data model

The Drizzle schema includes a `contact_inquiries` table used by `POST /api/v1/inquiries`. It records whether a submission is a contact message or cleaning request, a public request reference, an idempotency key, preferred contact method, and request preference fields. The `email_outbox` table records customer and internal notifications for retryable delivery. Outbox attempts are bounded and permanently failing messages move to `dead_letter`; the admin overview exposes failed notification counts. Service interest remains free text so the schema does not lock MG into unconfirmed service categories.
