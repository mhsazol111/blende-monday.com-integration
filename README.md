# monday-automation-service

A config-driven notification & automation engine for monday.com.

It receives monday webhooks and runs per-group rules of the form
**WHEN** _trigger_ — **IF** _conditions_ — **THEN** _actions_ (email / Slack), where actions can
fire immediately or be scheduled for later, and can be cleared per item. It replaces a temporary
WordPress plugin (the former `monday-subitem-cloner.php`), now retired — its cloning logic has been
ported into this service.

> **For AI agents / new sessions:** read [`CLAUDE.md`](./CLAUDE.md) first — it tracks the current
> build phase, the agreed rule spec, and how to run things.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in MONDAY_API_TOKEN etc.
npm run typecheck      # confirm it compiles
npm run discover       # list boards → groups → columns → labels → subitems
npm run dev            # run the service (webhook ingress + scheduler + configurator)
```

Then open the **configurator** at `http://localhost:3000/` to build rules from live board
data (no IDs to copy). If `WEBHOOK_SHARED_SECRET` is set, append `?secret=<value>` to save.

## Scripts

| Script              | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `npm run typecheck` | Type-check without emitting.                                  |
| `npm run build`     | Compile TypeScript to `dist/`.                                |
| `npm run dev`       | Run the service with hot reload (`tsx watch`).                |
| `npm run start`     | Run the compiled service from `dist/`.                        |
| `npm run discover`  | Print the structure of a board (IDs the rules engine needs).  |
| `npm test`          | Run all offline test suites (no monday/network needed).       |

## Layout

```
src/
  config/env.ts      Centralised, validated environment access
  util/              Logger + {{template}} renderer
  monday/            GraphQL client, discovery, item hydrate, template cloner
  events/            Canonical internal event types
  rules/             Rule schema, JSON loader, matching engine
  queue/ db/         Queue contracts + SQLite store
  senders/           Email (SMTP/dry-run) + Slack senders
  web/admin.ts       Configurator API + static UI routes
  worker.ts          Scheduler loop (dispatches due actions)
  server.ts          Fastify ingress + wiring
  index.ts           Service entrypoint
web/                 Configurator UI (index.html + app.js)
config/rules.json    Rule definitions (editable via the configurator)
```

## Deploy

Containerised via `Dockerfile` (Node 24 Alpine). On Coolify: deploy from the repo (auto-detects the
Dockerfile), set env vars, mount a **persistent volume at `/app/data`** (rules + SQLite queue),
run a **single instance**, and set `WEBHOOK_SHARED_SECRET`. Full steps in `CLAUDE.md` §11.

See `CLAUDE.md` for architecture, the full rule spec, security notes, and the deployment guide.
