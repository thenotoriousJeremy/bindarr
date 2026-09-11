# pokemontcgapi.com fixtures

These are documentation fixtures, not recordings from an authenticated account.
No API credits are consumed by the tests.

- `card.json`: the single-card response example from the
  [OpenAPI contract](https://pokemontcgapi.com/openapi.json), retrieved 2026-09-10.
  Its `images` entry is the [Image object example](https://pokemontcgapi.com/docs/objects/image).
  `translations` contains an illustrative English/Japanese pair in the documented
  `{ locale, name }` shape from the [card endpoint](https://pokemontcgapi.com/docs/api/cards/get).
- `sets.json`: the Japanese set-list response example from the same OpenAPI.
- Tests derive synthetic IDs, region variants and large pages from these small
  fixtures. Those derived rows test pagination and filtering, not live coverage.

Before claiming live verification, use a server-side key to check an English,
a Japanese and a Simplified Chinese set/card; repeat a request with its ETag;
record sanitized bodies here. Also verify actual credit debits: the public
OpenAPI retrieved for this contribution describes an `include=prices` surcharge,
while the same operation declares `x-credits: 1`. The implementation uses 250-card pages and does not assume a quota
in its control flow.

The [coverage page](https://pokemontcgapi.com/coverage) identifies CN as Simplified
Chinese, and currently reports no price rows for that region. Chinese names are
not among the documented translation locales. Tests must not invent those fields.
