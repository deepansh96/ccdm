"use strict";

// Operation dispatch table. Each operation family lives in its own module and
// declares its ops as `{ roles, scoped, run(ctx, args) }`; add a family here.
const FAMILIES = [
  require("./reply.js"),
  require("./status.js"),
];

const OPERATIONS = Object.freeze(Object.assign({}, ...FAMILIES.map(family => family.ops)));

module.exports = { OPERATIONS };
