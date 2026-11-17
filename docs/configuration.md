# Configuration

Every setting is an optional environment variable. Set them in your compose file, or in `backend/.env` (`app/backend/.env` for the prebuilt server). [`.env.example`](../.env.example) lists every variable with its default.

- [Server](#server)
- [Accounts and sign-in](#accounts-and-sign-in)
- [Single sign-on (OIDC)](#single-sign-on-oidc)
- [Card data and scanning](#card-data-and-scanning)
- [Backups, notifications and metrics](#backups-notifications-and-metrics)

## Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port. |
| `HTTPS_PORT` | `3443` in Docker, off otherwise | HTTPS port. `""` serves HTTP only. |
| `SSL_CERT_PATH`, `SSL_KEY_PATH` | | Your own certificate instead of the generated self-signed one. |
| `DB_PATH` | `/app/database/bindarr.db` in Docker | The SQLite file. A relative path is read from `backend/`. |
| `PUBLIC_BASE_URL` | | The address users reach Bindarr at behind a proxy, e.g. `https://cards.example.com`. Used for share links and SSO, and allowed as a CORS origin. Also settable in Admin. |
| `TRUST_PROXY` | | The number of reverse proxies in front of Bindarr (usually `1`), so rate limits see the real client address. Leave unset when clients connect directly. `true` means `1`. |
| `CORS_ORIGIN` | | More allowed origins, comma-separated. Localhost and private-network origins are always allowed. |
| `CSP_REPORT_ONLY` | | `true` stops enforcing the Content Security Policy. Use it if card images stop loading after a provider moves its images to a new host, until Bindarr is updated. |

## Accounts and sign-in

| Variable | Default | Purpose |
| --- | --- | --- |
| `SETUP_CODE` | random | The code needed to create the first account. Unset, a new one is printed to the log at each start. |
| `DEFAULT_ADMIN_PASSWORD` | | Create the `admin` account with this password at startup. Only used while no account exists. |
| `ALLOW_REGISTRATION` | | `true` lets anyone register. Unset, only admins create accounts. |

## Single sign-on (OIDC)

Works with any OpenID Connect provider (Authelia, Authentik, Keycloak and others).

| Variable | Default | Purpose |
| --- | --- | --- |
| `OIDC_ENABLED` | `false` | `true` turns on SSO. |
| `OIDC_ISSUER_URL` | | The provider's base URL. Must be `https` (except `localhost`), and must match the `issuer` in its discovery document. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | The client registered at the provider. |
| `OIDC_PROVIDER_NAME` | `Single Sign-On` | The login button's label. |
| `OIDC_SCOPES` | `openid profile email` | Scopes to request. |
| `OIDC_USER_CLAIM` | `preferred_username` | The claim used as the Bindarr username. |
| `OIDC_AUTO_PROVISION` | `true` | Create an account on a user's first SSO login. |
| `OIDC_DEFAULT_ROLE` | `member` | The role of those accounts. `admin` makes every new SSO user an admin. |
| `OIDC_ALLOW_USERNAME_LINK` | `false` | Let an SSO login take over an existing account with the same username, to move pre-SSO accounts over. **Only if users cannot pick their own username at the provider**, or anyone can claim `admin`. |
| `OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | `client_secret_basic` | Or `client_secret_post`. |
| `OIDC_SESSION_SECRET` | random at each start | Signs logins in progress. Set it to keep logins working across restarts and multiple replicas. |
| `OIDC_REDIRECT_URI` | from `PUBLIC_BASE_URL` | Override the redirect URI. |

Register `<PUBLIC_BASE_URL>/api/auth/oidc/callback` as the redirect URI at the provider. The mobile apps use the same one. Start a login from that address: one started from another address can't be finished.

### A provider with a private CA

If SSO fails with `fetch failed` and the log shows `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`, the provider's certificate comes from a CA Node doesn't trust. Node ignores the system certificate store, so mount the CA and point `NODE_EXTRA_CA_CERTS` at it:

```yaml
    environment:
      - NODE_EXTRA_CA_CERTS=/certs/root-ca.pem
    volumes:
      - bindarr-data:/app/database
      - ./root-ca.pem:/certs/root-ca.pem:ro
```

Node reads it once at startup, so it must be in the container's environment, not in `.env`.

## Card data and scanning

| Variable | Default | Purpose |
| --- | --- | --- |
| `POKEMONTCGAPI_KEY` | | Key for the optional pokemontcgapi.com Pokémon provider. See [Card data](card-data.md#pokémon). |
| `POKEMON_TCG_API_KEY` | | Only for installs still on pokemontcg.io, which shuts down on 1 March 2027. |
| `TCGCSV_BASE_URL` | the project's mirror | Where TCGplayer data comes from. See [the TCGCSV mirror](card-data.md#the-tcgcsv-mirror). Don't point it at tcgcsv.com. |
| `RIFTCODEX_BASE_URL` | `https://api.riftcodex.com` | Riftbound card data. |
| `CV_MODEL_DIR` | `/app/database/models` in Docker | Scan models and catalogs. Must be persistent storage. |
| `CV_SCAN_GAP` | `0.10` | How far the best match must beat the next before it counts. Lower accepts more guesses. |
| `CATALOG_AUTO_UPDATE` | on | `0` stops adding newly released cards to your catalogs. |
| `CATALOG_RELEASE_URL` | this repo's `scan-catalogs` release | Where Bindarr's catalogs download from. `off` turns the downloads off. |
| `CATALOG_EMBED_WORKERS` | cores − 1, at most 4 | Threads used when you build a catalog yourself. |

## Backups, notifications and metrics

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_DIR` | `backups/` beside the database | Where backups go. |
| `BACKUP_INTERVAL_HOURS` | `24` | Automatic backup interval. `0` turns it off. |
| `BACKUP_KEEP_LAST` | `10` | Regular backups to keep. Pre-upgrade backups are kept separately (the newest 3). |
| `NOTIFY_ALLOW_PRIVATE` | | `true` lets notifications reach private-network addresses, such as your own ntfy or Apprise server. |
| `METRICS_ENABLED` | `false` | `true` adds a Metrics panel to Admin. |
| `PROMETHEUS_METRICS_ENABLED` | `false` | `true` serves metrics at `/metrics` on `PROMETHEUS_PORT`. They include usernames and collection values: set a token. |
| `PROMETHEUS_PORT` | `9100` | Port for `/metrics`. |
| `PROMETHEUS_METRICS_TOKEN` | | Require `Authorization: Bearer <token>` on `/metrics`. |
