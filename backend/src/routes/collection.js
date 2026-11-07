// Search, scan matching, and the collection's own entries, mounted at /api by
// server.js and embedded/index.js.
//
// The routes live in routes/collection/, one file per concern; this file only
// composes them. Every module registers onto THIS router rather than mounting a
// router of its own, so the route table stays one flat list: the middleware each
// route carries (searchLimiter on search, cert, scan-match and the graded price
// fetch) and the order paths are tried in are exactly what they were when it
// was one file, and code that reads router.stack still finds each route by path.
//
// Order matters where two paths can match the same request. GET
// /collection/cert/:certNumber (search) must precede GET /collection/:id
// (entries), which hands anything non-numeric on with next().
const express = require('express');
const search = require('./collection/search');
const scan = require('./collection/scan');
const entries = require('./collection/entries');
const add = require('./collection/add');
const placement = require('./collection/placement');
const bulk = require('./collection/bulk');
const { AddCardError } = require('./collection/shared');

const router = express.Router();

search.register(router);
scan.register(router);
entries.register(router);
add.register(router);
placement.register(router);
bulk.register(router);

router.normalizeSearchParams = search.normalizeSearchParams;
router.addCardToCollection = add.addCardToCollection;
router.resolveCardForAdd = add.resolveCardForAdd;
router.AddCardError = AddCardError;
module.exports = router;
