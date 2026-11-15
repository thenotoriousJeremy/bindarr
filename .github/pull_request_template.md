## What and why

<!-- What this changes and the problem it solves. Link the issue: "Fixes #123". -->

## How it was tested

<!-- The commands you ran and what you checked by hand. Screenshots for UI changes. -->

## Checklist

<!-- From AGENTS.md. Tick what applies; say why if something does not. -->

- [ ] `npm test` passes (backend unit and e2e, frontend utilities, locales, mirror), and new behaviour has a test.
- [ ] `cd frontend && npm run lint` is clean (CI fails on any warning).
- [ ] New UI text goes through `t()` with its key in `frontend/src/locales/en.json`, and `cd frontend && npm run check:locales` passes.
- [ ] A route mounted in `backend/src/server.js` is mounted in `backend/src/embedded/index.js` too, or answers 501 there (device mode), and code device mode reaches uses no Node API outside `backend/src/embedded/aliases.js`.
- [ ] Changes to user data are scoped to `req.user.id`, with parameterized SQL.
- [ ] Nothing contacts tcgcsv.com, and tests stay offline: e2e servers start through `backend/test/e2e/harness.js`, and provider tests use fixtures.
