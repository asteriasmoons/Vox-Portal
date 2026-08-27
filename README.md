# Vox Bugs Bot

Standalone Telegram bot + Mini App for structured bug reports, deployed on **Cloudflare Workers**.

Users can submit a bug either through the Mini App (a polished form) or by messaging `/bug` to the bot. Both paths converge on the same backend and produce the same result: **one channel post per bug** in a dedicated Bug Reports channel, with the full report, attachments, and admin discussion living in that post's linked-discussion-group **comment thread**.

> This is a **new, standalone project**. It does **not** share code, tokens, database, or infrastructure with any other Vox bot.

---

## Architecture

```
User
  ↓
Vox Bugs Bot (private chat)   or   Mini App form
  ↓
Cloudflare Worker (this repo)
  ├─ D1        — bug records, attachments, status history, sequence
  ├─ R2        — Mini App attachment uploads
  ├─ KV        — /bug wizard sessions + channel→thread id cache
  └─ Assets    — Mini App HTML/CSS/JS
  ↓
Telegram Bug Reports channel  (concise ticket message — edited in place on status change)
  ↓ (Telegram auto-mirror)
Linked discussion group       (comment thread = full report + attachments + admin discussion)
```

**Each bug gets exactly one channel post** and one comment thread. Status changes edit the ticket in place and append a status-history message to that bug's thread. Bug numbers are monotonic (`BUG-0001`, `BUG-0002`, …) and generated atomically inside D1, so two simultaneous submissions can never collide.

---

## Required Telegram setup

You need three things in Telegram *before* the bot works end-to-end:

### 1. The bot

