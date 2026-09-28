"use strict";

// A typed operation failure, returned to the client as `{ok:false, error:{code, message}}`.
class OpError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

module.exports = { OpError };
