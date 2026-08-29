import type { Env } from "../config";
import type {
  BugRow,
  AttachmentRow,
  StatusHistoryRow,
  NewBugInput,
  NewAttachmentInput,
} from "./types";
import type { StatusId } from "../bugs/constants";
import type { BetaStatusId } from "../beta/constants";

// ── Sequence ────────────────────────────────────────────────
// Atomically increment the 'bug' sequence and return the new value.
// UPDATE ... RETURNING is a single statement, so it is atomic under D1
// (SQLite serializes writes) — two concurrent submissions cannot collide.
export async function nextBugNumber(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `UPDATE sequences SET value = value + 1 WHERE name = 'bug'
     RETURNING value AS n`,
  ).first<{ n: number }>();
  if (!row) throw new Error("sequences.bug row missing — did you run schema.sql?");
  return row.n;
}

// ── Bugs ────────────────────────────────────────────────────
export async function insertBug(env: Env, input: NewBugInput, publicNumber: number): Promise<BugRow> {
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    `INSERT INTO bugs (
       public_number, reporter_tg_id, reporter_username, reporter_display_name,
       app, app_version, app_build, device, os,
       category, severity, title, actual_behavior, expected_behavior,
       reproduction_steps, frequency, notes,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
     RETURNING *`,
  ).bind(
    publicNumber,
    input.reporter_tg_id,
    input.reporter_username ?? null,
    input.reporter_display_name ?? null,
    input.app,
    input.app_version ?? null,
    input.app_build ?? null,
    input.device ?? null,
    input.os ?? null,
    input.category,
    input.severity,
    input.title,
    input.actual_behavior,
    input.expected_behavior ?? null,
    input.reproduction_steps ?? null,
    input.frequency ?? null,
    input.notes ?? null,
    now,
    now,
  );
  const row = await stmt.first<BugRow>();
  if (!row) throw new Error("insertBug: no row returned");
  return row;
}

export async function setBugTelegramLinkage(
  env: Env,
  bugId: number,
  channelMessageId: number,
  discussionMessageId: number | null,
  discussionThreadId: number | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE bugs SET
       channel_message_id    = ?,
       discussion_message_id = ?,
       discussion_thread_id  = ?,
       updated_at            = ?
     WHERE id = ?`,
  )
    .bind(channelMessageId, discussionMessageId, discussionThreadId, Math.floor(Date.now() / 1000), bugId)
    .run();
}

export async function getBug(env: Env, id: number): Promise<BugRow | null> {
  return await env.DB.prepare(`SELECT * FROM bugs WHERE id = ?`).bind(id).first<BugRow>();
}

export async function getBugByPublicNumber(env: Env, n: number): Promise<BugRow | null> {
  return await env.DB.prepare(`SELECT * FROM bugs WHERE public_number = ?`).bind(n).first<BugRow>();
}

export async function updateBugStatus(
  env: Env,
  bugId: number,
  toStatus: StatusId,
  changedBy: number | null,
  note?: string | null,
): Promise<{ from: StatusId | null; to: StatusId } | null> {
  const current = await getBug(env, bugId);
  if (!current) return null;
  const from = current.status;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?`).bind(toStatus, now, bugId),
    env.DB.prepare(
      `INSERT INTO status_history (bug_id, from_status, to_status, changed_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(bugId, from, toStatus, changedBy, note ?? null, now),
  ]);
  return { from, to: toStatus };
}

export async function updateBugSeverity(env: Env, bugId: number, sev: string) {
  await env.DB.prepare(`UPDATE bugs SET severity = ?, updated_at = ? WHERE id = ?`)
    .bind(sev, Math.floor(Date.now() / 1000), bugId)
    .run();
}

export async function updateBugCategory(env: Env, bugId: number, cat: string) {
  await env.DB.prepare(`UPDATE bugs SET category = ?, updated_at = ? WHERE id = ?`)
    .bind(cat, Math.floor(Date.now() / 1000), bugId)
    .run();
}

export async function updateBugFixedInfo(env: Env, bugId: number, version: string | null, build: string | null) {
  await env.DB.prepare(
    `UPDATE bugs SET fixed_in_version = ?, fixed_in_build = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(version, build, Math.floor(Date.now() / 1000), bugId)
    .run();
}

