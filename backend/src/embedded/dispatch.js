// One request through the embedded routes, without a socket.
//
// Builds the part of Express's req/res that the route modules actually use and
// resolves once a handler ends the response. That part is small: params, query,
// body and headers on the way in; status, json, send and set on the way out
// (`grep -o "res\.[a-z]*" backend/src/routes` is the whole list).
'use strict';

// Express parses the query string with qs. Nothing in the app sends bracketed
// keys, so the flat case is all that is needed: one value is a string, a
// repeated key becomes an array, exactly as qs returns them.
function parseQuery(search) {
  const query = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.prototype.hasOwnProperty.call(query, key)) query[key] = value;
    else if (Array.isArray(query[key])) query[key].push(value);
    else query[key] = [query[key], value];
  }
  return query;
}

function lowerCaseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null) out[name.toLowerCase()] = String(value);
  }
  return out;
}

// body-parser's json(): parse only what says it is JSON, and answer anything
// else with an empty object so `req.body.x` reads as undefined, not a crash.
function parseBody(body, headers) {
  if (body === undefined || body === null || body === '') return {};
  if (typeof body !== 'string') return body;
  if (!/\bjson\b/i.test(headers['content-type'] || '')) return {};
  try {
    return JSON.parse(body);
  } catch (err) {
    err.status = 400;
    throw err;
  }
}

function createRequest({ method = 'GET', url, headers, body }) {
  const queryAt = url.indexOf('?');
  const h = lowerCaseHeaders(headers);
  return {
    method: String(method).toUpperCase(),
    url,
    originalUrl: url,
    baseUrl: '',
    get path() {
      const at = this.url.indexOf('?');
      return (at === -1 ? this.url : this.url.slice(0, at)) || '/';
    },
    headers: h,
    query: parseQuery(queryAt === -1 ? '' : url.slice(queryAt + 1)),
    body: parseBody(body, h),
    params: {},
    ip: '127.0.0.1',
    protocol: 'https',
    hostname: 'localhost',
    secure: true,
    get(name) { return h[String(name).toLowerCase()]; },
    header(name) { return h[String(name).toLowerCase()]; },
  };
}

const TYPES = { json: 'application/json', html: 'text/html', text: 'text/plain', csv: 'text/csv' };

function createResponse(resolve) {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    finished: false,
    locals: {},
    status(code) { res.statusCode = code; return res; },
    sendStatus(code) { return res.status(code).type('text').send(String(code)); },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; return res; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete headers[String(name).toLowerCase()]; },
    set(field, value) {
      if (field && typeof field === 'object') {
        for (const [k, v] of Object.entries(field)) res.setHeader(k, v);
      } else {
        res.setHeader(field, value);
      }
      return res;
    },
    header(field, value) { return res.set(field, value); },
    get(field) { return res.getHeader(field); },
    type(type) { return res.setHeader('content-type', TYPES[type] || type); },
    attachment(filename) {
      return res.setHeader('content-disposition', filename ? `attachment; filename="${filename}"` : 'attachment');
    },
    json(obj) {
      if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(obj === undefined ? '' : JSON.stringify(obj));
    },
    send(body) {
      if (body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) return res.json(body);
      if (typeof body === 'string' && !res.getHeader('content-type')) res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(body);
    },
    redirect(statusOrUrl, maybeUrl) {
      const url = maybeUrl === undefined ? statusOrUrl : maybeUrl;
      res.statusCode = maybeUrl === undefined ? 302 : statusOrUrl;
      res.setHeader('location', url);
      return res.end('');
    },
    // There are no files to send on a phone (fs is a stub), so these report the
    // same ENOENT a missing file would on a server.
    sendFile(path, options, callback) {
      const cb = typeof options === 'function' ? options : callback;
      const err = Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: 'ENOENT', status: 404 });
      if (cb) cb(err);
      else res.status(404).end('');
    },
    download(path, ...rest) {
      const cb = rest.find(a => typeof a === 'function');
      return res.sendFile(path, cb);
    },
    end(body) {
      if (res.finished) return res;
      res.finished = true;
      res.headersSent = true;
      resolve({ status: res.statusCode, headers: { ...headers }, body: body === undefined || body === null ? '' : body });
      return res;
    },
  };
  return res;
}

function finish(err, req, res) {
  if (res.finished) {
    if (err) console.error(err);
    return;
  }
  if (err) {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    // Never a stack trace, the same rule as the server's error handler.
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err.message || 'Bad request') });
    return;
  }
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
}

// request: { method, url, headers, body }, url being path + query ('/api/x?y=1').
// Resolves { status, headers, body } — it never rejects; a failure is a status.
function dispatch(app, request) {
  return new Promise((resolve) => {
    const res = createResponse(resolve);
    let req;
    try {
      req = createRequest(request);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.status ? 'Malformed request body' : 'Bad request' });
      return;
    }
    app(req, res, (err) => finish(err, req, res));
  });
}

module.exports = { dispatch, parseQuery };
