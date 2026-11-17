# Scanning

Bindarr identifies a card from its artwork alone: there's no text recognition and nothing to type. It needs two downloads, neither bundled with the app.

## 1. The models

Two small neural networks (about 10 MB) find the card in the frame and turn its art into a fingerprint. They're AGPL-3.0 (Bindarr is MIT), so you download them yourself: **Admin → Catalogs**, step 1, or

```bash
docker exec bindarr node scripts/fetch-models.mjs
```

(`node scripts/fetch-models.mjs` in `backend/` outside Docker, then restart.) Without them, scanning says so instead of guessing.

## 2. A catalog per game

A catalog holds the fingerprint of every card in a game.

- **Bindarr's catalogs** (Admin → Catalogs): one download per game, rebuilt weekly by this repository's CI and published as the [`scan-catalogs` release](https://github.com/thenotoriousJeremy/bindarr/releases/tag/scan-catalogs). Magic is about 33 MB, Pokémon about 8 MB, the others smaller. Afterwards Bindarr checks daily and downloads only new cards. The Pokémon catalogs use TCGdex's card ids, so they're offered only while TCGdex is your Pokémon provider.
- **Build your own** on the same page, per game and language. It downloads every card's image and fingerprints it, which takes hours for a whole game. You can stop and resume it. Your own catalog and a downloaded one are searched together, and yours wins.

## Scanning

Scan from **Add/Remove Cards → Scan** over HTTPS ([why](install.md#ports-and-https)). Picking the set you're scanning is optional; it narrows the search, which is faster and more accurate.

A card that isn't in the catalog is reported as missing, with the nearest matches underneath, never guessed. How complete a catalog can be depends on the card data for that language: the Catalogs page shows what a catalog holds against what the provider lists.

The pipeline and its accuracy measurements are in [PROJECT.md](../PROJECT.md#image-identification-pipeline). Scanning on a phone with no server is covered in [MOBILE.md](../MOBILE.md#scanning-on-the-phone).
