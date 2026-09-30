"use strict";

// Project Identity: the webhook username and avatar a project's replies use.
const MAX_USERNAME = 80;
const ZWJ = "‍";
const AVATARS = {
  claude: "https://cdn.discordapp.com/embed/avatars/0.png",
  codex: "https://cdn.discordapp.com/embed/avatars/1.png",
};

// Discord rejects webhook usernames containing these words.
function breakForbidden(text) {
  return text.replace(/discord|clyde/gi, word => `${word[0]}${ZWJ}${word.slice(1)}`);
}

// `<project>-<type> · N%`, or `<project>-<type>` without a context percentage.
// The project name is truncated first so the suffix survives the length cap.
function webhookUsername(project, type, contextPct) {
  const hasPct = contextPct !== undefined && contextPct !== null && Number.isFinite(Number(contextPct));
  const pct = hasPct ? ` · ${Math.round(Number(contextPct))}%` : "";
  const suffix = `-${type}${pct}`;
  const name = [...breakForbidden(project)].slice(0, MAX_USERNAME - [...suffix].length).join("");
  return `${name}${suffix}`;
}

// The project's webhook, `ccdm-<project>`, under the same naming rules.
function webhookName(project) {
  return [...breakForbidden(`ccdm-${project}`)].slice(0, MAX_USERNAME).join("");
}

function avatarUrl(type) {
  return AVATARS[type] || AVATARS.claude;
}

module.exports = { avatarUrl, webhookName, webhookUsername };
