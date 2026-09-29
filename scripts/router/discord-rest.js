"use strict";

// Minimal Discord REST calls. `token` is the root bot token; webhook
// executes authenticate with the webhook's own token in the URL instead.
const API = "https://discord.com/api/v10";

class DiscordError extends Error {
  constructor(status, body) {
    super(`Discord API ${status}${body?.message ? `: ${body.message}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

// A FormData `body` is sent as multipart (fetch sets its boundary); anything else as JSON.
async function discordRequest(method, route, { token, body, query } = {}) {
  const url = new URL(`${API}${route}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  const headers = {};
  if (token) headers.Authorization = `Bot ${token}`;
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  const payload = body === undefined || multipart ? body : JSON.stringify(body);
  const res = await fetch(url.href, { method, headers, body: payload });
  const text = res.status === 204 ? "" : await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text };
  }
  if (!res.ok) throw new DiscordError(res.status, parsed);
  return parsed;
}

module.exports = { DiscordError, discordRequest };
