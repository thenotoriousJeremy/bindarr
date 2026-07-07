# Pokedexrr 🎴

Pokedexrr is a self-hostable, mobile-friendly full-stack web application designed for Pokémon card collectors. It allows you to scan your physical cards using your phone's camera, track real-time market valuations, organize card placements in physical binders and boxes, view rich analytics, and export your database for external trackers.

---

## ✨ Features

- **📱 Phone-to-Camera OCR Scanning**: Uses client-side video cropping and **Tesseract.js** to scan card Names and Collector Numbers (e.g. `58/102`) directly from your phone's browser—no heavy server-side AI required. Supports **English**, **Japanese**, and **Vintage** card layouts with automatic name translation.
- **📊 Interactive Dashboard & Metrics**: Track total collection value, net worth trends (24H / 7D / 30D), average card value, holo print rates, energy type distributions (pie chart), rarity distributions, and set completion milestones.
- **🗺️ Real-world Location Coordinator**: Assign physical coordinate mappings to your cards so you can locate them instantly:
  - **Binders**: Maps by Binder Name, Page Number, and Slot (1-9). Features a double-page book view with 3D page-flip animations and multi-card slot stacking.
  - **Storage Boxes**: Maps by Box Name, Row ID/Letter, and Divider Section.
- **🇯🇵 Japanese Card Support**: OCR scans Japanese card names (hiragana, katakana, kanji), automatically translates them to English for API lookups, and displays them in their native Japanese names across the app.
- **💾 Universal Database Exports**: One-click downloads of your complete database in CSV (TCGplayer format compatible) or JSON.
- **🔐 Multi-User Auth**: Session-token authentication (opaque random tokens stored in a server-side `sessions` table, sent as a `Bearer` header) with admin controls for managing users and roles.
- **🐳 100% Self-Hostable & Portable**: Single-container Docker build with a local SQLite database that mounts to a persistent volume.
- **⚡ CI/CD Automation**: GitHub Actions workflow to auto-build and publish the container image to GitHub Container Registry (GHCR).

---

## 🛠️ Tech Stack

- **Frontend**: React, Vite, Recharts, Lucide React, Tesseract.js, Canvas Confetti
- **Backend**: Node.js, Express, SQLite (`sqlite3` module), Axios, Helmet, express-rate-limit
- **Deployment**: Docker, Docker Compose, GitHub Actions

---

## 🚀 Quick Start (Development)

### Prerequisites
- Node.js (v18+)
- npm (v9+)

### Installation
1. Clone this repository.
2. Install dependencies for the root, frontend, and backend packages:
   ```bash
   npm run install:all
   ```

### Running the App
Start both the React development server and the Express API server concurrently:
```bash
npm run dev
```
- **Frontend client**: `https://localhost:5173` (Runs over local HTTPS to allow camera access)
- **Backend API server**: `http://localhost:3001`

> [!IMPORTANT]
> **Mobile Camera HTTPS Requirement**: Modern mobile browsers (Safari, Chrome, Firefox) restrict video camera access (`getUserMedia`) to **Secure Contexts (HTTPS)** only. 
> 
> To test on your mobile phone:
> 1. Connect your phone and computer to the same Wi-Fi network.
> 2. Open **`https://<your-computer-ip>:5173`** in your mobile browser.
> 3. Your browser will display a warning because the local developer SSL certificate is self-signed. Tap **Advanced** (or *Show Details*) and select **Proceed/Trust** (e.g. *Proceed to 192.168.x.x (unsafe)*). The app will load, and the camera will initialize successfully!

#### Alternative: Chrome Developer Flags (HTTP)
If you prefer not to use self-signed HTTPS in development:
1. Open Google Chrome on your phone.
2. Navigate to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
3. Enable the flag and enter your computer's IP: `http://<your-computer-ip>:5173` (and port `3001` for container testing).
4. Relaunch Chrome. The browser will treat this address as secure, allowing camera access.


---

## 🔑 First-Time Sign In

On its **first startup**, Pokedexrr creates a default administrator account and prints the credentials to the server console (the terminal running `npm run dev` / `npm start`, or `docker-compose logs`).

Look for these lines in the startup logs:
```text
Created default admin user. ID: 1
  username: admin
  password: <generated-password>
Log in and change this password immediately via Settings.
```

- **Username**: `admin`
- **Password**:
  - If you set the `DEFAULT_ADMIN_PASSWORD` environment variable before first startup, that value is used.
  - Otherwise a random password is generated and printed **once** in the logs above. Copy it before clearing your terminal.

