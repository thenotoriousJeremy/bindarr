# Repository Guidelines

## Project Overview

Bindarr is a self-hosted, multi-user collection manager for Pokémon, Magic: The Gathering, and Disney Lorcana cards. It provides search, collection/storage/deck management, pricing, imports/exports, sharing, and optional camera scanning. The product is a React/Vite SPA backed by Express and one SQLite database; Docker packages both.

## Architecture & Data Flow

- `frontend/src/main.jsx` boots native setup, i18n, then `App.jsx`. `App.jsx` owns session/tab/toast state, installs auth-aware fetch behavior, lazy-loads views, and handles public share routes.
- UI components call relative `/api` endpoints. In Capacitor, `frontend/src/apiBase.js` rewrites those calls to the configured server; Vite proxies `/api`, `/models`, and `/ort` to port 3001 in development.
- `backend/src/server.js` is the composition root: middleware, route mounting, startup initialization/jobs, API/static serving, and optional TLS listener. Route order is security-sensitive: public auth/shared/card-art paths precede the authenticated `/api` gate.
- `backend/src/routes/*.js` own HTTP/domain operations. Routes use `req.user.id` to scope records. Central decisions belong in existing utilities, especially `utils/pokemonProvider.js` for Pokémon source selection and `utils/cardApi.js` for card-ID provider dispatch.
- `backend/src/db.js` owns the shared SQLite connection, schema initialization/migrations, Promise SQL helpers (`run`, `get`, `all`), and `withTransaction`. SQLite uses WAL; preserve its startup migration and transaction model.
- Provider clients normalize external cards into the cached card shape before collection operations. Scan requests flow through `routes/collection.js` to `cvScan.js`, which matches images against catalog assets built by `catalog.js`.
- Production builds `frontend/dist`; Express serves it after API routes. `/app/database` persists SQLite, backups, TLS material, models, and scan catalogs.

## Key Directories

- `backend/src/` — Express service, database, provider clients, scan/catalog/backup logic.
- `backend/src/routes/` — feature routers; mount/access order is defined in `backend/src/server.js`.
- `backend/src/middleware/` — authentication, authorization, and rate limits.
- `backend/src/utils/` — shared policy/domain helpers. Reuse these instead of duplicating provider, language, price, placement, or TLS logic.
- `backend/test/` — standalone unit assertions; `backend/test/e2e/` boots real server processes with temporary SQLite state.
- `frontend/src/` — React app, components, utilities, global CSS, and locales.
- `frontend/src/locales/` — BCP-47 JSON dictionaries; loaded dynamically by `utils/i18n.jsx`.
- `frontend/scripts/` — frontend build/locale helpers. `frontend/android/` and `frontend/ios/` are Capacitor native shells.
- `shared/` — runtime JSON tables/assets consumed by backend; not an npm workspace package.
- `backend/scripts/` — operator maintenance tasks, not normal development hooks.

## Development Commands

```sh
npm run install:all                 # install root, backend, and frontend packages
npm run dev                         # backend nodemon + HTTPS Vite dev server
npm run dev:backend                 # backend only
npm run dev:frontend                # frontend only
npm run build:frontend              # build frontend/dist
npm test                            # backend unit/e2e, then frontend utilities/locales
npm start                           # production backend start

cd backend && npm run test:e2e      # E2E only
cd frontend && npm run lint         # required ESLint gate; warnings fail
cd frontend && npm run check:locales
cd frontend && npm run preview

docker compose up -d                # source-built container deployment
```

Use `npm ci` in each package scope for reproducible CI/container installs. Backend changes need a process restart when running `node src/server.js`; only the backend `dev` script reloads automatically.

## Code Conventions & Common Patterns

