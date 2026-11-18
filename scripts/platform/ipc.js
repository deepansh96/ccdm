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
const { Duplex } = require("node:stream");

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

// Windows server plumbing: koffi creates every pipe instance, because Node's own
// pipe server has no way to set a DACL or refuse remote clients. Overlapped I/O
// finishes on one completion port with one waiting call, so idle clients never
// hold libuv pool threads.
const PIPE_ACCESS_DUPLEX = 0x3;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const PIPE_UNLIMITED_INSTANCES = 255;
const INVALID_HANDLE = -1;
const ERROR_IO_PENDING = 997;
const ERROR_PIPE_CONNECTED = 535;
const READ_CONTROL = 0x00020000;
const OPEN_EXISTING = 3;
const SE_KERNEL_OBJECT = 6;
const OWNER_GROUP_DACL = 0x1 | 0x2 | 0x4;
const SDDL_REVISION = 1;
// Each instance owns one block: an OVERLAPPED per direction, then a buffer per
// direction, so a read and a write can be outstanding together.
const PIPE_BUFFER_BYTES = 64 * 1024;
const OVERLAPPED_BYTES = 32;
const READ_SLOT = 0;
const WRITE_SLOT = OVERLAPPED_BYTES;
const READ_BUFFER = 2 * OVERLAPPED_BYTES;
const WRITE_BUFFER = READ_BUFFER + PIPE_BUFFER_BYTES;
const INSTANCE_BYTES = WRITE_BUFFER + PIPE_BUFFER_BYTES;
// Instances kept waiting for a client, as libuv keeps for its own pipe servers.
const PENDING_INSTANCES = 4;
// The waiter returns this often even with nothing to do. A call that never
// returned would hang process exit, which joins the libuv pool.
const WAITER_WAKE_MS = 1000;
const INSTANCE_RETRY_MS = 1000;

let pipeNative = null;

// koffi is an optional dependency that exists for Windows; load it only here.
function pipeApi() {
  if (pipeNative) return pipeNative;
  const koffi = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const securityAttributes = koffi.struct({ nLength: "uint32_t", lpSecurityDescriptor: "void *", bInheritHandle: "int" });
  const out = koffi.out(koffi.pointer("void *"));
  const handle = "intptr_t";
  // Addresses inside an instance's block travel as plain numbers.
  const address = "uintptr_t";
  const win32 = (library, name, result, parameters) => library.func("__stdcall", name, result, parameters);
  pipeNative = {
    koffi,
    securityAttributesBytes: koffi.sizeof(securityAttributes),
    CancelIoEx: win32(kernel32, "CancelIoEx", "int", [handle, "void *"]),
    CloseHandle: win32(kernel32, "CloseHandle", "int", [handle]),
    ConnectNamedPipe: win32(kernel32, "ConnectNamedPipe", "int", [handle, address]),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: win32(advapi32,
      "ConvertSecurityDescriptorToStringSecurityDescriptorW", "int", ["void *", "uint32_t", "uint32_t", out, "void *"]),
    ConvertStringSecurityDescriptorToSecurityDescriptorW: win32(advapi32,
      "ConvertStringSecurityDescriptorToSecurityDescriptorW", "int", ["str16", "uint32_t", out, "void *"]),
    CreateFileW: win32(kernel32, "CreateFileW", handle, ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", handle]),
    CreateIoCompletionPort: win32(kernel32, "CreateIoCompletionPort", handle, [handle, handle, "uintptr_t", "uint32_t"]),
    CreateNamedPipeW: win32(kernel32, "CreateNamedPipeW", handle,
      ["str16", "uint32_t", "uint32_t", "uint32_t", "uint32_t", "uint32_t", "uint32_t", koffi.pointer(securityAttributes)]),
    GetLastError: win32(kernel32, "GetLastError", "uint32_t", []),
    GetQueuedCompletionStatus: win32(kernel32, "GetQueuedCompletionStatus", "int",
      [handle, koffi.out(koffi.pointer("uint32_t")), koffi.out(koffi.pointer("uintptr_t")), koffi.out(koffi.pointer("uintptr_t")), "uint32_t"]),
    GetSecurityInfo: win32(advapi32, "GetSecurityInfo", "uint32_t", [handle, "int", "uint32_t", "void *", "void *", "void *", "void *", out]),
    LocalFree: win32(kernel32, "LocalFree", "void *", ["void *"]),
    PostQueuedCompletionStatus: win32(kernel32, "PostQueuedCompletionStatus", "int", [handle, "uint32_t", "uintptr_t", "uintptr_t"]),
    ReadFile: win32(kernel32, "ReadFile", "int", [handle, address, "uint32_t", "void *", address]),
    WriteFile: win32(kernel32, "WriteFile", "int", [handle, address, "uint32_t", "void *", address]),
  };
  return pipeNative;
}

function ownerOnlyDescriptor(api) {
  const descriptor = [null];
  const sddl = `D:P(A;;GA;;;${require("./privacy.js").currentUserSid()})`;
  if (!api.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION, descriptor, null)) {
    throw new Error(`the security descriptor was refused with error ${api.GetLastError()}`);
  }
  return descriptor[0];
}

