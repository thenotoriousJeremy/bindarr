// `express-rate-limit` inside the phone app. The limiters exist to stop other
// people's clients from hammering a server and its upstream APIs; on a phone the
// only client is the app itself, so each one is a pass-through.
'use strict';

module.exports = function rateLimit() {
  return (req, res, next) => next();
};
module.exports.rateLimit = module.exports;
