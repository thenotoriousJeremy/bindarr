# Mobile apps (iOS + Android)

The native apps are the existing React frontend wrapped with [Capacitor](https://capacitorjs.com).
No separate codebase: every web change flows into both apps on the next build.

The sign-in screen (native app only) offers two ways to run:

- **My server** — the app asks for a **Server URL** and stores it locally. All
  `/api` calls are routed to that server through Capacitor's native HTTP layer,
  which also sidesteps WebView CORS — no backend CORS changes needed. See
  [Connecting to a server](#connecting-to-a-server) for the certificate the
  phone has to trust.
- **This device** — no server at all. The app runs Bindarr's own backend inside
  itself, against a SQLite database on the phone. See [Device mode](#device-mode-no-server).

## Connecting to a server

The app only talks HTTPS (Android refuses plain `http://` outright), and unlike a
browser it cannot click through a certificate warning. So the phone must already
trust the server's certificate:

- **A certificate from a public CA** — a reverse proxy with Let's Encrypt in front
  of Bindarr, or `SSL_CERT_PATH`/`SSL_KEY_PATH` pointing at one. This is the
  setup that works everywhere, LAN included, if you give the server a real
  hostname (a DNS-01 challenge issues one for a name that only resolves on your LAN).
- **Your own CA, installed on the phone** — issue the server's certificate from a
  private CA and install the CA certificate. Android: Settings → Security →
  Encryption & credentials → Install a certificate → CA certificate (the app
  trusts user-installed CAs, `res/xml/network_security_config.xml`). iOS: install
  the profile, then turn it on under Settings → General → About → Certificate
  Trust Settings.

Bindarr's built-in self-signed certificate (`HTTPS_PORT` with no `SSL_CERT_PATH`)
is meant for a desktop browser's click-through. It is not a CA certificate, names
only the addresses the server had when it was made, and is replaced every 397
days, so trusting it on a phone is not a supported setup; use one of the two
above for the apps. The server URL is what the certificate names:
`https://cards.example.com`, or `https://192.168.1.50:3443` only if that address
is in the certificate.

All `/api` requests go through native HTTP, which is not subject to WebView CORS.
The one thing loaded straight into the page from the server, contributed card
art, is fetched the same way and shown as a blob URL (`components/CardImage.jsx`).

## Layout

- `frontend/capacitor.config.json` — app id (`com.bindarr.app`), name, `CapacitorHttp` on, SQLite plugin config.
- `frontend/src/apiBase.js` — native fetch shim: prepends the server URL, or hands `/api` to the device backend.
- `frontend/src/device/` — device mode's runtime (the bundled backend lands in `generated/`).
- `frontend/native-detector/` — the app's own Capacitor plugin: the live scanner's corner model on native ONNX Runtime. See [Native card detection](#native-card-detection).
- `backend/src/embedded/` — the backend's composition root for device mode, and its stand-ins for Node modules.
- `frontend/android/`, `frontend/ios/` — native projects (committed; build output is git-ignored).

## Native card detection

The scanner's live outline comes from the corner model (fastweb-single, stored as
`cornelius.onnx`), run on every camera frame. On the web it runs in
onnxruntime-web on ONE wasm thread: the WebView is never cross-origin isolated,
so wasm gets no threads, and wasm costs about twice native code on the same core.
That was ~150 ms a frame on a phone.

In the app it runs through native ONNX Runtime instead, in the
`bindarr-native-detector` plugin (`frontend/native-detector/`, a local `file:`
dependency that `npx cap sync` wires into both projects like any other plugin):

- Android: `onnxruntime-android` (Java API), CPU EP on up to 4 threads, or XNNPACK.
- iOS: `onnxruntime-swift-package-manager`, CPU EP on up to 4 threads, or CoreML.
- On first load the plugin times each engine on the phone itself and keeps the
  fastest; the console logs the timings, and the scanner's debug row (scan
  settings) shows `native-cpu`, `native-xnnpack` or `native-coreml`. To pin one
  for comparison, set `localStorage['bindarr.nativeDetectorEngine']` to `cpu`,
  `xnnpack` or `coreml` (`auto` is the default) and reopen the scanner.
- Frames cross the bridge as a ~30 KB JPEG of the 384×384 crop, not raw pixels.
  Everything after inference (the confidence gate, corner order, focus score, card
  signature) is `src/utils/detectResult.js`, shared with the wasm worker.
- `src/utils/cardDetector.js` uses the plugin whenever it is present, and drops
  to the wasm worker for the rest of that scanner session if it fails. On the
  web, and in app builds without the plugin, the worker is all there is.

The model still comes from the same place (the server's `/models/cornelius.onnx`,
or device mode's download), handed to the plugin once per app launch and kept
for the next scanner open. Capture-time dewarping and device mode's milo pass
(`src/device/scanEngine.js`) still run in wasm.

## Device mode (no server)

Picking **This device** runs the same Express route modules a server runs, inside
the app's WebView. There is no port and no second codebase: every `/api` request
the UI makes is answered in-process.

- `backend/src/embedded/index.js` mounts the same route table as `server.js`
  (`backend/src/routes/mounts.js`: every `/api` router once, with what the phone
  does in its place). `frontend/scripts/build-device-backend.mjs` bundles it into
  the app before every `vite dev` / `vite build`, swapping the Node modules a
  phone lacks for the stand-ins listed in `backend/src/embedded/aliases.js` (a
  small Express-style router, `fs`/`path`/`crypto` shims, and a `sqlite3` adapter).
  A route added to the table either runs on the phone too or answers 501 there;
  `backend/test/apimounts.test.js` fails on one that does neither.
- The database is native SQLite through `@capacitor-community/sqlite`
  (`frontend/src/utils/deviceSqlite.js` adapts it to what `db.js` expects), so
  `db.js` and its migrations run unchanged. The file lives in the app's private
  storage (iOS: `Library/CapacitorDatabase`), which the OS includes in device
  backups. The downloaded scan data is kept out of them (below).
- A WebView has no async context, so `db.js` cannot tell a transaction's own
  statements from anyone else's there. Requests and the background jobs therefore
  take turns, first come first served (`backend/src/embedded/units.js`): every job
  `backend/src/embedded/index.js` schedules (set lists, price sweeps, exchange
  rates, the trash purge, TCGCSV, the product map) runs as one unit from start to
  end, and lets go while it downloads (any provider request it makes through axios)
  and between its transactions. A request's own provider calls happen
  inside its turn, so a slow provider delays the next request, up to that
  provider's timeout.
- Card search, set lists and prices go straight from the phone to the providers,
  through the same native HTTP layer server mode uses. While the app is open:
  prices on the server's schedule, exchange rates daily, expired trash purged
  daily, set lists weekly. TCGCSV (the Pokémon price data, well over a thousand
  requests per new version) syncs at most weekly on a phone, when the Pokémon
  scan download builds the product map, and the first time a game served from
  TCGplayer's catalogue (Yu-Gi-Oh!, One Piece...) is opened; in between, prices
  come from the last version synced. A game's first use writes its card list in the
  background too: until it is done, its search and set list answer with what is
  cached and say so (`X-Catalogue-Pending`), and the app shows "downloading" rather
  than "no matches". Leaving device mode stops these jobs.
- There is one account and no login. The phone's owner is the `admin` user, with a
  session that never expires.

What needs a server answers 501 "not on this device" in device mode, and is hidden
or explained in the UI: **share links**, **other accounts and SSO**, **server
backups and scan catalogs** (Admin), **contributed card art** and **uploaded binder
artwork** (both decoded with `sharp`), **notifications** and the **health probe**.
Instance settings (Pokémon data provider, Magic price source, refresh interval)
move from Admin into Settings.

### Scanning on the phone

Cards can be scanned after a one-time download (Add Cards → Scan, or Settings →
This Device): the two models (~8 MB, AGPL-3.0, fetched only when the owner presses
the button, from the same pinned, checksummed Hugging Face files
`backend/scripts/fetch-models.mjs` uses) and that game's catalog. The catalog is
Bindarr's own, from the weekly `scan-catalogs` release (PROJECT.md, "Published
catalogs"): Magic ~33 MB, Pokémon ~8 MB, the others smaller, after which the app
checks once a day at launch and downloads only the new cards. A phone with no
catalog installed asks GitHub for nothing until the scanning setup is opened.
When the release cannot be reached, the model author's dated snapshot is
downloaded instead (Magic ~56 MB, Pokémon ~13 MB, Yu-Gi-Oh! ~21 MB; Riftbound has
none). Pokémon's catalog names cards by TCGdex id, so it is used only while the
phone takes its Pokémon cards from TCGdex; otherwise the snapshot is offered.

- `frontend/src/device/scanAssets.js` downloads with `@capacitor/file-transfer`
  into the app's private storage, checks each file's exact size and SHA-256
  (WebCrypto, or `src/utils/sha256.js` in a WebView without it), and reads files
  back through the WebView's local server rather than across the bridge. The
  release's index and manifests are read with a size cap (`src/utils/cappedJson.js`).
  Release segments are applied with the backend's own
  `utils/catalogSegments.js`, handed over by the bundle. The files
  stay out of the phone's backups, since they can be downloaded again and would
  crowd out the database: on iOS they live in `Library/NoCloud` (an install that
  downloaded them into Documents has them moved on its next launch), and on
  Android `res/xml/backup_rules.xml` and `data_extraction_rules.xml` leave
  `files/scan/` out of the cloud backup.
- The models run in onnxruntime-web, whose wasm needs WebAssembly SIMD: iOS 16.4
  or later (any current Android WebView has it). Without it the download is
  refused before anything is fetched, and a scan whose model fails on the phone
  says so instead of asking for the download again.
- `frontend/src/device/scanEngine.js` does the server's half of a scan in the
  WebView: resize the scanner's crop to 448 (or find the corners with cornelius
  and dewarp a whole frame), then run milo with onnxruntime-web.
- `runtime.js` swaps the photo in `/api/scan-match` and `/api/search` bodies for
  that embedding. The route accepts `embedding` in place of `image`, and
  `cvScan.setSource()` hands it the downloaded catalogs, so the sweep, the
  not-in-catalog gate and naming the card are the server's own code.
- A release catalog names cards by Bindarr card id. The model author's Pokémon
  snapshot names them by TCGplayer product id, so after that download the product
  map is built from TCGCSV in the background, as on a server.

A card newer than the catalog cannot be scanned until the next weekly update (a
snapshot never gets one); it is reported as not in the catalog rather than
matched to something else.

### Backups and moving to a server

Settings → Collection Backup & Data → **Export full backup** saves the whole account
(storage and each copy's place in it, decks, lists, notes, sealed product and the
recipes it follows, deals recorded with people outside Bindarr, and the card data and price
history behind them) through the share sheet. **Import Backup** recognises the file
and restores it, replacing what the account has. The same file restores on a
server, which is how a collection moves off the phone (`routes/backup.js`). The
CSV/JSON exports remain for spreadsheets and other apps. Files for the share sheet
are written to the app's cache in slices (`src/utils/saveFile.js`) and deleted
afterwards; the next export clears anything an interrupted one left.

Switching back: Settings → This Device → **Connect to a server instead**. The
on-device collection stays where it is; choosing **This device** again reopens it.

### Trying device mode in a browser

```bash
cd frontend
VITE_DEVICE_WEB=1 npm run dev
```

The sign-in screen then offers **This device** on the web too. A desktop browser
has no native SQLite, so `src/device/webStore.js` stands in for the plugin over
sql.js (kept in IndexedDB). In a browser, provider requests are subject to CORS,
which native HTTP on a phone is not: a provider that sends no CORS headers fails
there (TCGCSV is read from the project's GitHub mirror, which does send them).
The share sheet only exists on a phone. With the flag set the dev server needs no
backend: it serves `/ort` itself and proxies nothing.

`backend/test/embedded.test.js` covers the device backend itself,
`devicelock.test.js` the turns requests and background jobs take,
`devicejobs.test.js` the background jobs, `apimounts.test.js` the route table, and
`frontend/src/utils/deviceSqlite.test.js` the plugin adapter; all of them run in
the normal test suites.

## Local build

Node 22.12 or later and npm 10 or later (Vite 8 and the Capacitor CLI refuse
anything older); Node 24 is what CI and the release builds use. Android Studio for
Android, Xcode on macOS for iOS.

```bash
cd frontend
npm ci
npm run build
npx cap sync            # copies dist/ into both native projects
npx cap open android    # opens Android Studio
npx cap open ios        # opens Xcode (macOS only)
```

## Automated releases

`.github/workflows/mobile-release.yml` runs on every `v*` tag push (same trigger
as the Docker image) and on manual `workflow_dispatch`. It builds:

- **Android** -> `.apk` (signed release if the keystore secrets are set, otherwise
  a debug-signed APK so builds work before you set anything up).
- **iOS** -> App Store / TestFlight-signed `.ipa` (only when the Apple signing
  secrets are present; the job self-skips if not).

On a **`v*` tag** it also uploads to the stores: Android `.aab` -> Google Play
**internal** track, iOS `.ipa` -> **TestFlight**. Both packages are additionally
attached to the GitHub Release.

On a manual **`workflow_dispatch`** it only builds and uploads workflow artifacts
— it never touches a store. Use dispatch to test builds.

Version name comes from the tag (`v1.4.0` -> `1.4.0`); the build/version code is
the workflow run number (monotonic, satisfies both stores' "must increase" rule).

Cut a release:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

## One-time setup (required secrets)

Add these under **Settings -> Secrets and variables -> Actions**.

Without the Android keystore secrets the workflow builds a **debug** APK only
(no `.aab`, no Play upload). With them it builds a signed `.aab`. Without the
Apple secrets the iOS job self-skips.

### Android

| Secret | How to get it |
|--------|---------------|
| `ANDROID_KEYSTORE_BASE64` | base64 of an upload keystore (`.p12`/`.jks`) — generate with openssl or keytool |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password you chose |
| `ANDROID_KEY_ALIAS` | key alias (e.g. `bindarr`) |
| `ANDROID_KEY_PASSWORD` | key password (same as keystore password for a `.p12`) |
| `PLAY_SERVICE_ACCOUNT_JSON` | Play Console -> Setup -> API access -> service account JSON key with release permission |

Back up the keystore — losing it means you can never update the Play listing.
The **first** `.aab` upload for a new package must be done manually in the Play
Console (create the app + one internal release); CI updates it after.

### iOS

Requires the paid Apple Developer Program (you are enrolled).

| Secret | How to get it |
|--------|---------------|
| `IOS_CERTIFICATE_BASE64` | Apple Distribution cert as `.p12`, base64 |
| `IOS_CERTIFICATE_PASSWORD` | password set when exporting the `.p12` |
| `IOS_PROVISIONING_PROFILE_BASE64` | an **App Store Connect** distribution profile for `com.bindarr.app`, base64 |
| `IOS_PROVISIONING_PROFILE_NAME` | the profile's exact name |
| `APPLE_TEAM_ID` | 10-char Team ID |
| `ASC_KEY_ID` | App Store Connect -> Users and Access -> Integrations -> Keys -> key ID |
| `ASC_ISSUER_ID` | same page, the issuer ID (shared across keys) |
| `ASC_API_KEY_BASE64` | base64 of the downloaded `AuthKey_*.p8` (App Manager role) |

An app record for `com.bindarr.app` must exist in App Store Connect before the
first TestFlight upload.
