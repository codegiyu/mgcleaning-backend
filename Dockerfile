FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# 4100, not 4000: the server's 3000 and 4400 are taken. Coolify maps the domain to this port.
ENV NODE_ENV=production API_PORT=4100

RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs backend

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

USER backend
EXPOSE 4100
# Ready means Postgres and Redis answer too, not just that the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.API_PORT + '/api/v1/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Migrations run before the API on every start (already-applied ones are skipped), so a
# Dockerfile deploy against an external database needs no separate migration step.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]
