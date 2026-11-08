// `express` inside the phone app. The route modules only call express.Router()
// (and server.js, which is not bundled, everything else), so a Router is the
// whole of it. Bodies arrive already parsed by dispatch.js, which is why json()
// has nothing left to do.
'use strict';

const Router = require('../router');

function express() {
  throw new Error('express() is not available on the device; mount routers with express.Router()');
}

express.Router = Router;
express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();

module.exports = express;