1. In [@BotFather](https://t.me/BotFather): `/newbot` → follow the prompts. Recommended name: **Vox Bugs Bot**, username **@VoxBugsBot** (or your choice — update `BOT_USERNAME` in `wrangler.toml`).
2. Copy the token. You'll store it as the `TELEGRAM_BOT_TOKEN` secret.
3. Recommended BotFather commands:
   - `/setdescription` — "Official bug-reporting system for the Vox apps."
   - `/setabouttext` — short one-liner.
   - `/setuserpic` — a 🐛 icon works fine.

### 2. The Bug Reports channel + linked discussion group

1. Create a **new Telegram channel** (private is fine). Name it something like `Vox Bug Reports`.
2. Create a **new group** to serve as the discussion group. Name it something like `Vox Bug Reports · Discussion`.
3. Open the channel settings → **Discussion** → link the group you just created. Telegram will now auto-mirror every channel post into that group; each mirrored post becomes a comment thread.
4. Add **Vox Bugs Bot** as an **administrator of the channel** with permission to `Post Messages` and `Edit Messages`. It does **not** need "Post Stories" or other extras.
5. Add **Vox Bugs Bot** as an **administrator of the discussion group** with permission to `Send Messages`, `Send Media`, and `Manage Topics` (Manage Topics is required so the bot may post inside thread replies).
6. In [@BotFather](https://t.me/BotFather): `/setprivacy` for your bot → **Disable**. This lets the bot see all messages in the discussion group so it can capture Telegram's auto-forward mirror (needed to learn each bug's thread id) and process admin `/note`, `/fixed`, `/dup` commands typed into threads.
7. Get the numeric IDs of both chats. Easiest method: forward one message from each into [@JsonDumpBot](https://t.me/JsonDumpBot). Channel IDs look like `-1001234567890`; group IDs look like `-1009876543210`. Set them as `CHANNEL_ID` and `DISCUSSION_CHAT_ID` secrets.
8. For password-gated channel joins, enable join-request approval on the channel invite link. The bot must have the channel admin permission to `Invite Users`. When a user requests to join, the bot DMs them for the access password and approves the request only when they answer correctly.

### 3. The Mini App

1. In [@BotFather](https://t.me/BotFather): `/newapp` → select your bot.
2. **Title**: "Report a Bug" (or your choice).
3. **Short name**: `bugs` — must match `MINIAPP_SHORT_NAME` in `wrangler.toml`.
4. **Web App URL**: `https://<your-worker>.workers.dev/app/` (must be HTTPS).
5. Upload an icon if desired (512×512 PNG).

After deploy, verify by tapping the Mini App button from `/start` inside a private chat with the bot.

---

## Environment variables

Non-secret values live in `wrangler.toml` under `[vars]`. Secrets are set with `wrangler secret put`.

| Name | Type | Purpose |
|------|------|---------|
| `BOT_USERNAME` | var | Bot username without `@`, used in shown URLs. |
| `MINIAPP_SHORT_NAME` | var | Must match the short name you set in BotFather. |
| `PUBLIC_ORIGIN` | var | Full HTTPS origin of the deployed Worker. |
| `TELEGRAM_BOT_TOKEN` | secret | From BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | secret | Long random string. Sent by Telegram as `X-Telegram-Bot-Api-Secret-Token` and verified by the Worker. |
| `CHANNEL_ID` | secret | Numeric id of the Bug Reports channel, e.g. `-1001234567890`. |
| `DISCUSSION_CHAT_ID` | secret | Numeric id of the linked discussion group. |
| `ADMIN_TELEGRAM_IDS` | secret | Comma-separated Telegram user IDs allowed to change status / mark fixed / mark duplicate. |
| `JOIN_APPROVAL_PASSWORD` | secret | Password required before approving channel join requests. |

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in. **Never commit `.dev.vars`.** The bot token is never exposed to the browser.

---

## First-time setup

```bash
# 1. Install deps
npm install

# 2. Create the Cloudflare resources
wrangler d1 create vox_bugs
# → copy the printed database_id into wrangler.toml

wrangler kv namespace create SESSIONS
# → copy the printed id into wrangler.toml

wrangler r2 bucket create vox-bugs-attachments

# 3. Apply the DB schema (local + remote)
npm run db:init:local
npm run db:init:remote

# 4. Push secrets (once each)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put CHANNEL_ID
wrangler secret put DISCUSSION_CHAT_ID
wrangler secret put ADMIN_TELEGRAM_IDS
wrangler secret put JOIN_APPROVAL_PASSWORD

# 5. Deploy
npm run deploy

# 6. Point Telegram at the Worker
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
PUBLIC_ORIGIN=https://vox-bugs-bot.<your-subdomain>.workers.dev \
  npm run set-webhook

# 7. Register the slash-command menu with Telegram
curl -X POST "https://vox-bugs-bot.<your-subdomain>.workers.dev/admin/register-commands" \
  -H "X-Admin-Secret: <TELEGRAM_WEBHOOK_SECRET>"
```

---

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
```

`wrangler dev` starts the Worker on `http://localhost:8787`. To test the webhook against a real Telegram bot, expose the port with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787`) and set that HTTPS URL as your webhook.

---

## Admin controls

The report message posted inside each bug's discussion thread carries an inline keyboard **only visible to admins** (any admin can tap; non-admins get "Not authorized"). From there admins can:

- **Status** → pick any of `New / Confirmed / Investigating / In Progress / Fix In Testing / Fixed / Closed / Cannot Reproduce`
- **Severity** → `Low / Medium / High / Critical`
- **Category** → any of the twelve categories
- **Mark Fixed / Close / Reopen** shortcuts
- **Cannot Reproduce** shortcut

Any change edits the original channel ticket in place, appends a `STATUS UPDATE` message to the bug's thread, and DMs the reporter through the bot.

Admin slash-commands typed **inside a bug's discussion thread**:

| Command | Effect |
|---------|--------|
| `/note <text>` | Post an internal note into that bug's thread. |
| `/fixed <version> [build]` | Record the fix version/build and set status to Fixed. |
| `/dup BUG-####` | Mark this bug as a duplicate of another. The duplicate reporter stays associated so they still receive updates. |

---

## Data model

D1 schema lives in `schema.sql`. Each bug row keeps:

- Internal `id` + public `public_number` (`BUG-####`)
- Reporter Telegram id, username, display name
- App / version / build / device / OS
- Category / severity / title / actual / expected / steps / frequency / notes
- Status + optional `fixed_in_version` / `fixed_in_build`
- Telegram linkage: `channel_message_id`, `discussion_message_id`, `discussion_thread_id`
- `duplicate_of_id` FK to another bug
- `created_at` / `updated_at`

Separate tables:

- `attachments` — one row per file, either a Telegram `file_id` or an R2 key.
- `status_history` — append-only audit trail of every status transition.
- `sequences` — a single row `('bug', N)` incremented atomically by `nextBugNumber()`.
- `processed_updates` — Telegram `update_id` de-dup so retries don't double-process.

The design is intentionally clean enough to add a web dashboard later without reshaping the backend.

---

## Security & reliability notes

- Telegram webhook is authenticated by the `X-Telegram-Bot-Api-Secret-Token` header, which the Worker compares against `TELEGRAM_WEBHOOK_SECRET`.
- Mini App requests are authenticated by validating the `initData` HMAC server-side against the bot token, per the [official spec](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). `auth_date` is enforced ≤ 24 h old to limit replay.
- Admin authorization is checked from `ADMIN_TELEGRAM_IDS` on every admin callback and admin command. Non-admins are rejected server-side; the client is not trusted.
- All user text is HTML-escaped before being sent to Telegram (parse_mode HTML). User content never becomes markup.
- Bug numbering uses `UPDATE ... RETURNING` on a `sequences` row so simultaneous submissions get distinct numbers.
- The Submit button in the Mini App disables itself and each submission carries a `submit_token`; double-taps can't create duplicates.
- If posting the channel ticket succeeds but posting the report body fails, the DB row still exists and the failure is logged — nothing is silently lost.
- Attachments are capped: max 10 per report, 20 MB per file.
- Tokens are only ever read from `env`; they are never sent to the browser, embedded in URLs, or logged.

---

## Repository layout

```
src/
  index.ts                 Worker entry + route table
  config.ts                Env types + admin helpers
  bugs/
    constants.ts           Categories, severities, statuses, frequencies
    formatting.ts          Channel ticket, report body, status update, DM text
    service.ts             createBug / changeStatus orchestrator
  db/
    types.ts               Row & input types
    queries.ts             All D1 SQL
  telegram/
    api.ts                 Telegram Bot API client (fetch-based)
    initdata.ts            Mini App initData HMAC validation
    keyboards.ts           Inline keyboards for admin controls
    channel.ts             Channel ticket + discussion-thread posting
    conversation.ts        /bug wizard state machine (KV-backed)
    commands.ts            /start /help /bug /cancel /mybugs
    admin.ts               Admin callback + admin group-command handling
    webhook.ts             Top-level update dispatcher
  miniapp/
    api.ts                 /api/config /api/upload /api/submit /api/mybugs
  util/
    html.ts                HTML escaping helpers
    log.ts                 Structured logger
public/
  app/
    index.html             Mini App HTML
    styles.css             Mini App styles (respects Telegram theme vars)
    app.js                 Mini App front-end
scripts/
  set-webhook.mjs          One-shot webhook registration helper
schema.sql                 D1 schema (idempotent)
wrangler.toml              Worker + bindings config
```
