// Headers for the two PWA files that are not content-hashed.
//
// The static handler serves frontend/dist with a year-long immutable cache, which
// is right for /assets/ and wrong for /sw.js and /manifest.webmanifest: a new
// build has to be able to replace them. They are revalidated instead.
//
// The worker also needs its own Content-Security-Policy. A worker is governed by
// the policy on its script response, not the page's, and fetch() from it is
// checked against connect-src. The page loads card art through img-src, but the
// worker caches that art by fetching it, so with the page's policy as-is every
// one of those fetches is a violation (fatal once the policy is enforced). The
// worker's copy adds the https image hosts to connect-src and nothing else.

const PWA_FILES = ['/sw.js', '/manifest.webmanifest'];

function workerCsp(policy) {
  if (!policy) return policy;
  const directives = String(policy).split(';').map(d => d.trim()).filter(Boolean);
  const img = directives.find(d => /^img-src\s/i.test(d));
  if (!img) return policy;
  const hosts = img.split(/\s+/).slice(1).filter(s => /^https:\/\/./i.test(s));
  if (!hosts.length) return policy;
  let found = false;
  const out = directives.map(d => {
    if (!/^connect-src\s/i.test(d)) return d;
    found = true;
    const have = new Set(d.split(/\s+/).slice(1));
    return [d, ...hosts.filter(h => !have.has(h))].join(' ');
  });
  // No connect-src means it falls back to default-src; spell it out so the
  // hosts are added to what default-src allowed rather than replacing it.
  if (!found) {
    const def = directives.find(d => /^default-src\s/i.test(d));
    const base = def ? def.split(/\s+/).slice(1) : ["'self'"];
    out.push(['connect-src', ...base, ...hosts].join(' '));
  }
  return out.join(';');
}

// Applied by the /sw.js and /manifest.webmanifest route in server.js, after
// helmet has set the page policy.
function setPwaHeaders(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  if (req.path !== '/sw.js') return;
  for (const name of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']) {
    const value = res.getHeader(name);
    if (value) res.setHeader(name, workerCsp(value));
  }
}

module.exports = { PWA_FILES, workerCsp, setPwaHeaders };
