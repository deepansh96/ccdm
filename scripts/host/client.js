"use strict";

// The ccdm-host client: resolves the endpoint and secret on every connect,
// requires the server proof before sending anything else, then authenticates and
// correlates requests by id.
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { ipcEndpoint, readIpcSecret, verifyServerProof } = require("../platform/ipc.js");
const { stateRoot } = require("../platform/paths.js");
const { ERRORS, HostError, NOT_RUNNING_MESSAGE, PROTOCOL_VERSION, encode, parseFrame } = require("./protocol.js");

const CONNECT_TIMEOUT_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

const hostStateDir = () => path.join(stateRoot(), "host");
const notRunning = () => new HostError("not_running", NOT_RUNNING_MESSAGE);

class HostClient {
  constructor({ timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, stateDir = hostStateDir() } = {}) {
    this.timeoutMs = timeoutMs;
    this.stateDir = stateDir;
    this.pending = new Map();
    this.nextId = 1;
    this.socket = null;
    this.failure = null;
  }

  // Resolves once hello_ok arrives. Nothing but the proof frame leaves before
  // the server has proved itself; a wrong proof sends nothing more.
  connect() {
    let endpoint;
    let secret;
    try {
      endpoint = ipcEndpoint(this.stateDir, "host");
      secret = readIpcSecret(this.stateDir, "host");
    } catch {
      return Promise.reject(notRunning());
    }
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      this.socket = socket;
      socket.setEncoding("utf8");
      const nonce = crypto.randomBytes(32).toString("hex");
      let stage = "proof";
      let buffer = "";
      let connected = false;
      const deadline = setTimeout(() => settleFail(connected
        ? new HostError(ERRORS.NOT_AUTHENTICATED, "the server on the ccdm-host pipe did not answer in time")
        : notRunning()), CONNECT_TIMEOUT_MS);
      const settleFail = error => {
        clearTimeout(deadline);
        stage = "failed";
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () => {
        connected = true;
        socket.write(encode({ type: "server_proof", nonce }));
      });
      socket.on("error", () => { if (stage !== "ready") settleFail(notRunning()); });
      socket.on("close", () => {
        if (stage === "ready") {
          this.failAll(notRunning());
          return;
        }
        if (stage !== "failed") settleFail(notRunning());
      });
      socket.on("data", chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const frame = parseFrame(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (stage === "ready") {
            this.deliver(frame);
          } else if (stage === "proof") {
            if (frame?.type !== "server_proof_ok" || !verifyServerProof(secret, nonce, frame.proof)) {
              settleFail(new HostError(ERRORS.NOT_AUTHENTICATED, "the server on the ccdm-host pipe did not prove itself"));
              return;
            }
            let token;
            try {
              token = fs.readFileSync(path.join(this.stateDir, "host.token"), "utf8").trim();
            } catch {
              settleFail(notRunning());
              return;
            }
            stage = "hello";
            socket.write(encode({ op: "hello", protocol_version: PROTOCOL_VERSION, token }));
          } else if (stage === "hello") {
            if (frame?.ok !== true) {
              settleFail(new HostError(frame?.error ?? ERRORS.NOT_AUTHENTICATED, frame?.message ?? "ccdm-host refused the hello"));
              return;
            }
            clearTimeout(deadline);
            stage = "ready";
            resolve(this);
          }
        }
      });
    });
  }

  deliver(frame) {
    const entry = frame && this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok === true) entry.resolve(frame);
    else entry.reject(new HostError(frame.error, frame.message));
  }

  failAll(error) {
    this.failure = error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  request(op, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError("timeout", `ccdm-host did not answer ${op} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encode({ id, op, ...args }));
    });
  }

  close() {
    this.socket?.destroy();
  }
}

// One connect, one request, one close: what the CLI and most callers want.
async function callHost(op, args = {}, options = {}) {
  const client = new HostClient(options);
  await client.connect();
  try {
    return await client.request(op, args, options);
  } finally {
    client.close();
  }
}

module.exports = { HostClient, callHost, hostStateDir };
