// Where a notification may be sent: the SSRF guard for user-supplied channel URLs.
//
// A notification channel is a URL a member types in and the SERVER then POSTs to,
// on a schedule, from inside the operator's network. Unchecked, that is a way for
// any account to make Bindarr reach things only Bindarr can reach: the router's
// admin page, a Docker sibling's unauthenticated API, a cloud metadata endpoint.
// So every destination is checked twice:
//
//   · on save (checkUrl), so a bad URL is refused while the user is looking;
//   · on every connection (guardedLookup), because a hostname that resolved to a
//     public address at save time can resolve to 127.0.0.1 tomorrow. The check
//     sits in the socket's own DNS lookup, so the address it approves is the
//     address the connection uses — there is no window between "checked" and
//     "connected" for a rebinding DNS server to slip a private answer into.
//
// Redirects are never followed (see notify.js's post), or a public URL could
// simply 302 to a private one.
//
// NOTIFY_ALLOW_PRIVATE=true lifts the private-network block, because self-hosters
// very often run ntfy, Apprise or Home Assistant on the same LAN or Docker
// network as Bindarr. It does NOT unlock link-local (169.254.0.0/16, fe80::/10):
// that range is where cloud metadata services live, no LAN notification service
// is addressed that way, and it is the one an SSRF is usually aimed at.
const dns = require('dns');
const net = require('net');

const allowPrivate = () => process.env.NOTIFY_ALLOW_PRIVATE === 'true';

// Never reachable, flag or not: link-local, "this network", multicast, reserved.
const ALWAYS_BLOCKED = new net.BlockList();
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addAddress('::', 'ipv6');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6');

// Reachable only with NOTIFY_ALLOW_PRIVATE=true: loopback, RFC 1918, carrier-grade
// NAT, the IETF/benchmark blocks, and IPv6 unique-local.
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

// ::ffff:10.0.0.1 is 10.0.0.1 to the kernel, so it is judged as one.
function unmap(address) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1] : address;
}

// Why an address may not be contacted, or null when it may.
function addressProblem(address) {
  const ip = unmap(String(address).replace(/^\[|\]$/g, ''));
  const family = net.isIP(ip);
  if (!family) return 'not an IP address';
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (ALWAYS_BLOCKED.check(ip, type)) return 'that address range is never allowed';
  if (PRIVATE.check(ip, type) && !allowPrivate()) {
    return 'private and local network addresses are blocked (an admin can set NOTIFY_ALLOW_PRIVATE=true)';
  }
  return null;
}

class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOTIFY_BLOCKED';
  }
}

// A drop-in for dns.lookup, handed to http(s).request as `lookup`. Node calls it
// for the connection it is about to open, so whatever it approves is exactly what
// gets connected to. Every resolved address must pass, not just the first: a
// resolver returning one public and one private record could otherwise be
// connected to the private one on a retry.
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    for (const a of list) {
      const problem = addressProblem(a.address);
      if (problem) return callback(new BlockedAddressError(`${hostname} resolves to ${a.address}: ${problem}`));
    }
    if (!list.length) return callback(new Error(`${hostname} did not resolve`));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const lookupAll = (hostname) => new Promise((resolve, reject) => {
  dns.lookup(hostname, { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
});

// Validate a destination URL. Resolves to the parsed URL, or throws an Error whose
// message is safe to show the user. `resolve: false` skips the DNS half, for
// callers that only want the shape checked.
async function checkUrl(raw, { resolve = true } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed.');
  }
  // Credentials in the URL would be stored and logged as part of it; the
  // channels that need a secret have a token field for it.
  if (url.username || url.password) throw new Error('Put credentials in the token field, not in the URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('The URL has no host.');
  if (net.isIP(host)) {
    const problem = addressProblem(host);
    if (problem) throw new Error(`${host}: ${problem}`);
    return url;
  }
  // "localhost" never needs DNS to be loopback.
  if (/^localhost$|\.localhost$/i.test(host)) {
    const problem = addressProblem('127.0.0.1');
    if (problem) throw new Error(`${host}: ${problem}`);
  }
  if (!resolve) return url;
  let list;
  try {
    list = await lookupAll(host);
  } catch {
    throw new Error(`Could not resolve ${host}.`);
  }
  for (const a of list) {
    const problem = addressProblem(a.address);
    if (problem) throw new Error(`${host} resolves to ${a.address}: ${problem}`);
  }
  return url;
}

module.exports = { checkUrl, guardedLookup, addressProblem, allowPrivate, BlockedAddressError };
