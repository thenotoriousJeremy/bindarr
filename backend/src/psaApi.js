// PSA certificate lookup, via PSA's public API (https://www.psacard.com/publicapi).
//
// What this provider is and is not: PSA's public API does exactly one useful
// thing — given the number printed on a slab's label, it returns what PSA graded.
// There is no public endpoint for the price guide and none for the population
// report as a whole, so this module does not pretend to value a card. It answers
// "what is in this slab, and what grade did it get", and the collection route
// turns that into a pre-filled add.
//
// Two consequences shape everything below:
//
//   1. Answers are cached forever, not for three days like the card providers. A
//      cert describes a slab that was sealed once and graded once — the grade
//      cannot change, so a second fetch can only spend quota to learn nothing.
//      A cached cert therefore also resolves with NO token configured.
//   2. Field names are read tolerantly and the whole response is stored verbatim.
//      PSA's documented casing has moved before, and a cert costs a request from a
//      per-account quota — so a wrong guess about a field name must be fixable
//      from the cache rather than by re-fetching every cert the user ever entered.
const axios = require('axios');
const db = require('./db');

const API_BASE_URL = 'https://api.psacard.com/publicapi';

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' },
});

// PSA meters the public API per token and does not publish the ceiling as a
// header, so the only safe assumption is that it is low. Requests are serialized
// behind a minimum gap instead of fanned out: entering a box of slabs one at a
// time is the actual usage pattern, and it costs the user nothing to be slow.
const MIN_REQUEST_GAP_MS = 350;
let gate = Promise.resolve();
function serialized(fn) {
  const run = gate.then(fn, fn);
  gate = run.then(
    () => new Promise(r => setTimeout(r, MIN_REQUEST_GAP_MS)),
    () => new Promise(r => setTimeout(r, MIN_REQUEST_GAP_MS))
  );
  return run;
}

// A cert number as PSA indexes it: digits only. Users read them off a label and
// type them with spaces or a stray dash, and '1234 5678' must not become a second
// cache row for the same slab — cert_number is this table's primary key.
function normalizeCertNumber(input) {
  return String(input == null ? '' : input).replace(/\D/g, '');
}

// Pull a value out of the response whatever PSA capitalized it as this year.
// Tries each candidate name, then a case-insensitive sweep of the keys.
function field(obj, ...names) {
  if (!obj) return null;
  for (const n of names) {
    if (obj[n] != null && obj[n] !== '') return obj[n];
  }
  const lower = new Map(Object.keys(obj).map(k => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit && obj[hit] != null && obj[hit] !== '') return obj[hit];
  }
  return null;
}

