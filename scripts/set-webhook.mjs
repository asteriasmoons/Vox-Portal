// Register/refresh the Telegram webhook. Run locally after deploy.
// Usage:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_ORIGIN=https://vox-bugs-bot.your.workers.dev \
//     node scripts/set-webhook.mjs

const token  = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const origin = process.env.PUBLIC_ORIGIN;

if (!token || !secret || !origin) {
  console.error("Missing TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / PUBLIC_ORIGIN");
  process.exit(1);
}

const url = `${origin.replace(/\/$/, "")}/webhook`;
const body = {
  url,
  secret_token: secret,
  allowed_updates: [
    "message",
    "edited_message",
    "callback_query",
    "channel_post",
  ],
  drop_pending_updates: false,
};

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!data.ok) process.exit(2);