> [!IMPORTANT]
> The password is only printed on the run that creates the account (when the database is first initialized). If you miss it and did not set `DEFAULT_ADMIN_PASSWORD`, delete the SQLite database file so it is recreated on the next startup, or set `DEFAULT_ADMIN_PASSWORD` and recreate the database.

After logging in, open **Settings** and change the password. Additional users can self-register from the login screen (they are created with the `member` role); an `admin` can manage users and roles from the **Admin** panel.

---

## 🐳 Docker Deployment (Production)

Pokedexrr is packaged as a single-container multi-stage Docker build, serving the compiled frontend directly from the Node server.

### Run with Docker Compose
1. Ensure Docker is running.
2. Run the following command in the root folder:
   ```bash
   docker-compose up -d
   ```
3. Open `http://localhost:3001` in your browser. All database files are persisted in the `pokedexrr-data` Docker volume.

### Environment variables (`.env`)
You can configure Pokedexrr by passing these environment variables in your container configuration:
- `PORT` (Default: `3001`) - The port the server runs on.
- `DB_PATH` (Default: `/app/database/pokemon_cards.db`) - Location of the SQLite database.
- `POKEMON_TCG_API_KEY` (Optional) - Your API key from [pokemontcg.io](https://pokemontcg.io). While Pokedexrr works without one, adding a free key increases TCG API rate limits (from 20k to 50k requests/day).
- `DEFAULT_ADMIN_PASSWORD` (Optional) - Sets a known password for the auto-created `admin` account on first startup. If unset, a random password is generated and printed once to the server logs (see [First-Time Sign In](#-first-time-sign-in)).
- `CORS_ORIGIN` (Optional) - Comma-separated list of origins allowed to call the API. Defaults to the Vite dev server + same-origin. Set to your real domain when deploying.

### Health check
The server exposes `GET /api/health` (no auth). It returns `200 {"status":"ok"}` when the app and database are reachable, `503` otherwise. The Docker image already wires this into a `HEALTHCHECK`.

---

## 💾 Backup, Restore & Recovery

**Backup.** All state lives in the single SQLite file (the `pokedexrr-data` volume in Docker, or `DB_PATH` locally). Two options:
- **File-level:** copy the DB file while the container is stopped, e.g. `docker run --rm -v pokedexrr-data:/data -v "$PWD":/backup alpine cp /data/pokemon_cards.db /backup/`. (The app runs in WAL mode; stop the container first so the `-wal`/`-shm` files are checkpointed.)
- **Per-user data:** each user can also export their own collection from the app as CSV or JSON (Collection → Export). This is portable to other trackers but does not include other users or app settings.

**Restore.** Stop the container, drop the backed-up `pokemon_cards.db` into the volume, start again. Or use the in-app Import (CSV/JSON) to restore a single user's collection.

**Lost admin password.** The initial `admin` password is printed once, on the run that first creates the database. If you lose it and did not set `DEFAULT_ADMIN_PASSWORD`, either set that variable and recreate the database, or delete the DB file so a fresh admin is generated on next startup. There is no self-service password reset.

---

## 📂 Project Structure

```text
/pokedexrr
  ├── backend/
  │     ├── src/
  │     │     ├── db.js              # SQLite schema, migrations & DB connection
  │     │     ├── server.js          # Express app: middleware, routes, /api/health
  │     │     ├── tcgApi.js          # Pokémon TCG API proxy, cache & price updates
  │     │     ├── middleware/
  │     │     │     └── auth.js       # Session-token auth, admin guard, rate limiters
  │     │     ├── routes/            # auth, admin, collection, sets, decks, shared
  │     │     └── utils/             # compartmentSort (filing engine), priceHelpers, authHelpers
  │     ├── test/                    # Framework-free smoke tests (npm test)
  │     └── package.json
  ├── frontend/
  │     ├── src/
  │     │     ├── components/        # Dashboard, CameraScanner, CardSearch, LocationManager,
  │     │     │                      #   CollectionList, AdminPanel, Settings, DeckBuilder,
  │     │     │                      #   SharedCollection, PriceHistoryChart, CardInspectorModal
  │     │     ├── utils/             # sorting, pricing, translation & printing helpers
  │     │     ├── App.jsx            # Routing tab controller + fetch/auth interceptor
  │     │     ├── index.css          # Core premium dark styling
  │     │     └── main.jsx
  │     ├── .eslintrc.cjs
  │     ├── package.json
  │     └── vite.config.js
  ├── Dockerfile                     # Multi-stage build, runs as non-root, HEALTHCHECK
  ├── docker-compose.yml
  ├── .dockerignore
  └── .github/
        └── workflows/
              └── docker-build.yml   # verify (backend tests) -> build & push to GHCR
```
