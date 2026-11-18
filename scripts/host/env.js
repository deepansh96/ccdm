"use strict";

// The environment of one session, rebuilt from the user's profile for every
// launch: what a process started by Explorer would get, plus the launch's own
// variables. Nothing comes from the host's own environment.
const { cleanEnv } = require("../platform/env.js");

// Predefined HKEY handles are sign-extended 32-bit constants.
const HKEY_CURRENT_USER = 0xFFFFFFFF80000001n;
const HKEY_LOCAL_MACHINE = 0xFFFFFFFF80000002n;
const KEY_READ = 0x20019;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_NO_MORE_ITEMS = 259;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const TOKEN_QUERY = 0x0008;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_IMPERSONATE = 0x0004;
// Longest registry value name and a generous value, in characters and bytes.
const NAME_CHARS = 16384;
const VALUE_BYTES = 64 * 1024;

let win32 = null;

function api() {
  if (win32) return win32;
  const koffi = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const userenv = koffi.load("userenv.dll");
  const outPointer = koffi.out(koffi.pointer("void *"));
  const outKey = koffi.out(koffi.pointer("uintptr_t"));
  const inOutDword = koffi.inout(koffi.pointer("uint32_t"));
  win32 = {
    koffi,
    CloseHandle: kernel32.func("__stdcall", "CloseHandle", "int", ["void *"]),
    CreateEnvironmentBlock: userenv.func("__stdcall", "CreateEnvironmentBlock", "int", [outPointer, "void *", "int"]),
    DestroyEnvironmentBlock: userenv.func("__stdcall", "DestroyEnvironmentBlock", "int", ["void *"]),
    GetCurrentProcess: kernel32.func("__stdcall", "GetCurrentProcess", "void *", []),
    GetLastError: kernel32.func("__stdcall", "GetLastError", "uint32_t", []),
    OpenProcessToken: advapi32.func("__stdcall", "OpenProcessToken", "int", ["void *", "uint32_t", outPointer]),
    RegCloseKey: advapi32.func("__stdcall", "RegCloseKey", "int32_t", ["uintptr_t"]),
    RegEnumValueW: advapi32.func("__stdcall", "RegEnumValueW", "int32_t",
      ["uintptr_t", "uint32_t", "void *", inOutDword, "void *", inOutDword, "void *", inOutDword]),
    RegOpenKeyExW: advapi32.func("__stdcall", "RegOpenKeyExW", "int32_t", ["uintptr_t", "str16", "uint32_t", "uint32_t", outKey]),
  };
  return win32;
}

// Wide "NAME=VALUE" strings, each NUL-terminated, then one more NUL. The name is
// searched from the second character: "=C:" style entries start with "=".
function readEnvironmentBlock(block) {
  const { koffi } = api();
  const env = {};
  let offset = 0;
  for (;;) {
    const entry = koffi.decode(block, offset, "char16_t", -1);
    if (!entry) return env;
    offset += (entry.length + 1) * 2;
    const separator = entry.indexOf("=", 1);
    if (separator > 0 && entry[0] !== "=") env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}

// What CreateEnvironmentBlock gives this user, with no inheritance.
function userEnvironmentBlock() {
  const windows = api();
  const token = [null];
  const access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE;
  if (!windows.OpenProcessToken(windows.GetCurrentProcess(), access, token)) {
    throw new Error(`OpenProcessToken failed (Windows error ${windows.GetLastError()})`);
  }
  const block = [null];
  try {
    if (!windows.CreateEnvironmentBlock(block, token[0], 0)) {
      throw new Error(`CreateEnvironmentBlock failed (Windows error ${windows.GetLastError()})`);
    }
    try {
      return readEnvironmentBlock(block[0]);
    } finally {
      windows.DestroyEnvironmentBlock(block[0]);
    }
  } finally {
    windows.CloseHandle(token[0]);
  }
}

function registryRoot(prefix) {
  const upper = prefix.toUpperCase();
  if (upper === "HKCU" || upper === "HKEY_CURRENT_USER") return HKEY_CURRENT_USER;
  if (upper === "HKLM" || upper === "HKEY_LOCAL_MACHINE") return HKEY_LOCAL_MACHINE;
  return null;
}

// The string values of one key, as { name, value, expand }. A key that does not exist has none.
function readRegistryValues(keyPath) {
  const separator = keyPath.indexOf("\\");
  const root = separator > 0 ? registryRoot(keyPath.slice(0, separator)) : null;
  if (root === null) throw new Error(`CCDM_HOST_ENV_KEYS names an unsupported key: ${keyPath}`);
  const windows = api();
  const key = [0];
  const opened = windows.RegOpenKeyExW(root, keyPath.slice(separator + 1), 0, KEY_READ, key);
  if (opened === ERROR_FILE_NOT_FOUND) return [];
  if (opened !== ERROR_SUCCESS) throw new Error(`RegOpenKeyExW failed for ${keyPath} (Windows error ${opened})`);
  const values = [];
  const name = Buffer.alloc(NAME_CHARS * 2);
  const data = Buffer.alloc(VALUE_BYTES);
  try {
    for (let index = 0; ; index += 1) {
      const nameChars = [NAME_CHARS];
      const type = [0];
      const dataBytes = [VALUE_BYTES];
      const status = windows.RegEnumValueW(key[0], index, name, nameChars, null, type, data, dataBytes);
      if (status === ERROR_NO_MORE_ITEMS) return values;
      if (status !== ERROR_SUCCESS) throw new Error(`RegEnumValueW failed for ${keyPath} (Windows error ${status})`);
      // A key's unnamed default value is no variable.
      if (nameChars[0] === 0 || (type[0] !== REG_SZ && type[0] !== REG_EXPAND_SZ)) continue;
      values.push({
        name: name.toString("utf16le", 0, nameChars[0] * 2),
        value: data.toString("utf16le", 0, dataBytes[0]).replace(/\0+$/, ""),
        expand: type[0] === REG_EXPAND_SZ,
      });
    }
  } finally {
    windows.RegCloseKey(key[0]);
  }
}

const existingName = (env, name) => Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());

function expandValue(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const key = existingName(env, name);
    return key === undefined ? whole : env[key];
  });
}

// Test seam: CCDM_HOST_ENV_KEYS names registry keys, separated by ";", whose
// values go on top of the block (PATH is appended). Read at every launch.
function mergeRegistryKeys(env, keyList) {
  for (const keyPath of (keyList ?? "").split(";").map(item => item.trim()).filter(Boolean)) {
    for (const { name, value, expand } of readRegistryValues(keyPath)) {
      const resolved = expand ? expandValue(value, env) : value;
      const existing = existingName(env, name);
      if (name.toUpperCase() === "PATH" && existing !== undefined) {
        env[existing] = `${env[existing]};${resolved}`;
      } else {
        env[existing ?? name] = resolved;
      }
    }
  }
  return env;
}

// One session's environment: the user's block, the test keys, the clean rule,
// then the launch's explicit variables and CCDM_SESSION_NAME.
function sessionEnvironment(name, explicit = {}, hostEnv = process.env) {
  const base = mergeRegistryKeys(userEnvironmentBlock(), hostEnv.CCDM_HOST_ENV_KEYS);
  return cleanEnv({ ...explicit, CCDM_SESSION_NAME: name }, base);
}

module.exports = { sessionEnvironment, userEnvironmentBlock };
