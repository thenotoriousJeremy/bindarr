# Translating Bindarr

Bindarr's interface is translated by whoever wants to translate it. There is no
account to make and no tool to learn: every language is a single JSON file in
[`frontend/src/locales/`](../frontend/src/locales), and a translation is a pull
request that adds or edits one.

You do not need to be a programmer. If you can edit a text file, you can do this.

## Add a new language

1. Copy [`frontend/src/locales/en.json`](../frontend/src/locales/en.json) to a new
   file in the same folder, named after your language's
   [BCP-47 tag](https://www.w3.org/International/articles/language-tags/) with a
   `.json` extension:

   | Language | File |
   |---|---|
   | German | `de.json` |
   | Japanese | `ja.json` |
   | Brazilian Portuguese | `pt-BR.json` |
   | Traditional Chinese | `zh-Hant.json` |

   Use the plain language tag (`de.json`) unless the variants genuinely differ in
   wording. Region-specific files only make sense when they are worth maintaining
   separately.

2. Translate the text on the **right** of each `:`. Never change the text on the
   left, and never change or reorder the keys.

   ```json
   "nav.collection": "Collection",     ← en.json
   "nav.collection": "Sammlung",       ← de.json
   ```

3. Open a pull request. That is the whole process. The language appears in
   Settings, under Preferences, as soon as the file is merged - nobody has to
   register it anywhere.

You can also send a partial file. Anything you have not translated falls back to
English, key by key, so a file with twenty lines in it is genuinely useful and
will be merged. Add the rest later, or let somebody else.

## The four rules

**1. Keep every `{placeholder}` exactly as it is.** The app injects a real value
where it sits. You may move it to wherever your grammar wants it, but it has to
survive, spelled identically.

```json
"toast.welcomeBack": "Welcome back, {name}!"
"toast.welcomeBack": "Willkommen zurück, {name}!"
```

**2. Finish a plural once you start it.** Some keys end in `.one` / `.other` -
those are counted phrases, and your language decides how many forms it needs.
English needs two. Japanese needs one. Russian needs four:

```json
"collection.cardUnit.one":   "card",
"collection.cardUnit.other": "cards"
```

```json
"collection.cardUnit.one":   "карта",
"collection.cardUnit.few":   "карты",
"collection.cardUnit.many":  "карт",
"collection.cardUnit.other": "карты"
```

Note that the English file has no `.few` or `.many` - you add the forms your own
language needs, and you drop the ones it does not. `other` is often the form for
fractional amounts rather than a whole count, which is why Russian has one on top
of its three integer forms. A plural can also carry a
`{count}`, in which case every form needs it:

```json
"bulk.confirmDelete.one":   "Delete {count} selected card? This cannot be undone.",
"bulk.confirmDelete.other": "Delete {count} selected cards? This cannot be undone."
```

Which forms your language needs is not a judgement call - it comes from
[Unicode's plural rules](https://www.unicode.org/cldr/charts/47/supplemental/language_plural_rules.html),
and the checker names the exact ones your file is missing. Leave a plural out
entirely and it just falls back to English; leave it half-done and some counts
show English while others show your language, which looks broken.

**3. Do not translate names.** `Bindarr`, `Magic: The Gathering`, `Pokémon`,
`LCARS`, `Scryfall`, and set or card names are brands or data, not interface text.
Card and set names come from Scryfall and TCGdex in the language the card was
printed in, so they are never in these files to begin with.

The same goes for anything a placeholder injects. `{theme}`, `{game}` and
`{set}` are filled at runtime with values that are already correct - and a few
placeholders carry literal code, like the `?theme=lcars` in
`settings.themeTip`. Move a placeholder wherever your grammar needs it, but
never translate what it stands for.

**4. Punctuation and capitalisation belong to your language.** Copy the meaning,
not the typography. Use your own quotation marks, your own spacing before `:` and
`?` if that is your convention, and your own sentence case. German nouns get
capitals; do not preserve English Title Case for its own sake.

## Check your work

If you have Node installed:

```bash
cd frontend && npm run check:locales
```

It reports how many keys you have covered and fails on the things that actually
break the interface - invalid JSON, a key that does not exist in `en.json`, a
dropped or invented `{placeholder}`, a half-finished plural. Untranslated keys are
only counted, never an error.

The same check runs automatically on your pull request, so running it yourself is
optional - it is just faster than waiting.

To see it in the running app:

```bash
npm run dev
```

then pick your language in Settings, under Preferences. Watch for text that no
longer fits its button - German and Russian commonly run 30% longer than English.
If something overflows, say so in the pull request rather than shortening the
translation into something unnatural; the layout is our problem to fix.

## What is not translatable yet

A few things you will see in the app are stored values rather than interface
text, so they are not in `en.json` and stay English for now: card **rarities**
and the card-language names on the entry form. Each one is written into the
database and matched against by the filing rules, so translating the display
needs a value/label split that does not exist for them yet. If a language you
are working on makes that gap especially awkward, say so in your pull request -
that is useful signal for doing it properly.

Card **conditions** and **printings** have that split: the database keeps the
English value, and what you see comes from the `condition.*` and `printing.*`
keys. Use the terms collectors in your language actually use - if they say
"Near Mint" in English, leave it English. The short forms (`condition.short.*`:
NM, LP, …) and the thumbnail badges (`printing.badge.*`: HOLO, REV, …) have
very little room, so keep them to a few letters.

## Interface language is not card language

These are two separate settings and they are meant to be. The interface language
is what these files control. The language a card was *printed* in is recorded per
card, when you add it. Somebody in Berlin can perfectly reasonably run the app in
German while collecting Japanese cards, so changing one never changes the other.

## Updating an existing translation

Same process: edit the file, open a pull request. When new English strings are
added, existing translations keep working and the new keys show in English until
somebody fills them in. Run the checker to see which ones those are - it prints
the count, and any key present in `en.json` but absent from your file is one of
them.
