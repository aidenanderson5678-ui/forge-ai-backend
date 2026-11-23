'use strict';

const { createInfoRoutes } = require('./health');
const { createGenerateRoute } = require('./generate');

/** Every route the API exposes. */
function buildRoutes(deps) {
  return [...createInfoRoutes(deps), createGenerateRoute(deps)];
}

module.exports = { buildRoutes };
