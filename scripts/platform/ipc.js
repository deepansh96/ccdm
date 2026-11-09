"use strict";

// Where a local server listens and how a client proves it is talking to the
// right one. POSIX uses `<name>.sock` in the state directory. Windows uses a
// named pipe whose random name and secret are published in that directory at
// every server start; clients resolve both again on every connect.
//
// Before sending anything else, a Windows client writes one NDJSON line
//   {"type":"server_proof","nonce":"<64 hex>"}
// and the server must answer with
//   {"type":"server_proof_ok","proof":"<serverProof(secret, nonce)>"}
// ccdmlib/platform/ipc.py is the Python twin.
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { writeFileAtomicSync } = require("./atomic");

const WIN32 = process.platform === "win32";
const ENDPOINT_OVERRIDES = new Map([["router", "CCDM_ROUTER_SOCKET"], ["host", "CCDM_HOST_SOCKET"]]);

// The secret goes first, so a client that finds the pipe name finds its secret.
function publishPipe(stateDir, name) {
  const pipe = `\\\\.\\pipe\\ccdm-${crypto.randomBytes(16).toString("hex")}-${name}`;
  const secret = crypto.randomBytes(32).toString("hex");
  writeFileAtomicSync(path.join(stateDir, `${name}.secret`), secret);
  writeFileAtomicSync(path.join(stateDir, `${name}.pipe`), pipe);
  return { pipe, secret };
}

function ipcEndpoint(stateDir, name) {
  if (!WIN32) return path.join(stateDir, `${name}.sock`);
  const variable = ENDPOINT_OVERRIDES.get(name);
  const override = variable && process.env[variable];
  if (override) return override;
  return fs.readFileSync(path.join(stateDir, `${name}.pipe`), "utf8").trim();
}

function readIpcSecret(stateDir, name) {
  return fs.readFileSync(path.join(stateDir, `${name}.secret`), "utf8").trim();
}

function serverProof(secret, nonce) {
  return crypto.createHmac("sha256", secret).update(nonce).digest("hex");
}

function verifyServerProof(secret, nonce, proof) {
  if (typeof proof !== "string") return false;
  const expected = Buffer.from(serverProof(secret, nonce));
  const actual = Buffer.from(proof);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A socket file left by a dead server blocks listen on POSIX. A pipe leaves nothing.
function prepareIpcListen(endpoint) {
  if (WIN32) return;
  try {
    fs.unlinkSync(endpoint);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Removes what publishPipe wrote, unless a later start has published its own.
function unpublishPipe(stateDir, name, pipe) {
  const named = path.join(stateDir, `${name}.pipe`);
  try {
    if (fs.readFileSync(named, "utf8").trim() !== pipe) return;
  } catch {
    return;
  }
  for (const file of [named, path.join(stateDir, `${name}.secret`)]) {
    try {
      fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 20 });
    } catch { /* The next start replaces it. */ }
  }
}

// The listening half of an endpoint, and the only place that knows how a server
// is created. `onConnection` gets a duplex stream it uses through setEncoding,
// write, destroy, destroyed and on("data" | "error" | "close"). A pipe hardened
// with a user-only DACL replaces this body on win32 and nothing above it.
function createIpcListener(onConnection) {
  const server = net.createServer(onConnection);
  return {
    listen(endpoint) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
    },
    close() {
      server.close();
    },
  };
}

module.exports = {
  createIpcListener, ipcEndpoint, prepareIpcListen, publishPipe, readIpcSecret, serverProof, unpublishPipe, verifyServerProof,
};
