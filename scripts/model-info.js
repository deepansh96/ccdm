"use strict";

// Root's `/model` answer: the provider, model, thinking level and account
// root runs with. A value root was launched with wins; otherwise it is the
// provider home's own default (Codex `config.toml`, Claude `settings.json`).
// Project channels and threads get the same answer from the Thread
// Supervisor (`scripts/thread_supervisor/model_info.py`), which shares this format.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODEL_COMMAND = /^\/model(?:\s|$)/;

const isModelCommand = text => MODEL_COMMAND.test(String(text || "").trim());

function expand(home) {
  const value = String(home);
  return path.normalize(value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);
}

function displayPath(home) {
  const full = expand(home);
  const user = os.homedir();
  return full === user || full.startsWith(user + path.sep) ? `~${full.slice(user.length)}` : full;
}

// `model` and `model_reasoning_effort` at the top level of config.toml, before its first [table].
function codexHomeDefaults(home) {
  const values = {};
  let text = "";
  try {
    text = fs.readFileSync(path.join(expand(home), "config.toml"), "utf8");
  } catch {
    return {};
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (match && ["model", "model_reasoning_effort"].includes(match[1])) values[match[1]] = match[2];
  }
  return { model: values.model, effort: values.model_reasoning_effort };
}

function claudeHomeDefaults(home) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(expand(home), "settings.json"), "utf8"));
  } catch {
    return {};
  }
  const pick = key => (typeof settings?.[key] === "string" && settings[key] ? settings[key] : undefined);
  return { model: pick("model"), effort: pick("effortLevel") };
}

// The account alias whose home is `home`, from `codex_accounts` or `claude_accounts`.
function accountAlias(registry, provider, home) {
  const accounts = registry?.[`${provider}_accounts`];
  if (!accounts || typeof accounts !== "object") return null;
  const target = expand(home);
  const match = Object.entries(accounts).find(([, value]) => typeof value === "string" && value && expand(value) === target);
  return match ? match[0] : null;
}

// `provider` is "codex" or "claude"; `model` and `effort` are what root was
// launched with, if anything; `home` its provider home.
function describe({ provider, home, model, effort, registry }) {
  const defaults = provider === "codex" ? codexHomeDefaults(home) : claudeHomeDefaults(home);
  const pick = (launched, fallback) => (launched ? [launched, "launch"] : fallback ? [fallback, "home config"] : [null, null]);
  const [modelValue, modelSource] = pick(model, defaults.model);
  const [effortValue, effortSource] = pick(effort, defaults.effort);
  const unset = provider === "codex" ? "default" : "account default";
  const shown = (value, source) => (value ? `${value} (${source})` : unset);
  const account = [accountAlias(registry, provider, home), displayPath(home)].filter(Boolean).join(" · ");
  return [
    "Root's session:",
    `Provider: ${provider}`,
    `Model: ${shown(modelValue, modelSource)}`,
    `Thinking: ${shown(effortValue, effortSource)}`,
    `Account: ${account}`,
  ].join("\n");
}

function readRegistry(registryPath) {
  try {
    return JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch {
    return {};
  }
}

module.exports = { describe, isModelCommand, readRegistry };
