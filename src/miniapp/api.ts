// Mini App API: /api/config, /api/upload, /api/submit, /api/mybugs.
// All endpoints validate Telegram initData server-side; the browser is
// never trusted to identify itself.

import type { Env } from "../config";
import { validateInitData } from "../telegram/initdata";
import { createBug, type IncomingAttachment } from "../bugs/service";
import { APPS, CATEGORIES, SEVERITIES, FREQUENCIES, CATEGORY_IDS, SEVERITY_IDS } from "../bugs/constants";
import { listBugsByReporter } from "../db/queries";
import { publicIdOf } from "../bugs/formatting";
import { log } from "../util/log";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_TITLE_LEN = 200;
const MAX_TEXT_LEN = 8000;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

function badRequest(msg: string) {
  return json({ ok: false, error: msg }, { status: 400 });
}

// GET /api/config — enum options for the form (no auth required).
export async function handleConfig(): Promise<Response> {
  return json({
    ok: true,
    apps: APPS,
    categories: CATEGORIES,
    severities: SEVERITIES,
    frequencies: FREQUENCIES,
  });
}

// POST /api/upload — stores one file in R2 and returns a key.
// The Mini App calls this per-file so the /submit payload stays small.
export async function handleUpload(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try {
    ({ user } = await validateInitData(env, initData));
  } catch (e) {
    return json({ ok: false, error: "auth" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  // FormDataEntryValue is File | string in the Workers runtime; do a duck
  // check rather than `instanceof File` (the File constructor isn't in
  // @cloudflare/workers-types' type surface, though the value is present).
  if (!file || typeof file === "string") return badRequest("missing file");
  const asFile = file as unknown as { size: number; name: string; type: string; stream: () => ReadableStream };
  if (asFile.size > MAX_ATTACHMENT_BYTES) return badRequest("file too large");

  const key = `uploads/${user.id}/${crypto.randomUUID()}-${sanitizeName(asFile.name)}`;
  await env.ATTACHMENTS.put(key, asFile.stream(), {
    httpMetadata: { contentType: asFile.type || "application/octet-stream" },
    customMetadata: { uploader: String(user.id), original_name: asFile.name },
  });
  return json({
    ok: true,
    key,
    mime: asFile.type || "application/octet-stream",
    name: asFile.name,
    size: asFile.size,
  });
}

// POST /api/submit — creates the bug and returns { public_id }.
export async function handleSubmit(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try {
    ({ user } = await validateInitData(env, initData));
  } catch {
    return json({ ok: false, error: "auth" }, { status: 401 });
  }

  let payload: SubmitPayload;
  try {
    payload = (await req.json()) as SubmitPayload;
  } catch {
    return badRequest("invalid JSON");
  }

  const problems = validatePayload(payload);
  if (problems.length) return badRequest(problems.join("; "));

  // Materialize R2 attachments back to bytes so we can forward into Telegram.
  const attachments: IncomingAttachment[] = [];
  for (const a of payload.attachments ?? []) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    const obj = await env.ATTACHMENTS.get(a.key);
    if (!obj) continue;
    const bytes = await obj.arrayBuffer();
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
    attachments.push({
      source: "r2",
      kind: kindOf(a.mime),
      r2_key: a.key,
      bytes,
      mime: a.mime || obj.httpMetadata?.contentType || "application/octet-stream",
      file_name: a.name || "attachment",
      size_bytes: bytes.byteLength,
    });
  }

  try {
    const row = await createBug(
      env,
      {
        reporter_tg_id: user.id,
        reporter_username: user.username ?? null,
        reporter_display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
        app: payload.app.trim(),
        app_version: nz(payload.app_version),
        app_build: nz(payload.app_build),
        device: nz(payload.device),
        os: nz(payload.os),
        // Payload was validated to be within our enum sets above.
        category: payload.category as import("../bugs/constants").CategoryId,
        severity: payload.severity as import("../bugs/constants").SeverityId,
        title: payload.title.trim(),
        actual_behavior: payload.actual_behavior.trim(),
        expected_behavior: nz(payload.expected_behavior),
        reproduction_steps: nz(payload.reproduction_steps),
        frequency: nz(payload.frequency) as any,
        notes: nz(payload.notes),
      },
      attachments,
    );
    return json({ ok: true, public_id: publicIdOf(row), id: row.id });
  } catch (e) {
    log.error("miniapp_submit_failed", e, { user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

// GET /api/mybugs — list this user's own bugs (for a future dashboard view).
export async function handleMyBugs(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try {
    ({ user } = await validateInitData(env, initData));
  } catch {
    return json({ ok: false, error: "auth" }, { status: 401 });
  }
  const rows = await listBugsByReporter(env, user.id, 50);
  return json({
    ok: true,
    bugs: rows.map((r) => ({
      public_id: publicIdOf(r),
      title: r.title,
      status: r.status,
      severity: r.severity,
      category: r.category,
      created_at: r.created_at,
    })),
  });
}

// ── helpers ─────────────────────────────────────────────────
interface SubmitPayload {
  app: string;
  app_version?: string;
  app_build?: string;
  device?: string;
  os?: string;
  category: string;
  severity: string;
  title: string;
  actual_behavior: string;
  expected_behavior?: string;
  reproduction_steps?: string;
  frequency?: string;
  notes?: string;
  attachments?: { key: string; name: string; mime: string; size?: number }[];
  // Client-generated idempotency token; reserved for future de-dup — not used yet.
  submit_token?: string;
}

function validatePayload(p: SubmitPayload): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["invalid body"];
  if (!nonEmpty(p.app)) errs.push("app is required");
  if (!nonEmpty(p.title)) errs.push("title is required");
  if (!nonEmpty(p.actual_behavior)) errs.push("actual_behavior is required");
  if (!(CATEGORY_IDS as readonly string[]).includes(p.category)) errs.push("category invalid");
  if (!(SEVERITY_IDS as readonly string[]).includes(p.severity)) errs.push("severity invalid");
  if (p.title && p.title.length > MAX_TITLE_LEN) errs.push("title too long");
  for (const k of ["actual_behavior", "expected_behavior", "reproduction_steps", "notes"] as const) {
    const v = p[k];
    if (v && v.length > MAX_TEXT_LEN) errs.push(`${k} too long`);
  }
  if ((p.attachments?.length ?? 0) > MAX_ATTACHMENTS) errs.push("too many attachments");
  return errs;
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}
function nz(s: unknown): string | null {
  return typeof s === "string" && s.trim() ? s.trim() : null;
}
function kindOf(mime: string | undefined): IncomingAttachment["kind"] {
  const m = (mime ?? "").toLowerCase();
  if (m === "image/gif") return "animation";
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("video/")) return "video";
  return "document";
}
function sanitizeName(n: string): string {
  return n.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";
}
