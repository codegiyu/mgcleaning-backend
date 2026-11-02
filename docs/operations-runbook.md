# MG Cleaning operations runbook

How to release, verify, back up, restore, and roll back the MG Cleaning stack (the `mgcleaning` website and this API). Commands assume Coolify as described in the README; adjust container names to what Coolify shows.

## Release checklist

1. **Back up first.** Take an on-demand backup (see [Backups](#backups)) before any deploy that adds a migration.
2. **Deploy the API.** Coolify builds the image; the new container applies migrations, then starts the API (in the Compose stack, the one-shot `migrate` service does this first). A failed migration leaves the previous container running.
3. **Deploy the website** with the same build variables as before (`NEXT_PUBLIC_*` are inlined at build time).
4. **Run the smoke test against staging twice in a row** (see below). Both runs must pass.
5. **Promote to production** by deploying the same commits. Do not rebuild from a different commit than the one that passed staging.
6. After production deploys, check `GET /api/v1/health`, sign in to `/admin`, and confirm the overview shows no email or website-update failures.

## Continuous integration

Both repositories run `.github/workflows/ci.yml` on pushes to `main` and `staging` and on pull requests:
- **API checks:** typecheck, unit tests, build, and a production dependency audit (high and critical advisories fail it).
- **API integration:** Postgres and Redis service containers, running the integration suite.
- **Website checks:** lint, typecheck, unit tests, build, and the same audit.
- **Website end-to-end:** the API and website run together, with Playwright on top.

The website's end-to-end job checks out this repository (public, so no token is needed): `main` for pushes to `main`, otherwise `staging`. Merge this repository's `main` before the website's so that run tests the same API that deploys. Deploy only commits whose CI is green.

## Staging smoke test

`src/scripts/smoke.ts` exercises the whole stack: health → inquiry (with attribution) → team (and optional customer) email delivery → admin sign-in and cookie attributes → R2 cover upload and verification → publish → public API and website page → unpublish and cache purge → sign-out revoked server-side. It refuses hosts that do not look like staging unless `SMOKE_ALLOW_PRODUCTION=yes`.

```sh
SMOKE_API_URL=https://api.staging.<domain>/api/v1 \
SMOKE_WEB_URL=https://staging.<domain> \
SMOKE_ADMIN_EMAIL=<staging admin> \
SMOKE_ADMIN_PASSWORD=<staging admin password> \
SMOKE_CUSTOMER_EMAIL=<inbox you control, optional> \
npm run smoke
```

Inside the API container use `node dist/scripts/smoke.js` with the same variables. Notes:

- It sends real email: the team alert goes to the configured inquiry inbox, so point staging's inbox at a test mailbox.
- Records it creates are marked `Smoke Test <run id>` / `smoke-<run id>`: the inquiry is closed and the article archived (there is no delete for either), and the uploaded image is deleted. Filter them out with the inbox's Source filter (`smoke`).
- `SMOKE_SKIP_MEDIA=yes` skips upload, publishing, and cache checks when R2 is not configured yet.
- A failed step exits non-zero; cleanup still runs and reports anything it could not undo.

## Inquiry alerts (one-time setup per environment)

M&G promises a reply to messages within 15 minutes, so the team alert has to reach a phone quickly and reliably.

1. **Verify the sender domain in Resend.** Add the SPF, DKIM, and (recommended) DMARC records Resend shows for the domain, and wait until Resend reports it verified. Without this, alerts are rejected or land in spam.
2. **Set the API environment:** `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` (a Coolify secret), and `EMAIL_FROM` on the verified domain (e.g. `notifications@<domain>`). The sender name defaults to `M&G Cleaning Services`; set `EMAIL_FROM_NAME` only to change it. `INQUIRY_NOTIFICATION_TO` always receives every alert, as well as any inbox set in step 3.
3. **Set the alert inbox in the dashboard.** In Admin → Settings, enter the inbox the customer experience officer reads on their phone. It takes effect for the next enquiry without a redeploy.
4. **Check `FRONTEND_ORIGINS`.** Its first entry must be the public website origin. The alert's "Open in dashboard" button links to `<first entry>/admin/inquiries/<id>`.
5. **Test it end to end:** run the smoke test (above) with the staging inbox, or send one real enquiry. Confirm on the officer's phone that the alert arrives, "Reply on WhatsApp" opens a chat with the customer, "Call" dials, and replying to the email addresses the customer.
6. **If an alert does not arrive:** the inquiry record shows "Team alert: Failed/Dead letter", and the overview counts email failures. Check the Resend dashboard for the rejection reason. The worker retries failed sends with backoff before giving up.

## Health checks

- **`GET /api/v1/health`:** liveness only. The process is up.
- **`GET /api/v1/health/ready`:** readiness. Postgres and Redis both answer within 2 seconds, otherwise it returns 503 naming the failed check (details go to the log). The image's `HEALTHCHECK` and the compose `api` health check use this endpoint, so an instance that loses its database or Redis is reported unhealthy.
- **Crashes:** an unhandled error or rejection is logged at `fatal`, the API shuts down cleanly with exit code 1, and the orchestrator restarts it. If draining hangs for 15 seconds it exits anyway.
- **Migrations on start:** the image runs migrations before the API, so the Dockerfile deploy needs no separate step. The new container migrates while the old one still serves, which is why schema changes must stay compatible with the previous release (see [Rollback](#rollback)). In the Compose stack the `migrate` service builds the same image (nearly free with Docker's layer cache) and the `api` service skips migrating.

## Accounts

- **First owners:** after the first deploy, create them with `admin:bootstrap:runtime`, then remove the bootstrap variables. `BOOTSTRAP_ADMIN_EMAIL` may hold several comma-separated addresses; each becomes an owner with `BOOTSTRAP_ADMIN_PASSWORD`, and with several addresses each must set their own password at first sign-in. Addresses that already have an account are skipped, so the command can be rerun to add more.
- **Everyone else:** add accounts from **Admin → Users**, staff by default. Pass the temporary password on privately; it is shown once and must be changed at first sign-in.
- **Hidden accounts:** addresses in `HIDDEN_ADMIN_EMAILS` (default `codegiyu@gmail.com`) do not appear in Users, cannot be changed or reset by other admins, and show as "Site administrator" in the activity log, except to that admin themselves. They still count as an active owner for the last-owner protection.
- **When someone leaves:** deactivate their account (Users → Deactivate). Their sessions end at once, and the audit trail still names them.
- **Owner locked out:** if every owner is locked out, an operator can reset a password with `admin:reset-password` inside the API container.

## Data retention and deletion requests

A retention pass (`src/maintenance/retention.ts`) runs at API start and then every six hours. It logs its counts when it changes anything:

| Data | Kept for |
|---|---|
| Enquiries (with their notes and emails) | 24 months |
| Sent or failed email copies | Bodies, recipients and buttons cleared after 90 days |
| Audit events | 24 months |
| Message-tap counts | 13 months |
| Finished cache purges | 30 days |
| Expired sessions | Removed |

The privacy page states the same periods; change both together.

When a customer asks for their details to be deleted:
1. An owner opens the enquiry in **Admin → Inquiries** and uses **Delete enquiry**. The enquiry and its emails are removed at once.
2. The activity log keeps the request reference as evidence.
3. Backups age out on their own rotation (see Backups).

## Backups

PostgreSQL holds every inquiry, article, audit event, and setting; the Docker volume alone is not a backup.

- **Schedule:** daily at 02:00 WAT, plus on demand before each migration. Keep 14 daily and 8 weekly copies.
- **Command** (Coolify scheduled task on the `postgres` service, or `docker exec` on the host):

  ```sh
  pg_dump --username "$POSTGRES_USER" --dbname mgcleaning --format custom --file /backups/mgcleaning-$(date +%F-%H%M).dump
  ```

- **Off-site copy:** copy each dump off the server (for example to a separate R2 bucket with its own write-only token). A backup on the same disk as the database does not survive losing the server. This is required before launch.
- **Redis** holds only queues, rate limits, and short-lived keys. It does not need restoring; the email and cache outboxes in PostgreSQL are re-queued automatically.
- **R2 media** objects are immutable and never overwritten. Deleted images are soft-deleted in the database first. Enable R2 bucket versioning or lifecycle rules if accidental-deletion recovery is required.

## Restore drill

Run `scripts/restore-drill.sh` after backups are first set up and then monthly. It restores into a database whose name must contain `restore` or `scratch`, then prints row counts and the number of applied migrations.

```sh
createdb mgcleaning_restore_check   # inside the postgres container or against a scratch server
BACKUP_FILE=/backups/mgcleaning-2026-10-27-0200.dump \
SCRATCH_DATABASE_URL=postgres://<user>:<pass>@localhost:5432/mgcleaning_restore_check \
scripts/restore-drill.sh
dropdb mgcleaning_restore_check
```

Compare the counts with production (`contact_inquiries`, `blog_posts`, `admin_users`) and record the date, backup file, duration, and result in the log at the end of this file.

**Real restore (data loss or corruption):** stop the `api` service in Coolify so nothing writes, restore the chosen dump into the production database with `pg_restore --clean --if-exists --no-owner`, start `api`, run the post-deploy checks above, and tell the M&G team that inquiries received after the backup time must be re-entered from email.

## Rollback

**Application code:** in Coolify, redeploy the previous successful deployment of the affected app (website or API stack). This is the default response to a bad release; fix forward only for trivial issues.

**Database:** the schema starts from a single migration, `0000_initial`. It was merged from the pre-launch history, because no database existed before the first deploy. From the first deploy on, migrations are forward-only and are never rolled back:
- Write each change so the previous API version still runs against the new schema: add tables and nullable or defaulted columns first, and drop or rename only in a later release.
- Record any step a rollback needs in a table here.

There is nothing to record until after launch.

Restore from backup only for data loss, never as a substitute for code rollback.

## Incident actions

- **Admin locked out:** set `ADMIN_RESET_EMAIL` and `ADMIN_RESET_PASSWORD` in the API container, run `node dist/scripts/resetAdminPassword.js`, then remove both variables. All sessions for that account are revoked.
- **Suspected admin account compromise:** reset the password as above, then sign out every admin everywhere with `DELETE FROM admin_sessions;`. Review `/admin/activity` for actions you do not recognise.
- **Rotate secrets:** `INQUIRY_SECURITY_SECRET` (resets rate-limit and duplicate keys; harmless), `REVALIDATE_SECRET` (change on the website and API together, then redeploy both), R2 token (create the new token, update the four `R2_*` credentials, redeploy, then revoke the old token), `RESEND_API_KEY` (same order).
- **Emails stuck in dead letter after a provider outage:** once the provider works again, re-queue them with `UPDATE email_outbox SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL WHERE status = 'dead_letter';`. The API picks them up within 15 seconds.
- **Website not reflecting an unpublish:** check the overview's "Website update failures", then re-queue with `UPDATE cache_revalidations SET status = 'pending', attempts = 0, available_at = now() WHERE status = 'dead_letter';`. For an immediate purge, redeploy the website (its cache lives in the container).
- **Abuse wave on the inquiry form:** set `TURNSTILE_MODE=on` with `TURNSTILE_SECRET_KEY` on the API and `NEXT_PUBLIC_TURNSTILE_MODE=on` with the site key on the website, then redeploy both. Lower `INQUIRY_RATE_LIMIT_PER_WINDOW` if needed.

## Restore drill log

| Date | Backup file | Duration | Result | By |
|---|---|---|---|---|
| | | | | |
