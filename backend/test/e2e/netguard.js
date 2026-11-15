// No e2e process may open a connection off this machine.
//
// Loaded into every process an e2e run starts: the suites (harness.js requires
// it), the servers they spawn (offline.js requires it) and, through NODE_OPTIONS,
// anything else test/e2e/run.js starts. offline.js answers the provider clients
// (axios and fetch) before they get this far; this is the floor under it, for
// whatever a change reaches the network with next: http.request, a raw socket, a
// DNS lookup.
//
// A connection to anything but this machine is refused the way an unreachable
// host refuses it (ECONNREFUSED, on the next tick), and a lookup of a name that is
// not local fails as unknown (ENOTFOUND). Both are written to stderr and, when
// BINDARR_E2E_NET_LOG names a file, appended to it: run.js reads that file after
// the last suite, lists every refusal and fails the run, because the suites must
// need nothing outside the machine. Requests offline.js answered are logged there
// too, as `offline`, which is the evidence that the guards were in place.
//
// Not covered: UDP (dgram) and dns.Resolver instances, neither of which the
// backend uses.
'use strict';

const GUARD = Symbol.for('bindarr.e2e.netguard');

// Once per process, even when it is reached by two paths (NODE_OPTIONS and a
// require can spell the same file differently on Windows).
if (!globalThis[GUARD]) globalThis[GUARD] = install();
module.exports = globalThis[GUARD];

function install() {
  const net = require('net');
  const dns = require('dns');
  const fs = require('fs');
  const path = require('path');

  const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

  // Loopback, the unspecified address (which connects to this machine), and no
  // host at all (net's default is localhost).
  const isLocal = (host) => {
    if (host === undefined || host === null || host === '') return true;
    let h = String(host).toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (LOCAL_NAMES.has(h) || h.endsWith('.localhost')) return true;
    if (net.isIPv4(h)) return h.startsWith('127.') || h === '0.0.0.0';
    if (net.isIPv6(h)) return h === '::1' || h === '::' || /^(0+:){7}0*1$/.test(h) || /^::ffff:127\./.test(h);
    return false;
  };

  const who = `${path.basename(process.argv[1] || 'node')} (pid ${process.pid})`;

  // `kind` is 'refused' for what this file stopped and 'offline' for what
  // offline.js answered; run.js fails a run on the first and counts the second.
  const record = (kind, what) => {
    const line = `${kind} ${what} from ${who}`;
    if (kind === 'refused') {
      try { process.stderr.write(`[e2e netguard] ${line}\n`); } catch { /* stderr closed */ }
    }
    const log = process.env.BINDARR_E2E_NET_LOG;
    if (log) {
      try { fs.appendFileSync(log, `${line}\n`); } catch { /* run.js reports a missing log */ }
    }
  };

  const error = (code, syscall, message, extra) =>
    Object.assign(new Error(`${message} (e2e netguard: a test run may not leave the machine)`), { code, syscall, ...extra });

  // Every TCP connection goes through here: net.connect, tls.connect (a TLSSocket
  // is a Socket), the http(s) agents and undici. net.connect hands its arguments
  // over already normalized, as an [options, callback] array.
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host;
    let port;
    if (first !== null && typeof first === 'object') {
      if (first.path) return connect.apply(this, args);            // a local pipe
      host = first.host;
      port = first.port;
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      return connect.apply(this, args);                             // a local pipe
    } else {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    }
    if (isLocal(host)) return connect.apply(this, args);
    record('refused', `connection to ${host}:${port}`);
    const err = error('ECONNREFUSED', 'connect', `connect ECONNREFUSED ${host}:${port}`, { address: host, port });
    process.nextTick(() => this.destroy(err));
    return this;
  };

  // A lookup is a packet to the resolver, so a name that is not local is refused
  // before one goes out. An IP literal resolves without the network.
  const allowedName = (hostname) => isLocal(hostname) || net.isIP(String(hostname)) !== 0;
  const notFound = (hostname, syscall) =>
    error('ENOTFOUND', syscall, `${syscall} ENOTFOUND ${hostname}`, { hostname });

  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (allowedName(hostname)) return lookup.apply(this, arguments);
    const cb = typeof options === 'function' ? options : callback;
    record('refused', `DNS lookup of ${hostname}`);
    process.nextTick(() => cb(notFound(hostname, 'getaddrinfo')));
    return {};
  };
  const lookupAsync = dns.promises.lookup;
  dns.promises.lookup = function guardedLookupAsync(hostname, ...rest) {
    if (allowedName(hostname)) return lookupAsync.call(this, hostname, ...rest);
    record('refused', `DNS lookup of ${hostname}`);
    return Promise.reject(notFound(hostname, 'getaddrinfo'));
  };

  // The resolve* family asks DNS servers directly (c-ares) whatever the name, and
  // nothing in the backend uses it, so every call is refused.
  const RESOLVERS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
    'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
  for (const name of RESOLVERS) {
    if (typeof dns[name] === 'function') {
      dns[name] = function guardedResolve(hostname, ...rest) {
        const cb = rest[rest.length - 1];
        record('refused', `DNS ${name} of ${hostname}`);
        if (typeof cb === 'function') process.nextTick(() => cb(notFound(hostname, `query${name}`)));
      };
    }
    if (typeof dns.promises[name] === 'function') {
      dns.promises[name] = function guardedResolveAsync(hostname) {
        record('refused', `DNS ${name} of ${hostname}`);
        return Promise.reject(notFound(hostname, `query${name}`));
      };
    }
  }

  return { isLocal, record };
}
