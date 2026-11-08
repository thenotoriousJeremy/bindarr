# Mobile apps (iOS + Android)

The native apps are the existing React frontend wrapped with [Capacitor](https://capacitorjs.com).
No separate codebase: every web change flows into both apps on the next build.

The sign-in screen (native app only) offers two ways to run:

- **My server** — the app asks for a **Server URL** and stores it locally. All
  `/api` calls are routed to that server through Capacitor's native HTTP layer,
  which also sidesteps WebView CORS — no backend CORS changes needed.
- **This device** — no server at all. The app runs Bindarr's own backend inside
  itself, against a SQLite database on the phone. See [Device mode](#device-mode-no-server).

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

- `backend/src/embedded/index.js` mounts the routers the way `server.js` does.
  `frontend/scripts/build-device-backend.mjs` bundles it into the app before
  every `vite dev` / `vite build`, swapping the Node modules a phone lacks for
  the stand-ins listed in `backend/src/embedded/aliases.js` (a small Express-style
  router, `fs`/`path`/`crypto` shims, and a `sqlite3` adapter).
- The database is native SQLite through `@capacitor-community/sqlite`
  (`frontend/src/utils/deviceSqlite.js` adapts it to what `db.js` expects), so
  `db.js` and its migrations run unchanged. The file lives in the app's private
  storage (iOS: `Library/CapacitorDatabase`), which the OS includes in device
  backups.
- Card search, set lists and prices go straight from the phone to the providers,
  through the same native HTTP layer server mode uses. Prices refresh on the
  server's schedule while the app is open; set lists refresh weekly.
- There is one account and no login. The phone's owner is the `admin` user, with a
  session that never expires.

What needs a server, and is hidden or explained in device mode: **share links**,
**other accounts and SSO**, **server backups**, **custom card art**, and **scanning
Lorcana cards**. Instance settings (Pokémon data provider, Magic price source,
refresh interval) move from Admin into Settings.

### Scanning on the phone

Magic and Pokémon cards can be scanned after a one-time download (Add Cards → Scan,
or Settings → This Device): the two models (~8 MB, AGPL-3.0, fetched only when the
owner presses the button) and that game's published catalog (Magic ~56 MB, Pokémon
~13 MB), from the same Hugging Face files `backend/scripts/fetch-models.mjs` uses.
Lorcana has no published catalog; servers build theirs with native image code.

- `frontend/src/device/scanAssets.js` downloads with `@capacitor/file-transfer`
  into the app's private storage, checks each file's exact size, and reads files
  back through the WebView's local server rather than across the bridge.
- `frontend/src/device/scanEngine.js` does the server's half of a scan in the
  WebView: resize the scanner's crop to 448 (or find the corners with cornelius
  and dewarp a whole frame), then run milo with onnxruntime-web.
- `runtime.js` swaps the photo in `/api/scan-match` and `/api/search` bodies for
  that embedding. The route accepts `embedding` in place of `image`, and
  `cvScan.setSource()` hands it the downloaded catalogs, so the sweep, the
  not-in-catalog gate and naming the card are the server's own code.
- The Pokémon catalog names cards by TCGplayer product id, so the product map is
  built from TCGCSV in the background after that download, as on a server.

Catalogs are dated snapshots: a card printed after one cannot be scanned, and is
reported as not in the catalog rather than matched to something else.

### Backups and moving to a server

Settings → Collection Backup → **Export full backup** saves the whole account
(storage and each copy's place in it, decks, lists, notes, sealed product, and the card data and price
history behind them) through the share sheet. **Import Backup** recognises the file
and restores it, replacing what the account has. The same file restores on a
server, which is how a collection moves off the phone (`routes/backup.js`). The
CSV/JSON exports remain for spreadsheets and other apps.

Switching back: Settings → This Device → **Connect to a server instead**. The
on-device collection stays where it is; choosing **This device** again reopens it.

### Trying device mode in a browser

```bash
cd frontend
VITE_DEVICE_WEB=1 npm run dev
```

The sign-in screen then offers **This device** on the web too. A desktop browser
has no native SQLite, so `src/device/webStore.js` stands in for the plugin over
sql.js (kept in IndexedDB). Two things only work on a phone: requests to providers
that send no CORS headers (TCGCSV prices, and so the Pokémon product map), and the
share sheet. With the flag set the dev server needs no backend: it serves `/ort`
itself and proxies nothing.

`backend/test/embedded.test.js` covers the device backend itself and
`frontend/src/utils/deviceSqlite.test.js` the plugin adapter; both run in the
normal test suites.

## Local build

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
