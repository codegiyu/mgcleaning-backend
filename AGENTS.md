# MG Cleaning backend instructions

- Read `README.md` before backend changes.
- Keep HTTP routes versioned under `/api/v1` and return the success/error envelope used by the MG web app's typed `callApi` helper.
- Validate user input at the route boundary with Zod; do not trust browser-side validation.
- Use Drizzle schema changes plus reviewed generated SQL migrations for PostgreSQL.
- Use BullMQ for work that should run outside the HTTP request. Keep workers runnable as separate processes.
- Keep secrets in `.env`; update `.env.example` with variable names and safe local defaults only.
- Do not add web app or React Query dependencies to this repository.
- Account management and site settings are owner-only: guard new routes of that kind with `requireOwner` (`src/routes/v1/admin-shared.ts`).
- Accounts listed in `HIDDEN_ADMIN_EMAILS` are invisible to other admins: any new route that lists or acts on admin users or shows actor emails must go through `isHiddenFrom` (`src/auth/hidden-admins.ts`).
- Personal data has fixed retention (`src/maintenance/retention.ts`). Any new table holding personal data needs a retention rule there, and a matching line on the website's privacy page.
- Production settings are validated in `parseEnv` (`src/env.ts`). Add new required production settings there, with a test in `src/tests/env.test.ts`.
- Until the first deploy, schema changes may be folded into `drizzle/0000_initial.sql` by regenerating it. After that, migrations are forward-only.
- Tests live in `src/tests/`, not beside the code.
- Run `npm run test:integration` (against a database whose name contains `test`) after changing queries, constraints, or the session flow.
