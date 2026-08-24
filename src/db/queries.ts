import type { Env } from "../config";
import type {
  BugRow,
  AttachmentRow,
  StatusHistoryRow,
  NewBugInput,
  NewAttachmentInput,
} from "./types";
import type { StatusId } from "../bugs/constants";

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