- **Modules:** backend is CommonJS (`require`, `module.exports`); frontend is ESM/JSX (`import`, `export`). Keep the boundary intact.
- **Names:** camelCase for values/functions, PascalCase for React components, snake_case for SQLite/API fields. Use lower-case game values: `pokemon`, `mtg`, `lorcana`.
- **Backend routes:** create `express.Router()`, validate early, use parameterized SQL (`?` with values), wrap async work in `try/catch`, log operational context, and return client-safe `{ error: '...' }` responses. Use `db.run/get/all`; do not use raw callback sqlite calls.
- **Auth:** preserve central auth/mount placement. Authenticated mutations must be user-scoped with `req.user.id`; do not rely on client-provided user IDs.
- **Providers:** normalize and cache through the existing provider modules. For Pokémon search/set work use `pokemonProvider.apiFor(lang)`; for an existing card ID use `cardApi`. Do not add feature-local language/ID-prefix branching.
- **Async/error handling:** non-critical startup warmups/background jobs may intentionally use fallbacks; mutations, auth, and ownership checks must fail explicitly. Do not turn deliberate non-blocking work into request-path blocking.
- **React/state:** function components and hooks are standard. Keep request/listener cleanups in `useEffect`; local loading/error state stays with the component. Use `const { t } = useT()` and stable translation keys rather than literal UI text.
- **Styling:** reuse tokens/classes from `frontend/src/index.css` (`--bg-*`, `--text-*`, `--surface-*`, `--accent-*`, `btn`) rather than hard-coded colors. Respect `data-theme`.
- **Formatting:** match the touched file’s style. No formatter or TypeScript/typecheck command is configured. Frontend ESLint is strict because its script uses `--max-warnings 0`.
- **Domain invariants:** card behavior is game-scoped; thread new card fields through both Pokémon and Scryfall normalization. Storage ordering is `position = slot * 1000`, not an array index.

## Important Files

- `package.json` — root command orchestration.
- `backend/src/server.js` — backend entry, route composition, lifecycle scheduling, static SPA serving.
- `backend/src/db.js` — schema/migrations, SQLite access, transactions.
- `backend/src/routes/collection.js` — search, scan matching, collection and price operations.
- `backend/src/routes/storage.js` — physical storage/location rules.
- `backend/src/middleware/auth.js` — bearer/API-key auth, roles, rate limits.
- `frontend/src/App.jsx` — frontend composition/session/fetch behavior.
- `frontend/src/utils/i18n.jsx` — translation context and locale loading.
- `frontend/vite.config.js` — HTTPS dev server, proxy, build behavior.
- `.env.example` — canonical runtime configuration.
- `Dockerfile`, `docker-compose.yml`, `entrypoint.sh` — production build, persistence, privilege model.
- `PROJECT.md` — architecture and operational reference; `README.md` — setup/operator reference.

## Runtime/Tooling Preferences

- Use **npm**, with separate root, `backend/`, and `frontend/` manifests/lockfiles; this is not an npm workspace.
- Local documented floor: Node 18+ and npm 9+. Use **Node 20** for server/container/CI parity; Node 22 is used only by mobile/demo release workflows.
- Frontend: React/Vite, ESM, JSX, HTTPS on `https://localhost:5173`. Backend: Node/Express/CommonJS on `http://localhost:3001` by default.
- Native dependencies (`sqlite3`, `sharp`, `onnxruntime-node`) are platform-sensitive. Install/rebuild in the target environment; Docker production uses Debian/glibc, not Alpine.
- Configure runtime through `.env.example`. Preserve `DB_PATH`, TLS, CORS, `PUBLIC_BASE_URL`, `TRUST_PROXY`, bootstrap auth, and provider-key semantics. Do not commit `.env`, database/WAL files, build output, models, catalogs, or generated native assets.
- Scan models/catalogs are stateful downloads outside the image. A missing catalog must retain the documented `503 notBuilt` behavior; do not guess a match.

## Testing & QA

- `npm test` runs `backend/test/run.js`, `backend/test/e2e/run.js`, then `frontend` utility tests and locale validation.
- Backend tests are plain Node/assert scripts, not Jest/Vitest. Unit suites live in `backend/test/*.test.js`; E2E suites in `backend/test/e2e/*.test.js` run serially against real Express processes.
- Set `DB_PATH` **before** importing DB-dependent backend modules. Use a per-PID temporary SQLite path and clean its `.db`, `-wal`, and `-shm` files. Prefer real temporary SQLite state over DB mocks.
- Keep provider tests deterministic/offline with checked-in fixtures and existing Axios interception. `backend/test/live/*.live.js` requires credentials and may consume provider credits; it is intentionally outside normal test discovery.
- Frontend utility tests live beside utilities as `frontend/src/utils/*.test.js`, using built-in `node:test`/`node:assert`. Match the surrounding test style; do not add a test framework.
- Locale changes require `cd frontend && npm run check:locales`. Preserve English keys/order, placeholders, and required plural categories; add translations under `frontend/src/locales/<BCP-47>.json`.
- CI hard-gates backend tests, frontend lint, and locale validation. There is no coverage threshold or configured coverage tool.
