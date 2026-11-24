# Install

- [Docker](#docker)
- [Unraid](#unraid)
- [Prebuilt server binary](#prebuilt-server-binary)
- [Mobile apps](#mobile-apps)
- [From source](#from-source)

## Docker

```yaml
services:
  bindarr:
    image: ghcr.io/thenotoriousjeremy/bindarr:latest
    container_name: bindarr
    restart: unless-stopped
    ports:
      - "3001:3001"   # HTTP
      - "3443:3443"   # HTTPS
    environment:
      - TRUST_PROXY=1   # only behind a reverse proxy
    volumes:
      - bindarr-data:/app/database

volumes:
  bindarr-data:
```

```bash
docker compose up -d
```

Everything Bindarr keeps (database, backups, scan models and catalogs, uploaded art, TLS certificate) lives in the `bindarr-data` volume. To update, run `docker compose pull && docker compose up -d`.

### First sign-in

The first visit creates the `admin` account. It asks for a setup code, so nobody who finds a new server before you can claim it. The code is in the log while no account exists:

```bash
docker logs bindarr 2>&1 | grep SETUP
```

A restart makes a new code; set `SETUP_CODE` to choose your own. A browser on the same machine as the server doesn't need it, but through Docker's port mapping or a reverse proxy you always do. Setting `DEFAULT_ADMIN_PASSWORD` creates the account at startup instead.

### Ports and HTTPS

| Port | Use it when |
| --- | --- |
| `3001` (HTTP) | A reverse proxy (Caddy, Traefik, Nginx Proxy Manager, Tailscale Serve) terminates TLS in front of Bindarr, or you browse on the host itself. |
| `3443` (HTTPS) | You have no proxy and want to use a phone. Browsers only allow the camera over HTTPS, so **scanning needs this** (or a proxy). |

Publish only the one you use. Behind a proxy, drop `3443` and set `TRUST_PROXY=1`.

The HTTPS certificate is self-signed, so each device warns once (**Advanced → Proceed**; on iOS, **Show Details → Visit this website**). To use your own, mount it and set `SSL_CERT_PATH` and `SSL_KEY_PATH`.

### Image tags

| Tag | Points at |
| --- | --- |
| `latest` | The newest release. |
| `1.10`, `1.10.3` | A specific release. |
| `edge` | The newest `main` commit, including unreleased work. |
| `sha-<short>` | One exact commit. |

`GET /api/health` answers `200` without auth and backs the image's healthcheck.

## Unraid

[`unraid/bindarr.xml`](../unraid/bindarr.xml) is a Docker template for Unraid. To use it before it's in Community Applications, save it to `/boot/config/plugins/dockerMan/templates-user/my-bindarr.xml` on the server, then pick **Bindarr** under **Docker → Add Container → Template**. Data goes to `/mnt/user/appdata/bindarr`, and [First sign-in](#first-sign-in) applies as above (the setup code is in the container's log).

## Prebuilt server binary

Each [release](https://github.com/thenotoriousJeremy/bindarr/releases/latest) includes a self-contained server:

| OS | File | Run |
| --- | --- | --- |
| Windows | `Bindarr-Server-windows-x64.zip` | Unzip, then run `bindarr-server.exe`. |
| Linux | `Bindarr-Server-linux-x64.tar.gz` | `tar xzf`, then `chmod +x bindarr-server && ./bindarr-server`. |
| macOS (Apple Silicon) | `Bindarr-Server-macos-arm64.tar.gz` | `tar xzf`, then `chmod +x bindarr-server && ./bindarr-server`. |

Open `http://localhost:3001`. Settings go in `app/backend/.env` (copy `app/backend/.env.example`). HTTPS is off by default here; add `HTTPS_PORT=3443` to scan from a phone.

Data lives in `app/backend/database/` and the scan models in `app/backend/data/models/`. Keep both folders when you replace the binary with a newer release.

## Mobile apps

The Android APK is attached to each release (allow installing from unknown sources). The iOS app is on TestFlight.

At sign-in, choose:

- **My server**: connect to a Bindarr server you run.
- **This device**: run Bindarr inside the app with no server. The collection stays on the phone, so export a full backup from Settings now and then; importing it on a server later moves the collection there. Share links, other accounts, trades between members and notifications need a server. See [MOBILE.md](../MOBILE.md#device-mode-no-server).

If your server's certificate comes from a private CA, install that CA on the phone first:

- **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
- **iOS:** install the profile, then turn on full trust for it under Settings → General → About → Certificate Trust Settings.

Riftbound is hidden in the store builds of the app: Riot's fan policy doesn't allow its cards in App Store or Google Play apps.

## From source

```bash
git clone https://github.com/thenotoriousJeremy/bindarr.git
cd bindarr
docker compose up -d   # the bundled docker-compose.yml builds the image
```

Or without Docker, with Node 22.12 or later (Node 24 recommended):

```bash
npm run install:all
npm run build:frontend
npm start
```

Native modules (`sqlite3`, `sharp`, `onnxruntime-node`) are built for the machine that installs them, so install on the machine that runs the server.
