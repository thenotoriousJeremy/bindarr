<div align="center">

<img src="frontend/public/logo.svg" width="120" height="120" alt="" />

# Bindarr

**Self-hosted collection manager for Pokémon and Magic: The Gathering cards.**

Identify cards with your phone camera, track prices, record which binder page and slot each card lives in, and pull decks back out again.

[![CI](https://img.shields.io/github/actions/workflow/status/thenotoriousJeremy/bindarr/docker-build.yml?branch=main&label=CI&logo=github)](https://github.com/thenotoriousJeremy/bindarr/actions/workflows/docker-build.yml)
[![Docker image](https://img.shields.io/badge/ghcr.io-bindarr-2496ED?logo=docker&logoColor=white)](https://github.com/thenotoriousJeremy/bindarr/pkgs/container/bindarr)
[![License: MIT](https://img.shields.io/github/license/thenotoriousJeremy/bindarr?color=blue)](LICENSE)
[![Stars](https://img.shields.io/github/stars/thenotoriousJeremy/bindarr?style=flat&logo=github)](https://github.com/thenotoriousJeremy/bindarr/stargazers)
[![Issues](https://img.shields.io/github/issues/thenotoriousJeremy/bindarr)](https://github.com/thenotoriousJeremy/bindarr/issues)

[Live demo](https://thenotoriousjeremy.github.io/bindarr/) · [Install](#install) · [Features](#features) · [How it works](PROJECT.md) · [Report a bug](https://github.com/thenotoriousJeremy/bindarr/issues/new)

</div>

---

https://github.com/user-attachments/assets/4ee6c23f-a024-499b-9fc3-3d144c42ba61

Try it without installing anything at **[thenotoriousjeremy.github.io/bindarr](https://thenotoriousjeremy.github.io/bindarr/)**. The demo runs the real frontend against sample data, so edits aren't saved and scanning is off (it needs a server).

---

## Features

- **Camera scanning** — photograph a card and the server identifies it from the image alone. Works for Magic and Pokémon.
- **Physical location tracking** — binders by page and slot (1–9), boxes by row and divider, with a page-flip binder view. Drag cards between pockets to arrange a binder, or file them by tapping on a phone.
- **Deck checkout** — reserve a deck's cards and get a checklist of exactly which slot each one sits in, then the same list in reverse when you put them back.
- **Search and bulk add** — search or browse a whole set with multi-select; pin a set and add by collector number one keystroke at a time.
- **Dashboard** — collection value, 7/30-day trends, rarity and type breakdowns, set completion.
- **Graded slabs** — record grader, grade and cert number per copy (PSA cert lookup fills them in), and give a slab its own value instead of the raw card's price.
- **Cards in 11 languages** — search, scan and record Japanese, Korean, Chinese, German, French, Spanish, Italian, Portuguese and Russian printings. A copy references the printing it actually is, so it shows the name and artwork on the card while staying searchable by its English name.
- **Exports and API** — CSV (TCGplayer-compatible) or JSON, plus a read-only API key for reading net worth from elsewhere.
- **Multi-user** — session-token auth, admin panel for users and roles, optional public share links.
- **11 UI languages**, community-translated.

Architecture, the scan pipeline, and the data model are in [PROJECT.md](PROJECT.md).

---

## Install

### Docker (recommended)

No clone, no build. Create a `docker-compose.yml`:

```yaml
services:
  bindarr:
    image: ghcr.io/thenotoriousjeremy/bindarr:latest
    container_name: bindarr
    restart: unless-stopped
    ports:
      - "3001:3001"   # HTTP  — point a reverse proxy here
      - "3443:3443"   # HTTPS — use this directly if you have no proxy (scanning needs it)
    environment: {}
      # All optional — see the table below.
      # - POKEMON_TCG_API_KEY=
      # - PUBLIC_BASE_URL=
      # - DEFAULT_ADMIN_PASSWORD=
      # - TRUST_PROXY=1
    volumes:
      - bindarr-data:/app/database

volumes:
  bindarr-data:
```

Start it:

```bash
docker compose up -d
```

Open `http://localhost:3001`. The first visit asks you to set a password for the
`admin` account and creates it right there — no password is ever written to the
logs. (If you set `DEFAULT_ADMIN_PASSWORD` instead, that same `admin` account is
created at startup and the first visit is a normal login screen.)

You can change the password later in Settings. Everything (database, backups, scan models and catalogs, TLS cert) lives in the `bindarr-data` volume.

Update with `docker compose pull && docker compose up -d`. Your volume is untouched.

To build from source instead, clone the repo and run `docker compose up -d` — the bundled [`docker-compose.yml`](docker-compose.yml) uses `build:` rather than `image:`.

#### Which port to use

Both ports serve the same app and the same database. Only the transport differs.

| Port | Use it when |
| --- | --- |
| `3001` (HTTP) | You have a reverse proxy (Caddy, NPM, Traefik, Tailscale Serve) terminating TLS in front, or you're on the host itself at `http://localhost:3001`. |
| `3443` (HTTPS) | You have no proxy and want to reach Bindarr from a phone. **Card scanning only works here** — browsers refuse camera access over plain HTTP to anything but `localhost`. |

Publish only the one you use. Behind a proxy, drop the `3443` line and set `TRUST_PROXY=1`.

The HTTPS certificate is self-signed and generated on first start into the volume, so your browser warns once per device (**Advanced → Proceed**; iOS Safari: **Show Details → Visit this website**). Mount a real certificate and set `SSL_CERT_PATH` + `SSL_KEY_PATH` to skip the warning.

#### Image tags

| Tag | Points at |
| --- | --- |
| `latest` | newest release — use this |
| `1.8`, `1.8.1` | a specific release, if you want to control upgrades |
| `edge` | newest `main` commit, including unreleased work |
| `sha-<short>` | one exact commit |

#### Environment variables

All optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port. |
| `HTTPS_PORT` | `3443` in the image | HTTPS port. Set to `""` for HTTP only. |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | — | Your own certificate instead of the generated self-signed one. |
| `DB_PATH` | `/app/database/bindarr.db` | SQLite file location. |
| `DEFAULT_ADMIN_PASSWORD` | — | Create the `admin` account with this password at startup instead of letting the first browser visit create the owner account. Only applied while the `users` table is empty — changing it later does nothing to an existing account. |
| `POKEMON_TCG_API_KEY` | — | Free key from [dev.pokemontcg.io](https://dev.pokemontcg.io/). Raises the Pokémon rate limit from 1,000 to 20,000 requests/day. |
| `PUBLIC_BASE_URL` | — | External URL behind a proxy, e.g. `https://cards.example.com`. Used for share links and auto-allowed as a CORS origin, so proxied logins work with just this. Also editable in the Admin panel. |
| `CORS_ORIGIN` | — | Extra allowed origins, comma-separated. Localhost and private-LAN origins are always allowed. |
| `ALLOW_REGISTRATION` | unset | `true` allows self-registration. Unset means invite-only: admins create accounts. |
| `TRUST_PROXY` | — | Number of proxy hops (usually `1`) when a reverse proxy terminates TLS, so rate limiting sees the real client IP. |
| `CV_MODEL_DIR` | `/app/database/models` in the image | Where the scan models and catalogs live. Must be on persistent storage, or an image update discards every catalog you built. |
| `CV_SCAN_GAP` | `0.10` | How far a match must stand above its runner-ups before it counts as an answer rather than "this card is not in the catalog". Lower accepts more guesses. |
| `BACKUP_INTERVAL_HOURS` | `24` | Automatic database snapshot interval. `0` disables. |
| `BACKUP_KEEP_LAST` | `10` | How many snapshots to retain. |

`GET /api/health` returns `200 {"status":"ok"}` with no auth and backs the image's `HEALTHCHECK`.

### Prebuilt server binary

If you'd rather not run Docker, every release ships a self-contained server. Download it from the [latest release](https://github.com/thenotoriousJeremy/bindarr/releases/latest), unpack, run, then open `http://localhost:3001`.

| OS | File | Run |
|----|------|-----|
| Windows | `Bindarr-Server-windows-x64.zip` | unzip, double-click `bindarr-server.exe` |
| Linux | `Bindarr-Server-linux-x64.tar.gz` | `tar xzf`, then `chmod +x bindarr-server && ./bindarr-server` |
| macOS (Apple Silicon) | `Bindarr-Server-macos-arm64.tar.gz` | `tar xzf`, then `chmod +x bindarr-server && ./bindarr-server` |

The first visit in a browser asks you to create the owner account. The SQLite file is created next to the binary. To set variables from the table above, create `app/backend/.env` before the first run — HTTPS is off by default here, so add `HTTPS_PORT=3443` if you want to scan from a phone.

### Mobile apps

`Bindarr-Android.apk` is attached to each release (allow "install from unknown sources"). iOS goes out through TestFlight. Both talk to a Bindarr server, so install one of the above first and point the app at it.

---

## Card scanning

Scanning is image-only — no OCR, no typing. Two things have to be in place, and
neither ships inside the app:

**1. The models.** Two small neural networks (~9.6 MB together) find the card in
the frame and turn its artwork into a fingerprint. They are AGPL-3.0 while Bindarr
is MIT, so they are fetched deliberately rather than bundled:

```bash
docker exec bindarr node scripts/fetch-models.mjs
```

(Running from source or the prebuilt binary: `node scripts/fetch-models.mjs` in
`backend/`.) Restart afterwards. Until they are there, the server says so at
startup and scanning returns a clear error instead of guesses.

**2. A catalog.** The fingerprint has to be compared against something. Build one
per game and language from **Admin → Catalogs**: it downloads that game's card
list and fingerprints every card's artwork — hours for a full English game, and
about 5 MB of output per 10,000 cards. Progress is live, stopping keeps what it
has, and resuming reuses it. `--catalogs` on the fetch command above grabs
prebuilt English Magic and Pokémon catalogs instead, which answer immediately but
only resolve cards your install has already seen.

Scanning is then the same whether or not you tell it which set you are feeding.
Naming the set just restricts the comparison to that set's cards, which is faster
and more accurate, and needs no preparation.

Coverage is only as good as the card data available for a language: the panel shows
what a catalog holds against what the provider claims exists, e.g. *3,297 of
16,192* for Japanese Pokémon, where the upstream data simply stops. A card outside
the catalog is reported as missing rather than guessed at, with the nearest matches
offered underneath.

The pipeline, its accuracy numbers, and the measurement harness are documented in
[PROJECT.md](PROJECT.md#image-identification-pipeline).

---

## Card values

Every price source Bindarr talks to — TCGplayer, Scryfall, Cardmarket — quotes the **raw** card. A PSA 10 sells for a multiple of that, so a graded copy needs its own number, and each copy can carry one: open the card, edit it, and set **Value for this copy**. That value replaces the market price everywhere — net worth, set totals, sorting by price, exports. Clear the field to go back to the card's own price.

For Pokémon slabs it can also be fetched. Put a [PokemonPriceTracker](https://www.pokemonpricetracker.com/api) key in **Settings → API Keys** and a **Fetch graded price** button appears on graded copies. It fills in what that card sells for on eBay at that grade — PSA, BGS or CGC, half grades included — and says how many sales the figure rests on. If the grade has no recorded sales it tells you which grades do, rather than guessing.

One card per press, never a background sweep: each lookup spends 2 of the free tier's 100 daily credits, and a sweep over a collection would spend a week's worth on one boot. Magic slabs have no source, so they stay hand-entered.

### Cards in other languages

Which marketplace can price a printing depends on where it is sold, so the source follows the card:

| Card | Priced from |
| --- | --- |
| Magic, any language | Scryfall — TCGplayer's USD price, or Cardmarket's EUR one when TCGplayer has no listing (most non-English printings) |
| Pokémon, English or Japanese | TCGplayer, via TCGCSV, in USD |
| Pokémon, other languages | the **English** printing's TCGplayer price, labelled as such — TCGplayer runs no German, Korean or Chinese catalogue |

Prices are stored in the currency they were quoted in and never converted — an exchange rate is a live number Bindarr has no source for — so each card shows its own symbol (`$4.50`, `€4.50`) and the card inspector names the marketplace. Collection totals sum the currencies as-is; `currencies` in the API response says when a total is mixed.

A price only exists once something fetched it. The Pokémon price sweep covers the sets you own cards from, so browsing a set you own nothing in shows `0.00` until a card from it lands in your collection.

## API access

For reading your collection from somewhere else — a finance tracker, a dashboard widget, a script — generate a key under **Settings → API Keys** and send it as a Bearer token:

```bash
curl -H "Authorization: Bearer <key>" http://localhost:3001/api/stats/networth
```

```json
{ "totalValue": 4210.55, "totalSpent": 2980.00, "gain": 1230.55, "gainPct": 41.3,
  "totalCards": 812, "uniqueEntries": 604,
  "byGame": { "pokemon": { "cards": 500, "value": 3100.20 }, "mtg": { "cards": 312, "value": 1110.35 } },
  "currencies": ["USD"], "asOf": "2026-08-17T17:55:40.898Z" }
```

The key never expires and is **read-only**: any request that is not a GET is refused, and admin endpoints are refused outright. Add `?game=pokemon` to scope the figures. `/api/stats` returns the full dashboard payload if you want the breakdowns too, and `/api/collection` returns every card. More than one entry in `currencies` means providers quoted in different currencies and the total sums them as-is.

Revoking is one click in the same panel; anything using the old key stops immediately.

## Arranging a binder

A container set to **Custom** order files by hand rather than by a sort scheme. Drag a card from the Unsorted queue into a pocket to file it, drag a filed card to another pocket to move it (drop it on an occupied pocket and the two swap), and drag one back to the Unsorted queue to take it out of the binder.

Dragging is mouse-only — on a phone a drag would fight the page-swipe, so touch files by tapping instead: turn on **Arrange**, tap the card, tap the pocket. Both routes go through the same placement rules, so a locked or full container refuses either way.

## Backup and restore

Everything is in one SQLite file (`DB_PATH`, in the `bindarr-data` volume under Docker).

Bindarr snapshots the database itself every 24 hours into a `backups/` folder beside it, keeping the last 10. That runs while the server is live and needs no downtime.

For an off-box copy, stop the container first so the WAL is checkpointed:

```bash
docker run --rm -v bindarr-data:/data -v "$PWD":/backup alpine cp /data/bindarr.db /backup/
```

Restore by dropping the file back into the volume with the container stopped. Individual users can also export and re-import their own collection as CSV or JSON from the app.

**Lost the admin password?** There's no self-service reset, and `DEFAULT_ADMIN_PASSWORD` will not change an existing account — it is only used when no accounts exist. Delete the database file to start fresh and create the owner account again.

> **Upgrading from before v1.5.0:** the database file was renamed `pokemon_cards.db` → `bindarr.db`. First start renames it automatically, sidecars included. Old `pokemon_cards.*.bak` backups still restore.

---

## Development

Node 18+ and npm 9+.

```bash
npm run install:all
npm run dev
```

Frontend at `https://localhost:5173` (self-signed HTTPS, so the camera works), backend at `http://localhost:3001`.

To test scanning from a phone, put it on the same Wi-Fi and open `https://<your-computer-ip>:5173`, then accept the certificate warning (**Advanced → Proceed**).

Tests: `npm test`. Frontend lint (matches CI, fails on any warning): `cd frontend && npm run lint`. Code layout and conventions: [PROJECT.md](PROJECT.md).

---

## Translating

Bindarr speaks English, Brazilian Portuguese, French, German, Italian, Japanese, Korean, Russian, Simplified Chinese, Traditional Chinese and Spanish. More are welcome, and it doesn't require writing code: copy [`frontend/src/locales/en.json`](frontend/src/locales/en.json), translate the text after each `:`, open a pull request. Partial files are fine — anything missing falls back to English key by key.

Details, including placeholder and plural rules, in [docs/TRANSLATING.md](docs/TRANSLATING.md).

This is the language of the *app*. The language a card was printed in is a separate per-card field.

---

## License

[MIT](LICENSE).
