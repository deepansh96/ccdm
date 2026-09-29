"use strict";

// A typed operation failure, returned to the client as `{ok:false, error:{code, message}}`.
class OpError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

// A target outside the session's scope; the server logs and records `target`.
class ScopeViolation extends OpError {
  constructor(target, message) {
    super("scope_violation", message);
    this.target = String(target);
  }
}

module.exports = { OpError, ScopeViolation };
