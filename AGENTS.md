# MG Cleaning backend instructions

- Read `README.md` before backend changes.
- Keep HTTP routes versioned under `/api/v1` and return the success/error envelope used by the MG web app's typed `callApi` helper.
- Validate user input at the route boundary with Zod; do not trust browser-side validation.
- Use Drizzle schema changes plus reviewed generated SQL migrations for PostgreSQL.
- Use BullMQ for work that should run outside the HTTP request. Keep workers runnable as separate processes.
- Keep secrets in `.env`; update `.env.example` with variable names and safe local defaults only.
- Do not add web app or React Query dependencies to this repository.
