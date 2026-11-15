# Privacy Policy

**Effective date:** November 15, 2026

Bindarr is a **self-hosted** application. You run your own Bindarr server and
your own database, or, in the phone app's device mode, keep everything on the
phone. The developer of Bindarr does **not** operate a hosted service, does
**not** receive your data, and has **no access** to any information you enter
into or generate with the app.

## What data the app handles

All data lives on the server **you** run, or on your phone in device mode. This
may include:

- Your account login (username and a securely hashed password).
- Your card collection: card identities, quantities, conditions, purchase
  info, market values, and binder/box slot locations.
- Photos you take with your device camera to identify cards.
- Data you export (CSV or database files).

None of this is transmitted to the developer or to any third-party analytics,
advertising, or tracking service. Bindarr contains no analytics SDKs, no ad
networks, and no telemetry.

## Fonts

The app's fonts are served by your own Bindarr server (or bundled in the phone
app), along with the rest of the interface. Opening the app makes no request to
Google Fonts or any other third-party font service.

## Camera

The app uses your device camera solely to capture card images for
identification. With a server, the image (or the card cropped out of it) is sent
to your own Bindarr server, which identifies it. In device mode it is identified
on the phone itself. Either way it is not sent to the developer or to any card
provider.

## Outside services

To find cards, prices and images, Bindarr talks to the public services below.
With a server, the requests come from **your server**; in device mode they come
from **the phone**. None of them receives your username, password or account
details. Each is governed by its own privacy policy.

### Card data and prices

| Service | Address | Used for | What it receives |
| --- | --- | --- | --- |
| TCGdex | `api.tcgdex.net` | Pokémon cards and sets (the default Pokémon source) | Search terms, set and card ids, the language; price refreshes for the non-English Pokémon cards you own |
| Pokémon TCG API | `api.pokemontcg.io` | The older Pokémon source, when selected or when an API key is set | Search terms, set and card ids, price refreshes for the cards you own, and the API key (the server's, or the one you entered in Settings) |
| pokemontcgapi.com | `api.pokemontcgapi.com` | An optional Pokémon source an admin can select | Search terms, card ids, and the server's API key |
| Scryfall | `api.scryfall.com` | Magic cards, sets and prices | Search terms; for the daily price refresh, the set and number (or name) of each Magic card you own or have in a deck |
| Lorcast | `api.lorcast.com` | Disney Lorcana cards, sets and prices | Search terms, set and card ids; price refreshes for the Lorcana cards you own |
| RiftCodex | `api.riftcodex.com` | The Riftbound card list, downloaded whole on first use and refreshed weekly | Nothing beyond the request |
| MTGJSON | `mtgjson.com` | Preconstructed Magic decks and Secret Lair drops, when you browse or import them | Which deck |
| TCGplayer prices, through the project's TCGCSV mirror | `raw.githubusercontent.com` (GitHub) | Daily price files, so installs never contact TCGCSV themselves | Which price files are downloaded follows the sets your collection holds (and sealed products, if enabled); no card list. `TCGCSV_BASE_URL` can point it elsewhere |

Price refreshes name the cards you own, by id or by set and number; quantities,
conditions, prices paid and storage locations never go with them.

### Other services

| Service | Address | Used for | What it receives |
| --- | --- | --- | --- |
| European Central Bank | `www.ecb.europa.eu` | Exchange rates, for showing prices in another currency; at most once a day | Nothing beyond the request (a public file) |
| GitHub | `api.github.com` | The "check for updates" button in Settings, answered from a six-hour cache | Nothing beyond the request |
| Hugging Face | `huggingface.co` | The card-scanning models and published catalogs, only when an admin (or, in device mode, you) downloads them | Nothing beyond the request |
| PSA | `api.psacard.com` | Looking up a graded slab's certificate, if you entered a PSA token | The certificate number and your token |
| PokemonPriceTracker | `www.pokemonpricetracker.com` | Prices for graded cards, on request, if you entered an API key | The card (its TCGplayer id, or its name), the grade, and your key |

### Services you set up

- **Notification channels** (Discord, ntfy, Apprise, or any webhook URL a user
  enters) receive the notifications themselves: card names and prices for price
  alerts, and server events such as a failed backup for admins.
- **A single sign-on provider** (OpenID Connect), if an admin configures one,
  takes part in the sign-in itself: it receives your server's client id and
  secret and the sign-in request, and sends back the identity it holds for you.

### In your browser

- Card images, set symbols and logos load straight from the providers' image
  servers (`images.pokemontcg.io`, `images.scrydex.com`, `assets.tcgdex.net`,
  `cards.scryfall.io`, `svgs.scryfall.io`, `cards.lorcast.io`,
  `media.rarebit.app`, `cmsassets.rgpub.io`, `tcgplayer-cdn.tcgplayer.com`),
  which see your IP address as with any image on the web.
- Marketplace links (TCGplayer, Cardmarket) are only followed when you click them.

## Data sharing

The developer shares nothing, because the developer receives nothing. Any
sharing of your data is entirely under your control on your own server.

## Data retention and deletion

You control retention. Because you host the data, you can delete your account,
your records, or the entire database at any time directly on your server (or by
removing the app's data on your phone).

## Children's privacy

Bindarr is not directed at children and collects no personal data on behalf of
the developer.

## Security

Passwords are stored hashed. Because you host Bindarr yourself, securing your
server, network, and backups is your responsibility. To report a security
problem in Bindarr itself, see [SECURITY.md](SECURITY.md).

## Changes

This policy may be updated. Changes are published in this file in the project
repository, and the effective date above is revised accordingly.

## Contact

Questions or issues: <https://github.com/thenotoriousJeremy/bindarr/issues>
