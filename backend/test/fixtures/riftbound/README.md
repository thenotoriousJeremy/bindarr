# Riftbound fixtures

Offline inputs for `test/riftbound*.test.js` and `test/e2e/riftbound.test.js`.
Nothing here is card art: the tests never fetch an image.

- `cards.json` — 15 records copied verbatim from `GET https://api.riftcodex.com/cards`
  on 2026-11-07. Chosen for the cases the provider has to get right: a Signature
  printing whose code carries `*` (`unl-229*-219`) next to its Overnumbered twin
  (`unl-229-219`), an alternate art with a letter suffix (`unl-176a-219`), a
  landscape battlefield (`unl-215-219`), a rune listed twice — the same printing as
  an older record without a TCGplayer product (`ven-r06`, collapsed to one card), a
  token (`sfd-t03`), an OPP promo and its Metal printing sharing one code
  (`opp-259-298`, two cards), a Vendetta code whose older record has a different
  name (`ven-189-166`, two cards), and a Legend, Champion units, a Signature card,
  a unit and an off-domain spell for the deck rules.
- `sets.json` — `GET https://api.riftcodex.com/sets?page=1&size=100`, verbatim, same day.
- `tcgcsv-89.json` — TCGCSV category 89 (Riftbound) groups and prices in TCGCSV's
  response shape. TCGCSV answered this machine with HTTP 403 while these were
  written, so the rows are modelled on published examples rather than copied:
  the group ids and abbreviations are TCGplayer's, the product ids are the
  fixture cards' own `tcgplayer_id`s, and the prices are illustrative. Product
  685537 (Prepared Neophyte) is deliberately absent — a listed card with no quote.
- `tcgplayer-89.json` — TCGplayer category 89 groups, products and prices as an
  install's TCGCSV cache holds them (slimmed by `utils/tcgcsvSlim.js`), copied from
  this repository's `tcgcsv-mirror` branch on 2026-11-16, for the sets RiftCodex
  lacks (`riftboundTcgplayer.js`, #181). Four groups, a few products each:
  Radiance (RAD), which RiftCodex does not have — an alternate art, a rune, a
  special art (`SP4/005`), two Signatures TCGplayer numbers alike (`179*/167`), a
  double-sided token (`T02 // T05`) and a booster pack; Unleashed (UNL), which it
  does; the 2025 Worlds Bundle (RWB), whose Bandle Tree RiftCodex files under PR
  and whose Oversized printing it does not have; and Legacy (LGC), sealed product
  only, not out yet. Cards carry `ext`, the short extendedData fields the slim
  cache keeps for category 89 (card type, domain, tags, energy, might, power).
- `riftcodex-later.json` — `PR`: RiftCodex's real Bandle Tree record (product
  672073), copied from `GET https://api.riftcodex.com/cards` on 2026-11-16. `RAD`
  and `RAD_SET`: Radiance as RiftCodex might add it, MODELLED on its records (the
  ids, image paths and dates are made up; names, numbers, types, domains and
  product ids follow TCGplayer's listing), for the hand-over when it does.
