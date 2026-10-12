# Backend-only Dockerfile. Frontends (client + admin) run in their own
# containers; host nginx routes by subdomain. This image just ships the
# Node API + WebSocket on port 5000.
#
# Build context = backend/
#   cd backend
#   docker build -t tp-backend .

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# Prod deps only. `npm ci` strict; falls back to `npm install` if the
# lock file is out of sync (e.g. razorpay was added but lock not committed).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

COPY src ./src
# Ops/maintenance scripts (engine benchmarks, seeds, etc.).
COPY scripts ./scripts
# One-off schema/data migrations run manually after a deploy, e.g.
#   docker compose exec backend node migrations/addLifetimePnlGate.js
# Without this the folder is absent from the image and the run fails with
# MODULE_NOT_FOUND (src/migrations/ works only because it rides along in src).
COPY migrations ./migrations

EXPOSE 5000
CMD ["node", "src/server.js"]