export async function markDuplicate(env: Env, bugId: number, ofId: number) {
  await env.DB.prepare(`UPDATE bugs SET duplicate_of_id = ?, updated_at = ? WHERE id = ?`)
    .bind(ofId, Math.floor(Date.now() / 1000), bugId)
    .run();
}

export async function listBugsByReporter(env: Env, tgUserId: number, limit = 25): Promise<BugRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM bugs WHERE reporter_tg_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(tgUserId, limit)
    .all<BugRow>();
  return results ?? [];
}

// ── Attachments ─────────────────────────────────────────────
export async function insertAttachment(env: Env, a: NewAttachmentInput): Promise<AttachmentRow> {
  const row = await env.DB.prepare(
    `INSERT INTO attachments (bug_id, kind, telegram_file_id, r2_key, mime_type, file_name, size_bytes, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      a.bug_id,
      a.kind,
      a.telegram_file_id ?? null,
      a.r2_key ?? null,
      a.mime_type ?? null,
      a.file_name ?? null,
      a.size_bytes ?? null,
      a.width ?? null,
      a.height ?? null,
    )
    .first<AttachmentRow>();
  if (!row) throw new Error("insertAttachment: no row returned");
  return row;
}

export async function setAttachmentPostedMessage(env: Env, attachmentId: number, messageId: number) {
  await env.DB.prepare(`UPDATE attachments SET posted_message_id = ? WHERE id = ?`)
    .bind(messageId, attachmentId)
    .run();
}

export async function listAttachments(env: Env, bugId: number): Promise<AttachmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM attachments WHERE bug_id = ? ORDER BY id ASC`,
  )
    .bind(bugId)
    .all<AttachmentRow>();
  return results ?? [];
}

export async function getAttachment(env: Env, id: number): Promise<AttachmentRow | null> {
  return await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?`).bind(id).first<AttachmentRow>();
}

// ── Status history ──────────────────────────────────────────
export async function listStatusHistory(env: Env, bugId: number): Promise<StatusHistoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM status_history WHERE bug_id = ? ORDER BY id ASC`,
  )
    .bind(bugId)
    .all<StatusHistoryRow>();
  return results ?? [];
}

// Clear channel/discussion linkage so a "force resend" can post fresh
// Telegram messages without doubling the channel ticket.
export async function clearBugTelegramLinkage(env: Env, bugId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE bugs SET
       channel_message_id    = NULL,
       discussion_message_id = NULL,
       discussion_thread_id  = NULL,
       report_message_id     = NULL,
       updated_at            = ?
     WHERE id = ?`,
  )
    .bind(Math.floor(Date.now() / 1000), bugId)
    .run();
  // Also clear posted_message_id so we can retry attachment posts cleanly.
  await env.DB.prepare(`UPDATE attachments SET posted_message_id = NULL WHERE bug_id = ?`)
    .bind(bugId)
    .run();
}

// ── Rich Message report id ──────────────────────────────────
export async function setReportMessageId(env: Env, bugId: number, messageId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE bugs SET report_message_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(messageId, Math.floor(Date.now() / 1000), bugId)
    .run();
}

// ── GitHub action idempotency ───────────────────────────────
// Returns true if we successfully claimed the action key (safe to run the
// GitHub side-effect now); false if it was already claimed by a prior
// invocation and the side-effect must be skipped.
export async function claimGitHubActionKey(env: Env, bugId: number, actionKey: string): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT INTO github_actions (bug_id, action_key) VALUES (?, ?)`,
    )
      .bind(bugId, actionKey)
      .run();
    return true;
  } catch {
    return false; // UNIQUE violation → already synced
  }
}

// ── GitHub cross-reference persistence ──────────────────────
// Set only the columns you pass; null explicitly clears a column
// (`github_error` clearing is used after a successful create).
export interface GitHubMetaPatch {
  github_repo?: string | null;
  github_issue_number?: number | null;
  github_issue_url?: string | null;
  github_status?: string | null;
  github_error?: string | null;
  github_created_at?: number | null;
}

