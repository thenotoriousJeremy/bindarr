// Just enough of Express's router to run the real route modules inside the app.
//
// On a phone there is no HTTP server: the WebView hands each /api request
// straight to the routes (see dispatch.js). Express itself cannot come along —
// its request and response objects are built on Node's http module — but the
// route modules only ever ask it for a Router, so that is what this provides,
// with the Express 4 behaviour they were written against:
//   - paths match case-insensitively, with an optional trailing slash;
//   - `:name` captures one URI-decoded segment into req.params;
//   - a router mounted with use() sees its path with the mount prefix removed;
//   - next(err) skips ahead to the next four-argument handler, and
//     next('route') abandons the rest of the current route's handlers.
//
// One deliberate difference: a handler whose promise rejects is routed to
// next(err) rather than left as an unhandled rejection, as Express 5 does.
'use strict';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];

// '/locations/:id/compartments/:comp_id' -> a RegExp plus its parameter names.
// `end` is a route (the whole path must match); otherwise it is a use() prefix,
// which has to stop at a segment boundary so '/api' never matches '/apikeys'.
function compile(path, end) {
  const keys = [];
  const source = path === '/' ? '' : String(path).replace(/\/+$/, '');
  let pattern = '';
  for (let i = 0; i < source.length;) {
    const param = /^:(\w+)/.exec(source.slice(i));
    if (param) {
      keys.push(param[1]);
      pattern += '([^/]+?)';
      i += param[0].length;
    } else if (source[i] === '*') {
      keys.push(String(keys.length));
      pattern += '(.*)';
      i++;
    } else {
      pattern += source[i].replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
      i++;
    }
  }
  return { keys, re: new RegExp(end ? `^${pattern}\\/?$` : `^${pattern}(?=\\/|$)`, 'i') };
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    err.message = `Failed to decode param '${value}'`;
    err.status = 400;
    throw err;
  }
}

function matchLayer(layer, pathname) {
  const m = layer.re.exec(pathname);
  if (!m) return null;
  const params = {};
  layer.keys.forEach((key, i) => {
    if (m[i + 1] !== undefined) params[key] = decodeParam(m[i + 1]);
  });
  return { params, matched: m[0] };
}

const methodMatches = (layerMethod, method) =>
  layerMethod === 'all' || layerMethod === method || (layerMethod === 'get' && method === 'head');

// Call one handler the way Express does: error handlers only see errors, plain
// handlers only see requests that have none.
function invoke(fn, err, req, res, next) {
  const errorHandler = fn.length === 4;
  if (err ? !errorHandler : errorHandler) return next(err);
  try {
    const ret = err ? fn(err, req, res, next) : fn(req, res, next);
    if (ret && typeof ret.then === 'function') ret.then(null, (e) => next(e || new Error('Handler rejected')));
  } catch (e) {
    next(e);
  }
}

// The handlers of one router.get(path, a, b, c), run in order.
function runRoute(fns, req, res, done) {
  let i = 0;
  const step = (err) => {
    if (err === 'route') return done();
    if (err === 'router') return done(err);
    const fn = fns[i++];
    if (!fn) return done(err);
    invoke(fn, err, req, res, step);
  };
  step();
}

function Router() {
  const stack = [];

  function router(req, res, out) {
    const parentUrl = req.url;
    const parentBase = req.baseUrl || '';
    const queryAt = parentUrl.indexOf('?');
    const pathname = (queryAt === -1 ? parentUrl : parentUrl.slice(0, queryAt)) || '/';
    const search = queryAt === -1 ? '' : parentUrl.slice(queryAt);
    let idx = 0;

    const next = (err) => {
      // A mounted router rewrites req.url on the way in; put it back whichever
      // way control returns here.
      req.url = parentUrl;
      req.baseUrl = parentBase;
      if (err === 'router') return out();

      while (idx < stack.length) {
        const layer = stack[idx++];
        // A pending error is only ever handled by use() middleware: routes do
        // not match while one is outstanding.
        if (err && layer.route) continue;
        if (layer.method && !methodMatches(layer.method, req.method.toLowerCase())) continue;
        let found;
        try {
          found = matchLayer(layer, pathname);
        } catch (decodeErr) {
          err = err || decodeErr;
          continue;
        }
        if (!found) continue;

        req.params = found.params;
        if (layer.route) {
          return runRoute(layer.fns, req, res, next);
        }
        if (found.matched) {
          req.baseUrl = parentBase + found.matched;
          req.url = (pathname.slice(found.matched.length) || '/') + search;
        }
        return invoke(layer.fns[0], err, req, res, next);
      }
      out(err);
    };

    next();
  }

  router.use = (...args) => {
    const path = typeof args[0] === 'string' ? args.shift() : '/';
    for (const fn of args.flat()) {
      if (typeof fn !== 'function') throw new TypeError('Router.use() requires a middleware function');
      stack.push({ ...compile(path, false), fns: [fn], method: null, route: false });
    }
    return router;
  };

  for (const method of METHODS) {
    router[method] = (path, ...fns) => {
      const handlers = fns.flat();
      if (!handlers.length || handlers.some(fn => typeof fn !== 'function')) {
        throw new TypeError(`Router.${method}() requires handler functions`);
      }
      stack.push({ ...compile(path, true), fns: handlers, method, route: true });
      return router;
    };
  }

  router.stack = stack;
  return router;
}

module.exports = Router;
module.exports.compile = compile;