// The numeric grade out of PSA's label text: 'GEM MT 10' -> 10, 'NM-MT 8' -> 8,
// 'MINT 9' -> 9. Half grades are matched too — PSA does not issue them but this
// same parse serves the other graders the collection column accepts.
//
// Returns null rather than 0 for a slab with no numeric grade. 'AUTHENTIC' and
// 'AUTHENTIC ALTERED' are real PSA labels: the card is genuine and encapsulated
// but ungraded, which is not the same as a grade of zero and must not sort or
// display as one.
function parseGrade(label) {
  const m = /(\d+(?:\.\d)?)\s*$/.exec(String(label || '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0 && n <= 10 ? n : null;
}

// A stored/received PSA response -> the shape the collection route speaks.
function normalizeCert(payload, certNumber) {
  // The documented response nests under `PSACert`; tolerate a flat body too.
  const c = field(payload, 'PSACert', 'psaCert') || payload || {};
  const gradeLabel = field(c, 'CardGrade', 'GradeDescription', 'cardGrade');
  return {
    cert_number: normalizeCertNumber(field(c, 'CertNumber', 'certNumber') || certNumber),
    grader: 'PSA',
    grade: parseGrade(gradeLabel),
    // Kept alongside the number because the words carry information the number
    // loses: an 'AUTHENTIC' slab has no grade at all, and 'MINT 9' vs 'OC MINT 9'
    // is a qualifier a collector cares about.
    grade_label: gradeLabel ? String(gradeLabel) : null,
    year: field(c, 'Year', 'year'),
    brand: field(c, 'Brand', 'brand'),
    subject: field(c, 'Subject', 'subject'),
    card_number: field(c, 'CardNumber', 'cardNumber'),
    variety: field(c, 'VarietyPedigree', 'Variety', 'varietyPedigree'),
    category: field(c, 'Category', 'category'),
    // Population comes along on the cert response even though there is no
    // population endpoint. Surfaced because it is free, but nothing values a card
    // from it — population is supply, not price.
    population: field(c, 'TotalPopulation', 'totalPopulation'),
    population_higher: field(c, 'PopulationHigher', 'populationHigher'),
  };
}

// PSA's card name, turned into something the card search can actually match.
//
// PSA writes labels in its own shorthand: 'CHARIZARD-HOLO', 'PIKACHU VMAX (SECRET)',
// 'BLASTOISE-HOLO 1ST EDITION'. The hyphen joins the name to a finish, the suffix
// words describe the printing, and none of it appears in a card's actual name — so
// searching the label verbatim finds nothing. Take the leading name only and let
// the caller's search do the rest.
const LABEL_NOISE = /\b(HOLO|REVERSE|FOIL|1ST\s*EDITION|SHADOWLESS|SECRET|FULL\s*ART|ALT\s*ART|PROMO|RAINBOW|GOLD)\b/gi;
function searchableName(subject) {
  return String(subject || '')
    .split('-')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(LABEL_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Look up a cert. Cache first, then the network — and the cache hit is the whole
// point, so a cert already seen resolves without a token.
//
// Throws with a `status` the route passes straight through, because the three
// failure modes need different words: no token configured is the user's setup, a
// rejected token (PSA's 401, passed on as 403) is a bad token, and a 404 means PSA
// has no such cert (a typo, or a slab from another grader).
async function lookupCert(certInput, token = '') {
  const cert_number = normalizeCertNumber(certInput);
  if (!cert_number) {
    const e = new Error('A PSA certification number is required');
    e.status = 400;
    throw e;
  }

  const cached = await db.get(`SELECT payload FROM psa_cert WHERE cert_number = ?`, [cert_number]);
  if (cached) {
    try {
      return { ...normalizeCert(JSON.parse(cached.payload), cert_number), cached: true };
    } catch {
      // A payload that will not parse is worse than no payload: it would make this
      // cert permanently unreadable. Drop it and fall through to a refetch.
      await db.run(`DELETE FROM psa_cert WHERE cert_number = ?`, [cert_number]);
    }
  }

  if (!token) {
    const e = new Error('No PSA API token configured. Add one in Settings to look up certification numbers.');
    e.status = 400;
    throw e;
  }

  let data;
  try {
    const res = await serialized(() => client.get(`/cert/GetByCertNumber/${cert_number}`, {
      // Lowercase 'bearer' is what PSA's own documentation shows.
      headers: { Authorization: `bearer ${token}` },
    }));
    data = res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      const e = new Error('PSA rejected the API token. Check it in Settings.');
      // 403, not PSA's 401: a 401 from Bindarr means the caller's own session is
      // gone, and the app signs out on it. This is a token in Settings.
      e.status = 403;
      throw e;
    }
    if (status === 404) {
      const e = new Error(`PSA has no record of certification number ${cert_number}.`);
      e.status = 404;
      throw e;
    }
    if (status === 429) {
      const e = new Error('PSA rate limit reached. Try again later.');
      e.status = 429;
      throw e;
    }
    const e = new Error(`PSA lookup failed: ${err.message}`);
    e.status = 502;
    throw e;
  }

  const normalized = normalizeCert(data, cert_number);
  // A response carrying no grade text is not a cert PSA knows — its API answers
  // 200 with an empty body for some unknown numbers rather than 404. Storing that
  // would cache a permanent "no such card" for a number the user may have simply
  // mistyped, so refuse it instead.
  if (!normalized.grade_label && !normalized.subject) {
    const e = new Error(`PSA returned no details for certification number ${cert_number}.`);
    e.status = 404;
    throw e;
  }

  await db.run(
    `INSERT OR REPLACE INTO psa_cert (cert_number, payload) VALUES (?, ?)`,
    [cert_number, JSON.stringify(data)]
  );
  return { ...normalized, cached: false };
}

module.exports = { lookupCert, normalizeCertNumber, parseGrade, searchableName, normalizeCert, client };