export async function saveGitHubMeta(env: Env, bugId: number, patch: GitHubMetaPatch): Promise<void> {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  if (!cols.length) return;
  cols.push(`updated_at = ?`);
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(bugId);
  await env.DB.prepare(`UPDATE bugs SET ${cols.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

// ── Feature Ideas ───────────────────────────────────────
import type { IdeaRow, IdeaAttachmentRow, NewIdeaInput } from "./types";

export async function nextIdeaNumber(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `UPDATE sequences SET value = value + 1 WHERE name = 'idea' RETURNING value AS n`,
  ).first<{ n: number }>();
  if (!row) throw new Error("sequences.idea missing — run migrations/003_ideas.sql");
  return row.n;
}

export async function insertIdea(env: Env, input: NewIdeaInput, publicNumber: number): Promise<IdeaRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO ideas (
       public_number, reporter_tg_id, reporter_username, reporter_display_name,
       app, title, what_i_want, why_useful, how_it_works, where_it_belongs, notes,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
     RETURNING *`,
  )
    .bind(
      publicNumber,
      input.reporter_tg_id,
      input.reporter_username ?? null,
      input.reporter_display_name ?? null,
      input.app,
      input.title,
      input.what_i_want,
      input.why_useful ?? null,
      input.how_it_works ?? null,
      input.where_it_belongs ?? null,
      input.notes ?? null,
      now,
      now,
    )
    .first<IdeaRow>();
  if (!row) throw new Error("insertIdea: no row");
  return row;
}

export async function getIdea(env: Env, id: number): Promise<IdeaRow | null> {
  return await env.DB.prepare(`SELECT * FROM ideas WHERE id = ?`).bind(id).first<IdeaRow>();
}

export async function listIdeasByReporter(env: Env, tgUserId: number, limit = 50): Promise<IdeaRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ideas WHERE reporter_tg_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(tgUserId, limit)
    .all<IdeaRow>();
  return results ?? [];
}

export async function setIdeaTelegramLinkage(
  env: Env,
  ideaId: number,
  channelMessageId: number,
  discussionMessageId: number | null,
  discussionThreadId: number | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ideas SET channel_message_id=?, discussion_message_id=?, discussion_thread_id=?, updated_at=? WHERE id=?`,
  )
    .bind(channelMessageId, discussionMessageId, discussionThreadId, Math.floor(Date.now() / 1000), ideaId)
    .run();
}

export async function setIdeaReportMessageId(env: Env, ideaId: number, messageId: number): Promise<void> {
  await env.DB.prepare(`UPDATE ideas SET report_message_id=?, updated_at=? WHERE id=?`)
    .bind(messageId, Math.floor(Date.now() / 1000), ideaId)
    .run();
}

export async function clearIdeaTelegramLinkage(env: Env, ideaId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE ideas SET
       channel_message_id = NULL,
       discussion_message_id = NULL,
       discussion_thread_id = NULL,
       report_message_id = NULL,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(Math.floor(Date.now() / 1000), ideaId)
    .run();
  await env.DB.prepare(`UPDATE idea_attachments SET posted_message_id = NULL WHERE idea_id = ?`)
    .bind(ideaId)
    .run();
}

export interface IdeaGitHubPatch {
  github_repo?: string | null;
  github_discussion_id?: string | null;
  github_discussion_url?: string | null;
  github_comment_id?: string | null;
  github_comment_url?: string | null;
  github_status?: string | null;
  github_error?: string | null;
  github_created_at?: number | null;
}

export async function saveIdeaGitHubMeta(env: Env, ideaId: number, patch: IdeaGitHubPatch): Promise<void> {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  if (!cols.length) return;
  cols.push(`updated_at = ?`);
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(ideaId);
  await env.DB.prepare(`UPDATE ideas SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function updateIdeaStatus(
  env: Env,
  ideaId: number,
  toStatus: string,
  changedBy: number | null,
  reason: string | null,
): Promise<{ from: string; to: string } | null> {
  const cur = await getIdea(env, ideaId);
  if (!cur) return null;
  const from = cur.status;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE ideas SET status=?, decision_reason=COALESCE(?, decision_reason), updated_at=? WHERE id=?`)
      .bind(toStatus, reason, now, ideaId),
    env.DB.prepare(
      `INSERT INTO idea_status_history (idea_id, from_status, to_status, changed_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(ideaId, from, toStatus, changedBy, reason, now),
  ]);
  return { from, to: toStatus };
}

