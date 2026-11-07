# Fonts

Served by Bindarr itself, so drawing the interface makes no request to a third
party. The `@font-face` rules are in `frontend/src/fonts.css`.

The files are the woff2 files Google Fonts serves for these families,
downloaded unmodified on 2026-11-07: Latin and Latin Extended subsets only,
upright only (the app sets no italic text). All are licensed under the SIL Open
Font License 1.1 — see `OFL.txt` for the license and each family's copyright.

| Family | Weights | Where |
|---|---|---|
| Outfit | 400–800 (variable) | default and light themes |
| Chakra Petch | 400, 500, 600, 700 | Pokédex theme |
| Righteous | 400 | Pokédex theme logo and headings |
| Crimson Pro | 400, 600, 700 (variable file) | Magic theme |
| Cinzel Decorative | 700, 900 | Magic headings and logo, Lorcana logo |
| Cinzel | 500–900 (variable) | Magic buttons |
| Philosopher | 400, 700 | Lorcana theme |
| Antonio | 400–700 (variable) | LCARS theme |

A browser fetches only what the page needs: the theme's own family, and the
Latin Extended file only for text that has such characters.

File names carry the Google Fonts version (`outfit-v15-…`). The server caches
everything it serves from here as immutable for a year, so an updated font must
come with a new file name, never replace an old one in place.
