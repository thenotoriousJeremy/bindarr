# Card data and prices

- [Where cards come from](#where-cards-come-from)
- [Pokémon](#pokémon)
- [Riftbound](#riftbound)
- [Prices](#prices)
- [The TCGCSV mirror](#the-tcgcsv-mirror)

## Where cards come from

| Game | Cards | Prices |
| --- | --- | --- |
| Pokémon | [TCGdex](https://tcgdex.dev) (default), or pokemontcgapi.com | TCGplayer via TCGCSV; Cardmarket or TCGplayer on pokemontcgapi.com |
| Magic: The Gathering | [Scryfall](https://scryfall.com) | Scryfall (TCGplayer USD, or Cardmarket EUR) |
| Disney Lorcana | [Lorcast](https://lorcast.com) | Lorcast |
| Riftbound | [RiftCodex](https://riftcodex.com) | TCGplayer via TCGCSV |
| Yu-Gi-Oh!, One Piece, Digimon, Flesh and Blood, Star Wars: Unlimited, Gundam | TCGplayer's catalogue via TCGCSV | TCGplayer via TCGCSV |

Card details are cached in the database. Riftbound and the TCGplayer-catalogue games download nothing until someone on the server uses them. [PRIVACY.md](../PRIVACY.md) lists exactly what each service receives.

## Pokémon

Choose the provider under **Admin → Instance Settings**.

| Provider | Languages | Key |
| --- | --- | --- |
| TCGdex (default) | All | None |
| pokemontcgapi.com | English, Japanese, Simplified Chinese; other languages use TCGdex | `POKEMONTCGAPI_KEY` (required) |
| pokemontcg.io | English; other languages use TCGdex | Shuts down **1 March 2027**. Offered only to installs already on it. |

Cards TCGdex doesn't have (about 6,000 English cards such as World Championship decks, Prize Pack and League promos, and most Japanese sets) come from TCGplayer's catalogue instead, with TCGplayer prices.

### Moving off pokemontcg.io

Cards collected while pokemontcg.io was the provider keep its ids (`sv1-1`), and those stop working when it shuts down. While any remain, **Admin** shows a migration panel:

1. **Preview migration** matches each card to the new provider by set and number, checked against name and TCGplayer product. It changes nothing.
2. **Migrate** takes a backup, then moves collection, decks, price history and every other reference in one transaction, and switches the provider to TCGdex.
3. **Undo migration** reverses the last run.

Cards that can't be matched stay as they are. Running it again moves only what's left. Afterwards, rebuild or re-download the Pokémon scan catalog.

### pokemontcgapi.com

Set `POKEMONTCGAPI_KEY` in the server's environment, restart, then select it under Admin → Instance Settings. It covers Japanese and Simplified Chinese as their own release lines, not translations of Western sets.

The API charges credits, mostly for prices, so Bindarr fetches prices only when a card enters your collection and in the scheduled refresh of cards you own. Search results show no price until a card is added. Switching provider doesn't change existing cards' ids; rebuild the scan catalog to include the new provider's cards.

## Riftbound

Card data comes from RiftCodex, a free community API. Art is loaded from Riot's own CDN; none is bundled. Sets TCGplayer sells that RiftCodex hasn't added yet (such as Radiance) come from TCGplayer's catalogue. Their cards get the ids RiftCodex will use, so nothing changes in anyone's collection when RiftCodex catches up. Decks are checked against Riot's construction rules.

## Prices

| Card | Priced from |
| --- | --- |
| Magic, any language | TCGplayer USD, or Cardmarket EUR when TCGplayer has no listing. **Admin → Instance Settings → Magic price source** reverses the order. |
| Pokémon, English or Japanese | TCGplayer USD |
| Pokémon, other languages | The English printing's TCGplayer price, labelled as such |
| Pokémon via pokemontcgapi.com | Cardmarket EUR, else TCGplayer USD |

Prices are stored in the currency they were quoted in. **Settings → Preferences** can show them converted to your currency at the European Central Bank's daily rate, with the original on hover.

Owned and decked cards are re-priced automatically once their price is over three days old. **Admin → Instance Settings → Refresh prices** sets how often that runs: daily (default), every 3 days, weekly, every 30 days, or never. A card from a set you own nothing in has no price until one is fetched.

**Graded slabs:** each copy can carry its own value, which replaces the market price in totals, sorting and exports. For Pokémon slabs, add a [PokemonPriceTracker](https://www.pokemonpricetracker.com/api) key in **Settings → API Keys** and **Fetch graded price** fills in recent eBay sales at that grade. It looks up one card per press, to stay inside the free tier.

## The TCGCSV mirror

TCGplayer data comes from [TCGCSV](https://tcgcsv.com), a free service run by one person. Its maintainer asked for one shared copy instead of every install syncing separately ([#102](https://github.com/thenotoriousJeremy/bindarr/issues/102)), so a daily job in this repository mirrors it to the `tcgcsv-mirror` branch:

```text
https://raw.githubusercontent.com/thenotoriousJeremy/bindarr/tcgcsv-mirror
```

Bindarr reads from the mirror by default and never contacts tcgcsv.com. It downloads a new dataset at most once a day, keeps the last complete one if a sync fails, and syncs only the categories your install uses. To use your own cache, set `TCGCSV_BASE_URL`. Please don't point it at tcgcsv.com.