export async function insertIdeaAttachment(env: Env, a: {
  idea_id: number; kind: IdeaAttachmentRow["kind"]; telegram_file_id?: string | null;
  r2_key?: string | null; mime_type?: string | null; file_name?: string | null;
  size_bytes?: number | null; width?: number | null; height?: number | null;
}): Promise<IdeaAttachmentRow> {
  const row = await env.DB.prepare(
    `INSERT INTO idea_attachments (idea_id, kind, telegram_file_id, r2_key, mime_type, file_name, size_bytes, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(
    a.idea_id, a.kind, a.telegram_file_id ?? null, a.r2_key ?? null,
    a.mime_type ?? null, a.file_name ?? null, a.size_bytes ?? null,
    a.width ?? null, a.height ?? null,
  ).first<IdeaAttachmentRow>();
  if (!row) throw new Error("insertIdeaAttachment: no row");
  return row;
}

export async function listIdeaAttachments(env: Env, ideaId: number): Promise<IdeaAttachmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM idea_attachments WHERE idea_id=? ORDER BY id ASC`,
  ).bind(ideaId).all<IdeaAttachmentRow>();
  return results ?? [];
}

export async function setIdeaAttachmentPostedMessage(env: Env, id: number, messageId: number): Promise<void> {
  await env.DB.prepare(`UPDATE idea_attachments SET posted_message_id=? WHERE id=?`)
    .bind(messageId, id).run();
}

// ── Beta Feedback ──────────────────────────────────────
import type { BetaFeedbackRow, BetaFeedbackAttachmentRow, BetaFeedbackRevisionRow, NewBetaFeedbackInput } from "./types";

export async function nextBetaFeedbackNumber(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `UPDATE sequences SET value = value + 1 WHERE name = 'beta' RETURNING value AS n`,
  ).first<{ n: number }>();
  if (!row) throw new Error("sequences.beta missing — run migrations/004_beta_feedback.sql");
  return row.n;
}

export async function insertBetaFeedback(
  env: Env,
  input: NewBetaFeedbackInput,
  publicNumber: number,
): Promise<BetaFeedbackRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO beta_feedback (
       public_number, reporter_tg_id, reporter_username, reporter_display_name,
       app, app_version, app_build, testing, feedback_types,
       what_did_you_do, what_happened, expected_behavior,
       overall_experience, would_use_feature, changes, notes,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
     RETURNING *`,
  )
    .bind(
      publicNumber,
      input.reporter_tg_id,
      input.reporter_username ?? null,
      input.reporter_display_name ?? null,
      input.app,
      input.app_version ?? null,
      input.app_build ?? null,
      input.testing,
      JSON.stringify(input.feedback_types),
      input.what_did_you_do,
      input.what_happened,
      input.expected_behavior ?? null,
      input.overall_experience,
      input.would_use_feature,
      input.changes ?? null,
      input.notes ?? null,
      now,
      now,
    )
    .first<BetaFeedbackRow>();
  if (!row) throw new Error("insertBetaFeedback: no row");
  return row;
}

export async function getBetaFeedback(env: Env, id: number): Promise<BetaFeedbackRow | null> {
  return await env.DB.prepare(`SELECT * FROM beta_feedback WHERE id = ?`).bind(id).first<BetaFeedbackRow>();
}

export async function listBetaFeedbackByReporter(env: Env, tgUserId: number, limit = 50): Promise<BetaFeedbackRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM beta_feedback WHERE reporter_tg_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(tgUserId, limit)
    .all<BetaFeedbackRow>();
  return results ?? [];
}

export async function setBetaFeedbackTelegramLinkage(
  env: Env,
  betaFeedbackId: number,
  channelMessageId: number,
  discussionMessageId: number | null,
  discussionThreadId: number | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE beta_feedback SET channel_message_id=?, discussion_message_id=?, discussion_thread_id=?, updated_at=? WHERE id=?`,
  )
    .bind(channelMessageId, discussionMessageId, discussionThreadId, Math.floor(Date.now() / 1000), betaFeedbackId)
    .run();
}

