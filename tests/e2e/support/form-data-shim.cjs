const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const stateDir = process.env.CCDM_TEST_STATE;
const stateFile = stateDir ? path.join(stateDir, "state.json") : null;

function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) return {};
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function writeState(state) {
  if (!stateDir || !stateFile) return;
  const tmp = path.join(stateDir, `.state.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function updateState(updater) {
  const state = readState();
  state.fixtures ||= {};
  state.fixtures.discord ||= {};
  state.fixtures.network ||= { blocked: [] };
  updater(state);
  writeState(state);
}

function targetFromOptions(options = {}) {
  const protocol = options.protocol || "https:";
  const host = options.host || options.hostname || "localhost";
  const requestPath = options.path || "/";
  return {
    href: `${protocol}//${host}${requestPath}`,
    host,
    method: (options.method || "GET").toUpperCase(),
    path: requestPath,
  };
}

function callbackResponse(callback, statusCode, body) {
  const response = new PassThrough();
  response.statusCode = statusCode;
  process.nextTick(() => {
    callback(null, response);
    process.nextTick(() => response.end(body));
  });
}

function callbackError(callback, error) {
  process.nextTick(() => callback(error));
}

class FormData {
  constructor() {
    this.parts = [];
  }

  append(name, value, options = {}) {
    this.parts.push({ name, value, options });
  }

  submit(options, callback) {
    const target = targetFromOptions(options);
    const messageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(target.path);
    if (target.host !== "discord.com" || target.method !== "POST" || !messageMatch) {
      updateState((state) => {
        state.fixtures.network.blocked ||= [];
        state.fixtures.network.blocked.push({ kind: "form-data", target: target.href });
      });
      callbackError(callback, new Error(`Blocked unexpected form-data egress: ${target.href}`));
      return new PassThrough();
    }

    let payload = {};
    const files = [];
    for (const part of this.parts) {
      if (part.name === "payload_json") {
        payload = JSON.parse(String(part.value || "{}"));
      } else if (part.name.startsWith("files[")) {
        const filePath = part.value?.path;
        const stat = filePath ? fs.statSync(filePath) : { size: 0 };
        files.push({
          field: part.name,
          filename: part.options?.filename ?? (filePath ? path.basename(filePath) : part.name),
          path: filePath,
          size: stat.size,
        });
      }
    }

    const state = readState();
    const failure = state.fixtures?.discord?.failures?.upload;
    if (failure) {
      updateState((nextState) => {
        nextState.fixtures.discord.uploadFailures ||= [];
        nextState.fixtures.discord.uploadFailures.push({
          channelId: messageMatch[1],
          status: failure.status ?? 500,
        });
      });
      callbackResponse(callback, failure.status ?? 500, JSON.stringify(failure.body ?? { message: "upload failed" }));
      return new PassThrough();
    }

    let id;
    updateState((nextState) => {
      nextState.fixtures.discord.uploads ||= [];
      id = `fake-upload-${nextState.fixtures.discord.uploads.length + 1}`;
      nextState.fixtures.discord.uploads.push({
        authorization: options.headers?.Authorization ?? options.headers?.authorization,
        channelId: messageMatch[1],
        files,
        id,
        payload,
      });
    });
    callbackResponse(callback, 200, JSON.stringify({ id }));
    return new PassThrough();
  }
}

module.exports = FormData;
