# Privacy Policy

**Effective date:** July 16, 2026

Bindarr is a **self-hosted** application. You run your own Bindarr server and
your own database. The developer of Bindarr does **not** operate a hosted
service, does **not** receive your data, and has **no access** to any
information you enter into or generate with the app.

## What data the app handles

All data lives on the server **you** run. This may include:

- Your account login (username and a securely hashed password).
- Your card collection: card identities, quantities, conditions, purchase
  info, market values, and binder/box slot locations.
- Photos you take with your device camera to identify cards.
- Data you export (CSV or database files).

None of this is transmitted to the developer or to any third-party analytics,
advertising, or tracking service. Bindarr contains no analytics SDKs, no ad
networks, and no telemetry.

## Camera

The app uses your device camera solely to capture card images for
identification. Images are processed by your own server. They are not sent to
the developer.

## Third-party services your server contacts

To identify cards and fetch prices and card images, your Bindarr **server**
makes requests to public card-catalog APIs:

- Pokémon TCG API (`api.pokemontcg.io`, `images.pokemontcg.io`)
- Scryfall (`api.scryfall.com`, `scryfall.com`, `cards.scryfall.io`)

These requests contain card search terms (names, set identifiers) needed to
look up catalog data. They do not include your account details or your
collection. Use of these services is governed by their own privacy policies.

## Data sharing

The developer shares nothing, because the developer receives nothing. Any
sharing of your data is entirely under your control on your own server.

## Data retention and deletion

You control retention. Because you host the data, you can delete your account,
your records, or the entire database at any time directly on your server.

## Children's privacy

Bindarr is not directed at children and collects no personal data on behalf of
the developer.

## Security

Passwords are stored hashed. Because you host Bindarr yourself, securing your
server, network, and backups is your responsibility.

## Changes

This policy may be updated. Changes are published in this file in the project
repository, and the effective date above is revised accordingly.

## Contact

Questions or issues: <https://github.com/thenotoriousJeremy/bindarr/issues>
