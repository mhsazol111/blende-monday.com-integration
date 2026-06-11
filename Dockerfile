# ── build stage ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prod dependencies only (node:sqlite is built into Node — no native build).
COPY package*.json ./
RUN npm ci --omit=dev

# App: compiled server + static configurator assets.
COPY --from=build /app/dist ./dist
COPY web ./web

# Persistent data (SQLite queue + rules.json) lives here — mount a volume.
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/automation.sqlite
ENV RULES_PATH=/app/data/rules.json
ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/index.js"]
