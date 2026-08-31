// Mini App API: /api/config, /api/upload, /api/submit, /api/mybugs.
// All endpoints validate Telegram initData server-side; the browser is
// never trusted to identify itself.

import { type Env, isAdmin } from "../config";
import { validateInitData } from "../telegram/initdata";
import { createBug, resendBugToTelegram, postGitHubIssuePreviewToThread, type IncomingAttachment } from "../bugs/service";
import { createIdea, resendIdeaToTelegram, type IncomingIdeaAttachment } from "../ideas/service";
import { createBetaFeedback, resendBetaFeedbackToTelegram, updateBetaFeedbackSubmission, type IncomingBetaFeedbackAttachment } from "../beta/service";
import { listIdeasByReporter, getIdea, listIdeaAttachments } from "../db/queries";
import { ideaPublicId } from "../ideas/formatting";
import { betaFeedbackPublicId } from "../beta/formatting";
import { postChannelTicket, postReportToThread, postR2AttachmentToThread, postTelegramAttachmentToThread, waitForDiscussionMirror } from "../telegram/channel";
import { createIssueForBug } from "../github/service";
import {
  getCallbackDetail,
  listCallbackRecords,
  sendManualCallbackUpdate,
  updateCallbackConfig,
} from "../callbacks/service";
import { APPS, CATEGORIES, SEVERITIES, FREQUENCIES, CATEGORY_IDS, SEVERITY_IDS, categoryMeta, type CategoryId, type SeverityId } from "../bugs/constants";
import { BUG_APP_CONFIGS, areValidBugAffectedAreas, bugAffectedAreaLabels, bugOptionLabel, isValidBugFeature } from "../bugs/app-metadata";
import { BETA_FEEDBACK_TYPE_IDS, BETA_FEEDBACK_TYPES, BETA_OVERALL_EXPERIENCE_IDS, BETA_OVERALL_EXPERIENCES, BETA_WOULD_USE_IDS, BETA_WOULD_USE_OPTIONS } from "../beta/constants";
import { IDEA_TYPE_IDS, IDEA_TYPES, ideaTypeLabel } from "../ideas/constants";
import { listBugsByReporter, getBug, listAttachments, getAttachment, setAttachmentPostedMessage, setBugTelegramLinkage, listBetaFeedbackByReporter, getBetaFeedback, listBetaFeedbackAttachments, getBetaFeedbackAttachment } from "../db/queries";
import { publicIdOf } from "../bugs/formatting";
import { getWorkRefBySubmission, listWorkHistory, type WorkHistoryFilters } from "../work/service";
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
    bug_apps: BUG_APP_CONFIGS,
    categories: CATEGORIES,
    severities: SEVERITIES,
    frequencies: FREQUENCIES,
    idea_types: IDEA_TYPES,
    beta_feedback_types: BETA_FEEDBACK_TYPES,
    beta_overall_experiences: BETA_OVERALL_EXPERIENCES,
    beta_would_use_options: BETA_WOULD_USE_OPTIONS,
  });
}