function createPipeListener(onConnection) {
  let api = null;
  let port = null;
  let descriptor = null;
  let endpoint = null;
  let retry = null;
  let closed = false;
  // Every instance not yet fully released, and those still waiting for a client.
  const instances = new Set();
  const listening = new Set();
  // OVERLAPPED address -> what to do when that operation completes.
  const operations = new Map();

  function wake() {
    if (port !== null) api.PostQueuedCompletionStatus(port, 0, 0, 0);
  }

  // Starts one overlapped call. Returns 0 when a completion will arrive, or the
  // Windows error when the call failed at once and none will.
  function post(instance, slot, start, done) {
    const address = instance.address + slot;
    instance.bytes.fill(0, slot, slot + OVERLAPPED_BYTES);
    operations.set(address, (ok, transferred) => {
      instance.pending -= 1;
      done(ok, transferred);
      release(instance);
    });
    instance.pending += 1;
    if (start(address)) return 0;
    const code = api.GetLastError();
    if (code === ERROR_IO_PENDING) return 0;
    operations.delete(address);
    instance.pending -= 1;
    return code;
  }

  function closeHandle(instance) {
    if (instance.handle === null) return;
    api.CancelIoEx(instance.handle, null);
    api.CloseHandle(instance.handle);
    instance.handle = null;
  }

  // The kernel holds pointers into the block until the last completion arrives.
  function release(instance) {
    if (instance.pending > 0 || !instance.finishDestroy) return;
    const finish = instance.finishDestroy;
    instance.finishDestroy = null;
    instance.bytes = null;
    api.koffi.free(instance.block);
    instances.delete(instance);
    finish();
    if (closed && instances.size === 0) wake();
  }

  function pipeStream(instance) {
    const endInput = () => {
      if (instance.inputEnded || instance.stream.destroyed) return;
      instance.inputEnded = true;
      instance.stream.push(null);
      instance.stream.read(0);
    };
    const startRead = () => {
      if (instance.reading) return;
      if (instance.handle === null) { endInput(); return; }
      instance.reading = true;
      const code = post(instance, READ_SLOT,
        overlapped => api.ReadFile(instance.handle, instance.address + READ_BUFFER, PIPE_BUFFER_BYTES, null, overlapped),
        (ok, transferred) => {
          instance.reading = false;
          if (!ok) endInput();
          else if (transferred === 0) startRead();
          // A copy, because the next read reuses the block.
          else if (!instance.stream.destroyed) {
            instance.stream.push(Buffer.from(instance.bytes.subarray(READ_BUFFER, READ_BUFFER + transferred)));
          }
        });
      if (code) {
        instance.reading = false;
        endInput();
      }
    };
    const writeFrom = (chunk, offset, callback) => {
      const end = Math.min(chunk.length, offset + PIPE_BUFFER_BYTES);
      chunk.copy(instance.bytes, WRITE_BUFFER, offset, end);
      const failed = () => callback(Object.assign(new Error("the pipe closed during a write"), { code: "EPIPE" }));
      const code = post(instance, WRITE_SLOT,
        overlapped => api.WriteFile(instance.handle, instance.address + WRITE_BUFFER, end - offset, null, overlapped),
        (ok) => {
          if (!ok) failed();
          else if (end < chunk.length) writeFrom(chunk, end, callback);
          else callback();
        });
      if (code) failed();
    };
    // One read at a time and only when the consumer wants more, one write at a
    // time; Duplex queues the rest and reports fullness through write() and "drain".
    return new Duplex({
      allowHalfOpen: false,
      read: startRead,
      write(chunk, _encoding, callback) {
        if (chunk.length === 0) callback();
        else writeFrom(chunk, 0, callback);
      },
      // A pipe has no half-close, so ending closes this side for good. Bytes
      // already written stay readable by the client.
      final(callback) {
        closeHandle(instance);
        instance.stream.once("finish", () => instance.stream.destroy());
        callback();
      },
      destroy(error, callback) {
        closeHandle(instance);
        instance.finishDestroy = () => callback(error);
        release(instance);
      },
    });
  }

  function openInstance() {
    // The name can lapse only if every instance has gone; then it is ours to claim again.
    const open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (instances.size === 0 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
    const handle = api.CreateNamedPipeW(endpoint, open >>> 0, PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES,
      PIPE_BUFFER_BYTES, PIPE_BUFFER_BYTES, 0,
      { nLength: api.securityAttributesBytes, lpSecurityDescriptor: descriptor, bInheritHandle: 0 });
    if (handle === INVALID_HANDLE) throw new Error(`CreateNamedPipeW failed with error ${api.GetLastError()}`);
    if (!api.CreateIoCompletionPort(handle, port, 0, 0)) {
      const code = api.GetLastError();
      api.CloseHandle(handle);
      throw new Error(`CreateIoCompletionPort failed with error ${code}`);
    }
    const block = api.koffi.alloc("uint8_t", INSTANCE_BYTES);
    const instance = {
      address: Number(api.koffi.address(block)),
      block,
      bytes: Buffer.from(api.koffi.view(block, INSTANCE_BYTES)),
      finishDestroy: null,
      handle,
      inputEnded: false,
      pending: 0,
      reading: false,
    };
    instance.stream = pipeStream(instance);
    instances.add(instance);
    listening.add(instance);
    const connected = (ok) => {
      listening.delete(instance);
      if (ok && !closed) {
        fillInstances();
        // Reading starts now, as net.Socket's does, so a client that leaves is
        // noticed even before the consumer attaches.
        instance.stream.read(0);
        onConnection(instance.stream);
      } else {
        instance.stream.destroy();
        retrySoon();
      }
    };
    const code = post(instance, READ_SLOT, overlapped => api.ConnectNamedPipe(handle, overlapped), connected);
    // Not from here: onConnection must not run in the middle of filling.
    if (code) setImmediate(connected, code === ERROR_PIPE_CONNECTED);
  }

  function retrySoon() {
    if (closed || retry) return;
    retry = setTimeout(fillInstances, INSTANCE_RETRY_MS);
    retry.unref();
  }

  // Running short of instances later only delays new clients, so keep trying.
  function fillInstances() {
    clearTimeout(retry);
    retry = null;
    if (closed) return;
    try {
      while (listening.size < PENDING_INSTANCES) openInstance();
    } catch {
      retrySoon();
    }
  }

  function teardown() {
    process.removeListener("exit", wake);
    if (port !== null) api.CloseHandle(port);
    port = null;
    if (descriptor) api.LocalFree(descriptor);
    descriptor = null;
  }

  function stop() {
    closed = true;
    clearTimeout(retry);
    for (const instance of [...listening]) instance.stream.destroy();
  }

  // The one waiting call: completions for every instance arrive here.
  function waitForCompletion() {
    const transferred = [0];
    const key = [0];
    const overlapped = [0];
    api.GetQueuedCompletionStatus.async(port, transferred, key, overlapped, WAITER_WAKE_MS, (error, ok) => {
      if (error) throw error;
      try {
        const address = Number(overlapped[0]);
        const complete = operations.get(address);
        operations.delete(address);
        if (complete) complete(Boolean(ok), transferred[0]);
      } finally {
        if (closed && instances.size === 0) teardown();
        else waitForCompletion();
      }
    });
  }

  return {
    async listen(target) {
      endpoint = target;
      try {
        // Test-only: can make a start fail, never make one succeed.
        if (process.env.CCDM_TEST_PIPE_CREATE_FAILS) throw new Error("forced by CCDM_TEST_PIPE_CREATE_FAILS");
        api = pipeApi();
        descriptor = ownerOnlyDescriptor(api);
        port = api.CreateIoCompletionPort(INVALID_HANDLE, 0, 0, 1);
        if (!port) throw new Error(`CreateIoCompletionPort failed with error ${api.GetLastError()}`);
        process.on("exit", wake);
        while (listening.size < PENDING_INSTANCES) openInstance();
      } catch (error) {
        if (port) {
          stop();
          if (instances.size === 0) teardown();
          else waitForCompletion();
        }
        throw new Error(`could not create ${target} with its owner-only pipe DACL: ${error.message}`);
      }
      waitForCompletion();
    },
    // Stops taking clients; connections that remain carry on, as with net.Server.
    close() {
      if (closed) return;
      stop();
      wake();
    },
  };
}

// The pipe's security descriptor as SDDL, read through a client handle.
function readPipeSddl(endpoint) {
  const api = pipeApi();
  const handle = api.CreateFileW(endpoint, READ_CONTROL, 0, null, OPEN_EXISTING, 0, 0);
  if (handle === INVALID_HANDLE) throw new Error(`CreateFileW failed with error ${api.GetLastError()}`);
  try {
    const descriptor = [null];
    const failure = api.GetSecurityInfo(handle, SE_KERNEL_OBJECT, OWNER_GROUP_DACL, null, null, null, null, descriptor);
    if (failure) throw new Error(`GetSecurityInfo failed with error ${failure}`);
    try {
      const text = [null];
      if (!api.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor[0], SDDL_REVISION, OWNER_GROUP_DACL, text, null)) {
        throw new Error(`the security descriptor could not be converted: error ${api.GetLastError()}`);
      }
      try {
        return api.koffi.decode(text[0], "char16_t", -1);
      } finally {
        api.LocalFree(text[0]);
      }
    } finally {
      api.LocalFree(descriptor[0]);
    }
  } finally {
    api.CloseHandle(handle);
  }
}

// The listening half of an endpoint, and the only place that knows how a server
// is created. `onConnection` gets a duplex stream it uses through setEncoding,
// write, destroy, destroyed and on("data" | "error" | "close"). On win32 every
// pipe instance is the current user's alone and refuses remote clients; a
// listener that cannot be created that way fails rather than falling back.
function createIpcListener(onConnection) {
  if (WIN32) return createPipeListener(onConnection);
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
  createIpcListener, ipcEndpoint, prepareIpcListen, publishPipe, readIpcSecret, readPipeSddl, serverProof, unpublishPipe, verifyServerProof,
};
