# PokeKeep 🎴

PokeKeep is a self-hostable, mobile-friendly full-stack web application designed for Pokémon card collectors. It allows you to scan your physical cards using your phone's camera, track real-time market valuations, organize card placements in physical binders and boxes, view rich analytics, and export your database for external trackers.

---

## ✨ Features

- **📱 Phone-to-Camera OCR Scanning**: Uses client-side video cropping and **Tesseract.js** to scan card Names and Collector Numbers (e.g. `58/102`) directly from your phone's browser—no heavy server-side AI required.
- **📊 Interactive Dashboard & Metrics**: Track total collection value, investment spend, return on spend (ROI), card counts, energy type distributions (pie chart), rarity distributions, and set completion milestones.
- **🗺️ Real-world Location Coordinator**: Assign physical coordinate mappings to your cards so you can locate them instantly:
  - **Binders**: Maps by Binder Name, Page Number, and Slot (1-9).
  - **Storage Boxes**: Maps by Box Name, Row ID/Letter, and Divider Section.
- **💾 Universal Database Exports**: One-click downloads of your complete database in CSV (TCGplayer format compatible) or JSON.
- **🐳 100% Self-Hostable & Portable**: Single-container Docker build with a local SQLite database that mounts to a persistent volume.
- **⚡ CI/CD Automation**: GitHub Actions workflow to auto-build and publish the container image to GitHub Container Registry (GHCR).

---

## 🛠️ Tech Stack

- **Frontend**: React, Vite, Recharts, Lucide React, Tesseract.js, Canvas Confetti
- **Backend**: Node.js, Express, SQLite (`sqlite3` module), Axios
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

## 🐳 Docker Deployment (Production)

PokeKeep is packaged as a single-container multi-stage Docker build, serving the compiled frontend directly from the Node server.

### Run with Docker Compose
1. Ensure Docker is running.
2. Run the following command in the root folder:
   ```bash
   docker-compose up -d
   ```
3. Open `http://localhost:3001` in your browser. All database files are persisted in the `pokekeep-data` Docker volume.

### Environment variables (`.env`)
You can configure PokeKeep by passing these environment variables in your container configuration:
- `PORT` (Default: `3001`) - The port the server runs on.
- `DB_PATH` (Default: `/app/database/pokemon_cards.db`) - Location of the SQLite database.
- `POKEMON_TCG_API_KEY` (Optional) - Your API key from [pokemontcg.io](https://pokemontcg.io). While PokeKeep works without one, adding a free key increases TCG API rate limits (from 20k to 50k requests/day).

---

## 📂 Project Structure

```text
/pokedexrr
  ├── backend/
  │     ├── src/
  │     │     ├── db.js          # SQLite Schema & DB connection
  │     │     ├── server.js      # Express API Server
  │     │     └── tcgApi.js      # Pokémon TCG API proxy & cache
  │     └── package.json
  ├── frontend/
  │     ├── src/
  │     │     ├── components/    # Reusable Dashboard, Scanner, Search, Locations, and Collection views
  │     │     ├── App.jsx        # Routing tab controller
  │     │     ├── index.css      # Core premium dark styling
  │     │     └── main.jsx
  │     ├── package.json
  │     └── vite.config.js
  ├── Dockerfile
  ├── docker-compose.yml
  └── .github/
        └── workflows/
              └── docker-build.yml
```