// GET /api/me — signed Telegram user context for client-side feature gates.
export async function handleMe(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try {
    ({ user } = await validateInitData(env, initData));
  } catch {
    return json({ ok: false, error: "auth" }, { status: 401 });
  }
  return json({
    ok: true,
    user: {
      id: user.id,
      username: user.username ?? null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
    },
    is_admin: isAdmin(env, user.id),
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
        category: (payload.bug_type || payload.category) as CategoryId,
        bug_type: (payload.bug_type || payload.category) as CategoryId,
        feature: payload.feature.trim(),
        affected_areas: JSON.stringify(payload.affected_areas),
        severity: payload.severity as SeverityId,
        title: deriveBugTitle(payload),
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
      row.github_sub_issue_number && row.github_sub_issue_url && row.github_repo
        ? {
            status: "created" as const,
            issue_number: row.github_sub_issue_number,
            issue_url: row.github_sub_issue_url,
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
  const userIsAdmin = isAdmin(env, user.id);
  const workRef = userIsAdmin ? await getWorkRefBySubmission(env, "idea", row.id) : null;
  return json({
    ok: true,
    idea: {
      ...row,
      public_id: ideaPublicId(row),
      idea_type_label: ideaTypeLabel(row.idea_type),
      where_it_belongs_label: bugOptionLabel(row.app, "feature", row.where_it_belongs),
      can_resubmit: userIsAdmin,
      ...(workRef ? { work_id: workRef.work_id } : {}),
    },
    attachments: atts.map((a) => ({ id: a.id, kind: a.kind, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes, posted_message_id: a.posted_message_id })),
  });
}

// POST /api/myideas/:id/resubmit — resend only this idea's Telegram delivery.
export async function handleResubmitIdea(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }

  let row = await getIdea(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  try {
    const { row: fresh, telegram } = await resendIdeaToTelegram(env, id);
    if (telegram !== "posted" || !fresh.report_message_id) {
      return json({ ok: false, error: "telegram_resubmit_failed" }, { status: 502 });
    }
    return json({
      ok: true,
      public_id: ideaPublicId(fresh),
      telegram,
      report_posted: true,
      github_created: !!fresh.github_comment_id,
      github_url: fresh.github_comment_url,
    });
  } catch (e) {
    log.error("resubmit_idea_failed", e, { ideaId: id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

// GET /api/mybeta-feedback/:id — full detail of one beta feedback submission.
export async function handleMyBetaFeedbackDetail(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  const row = await getBetaFeedback(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });
  const atts = await listBetaFeedbackAttachments(env, row.id);
  const userIsAdmin = isAdmin(env, user.id);
  const workRef = userIsAdmin ? await getWorkRefBySubmission(env, "beta", row.id) : null;
  return json({
    ok: true,
    beta_feedback: { ...row, public_id: betaFeedbackPublicId(row), can_resubmit: userIsAdmin, ...(workRef ? { work_id: workRef.work_id } : {}) },
    attachments: atts.map((a) => ({
      id: a.id,
      kind: a.kind,
      file_name: a.file_name,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      posted_message_id: a.posted_message_id,
    })),
  });
}

// POST /api/mybeta-feedback/:id/resubmit — resend this beta feedback's Telegram delivery.
export async function handleResubmitBetaFeedback(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }

  let row = await getBetaFeedback(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  try {
    const { row: fresh, telegram } = await resendBetaFeedbackToTelegram(env, id, { force: true });
    if (telegram !== "posted" || !fresh.channel_message_id || !fresh.report_message_id) {
      return json({ ok: false, error: "telegram_resubmit_failed" }, { status: 502 });
    }
    return json({
      ok: true,
      public_id: betaFeedbackPublicId(fresh),
      telegram,
      report_posted: true,
      github_created: !!fresh.github_comment_id,
      github_url: fresh.github_comment_url,
    });
  } catch (e) {
    log.error("resubmit_beta_feedback_force_repost_failed", e, { betaFeedbackId: id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

// PATCH /api/mybeta-feedback/:id — reporter edit of an existing Beta Feedback submission.
export async function handleUpdateBetaFeedback(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }

  let row = await getBetaFeedback(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });

  let payload: BetaFeedbackEditPayload;
  try { payload = (await req.json()) as BetaFeedbackEditPayload; }
  catch { return badRequest("invalid JSON"); }

  const errs = validateBetaFeedbackPayload(payload);
  if (errs.length) return badRequest(errs.join("; "));
  if (payload.keep_attachment_ids && !Array.isArray(payload.keep_attachment_ids)) {
    return badRequest("keep_attachment_ids invalid");
  }
  const keepAttachmentIds = (payload.keep_attachment_ids ?? [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const attachments = await materializeBetaFeedbackAttachments(env, payload.attachments ?? []);

  try {
    const updated = await updateBetaFeedbackSubmission(
      env,
      row.id,
      {
        reporter_tg_id: user.id,
        reporter_username: user.username ?? null,
        reporter_display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
        app: payload.app.trim(),
        app_version: nz(payload.app_version),
        app_build: nz(payload.app_build),
        testing: payload.testing.trim(),
        feedback_types: payload.feedback_types as any,
        what_did_you_do: payload.what_did_you_do.trim(),
        what_happened: payload.what_happened.trim(),
        expected_behavior: nz(payload.expected_behavior),
        overall_experience: payload.overall_experience as any,
        would_use_feature: payload.would_use_feature as any,
        changes: nz(payload.changes),
        notes: nz(payload.notes),
        keep_attachment_ids: keepAttachmentIds,
      },
      attachments,
    );
    return json({
      ok: true,
      public_id: betaFeedbackPublicId(updated),
      id: updated.id,
      telegram: { status: "updated" as const },
      github: betaFeedbackGithubResult(updated),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "too_many_attachments") return badRequest("too many attachments");
    if (msg === "forbidden") return json({ ok: false, error: "forbidden" }, { status: 403 });
    log.error("miniapp_update_beta_feedback_failed", e, { betaFeedbackId: id, user_id: user.id });
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
        idea_type: payload.idea_type as any,
        what_i_want: payload.what_i_want.trim(),
        why_useful: payload.why_useful.trim(),
        where_it_belongs: payload.where_it_belongs.trim(),
        user_flow: JSON.stringify(listPayload(payload.user_flow)),
        key_features: JSON.stringify(listPayload(payload.key_features)),
        expected_experience: payload.expected_experience.trim(),
        anything_to_avoid: nz(payload.anything_to_avoid),
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

// POST /api/submit-beta-feedback — creates Beta Feedback (Telegram + GitHub Discussion).
export async function handleSubmitBetaFeedback(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try {
    ({ user } = await validateInitData(env, initData));
  } catch { return json({ ok: false, error: "auth" }, { status: 401 }); }

  let payload: BetaFeedbackSubmitPayload;
  try { payload = (await req.json()) as BetaFeedbackSubmitPayload; }
  catch { return badRequest("invalid JSON"); }

  const errs = validateBetaFeedbackPayload(payload);
  if (errs.length) return badRequest(errs.join("; "));

  const attachments = await materializeBetaFeedbackAttachments(env, payload.attachments ?? []);

  try {
    const row = await createBetaFeedback(
      env,
      {
        reporter_tg_id: user.id,
        reporter_username: user.username ?? null,
        reporter_display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
        app: payload.app.trim(),
        app_version: nz(payload.app_version),
        app_build: nz(payload.app_build),
        testing: payload.testing.trim(),
        feedback_types: payload.feedback_types as any,
        what_did_you_do: payload.what_did_you_do.trim(),
        what_happened: payload.what_happened.trim(),
        expected_behavior: nz(payload.expected_behavior),
        overall_experience: payload.overall_experience as any,
        would_use_feature: payload.would_use_feature as any,
        changes: nz(payload.changes),
        notes: nz(payload.notes),
      },
      attachments,
    );
    return json({
      ok: true,
      public_id: betaFeedbackPublicId(row),
      id: row.id,
      telegram: { status: "sent" as const },
      github: betaFeedbackGithubResult(row),
    });
  } catch (e) {
    log.error("miniapp_submit_beta_feedback_failed", e, { user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

interface BetaFeedbackSubmitPayload {
  app: string;
  app_version?: string;
  app_build?: string;
  testing: string;
  feedback_types: string[];
  what_did_you_do: string;
  what_happened: string;
  expected_behavior?: string;
  overall_experience: string;
  would_use_feature: string;
  changes?: string;
  notes?: string;
  attachments?: { key: string; name: string; mime: string; size?: number }[];
  submit_token?: string;
}

interface BetaFeedbackEditPayload extends BetaFeedbackSubmitPayload {
  keep_attachment_ids?: number[];
}

function validateBetaFeedbackPayload(p: BetaFeedbackSubmitPayload): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["invalid body"];
  if (!p.app?.trim()) errs.push("app is required");
  if (!p.testing?.trim()) errs.push("testing is required");
  if (!Array.isArray(p.feedback_types) || !p.feedback_types.length) errs.push("feedback_types is required");
  else if (p.feedback_types.some((id) => !(BETA_FEEDBACK_TYPE_IDS as readonly string[]).includes(id))) {
    errs.push("feedback_types invalid");
  }
  if (!p.what_did_you_do?.trim()) errs.push("what_did_you_do is required");
  if (!p.what_happened?.trim()) errs.push("what_happened is required");
  if (!(BETA_OVERALL_EXPERIENCE_IDS as readonly string[]).includes(p.overall_experience)) errs.push("overall_experience invalid");
  if (!(BETA_WOULD_USE_IDS as readonly string[]).includes(p.would_use_feature)) errs.push("would_use_feature invalid");
  for (const k of ["testing", "what_did_you_do", "what_happened", "expected_behavior", "changes", "notes"] as const) {
    const v = p[k];
    if (v && v.length > MAX_TEXT_LEN) errs.push(`${k} too long`);
  }
  if ((p.attachments?.length ?? 0) > MAX_ATTACHMENTS) errs.push("too many attachments");
  return errs;
}

async function materializeBetaFeedbackAttachments(
  env: Env,
  payloadAttachments: { key: string; name: string; mime: string; size?: number }[],
): Promise<IncomingBetaFeedbackAttachment[]> {
  const attachments: IncomingBetaFeedbackAttachment[] = [];
  for (const a of payloadAttachments) {
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
  return attachments;
}

function betaFeedbackGithubResult(row: {
  github_comment_id?: string | null;
  github_comment_url?: string | null;
  github_status?: string | null;
  github_error?: string | null;
}) {
  return row.github_comment_id && row.github_comment_url
    ? { status: "created" as const, comment_id: row.github_comment_id, comment_url: row.github_comment_url }
    : row.github_status === "skipped_no_mapping"
    ? { status: "skipped_no_mapping" as const, reason: row.github_error ?? null }
    : row.github_status === "skipped_disabled"
    ? { status: "skipped_disabled" as const, reason: row.github_error ?? null }
    : row.github_status === "failed"
    ? { status: "failed" as const, reason: row.github_error ?? null }
    : { status: "not_attempted" as const };
}

export async function handleBetaFeedbackAttachment(env: Env, req: Request, attachmentId: number): Promise<Response> {
  const row = await getBetaFeedbackAttachment(env, attachmentId);
  return serveStoredAttachment(env, req, row, attachmentId);
}

export async function handleBugAttachment(env: Env, req: Request, attachmentId: number): Promise<Response> {
  const row = await getAttachment(env, attachmentId);
  return serveStoredAttachment(env, req, row, attachmentId);
}

async function serveStoredAttachment(
  env: Env,
  req: Request,
  row: { id: number; r2_key: string | null; file_name: string | null; mime_type: string | null; kind: string } | null,
  attachmentId: number,
): Promise<Response> {
  if (!row?.r2_key) return new Response("not found", { status: 404 });
  const obj = await env.ATTACHMENTS.get(row.r2_key);
  if (!obj?.body) return new Response("not found", { status: 404 });
  const name = row.file_name || `attachment-${attachmentId}`;
  const mime = row.mime_type || obj.httpMetadata?.contentType || "application/octet-stream";
  const wantsRounded = new URL(req.url).searchParams.get("variant") === "rounded";
  if (wantsRounded && mime.toLowerCase().startsWith("image/")) {
    const bytes = await obj.arrayBuffer();
    return new Response(roundedImageSvg(bytes, mime, name), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "content-disposition": `inline; filename="${sanitizeHeaderValue(name)}.svg"`,
      },
    });
  }
  return new Response(obj.body, {
    headers: {
      "content-type": mime,
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `inline; filename="${sanitizeHeaderValue(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}

function roundedImageSvg(bytes: ArrayBuffer, mime: string, name: string): string {
  const dims = imageDimensions(bytes, mime) ?? { width: 1, height: 1 };
  const radius = Math.max(1, Math.round(Math.min(dims.width, dims.height) * 0.055));
  const base64 = arrayBufferToBase64(bytes);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dims.width}" height="${dims.height}" viewBox="0 0 ${dims.width} ${dims.height}">`,
    "  <defs>",
    `    <clipPath id="r"><rect x="0" y="0" width="${dims.width}" height="${dims.height}" rx="${radius}" ry="${radius}"/></clipPath>`,
    "  </defs>",
    `  <image href="data:${sanitizeSvgMime(mime)};base64,${base64}" width="${dims.width}" height="${dims.height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)">`,
    `    <title>${escapeSvgText(name)}</title>`,
    "  </image>",
    "</svg>",
  ].join("\n");
}

function imageDimensions(bytes: ArrayBuffer, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes);
  const lowerMime = mime.toLowerCase();
  if (lowerMime.includes("png") && bytes.byteLength >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (lowerMime.includes("gif") && bytes.byteLength >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (lowerMime.includes("jpeg") || lowerMime.includes("jpg")) {
    return jpegDimensions(view);
  }
  return null;
}

function jpegDimensions(view: DataView): { width: number; height: number } | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (size < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + size;
  }
  return null;
}

function arrayBufferToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  const chunk = 0x8000;
  const data = new Uint8Array(bytes);
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sanitizeSvgMime(mime: string): string {
  return /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/png";
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface IdeaSubmitPayload {
  app: string;
  title: string;
  idea_type: string;
  what_i_want: string;
  why_useful: string;
  where_it_belongs: string;
  user_flow: string[];
  key_features: string[];
  expected_experience: string;
  anything_to_avoid?: string;
  notes?: string;
  attachments?: { key: string; name: string; mime: string; size?: number }[];
  submit_token?: string;
}

function validateIdeaPayload(p: IdeaSubmitPayload): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object") return ["invalid body"];
  if (!p.app?.trim()) errs.push("app is required");
  if (!p.title?.trim()) errs.push("title is required");
  if (!(IDEA_TYPE_IDS as readonly string[]).includes(p.idea_type)) errs.push("idea_type invalid");
  if (!p.what_i_want?.trim()) errs.push("what_i_want is required");
  if (!p.why_useful?.trim()) errs.push("why_useful is required");
  if (!p.where_it_belongs?.trim() || !isValidBugFeature(p.app, p.where_it_belongs)) errs.push("where_it_belongs invalid");
  if (!listPayload(p.user_flow).length) errs.push("user_flow is required");
  if (!listPayload(p.key_features).length) errs.push("key_features is required");
  if (!p.expected_experience?.trim()) errs.push("expected_experience is required");
  if (p.title && p.title.length > MAX_TITLE_LEN) errs.push("title too long");
  for (const k of ["what_i_want", "why_useful", "expected_experience", "anything_to_avoid", "notes"] as const) {
    const v = p[k];
    if (v && v.length > MAX_TEXT_LEN) errs.push(`${k} too long`);
  }
  for (const [key, values] of [["user_flow", listPayload(p.user_flow)], ["key_features", listPayload(p.key_features)]] as const) {
    if (values.length > 30) errs.push(`${key} too many entries`);
    if (values.some((v) => v.length > MAX_TEXT_LEN)) errs.push(`${key} entry too long`);
  }
  if ((p.attachments?.length ?? 0) > MAX_ATTACHMENTS) errs.push("too many attachments");
  return errs;
}

function listPayload(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
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
  const [bugRows, ideaRows, betaRows] = await Promise.all([
    listBugsByReporter(env, user.id, 50),
    listIdeasByReporter(env, user.id, 50),
    listBetaFeedbackByReporter(env, user.id, 50),
  ]);
  const canResubmit = isAdmin(env, user.id);
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
        severity: r.severity,
        category: r.category,
        bug_type: r.bug_type ?? r.category,
        bug_type_label: categoryMeta(r.bug_type ?? r.category).label,
        feature: r.feature,
        feature_label: bugOptionLabel(r.app, "feature", r.feature),
        affected_areas: r.affected_areas,
        affected_area_labels: bugAffectedAreaLabels(r.app, r.affected_areas),
        created_at: r.created_at,
        telegram_posted: !!r.channel_message_id,
        report_posted: !!r.report_message_id,
        can_resubmit: canResubmit,
        github_created: !!r.github_sub_issue_number,
        github_url: r.github_sub_issue_url ?? r.github_issue_url,
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
        can_resubmit: canResubmit,
        github_created: !!r.github_comment_id,
        github_url: r.github_comment_url,
      })),
      ...betaRows.map((r) => ({
        type: "beta" as const,
        id: r.id,
        public_id: betaFeedbackPublicId(r),
        title: r.testing,
        app: r.app,
        status: r.status,
        created_at: r.created_at,
        telegram_posted: !!r.channel_message_id,
        report_posted: !!r.report_message_id,
        can_resubmit: canResubmit,
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
      bug_type: r.bug_type ?? r.category,
      bug_type_label: categoryMeta(r.bug_type ?? r.category).label,
      feature: r.feature,
      feature_label: bugOptionLabel(r.app, "feature", r.feature),
      affected_areas: r.affected_areas,
      affected_area_labels: bugAffectedAreaLabels(r.app, r.affected_areas),
      created_at: r.created_at,
      // Delivery state — history rows use these to decide whether to
      // render the "Resend to Telegram" affordance.
      telegram_posted: !!r.channel_message_id,
      report_posted:   !!r.report_message_id,
      can_resubmit:    canResubmit,
      github_created:  !!r.github_sub_issue_number,
      github_url:      r.github_sub_issue_url ?? r.github_issue_url,
    })),
  });
}

export async function handleCallbacksList(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  try {
    const callbacks = await listCallbackRecords(env);
    return json({ ok: true, callbacks });
  } catch (e) {
    log.error("callbacks_list_failed", e, { user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function handleWorkHistory(env: Env, req: Request): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const filters: WorkHistoryFilters = {};
  const type = url.searchParams.get("type");
  if (type === "bug" || type === "idea" || type === "beta") filters.submission_type = type;
  const app = url.searchParams.get("app");
  if (app) filters.app = app;
  const assignee = url.searchParams.get("assignee");
  if (assignee) filters.assignee = assignee;
  const eventType = url.searchParams.get("event_type");
  if (eventType) filters.event_type = eventType;
  const state = url.searchParams.get("state");
  if (state) filters.activity_state = state;
  const search = url.searchParams.get("q");
  if (search) filters.search = search;

  try {
    const entries = await listWorkHistory(env, filters);
    return json({
      ok: true,
      entries,
      filters: {
        apps: unique(entries.map((e) => e.app)),
        assignees: unique(entries.map((e) => e.assigned_username).filter(Boolean) as string[]),
        event_types: unique(entries.map((e) => e.event_type)),
        states: unique(entries.map((e) => e.activity_status).filter(Boolean) as string[]),
      },
    });
  } catch (e) {
    log.error("work_history_failed", e, { user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function handleCallbackDetail(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  try {
    const detail = await getCallbackDetail(env, id);
    if (!detail.record) return json({ ok: false, error: "not_found" }, { status: 404 });
    return json({ ok: true, ...detail });
  } catch (e) {
    log.error("callback_detail_failed", e, { callbackId: id, user_id: user.id });
    return json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function handleUpdateCallback(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  let payload: unknown;
  try { payload = await req.json(); }
  catch { return badRequest("invalid JSON"); }
  const p = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const record = await updateCallbackConfig(env, id, {
    followup_destination: p.followup_destination === "channel" || p.followup_destination === "dm" ? p.followup_destination : undefined,
    followup_message: typeof p.followup_message === "string" ? p.followup_message : undefined,
    followup_message_html: typeof p.followup_message_html === "string" ? p.followup_message_html : p.followup_message_html === null ? null : undefined,
    followup_message_doc: typeof p.followup_message_doc === "string" ? p.followup_message_doc : p.followup_message_doc === null ? null : undefined,
    followup_enabled: typeof p.followup_enabled === "boolean" ? p.followup_enabled : undefined,
    active: typeof p.active === "boolean" ? p.active : undefined,
  });
  if (!record) return json({ ok: false, error: "not_found" }, { status: 404 });
  return json({ ok: true, record });
}

export async function handleSendCallbackUpdate(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

  let payload: unknown;
  try { payload = await req.json(); }
  catch { return badRequest("invalid JSON"); }
  const p = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const message = typeof p.message === "string" ? p.message : "";
  const message_html = typeof p.message_html === "string" ? p.message_html : null;
  const message_doc = typeof p.message_doc === "string" ? p.message_doc : null;
  const destination =
    p.destination === "channel" || p.destination === "dm" || p.destination === "github"
      ? p.destination
      : undefined;
  const recipient_user_id = typeof p.recipient_user_id === "number"
    ? p.recipient_user_id
    : typeof p.recipient_user_id === "string" && p.recipient_user_id
    ? Number(p.recipient_user_id)
    : null;
  const result = await sendManualCallbackUpdate(env, id, {
    message,
    message_html,
    message_doc,
    destination,
    recipient_user_id,
    sent_by_tg_id: user.id,
  });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "message_required" ? 400 : 502;
    return json({ ok: false, error: result.error ?? "send_failed" }, { status });
  }
  const detail = await getCallbackDetail(env, id);
  return json({ ok: true, ...detail });
}

export async function handleMyBugDetail(env: Env, req: Request, id: number): Promise<Response> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  let user;
  try { ({ user } = await validateInitData(env, initData)); }
  catch { return json({ ok: false, error: "auth" }, { status: 401 }); }
  const row = await getBug(env, id);
  if (!row || row.reporter_tg_id !== user.id) return json({ ok: false, error: "not_found" }, { status: 404 });
  const atts = await listAttachments(env, row.id);
  const userIsAdmin = isAdmin(env, user.id);
  const workRef = userIsAdmin ? await getWorkRefBySubmission(env, "bug", row.id) : null;
  return json({
    ok: true,
    bug: {
      ...row,
      public_id: publicIdOf(row),
      bug_type_label: categoryMeta(row.bug_type ?? row.category).label,
      feature_label: bugOptionLabel(row.app, "feature", row.feature),
      affected_area_labels: bugAffectedAreaLabels(row.app, row.affected_areas),
      github_url: row.github_sub_issue_url ?? row.github_issue_url,
      can_resubmit: userIsAdmin,
      ...(workRef ? { work_id: workRef.work_id } : {}),
    },
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
  if (!isAdmin(env, user.id)) return json({ ok: false, error: "forbidden" }, { status: 403 });

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
        github_created: !!fresh.github_sub_issue_number,
        github_url: fresh.github_sub_issue_url ?? fresh.github_issue_url,
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

  const reportMessage = await postReportToThread(env, row, mirrorId);
  if (!reportMessage) {
    return json({ ok: false, error: "telegram_resubmit_failed" }, { status: 502 });
  }
  row = { ...row, report_message_id: reportMessage.message_id };
  const atts = await listAttachments(env, row.id);
  for (const a of atts) {
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

  try {
    await createIssueForBug(env, row.id);
    const fresh = await getBug(env, row.id);
    if (fresh?.github_sub_issue_url || fresh?.github_issue_url) {
      await postGitHubIssuePreviewToThread(env, {
        ...fresh,
        report_message_id: row.report_message_id,
      }, fresh.github_sub_issue_url ?? fresh.github_issue_url ?? undefined);
    }
  } catch (e) {
    log.warn("resubmit_github_preview_failed", { bugId: row.id, err: String(e) });
  }

  const finalRow = (await getBug(env, row.id)) ?? row;
  return json({
    ok: true,
    public_id: publicIdOf(finalRow),
    telegram: "posted",
    report_posted: true,
    github_created: !!finalRow.github_sub_issue_number,
    github_url: finalRow.github_sub_issue_url ?? finalRow.github_issue_url,
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
  bug_type: string;
  feature: string;
  affected_areas: string[];
  severity: string;
  title?: string;
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
  if (!nonEmpty(p.app_version)) errs.push("version is required");
  if (!nonEmpty(p.app_build)) errs.push("build is required");
  if (!nonEmpty(p.device)) errs.push("device is required");
  if (!nonEmpty(p.os)) errs.push("os is required");
  if (!nonEmpty(p.feature) || !isValidBugFeature(p.app, p.feature)) errs.push("feature invalid");
  if (!Array.isArray(p.affected_areas) || !areValidBugAffectedAreas(p.app, p.affected_areas)) errs.push("affected_areas invalid");
  const bugType = p.bug_type || p.category;
  if (!bugType || !(CATEGORY_IDS as readonly string[]).includes(bugType)) errs.push("bug_type invalid");
  if (!nonEmpty(p.actual_behavior)) errs.push("actual_behavior is required");
  if (!nonEmpty(p.expected_behavior)) errs.push("expected_behavior is required");
  if (!nonEmpty(p.reproduction_steps)) errs.push("reproduction_steps is required");
  if (!p.frequency) errs.push("frequency is required");
  if (p.category && !(CATEGORY_IDS as readonly string[]).includes(p.category)) errs.push("category invalid");
  if (!(SEVERITY_IDS as readonly string[]).includes(p.severity)) errs.push("severity invalid");
  if (p.frequency && !(FREQUENCIES.map((f) => f.id) as readonly string[]).includes(p.frequency)) errs.push("frequency invalid");
  if (p.title && p.title.length > MAX_TITLE_LEN) errs.push("title too long");
  for (const k of ["actual_behavior", "expected_behavior", "reproduction_steps", "notes"] as const) {
    const v = p[k];
    if (v && v.length > MAX_TEXT_LEN) errs.push(`${k} too long`);
  }
  if ((p.attachments?.length ?? 0) > MAX_ATTACHMENTS) errs.push("too many attachments");
  return errs;
}

function deriveBugTitle(p: SubmitPayload): string {
  const basis = (p.actual_behavior || p.expected_behavior || "Bug report").trim().replace(/\s+/g, " ");
  return basis.length > MAX_TITLE_LEN ? basis.slice(0, MAX_TITLE_LEN - 1) + "…" : basis;
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}
function nz(s: unknown): string | null {
  return typeof s === "string" && s.trim() ? s.trim() : null;
}
function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
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

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\r\n\\]+/g, "_").slice(0, 180) || "attachment";
}
