// Daily ECB euro reference rates, for converting displayed prices (review item 9).
//
// The ECB publishes one set of rates per working day at about 16:00 CET, as a
// small XML file with no key and no rate limit beyond courtesy. Bindarr asks at
// most once a day: the scheduler's hourly fx-rates job (server.js) calls
// refreshIfDue(), which reads the last successful fetch from the table and
// returns without touching the network until 24 hours have passed. A failure is
// returned, not thrown; the job turns it into an error so the scheduler retries.
//
// Prices are never stored converted. These rates only feed GET /api/fx and the
// dashboard totals, so a stale or missing rate can at worst leave a price in the
// currency its marketplace quoted — the behaviour before any of this existed.
const axios = require('axios');
const db = require('./db');

const { version } = require('../package.json');
const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const USER_AGENT = `Bindarr/${version} exchange-rate sync (+https://github.com/thenotoriousJeremy/bindarr)`;
const DAY_MS = 24 * 60 * 60 * 1000;

// <Cube time='2026-11-06'> then <Cube currency='USD' rate='1.1165'/> per currency.
// A regex rather than an XML parser: the format has been fixed since 1999, the
// file is 1.5 KB, and the alternative is a new dependency for two attributes.
function parseEcbXml(xml) {
  const text = String(xml || '');
  const day = text.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/);
  if (!day) throw new Error('ECB response has no rate date');
  const rates = {};
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/?>/g;
  let m;
  while ((m = re.exec(text))) {
    const rate = parseFloat(m[2]);
    if (Number.isFinite(rate) && rate > 0) rates[m[1]] = rate;
  }
  if (!Object.keys(rates).length) throw new Error('ECB response has no rates');
  return { date: day[1], rates };
}

async function saveRates({ date, rates }, fetchedAt = new Date()) {
  const stamp = fetchedAt.toISOString();
  await db.withTransaction(async () => {
    for (const [currency, rate] of Object.entries(rates)) {
      await db.run(
        `INSERT OR REPLACE INTO fx_rates (rate_date, currency, rate, fetched_at) VALUES (?, ?, ?, ?)`,
        [date, currency, rate, stamp]
      );
    }
  });
}

// The newest publication on record, as { base, date, rates }, or null when
// none has ever been fetched. The base currency is implicit in the ECB's data,
// so it is added here rather than stored.
async function latestRates() {
  const newest = await db.get(`SELECT rate_date FROM fx_rates ORDER BY rate_date DESC LIMIT 1`);
  if (!newest) return null;
  const rows = await db.all(`SELECT currency, rate FROM fx_rates WHERE rate_date = ?`, [newest.rate_date]);
  const rates = { EUR: 1 };
  for (const r of rows) rates[r.currency] = r.rate;
  return { base: 'EUR', date: newest.rate_date, rates };
}

async function fetchEcbXml() {
  const res = await axios.get(ECB_URL, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml, text/xml' },
  });
  return res.data;
}

// `fetchXml` and `now` are seams for tests, which must never reach the ECB.
async function refreshIfDue({ fetchXml = fetchEcbXml, now = Date.now() } = {}) {
  const last = await db.get(`SELECT MAX(fetched_at) AS at FROM fx_rates`);
  if (last && last.at && now - Date.parse(last.at) < DAY_MS) return { skipped: 'fresh' };
  try {
    const parsed = parseEcbXml(await fetchXml());
    await saveRates(parsed, new Date(now));
    return { fetched: parsed.date };
  } catch (err) {
    console.warn('ECB exchange-rate fetch failed:', err.message);
    return { error: err.message };
  }
}

module.exports = { ECB_URL, USER_AGENT, parseEcbXml, saveRates, latestRates, refreshIfDue };
