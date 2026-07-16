# Mobile apps (iOS + Android)

The native apps are the existing React frontend wrapped with [Capacitor](https://capacitorjs.com).
No separate codebase: every web change flows into both apps on the next build.

Because each user self-hosts Bindarr, the app asks for a **Server URL** on the
login screen (shown only in the native app) and stores it locally. All `/api`
calls are routed to that server through Capacitor's native HTTP layer, which
also sidesteps WebView CORS — no backend CORS changes needed.

## Layout

- `frontend/capacitor.config.json` — app id (`com.bindarr.app`), name, `CapacitorHttp` on.
- `frontend/src/apiBase.js` — native fetch shim that prepends the user's server URL.
- `frontend/android/`, `frontend/ios/` — native projects (committed; build output is git-ignored).

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
