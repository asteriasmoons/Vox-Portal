// Vox Bugs Bot — Worker entry.
//
// Routes:
//   POST /webhook          Telegram webhook (validated via secret header)
//   GET  /api/config       Mini App enum lists
//   POST /api/upload       Mini App attachment upload (auth: initData)
//   POST /api/submit       Mini App bug submission (auth: initData)
//   GET  /api/mybugs       Mini App user's own bugs (auth: initData)
//   POST /admin/register-commands  (auth: X-Admin-Secret == TELEGRAM_WEBHOOK_SECRET)
//   GET  /app/*            Static Mini App assets (served from ./public via ASSETS binding)
//   GET  /                 Simple index

import type { Env } from "./config";
import { dispatchUpdate } from "./telegram/webhook";
import { handleConfig, handleSubmit, handleUpload, handleMyBugs } from "./miniapp/api";
import { registerCommands } from "./telegram/commands";
import { log } from "./util/log";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // ── Telegram webhook ────────────────────────────────────
    if (url.pathname === "/webhook" && req.method === "POST") {
      const secret = req.headers.get("x-telegram-bot-api-secret-token");
      if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update: unknown;
      try {
        update = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      // Ack fast; process asynchronously so Telegram doesn't retry on latency spikes.
      ctx.waitUntil(dispatchUpdate(env, update as any));
      return new Response("ok");
    }

    // ── Mini App API ────────────────────────────────────────
    if (url.pathname === "/api/config" && req.method === "GET") return handleConfig();
    if (url.pathname === "/api/upload" && req.method === "POST") return handleUpload(env, req);
    if (url.pathname === "/api/submit" && req.method === "POST") return handleSubmit(env, req);
    if (url.pathname === "/api/mybugs" && req.method === "GET")  return handleMyBugs(env, req);

    // ── One-shot admin: register slash-command list with Telegram ──
    if (url.pathname === "/admin/register-commands" && req.method === "POST") {
      const secret = req.headers.get("x-admin-secret");
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      try {
        await registerCommands(env);
        return new Response("ok");
      } catch (e) {
        log.error("register_commands_failed", e);
        return new Response("failed", { status: 500 });
      }
    }

    // ── Mini App static assets ──────────────────────────────
    if (url.pathname === "/" ) {
      return new Response("Vox Bugs Bot is running.", {
        headers: { "content-type": "text/plain" },
      });
    }
    // Static assets served from /public/*.
    // /app or /app/ → /app/index.html
    // /app/anything → /app/anything
    // /icons/*      → /icons/* (Mini App SVGs)
    if (url.pathname.startsWith("/app") || url.pathname.startsWith("/icons/")) {
      let assetPath = url.pathname;
      if (assetPath === "/app" || assetPath === "/app/") assetPath = "/app/index.html";
      const assetReq = new Request(new URL(assetPath, req.url).toString(), req);
      return env.ASSETS.fetch(assetReq);
    }

    return new Response("not found", { status: 404 });
  },
};
