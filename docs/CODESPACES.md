# Codespaces development

Use the `feature/collection-enhancements` branch when creating a Codespace.
The devcontainer installs Node 20 dependencies and builds the frontend once.
It also runs the standalone opening-accounting test; this is not the full suite.

## Start and resume

Run from the repository root:

```sh
bash .devcontainer/start.sh
```

Open forwarded port 3001 from the Ports panel. Keep its visibility private.
Codespaces supplies the external HTTPS address; Express uses HTTP internally.
Use the server log's generated first-run admin password to sign in as `admin`.
Do not publish that password or disable application authentication.

Backend JavaScript changes restart through nodemon. Frontend changes rebuild
through Vite build watch; refresh the browser once the build finishes. This is
not frontend HMR. Dependency installation is not repeated on start or resume.
After changing a package lockfile, run `npm ci` in that package directory.

## Data and secrets

The test database is `.devcontainer/data/bindarr.db`. The directory is ignored
by Git and remains with this Codespace across stops/restarts. Deleting the
Codespace can delete its data: export or back up important test data first.
Never point this environment at the live household collection database.
This setup neither resets nor seeds an existing database.

Put provider credentials in repository-scoped Codespaces secrets, never Git.
The upcoming PokéWallet adapter is not implemented by this environment commit;
a key alone will not enable it. Avoid committing `.env` files or sharing logs
containing credentials. Provider calls and scanner model downloads may still
use external services; this is not an offline sandbox. Turn automatic pricing
off in Admin while testing unrelated UI, especially while TCGCSV blocks access.

## Tests

```sh
node backend/test/openingAccounting.test.js
npm test
npm run lint --prefix frontend
npm run check:locales --prefix frontend
```

The standalone test is not a substitute for the full suite. Codespaces may
consume your included GitHub quota and incur charges depending on account and
billing settings. Stop the Codespace when finished. This configuration has not
yet been validated in a running Codespace.
