// Mini App API: /api/config, /api/upload, /api/submit, /api/mybugs.
// All endpoints validate Telegram initData server-side; the browser is
// never trusted to identify itself.

import type { Env } from "../config";
import { validateInitData } from "../telegram/initdata";
import { createBug, resendBugToTelegram, type IncomingAttachment } from "../bugs/service";
import { createIdea, resendIdeaToTelegram, type IncomingIdeaAttachment } from "../ideas/service";
import { listIdeasByReporter, getIdea, listIdeaAttachments } from "../db/queries";
import { ideaPublicId } from "../ideas/formatting";
import { postChannelTicket, postReportToThread, postR2AttachmentToThread, postTelegramAttachmentToThread, waitForDiscussionMirror } from "../telegram/channel";
import { APPS, CATEGORIES, SEVERITIES, FREQUENCIES, CATEGORY_IDS, SEVERITY_IDS } from "../bugs/constants";
import { listBugsByReporter, getBug, listAttachments, setAttachmentPostedMessage, setBugTelegramLinkage } from "../db/queries";
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
    // Distribute independent per-destination outcomes to the client so the
    // Mini App can render "✓ Sent to Telegram / ⚠ GitHub …" accurately.
    // The Telegram flow succeeded — if it hadn't, createBug would have
    // thrown before this line. GitHub is inferred from persisted metadata.
    const github =
      row.github_issue_number && row.github_issue_url && row.github_repo
        ? {
            status: "created" as const,
            issue_number: row.github_issue_number,
            issue_url: row.github_issue_url,
            repo: row.github_repo,
          }
        : row.github_status === "skipped_no_mapping"
        ? { status: "skipped_no_mapping" as const, reason: row.github_error ?? null }
        : row.github_status === "skipped_disabled"
        ? { status: "skipped_disabled" as const, reason: row.github_error ?? null }
        : row.github_status === "failed"
        ? { status: "failed" as const, reason: row.github_error ?? null }
        : { status: "not_attempted" as const };

    return json({
      ok: true,
      public_id: publicIdOf(row),
      id: row.id,
      telegram: { status: "sent" as const },
      github,
    });
  } catch (e) {
    log.error("miniapp_submit_failed", e, { user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

// GET /api/myideas/:id — full detail of one of the caller's ideas. Ideas
// and bugs each have their own auto-increment id, so tapping IDEA-0001
// must go here (not to /api/mybugs/1, which would return BUG-0001).
export async function handleMyIdeaDetail(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  const row = await getIdea(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });
  const atts = await listIdeaAttachments(env, row.id);
  return json({
    ok: true,
    idea: { ...row, public_id: ideaPublicId(row) },
    attachments: atts.map((a) => ({ id: a.id, kind: a.kind, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes, posted_message_id: a.posted_message_id })),
  });
}

// POST /api/myideas/:id/resubmit — resend only this idea's Telegram delivery.
export async function handleResubmitIdea(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }

  const row = await getIdea(env, id);
  if (!row || row.reporter_tg_id !== user.id) {
    return json({ ok: false, error: "not_found" }, { status: 404 });
  }
  try {
    const result = await resendIdeaToTelegram(env, id);
    return json({
      ok: result.telegram !== "failed",
      public_id: ideaPublicId(result.row),
      telegram: result.telegram,
      report_posted: !!result.row.report_message_id,
      github_created: !!result.row.github_comment_id,
      github_url: result.row.github_comment_url,
    }, result.telegram === "failed" ? { status: 500 } : {});
  } catch (e) {
    log.error("resubmit_idea_failed", e, { ideaId: id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

// POST /api/submit-idea — creates a Feature Idea (Telegram + GitHub Discussion).
export async function handleSubmitIdea(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try {
    ({ user } = await validateInitData(env, initData));
  } catch { return json({ ok: false, error: "auth" }, { status: 401 }); }

  let payload: IdeaSubmitPayload;
  try { payload = (await req.json()) as IdeaSubmitPayload; }
  catch { return badRequest("invalid JSON"); }

  const errs = validateIdeaPayload(payload);
  if (errs.length) return badRequest(errs.join("; "));

  // Materialize R2 attachments back to bytes.
  const attachments: IncomingIdeaAttachment[] = [];
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
    const row = await createIdea(
      env,
      {
        reporter_tg_id: user.id,
        reporter_username: user.username ?? null,
        reporter_display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
        app: payload.app.trim(),
        title: payload.title.trim(),
        what_i_want: payload.what_i_want.trim(),
        why_useful: nz(payload.why_useful),
        how_it_works: nz(payload.how_it_works),
        where_it_belongs: nz(payload.where_it_belongs),
        notes: nz(payload.notes),
      },
      attachments,
    );
    // Mirrors the bug submit response shape: Telegram is "sent" if createIdea
    // returned without throwing (both channel post and rich report succeeded).
    // GitHub outcome is derived from the persisted meta.
    const github =
      row.github_comment_id && row.github_comment_url
        ? { status: "created" as const, comment_id: row.github_comment_id, comment_url: row.github_comment_url }
        : row.github_status === "skipped_no_mapping"
        ? { status: "skipped_no_mapping" as const, reason: row.github_error ?? null }
        : row.github_status === "skipped_disabled"
        ? { status: "skipped_disabled" as const, reason: row.github_error ?? null }
        : row.github_status === "failed"
        ? { status: "failed" as const, reason: row.github_error ?? null }
        : { status: "not_attempted" as const };
    return json({
      ok: true,
      public_id: ideaPublicId(row),
      id: row.id,
      telegram: { status: "sent" as const },
      github,
    });
  } catch (e) {
    log.error("miniapp_submit_idea_failed", e, { user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

interface IdeaSubmitPayload {
  app: string;
  title: string;
  what_i_want: string;
  why_useful?: string;
  how_it_works?: string;
  where_it_belongs?: string;
  notes?: string;
  attachments?: { key: string; name: string; mime: string; size?: number }[];
  submit_token?: string;
}

function validateIdeaPayload(p: IdeaSubmitPayload): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["invalid body"];
  if (!p.app?.trim()) errs.push("app is required");
  if (!p.title?.trim()) errs.push("title is required");
  if (!p.what_i_want?.trim()) errs.push("what_i_want is required");
  if (p.title && p.title.length > MAX_TITLE_LEN) errs.push("title too long");
  for (const k of ["what_i_want", "why_useful", "how_it_works", "where_it_belongs", "notes"] as const) {
    const v = p[k];
    if (v && v.length > MAX_TEXT_LEN) errs.push(`${k} too long`);
  }
  if ((p.attachments?.length ?? 0) > MAX_ATTACHMENTS) errs.push("too many attachments");
  return errs;
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
  const [bugRows, ideaRows] = await Promise.all([
    listBugsByReporter(env, user.id, 50),
    listIdeasByReporter(env, user.id, 50),
  ]);
  return json({
    ok: true,
    // Unified feed: bugs + ideas, most-recent first. Frontend keys on `type`.
    submissions: [
      ...bugRows.map((r) => ({
        type: "bug" as const,
        id: r.id,
        public_id: `BUG-${String(r.public_number).padStart(4, "0")}`,
        title: r.title,
        app: r.app,
        status: r.status,
        created_at: r.created_at,
        telegram_posted: !!r.channel_message_id,
        report_posted: !!r.report_message_id,
        github_created: !!r.github_issue_number,
        github_url: r.github_issue_url,
      })),
      ...ideaRows.map((r) => ({
        type: "idea" as const,
        id: r.id,
        public_id: ideaPublicId(r),
        title: r.title,
        app: r.app,
        status: r.status,
        created_at: r.created_at,
        telegram_posted: !!r.channel_message_id,
        report_posted: !!r.report_message_id,
        github_created: !!r.github_comment_id,
        github_url: r.github_comment_url,
      })),
    ].sort((a, b) => b.created_at - a.created_at),
    // Legacy shape kept for backward compat with any older cached JS.
    bugs: bugRows.map((r) => ({
      id: r.id,
      public_id: publicIdOf(r),
      title: r.title,
      status: r.status,
      severity: r.severity,
      category: r.category,
      created_at: r.created_at,
      // Delivery state — history rows use these to decide whether to
      // render the "Resend to Telegram" affordance.
      telegram_posted: !!r.channel_message_id,
      report_posted:   !!r.report_message_id,
      github_created:  !!r.github_issue_number,
      github_url:      r.github_issue_url,
    })),
  });
}

export async function handleMyBugDetail(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  const row = await getBug(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });
  const atts = await listAttachments(env, row.id);
  return json({
    ok: true,
    bug: { ...row, public_id: publicIdOf(row) },
    attachments: atts.map((a) => ({ id: a.id, kind: a.kind, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes, posted_message_id: a.posted_message_id })),
  });
}

export async function handleResubmitBug(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  let row = await getBug(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });

  // Case A: original submission never posted the channel ticket at all —
  // delegate to the from-scratch resender, which posts channel + mirror +
  // rich report + attachments in one shot (idempotent GitHub retry included).
  if (!row.channel_message_id) {
    try {
      const { row: fresh, telegram } = await resendBugToTelegram(env, id);
      return json({
        ok: true,
        public_id: publicIdOf(fresh),
        telegram,
        report_posted: !!fresh.report_message_id,
        github_created: !!fresh.github_issue_number,
        github_url: fresh.github_issue_url,
      });
    } catch (e) {
      log.error("resubmit_from_scratch_failed", e, { bugId: id });
      return json({ ok: false, error: "server" }, { status: 500 });
    }
  }

  // Case B: channel ticket landed but the report / attachments partially
  // failed — the existing repost-report path below handles it.

  let mirrorId = row.discussion_message_id ?? await waitForDiscussionMirror(env, row.channel_message_id, 3000);

  // Legacy recovery: reports created before discussion-root capture existed cannot
  // recover the historical mirror through the Bot API. Re-post the SAME bug ticket
  // to the channel, wait for Telegram to auto-forward that new post into the linked
  // discussion group, and then continue using that new comment root. This does not
  // create a new database bug or public BUG number.
  if (!mirrorId) {
    const replacementChannelMessageId = await postChannelTicket(env, row);
    mirrorId = await waitForDiscussionMirror(env, replacementChannelMessageId, 8000);
    if (!mirrorId) return json({ ok: false, error: "discussion_mirror_missing_after_repost" }, { status: 409 });
    await setBugTelegramLinkage(env, row.id, replacementChannelMessageId, mirrorId, mirrorId);
    row = { ...row, channel_message_id: replacementChannelMessageId, discussion_message_id: mirrorId, discussion_thread_id: mirrorId };
  } else if (!row.discussion_message_id) {
    await setBugTelegramLinkage(env, row.id, row.channel_message_id, mirrorId, mirrorId);
    row = { ...row, discussion_message_id: mirrorId, discussion_thread_id: mirrorId };
  } else if (!row.discussion_thread_id) {
    await setBugTelegramLinkage(env, row.id, row.channel_message_id, row.discussion_message_id, row.discussion_message_id);
    row = { ...row, discussion_thread_id: row.discussion_message_id };
  }

  await postReportToThread(env, row, mirrorId);
  const atts = await listAttachments(env, row.id);
  for (const a of atts) {
    if (a.posted_message_id) continue;
    try {
      let posted: number | null = null;
      if (a.r2_key) {
        const obj = await env.ATTACHMENTS.get(a.r2_key);
        if (!obj) continue;
        posted = await postR2AttachmentToThread(env, row, await obj.arrayBuffer(), a.mime_type ?? "application/octet-stream", a.file_name ?? "attachment");
      } else if (a.telegram_file_id) {
        posted = await postTelegramAttachmentToThread(env, row, a.kind, a.telegram_file_id);
      }
      if (posted) await setAttachmentPostedMessage(env, a.id, posted);
    } catch (e) {
      log.error("resubmit_attachment_post_failed_nonfatal", e, {
        bugId: row.id,
        attachmentId: a.id,
        kind: a.kind,
        mime: a.mime_type,
        fileName: a.file_name,
      });
    }
  }
  return json({ ok: true });
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
