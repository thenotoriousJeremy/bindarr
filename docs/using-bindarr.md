# Using Bindarr

- [Importing a collection](#importing-a-collection)
- [Decks](#decks)
- [Binders and boxes](#binders-and-boxes)
- [Sealed product](#sealed-product)
- [Trades and gifts](#trades-and-gifts)
- [API access](#api-access)

## Importing a collection

**Settings → Import Backup** takes a ManaBox `.txt` export, or a CSV from ManaBox, Dragon Shield, TCGplayer, Moxfield or Archidekt. Columns are matched by name. A Scryfall ID picks the exact printing. A TCGplayer export doesn't name its game, so it's read as Pokémon unless it has a Game or Product Line column.

The same screen restores a full backup made with **Export full backup** (see [Backups](backups.md)).

## Decks

**Deck Builder → Create Deck** starts an empty deck, or **Quick Import Decklist** reads a pasted list or a ManaBox export. Decks are built from cards you own and checked against the format's rules: size, copy limits, Commander colour identity, and each game's own rules. A Magic list can keep tokens, which don't count toward the deck.

**Check Out for Play** reserves a deck's cards. A copy that another checked-out deck holds is flagged with that deck's name.

## Binders and boxes

Create containers in **Storage**: binders by page and pocket (up to 12 pockets per page), boxes by row and divider. Each one files cards by a sort order you choose, or by hand.

- **Arrange by hand:** set a binder's order to **Custom**, then drag cards from Unsorted into pockets, between pockets (an occupied pocket swaps), or back to Unsorted. On a phone, turn on **Arrange** and tap the card, then the pocket.
- **Import a box from ManaBox:** the upload button beside **Create Container** turns a ManaBox `.txt` export into a box, filing the cards you already have in Unsorted.
- **Binder artwork:** open a page and choose **Artwork** to lay your own picture across its pockets. **Print** produces the inserts at real size, with cut marks. Print at 100% with *Fit to page* off, and check the 50 mm test line.

Deleted cards stay in the trash for 30 days, and restoring one puts it back in its old pocket.

## Sealed product

**Collection → Sealed** tracks purchases unit by unit, so opening one box doesn't mark its twin as opened.

- **Recipes** list a product's guaranteed contents. They're shared across the server, and only their creator or an admin can edit them. Opening a unit adds its recipe's cards to your collection, linked to that unit.
- **Sharing:** a purchase can be made available to every account. The first person to open a unit claims it and gets its contents.
- **Value:** market value is tracked separately from what you paid, and only unopened units count toward it. Catalog-linked products can refresh their value from TCGplayer data.

Magic and Lorcana sealed prices are off by default: turn them on under **Admin → Instance Settings**.

## Trades and gifts

Under **Add/Remove Cards → Trades & Gifts**, offer cards or sealed units to another member as a gift or a trade, then accept, decline, counter or cancel. Each member opts in under **Settings**. Trades with people outside Bindarr can be recorded too; they move the cards in or out of your collection.

## API access

Create a key under **Settings → API Keys** and send it as a bearer token:

```bash
curl -H "Authorization: Bearer <key>" http://localhost:3001/api/stats/networth
```

```json
{ "totalValue": 4210.55, "totalSpent": 2980.00, "gain": 1230.55, "gainPct": 41.3,
  "totalCards": 812, "uniqueEntries": 604,
  "byGame": { "pokemon": { "cards": 500, "value": 3100.20 }, "mtg": { "cards": 312, "value": 1110.35 } },
  "currencies": ["USD"], "asOf": "2026-08-17T17:55:40.898Z" }
```

Keys are read-only: anything but `GET` is refused, and so is every admin endpoint. `?game=pokemon` narrows the figures. `/api/stats` returns the whole dashboard and `/api/collection` every card. More than one entry in `currencies` means the total adds prices quoted in different currencies. Revoking a key takes effect immediately.