export async function setBetaFeedbackReportMessageId(
  env: Env,
  betaFeedbackId: number,
  messageId: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE beta_feedback SET report_message_id=?, updated_at=? WHERE id=?`)
    .bind(messageId, Math.floor(Date.now() / 1000), betaFeedbackId)
    .run();
}

export async function setBetaFeedbackGitHubPreviewMessageId(
  env: Env,
  betaFeedbackId: number,
  messageId: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE beta_feedback SET github_preview_message_id=?, updated_at=? WHERE id=?`)
    .bind(messageId, Math.floor(Date.now() / 1000), betaFeedbackId)
    .run();
}

export async function clearBetaFeedbackTelegramLinkage(env: Env, betaFeedbackId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE beta_feedback SET
       channel_message_id = NULL,
       discussion_message_id = NULL,
       discussion_thread_id = NULL,
       report_message_id = NULL,
       github_preview_message_id = NULL,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(Math.floor(Date.now() / 1000), betaFeedbackId)
    .run();
  await env.DB.prepare(`UPDATE beta_feedback_attachments SET posted_message_id = NULL WHERE beta_feedback_id = ?`)
    .bind(betaFeedbackId)
    .run();
}

export interface BetaFeedbackGitHubPatch {
  github_repo?: string | null;
  github_discussion_id?: string | null;
  github_discussion_url?: string | null;
  github_comment_id?: string | null;
  github_comment_url?: string | null;
  github_status?: string | null;
  github_error?: string | null;
  github_created_at?: number | null;
}

export async function saveBetaFeedbackGitHubMeta(
  env: Env,
  betaFeedbackId: number,
  patch: BetaFeedbackGitHubPatch,
): Promise<void> {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  if (!cols.length) return;
  cols.push(`updated_at = ?`);
  vals.push(Math.floor(Date.now() / 1000));
  vals.push(betaFeedbackId);
  await env.DB.prepare(`UPDATE beta_feedback SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export interface BetaFeedbackEditablePatch {
  app: string;
  app_version: string | null;
  app_build: string | null;
  testing: string;
  feedback_types: string;
  what_did_you_do: string;
  what_happened: string;
  expected_behavior: string | null;
  overall_experience: string;
  would_use_feature: string;
  changes: string | null;
  notes: string | null;
}

export async function insertBetaFeedbackRevision(
  env: Env,
  row: BetaFeedbackRow,
  attachments: BetaFeedbackAttachmentRow[],
  editedBy: number,
): Promise<BetaFeedbackRevisionRow> {
  const latest = await env.DB.prepare(
    `SELECT COALESCE(MAX(revision_number), 0) AS n
     FROM beta_feedback_revisions
     WHERE beta_feedback_id = ?`,
  ).bind(row.id).first<{ n: number }>();
  const revisionNumber = Number(latest?.n ?? 0) + 1;
  const previousData = JSON.stringify({
    beta_feedback: row,
    attachments,
  });
  const inserted = await env.DB.prepare(
    `INSERT INTO beta_feedback_revisions (
       beta_feedback_id, public_number, revision_number, previous_data, edited_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(row.id, row.public_number, revisionNumber, previousData, editedBy, Math.floor(Date.now() / 1000))
    .first<BetaFeedbackRevisionRow>();
  if (!inserted) throw new Error("insertBetaFeedbackRevision: no row");
  return inserted;
}

export async function updateBetaFeedbackEditableFields(
  env: Env,
  betaFeedbackId: number,
  patch: BetaFeedbackEditablePatch,
  editedAt: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE beta_feedback SET
       app = ?,
       app_version = ?,
       app_build = ?,
       testing = ?,
       feedback_types = ?,
       what_did_you_do = ?,
       what_happened = ?,
       expected_behavior = ?,
       overall_experience = ?,
       would_use_feature = ?,
       changes = ?,
       notes = ?,
       last_edited_at = ?,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      patch.app,
      patch.app_version,
      patch.app_build,
      patch.testing,
      patch.feedback_types,
      patch.what_did_you_do,
      patch.what_happened,
      patch.expected_behavior,
      patch.overall_experience,
      patch.would_use_feature,
      patch.changes,
      patch.notes,
      editedAt,
      editedAt,
      betaFeedbackId,
    )
    .run();
}

export async function deleteBetaFeedbackAttachmentsByIds(
  env: Env,
  betaFeedbackId: number,
  ids: number[],
): Promise<void> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  for (const id of unique) {
    await env.DB.prepare(`DELETE FROM beta_feedback_attachments WHERE beta_feedback_id = ? AND id = ?`)
      .bind(betaFeedbackId, id)
      .run();
  }
}

