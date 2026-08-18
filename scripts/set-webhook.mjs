// Register/refresh the Telegram webhook.
//
// Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_ORIGIN from:
//   1. process.env (highest precedence — inline / CI use)
//   2. ./.dev.vars in the project root (KEY=VALUE per line, # comments ok)
//
// Usage:
//   npm run set-webhook
//   or
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_ORIGIN=... \
//     node scripts/set-webhook.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const devVarsPath = resolve(here, "..", ".dev.vars");

function loadDevVars(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single wrapping pair of quotes, if present.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fromFile = loadDevVars(devVarsPath);
const pick = (k) => process.env[k] ?? fromFile[k];

const token  = pick("TELEGRAM_BOT_TOKEN");
const secret = pick("TELEGRAM_WEBHOOK_SECRET");
const origin = pick("PUBLIC_ORIGIN");

const missing = [];
if (!token)  missing.push("TELEGRAM_BOT_TOKEN");
if (!secret) missing.push("TELEGRAM_WEBHOOK_SECRET");
if (!origin) missing.push("PUBLIC_ORIGIN");
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}.`);
  console.error(`Provide them inline, or put them in ${devVarsPath}`);
  process.exit(1);
}

const url = `${origin.replace(/\/$/, "")}/webhook`;
const body = {
  url,
  secret_token: secret,
  allowed_updates: ["message", "edited_message", "callback_query", "channel_post"],
  drop_pending_updates: false,
};

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log(JSON.stringify({ ...data, target_url: url }, null, 2));
if (!data.ok) process.exit(2);
