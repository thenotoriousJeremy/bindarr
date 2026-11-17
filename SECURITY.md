# Security policy

## Reporting a vulnerability

Please report a security problem privately, not in a public issue, pull request
or discussion:

**[Report a vulnerability](https://github.com/thenotoriousJeremy/bindarr/security/advisories/new)**
(GitHub's private vulnerability reporting).

A useful report says what an attacker can do, against which version or commit,
and how to reproduce it: the requests, the steps, or a short script. Whether the
attacker needs an account, and which role, matters as much as the bug itself.

The report stays private while it is fixed. The fix ships in a release, and the
advisory is published with it, crediting you unless you would rather not be
named.

## Supported versions

Fixes go into the next release; older releases are not patched.

| Version | Supported |
| --- | --- |
| The latest release (Docker `latest`, the release binaries, the current app) | Yes |
| `edge` (the newest `main` build) | Yes, as the place fixes land first |
| Any earlier release | No: update to the latest |

## Scope

In scope: the server and its API, the web app, the Android and iOS apps (both
server and device mode), the Docker image, and this repository's workflows.

Not a vulnerability in Bindarr:

- The security of the machine, network or reverse proxy you run it on.
- Settings that knowingly widen access, used as documented: `NOTIFY_ALLOW_PRIVATE`,
  `OIDC_DEFAULT_ROLE=admin`, `OIDC_ALLOW_USERNAME_LINK`, `ALLOW_REGISTRATION`, or
  `TRUST_PROXY` on a server that is reached directly. docs/configuration.md
  describes what each one opens.
- Problems in the card-data providers or other services Bindarr talks to
  ([PRIVACY.md](PRIVACY.md) lists them); report those to the service.