export async function getBetaFeedbackAttachment(
  env: Env,
  attachmentId: number,
): Promise<BetaFeedbackAttachmentRow | null> {
  return await env.DB.prepare(`SELECT * FROM beta_feedback_attachments WHERE id = ?`)
    .bind(attachmentId)
    .first<BetaFeedbackAttachmentRow>();
}

export async function updateBetaFeedbackStatus(
  env: Env,
  betaFeedbackId: number,
  toStatus: BetaStatusId,
  changedBy: number | null,
  note?: string | null,
): Promise<{ from: BetaStatusId | null; to: BetaStatusId } | null> {
  const cur = await getBetaFeedback(env, betaFeedbackId);
  if (!cur) return null;
  const from = cur.status;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE beta_feedback SET status=?, updated_at=? WHERE id=?`)
      .bind(toStatus, now, betaFeedbackId),
    env.DB.prepare(
      `INSERT INTO beta_feedback_status_history (beta_feedback_id, from_status, to_status, changed_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(betaFeedbackId, from, toStatus, changedBy, note ?? null, now),
  ]);
  return { from, to: toStatus };
}

export async function insertBetaFeedbackAttachment(env: Env, a: {
  beta_feedback_id: number; kind: BetaFeedbackAttachmentRow["kind"]; telegram_file_id?: string | null;
  r2_key?: string | null; mime_type?: string | null; file_name?: string | null;
  size_bytes?: number | null; width?: number | null; height?: number | null;
}): Promise<BetaFeedbackAttachmentRow> {
  const row = await env.DB.prepare(
    `INSERT INTO beta_feedback_attachments (beta_feedback_id, kind, telegram_file_id, r2_key, mime_type, file_name, size_bytes, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(
    a.beta_feedback_id, a.kind, a.telegram_file_id ?? null, a.r2_key ?? null,
    a.mime_type ?? null, a.file_name ?? null, a.size_bytes ?? null,
    a.width ?? null, a.height ?? null,
  ).first<BetaFeedbackAttachmentRow>();
  if (!row) throw new Error("insertBetaFeedbackAttachment: no row");
  return row;
}

export async function listBetaFeedbackAttachments(
  env: Env,
  betaFeedbackId: number,
): Promise<BetaFeedbackAttachmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM beta_feedback_attachments WHERE beta_feedback_id=? ORDER BY id ASC`,
  ).bind(betaFeedbackId).all<BetaFeedbackAttachmentRow>();
  return results ?? [];
}

export async function setBetaFeedbackAttachmentPostedMessage(
  env: Env,
  id: number,
  messageId: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE beta_feedback_attachments SET posted_message_id=? WHERE id=?`)
    .bind(messageId, id).run();
}

// ── Update idempotency ──────────────────────────────────────
// Returns true if this update_id was NOT yet processed (and marks it as processed).
export async function claimUpdateId(env: Env, updateId: number): Promise<boolean> {
  try {
    await env.DB.prepare(`INSERT INTO processed_updates (update_id) VALUES (?)`)
      .bind(updateId)
      .run();
    return true;
  } catch {
    return false; // unique-constraint violation → already processed
  }
}
