import type { Env } from "../config";
import { getBetaFeedback, getBug, getIdea } from "../db/queries";
import type {
  BetaFeedbackRow,
  BugRow,
  IdeaRow,
  WorkAssignmentRow,
  WorkHistoryRow,
  WorkRefRow,
  WorkSubmissionType,
} from "../db/types";
import { publicIdOf } from "../bugs/formatting";
import { ideaPublicId } from "../ideas/formatting";
import { betaFeedbackPublicId } from "../beta/formatting";

const WORK_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const WORK_ID_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const MAX_WORK_ID_ATTEMPTS = 32;

export type AssignmentEventType = "case_assigned" | "idea_assigned";

export interface ResolvedWorkRef {
  work_ref: WorkRefRow;
  submission_type: WorkSubmissionType;
  submission: BugRow | IdeaRow | BetaFeedbackRow;
  public_id: string;
  app: string;
  status: string;
  assignment: WorkAssignmentRow | null;
}

export interface WorkHistoryEntry {
  id: number;
  event_type: string;
  submission_type: WorkSubmissionType;
  submission_record_id: number;
  public_id: string;
  work_id: string;
  app: string;
  status: string;
  activity_status: string | null;
  assigned_username: string | null;
  assigned_telegram_user_id: number | null;
  assigned_by: number | null;
  assigned_by_username: string | null;
  note: string | null;
  actor_telegram_id: number | null;
  actor_username: string | null;
  created_at: number;
}

export interface WorkHistoryFilters {
  submission_type?: WorkSubmissionType;
  app?: string;
  assignee?: string;
  event_type?: string;
  activity_state?: string;
  search?: string;
}

export function isWorkIdFormat(value: string): boolean {
  return WORK_ID_PATTERN.test(value.trim().toUpperCase());
}

export async function ensureWorkRef(
  env: Env,
  submissionType: WorkSubmissionType,
  submissionRecordId: number,
): Promise<WorkRefRow> {
  const existing = await getWorkRefBySubmission(env, submissionType, submissionRecordId);
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_WORK_ID_ATTEMPTS; attempt++) {
    const workId = generateWorkId();
    try {
      const row = await env.DB.prepare(
        `INSERT INTO work_refs (work_id, submission_type, submission_record_id, created_at)
         VALUES (?, ?, ?, ?)
         RETURNING *`,
      )
        .bind(workId, submissionType, submissionRecordId, unixNow())
        .first<WorkRefRow>();
      if (row) return row;
    } catch {
      const raced = await getWorkRefBySubmission(env, submissionType, submissionRecordId);
      if (raced) return raced;
    }
  }

  throw new Error("work_id_collision_exhausted");
}

export async function getWorkRefBySubmission(
  env: Env,
  submissionType: WorkSubmissionType,
  submissionRecordId: number,
): Promise<WorkRefRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM work_refs WHERE submission_type = ? AND submission_record_id = ? LIMIT 1`,
  )
    .bind(submissionType, submissionRecordId)
    .first<WorkRefRow>();
}

export async function resolveWorkId(env: Env, workId: string): Promise<ResolvedWorkRef | null> {
  const normalized = workId.trim().toUpperCase();
  if (!isWorkIdFormat(normalized)) return null;
  const workRef = await env.DB.prepare(
    `SELECT * FROM work_refs WHERE work_id = ? LIMIT 1`,
  )
    .bind(normalized)
    .first<WorkRefRow>();
  if (!workRef) return null;
  return await resolveWorkRef(env, workRef);
}

export async function assignWork(
  env: Env,
  input: {
    expected_type: "bug" | "idea";
    work_id: string;
    assigned_username: string;
    assigned_by: number;
    assigned_by_username?: string | null;
    note: string;
    event_type: AssignmentEventType;
  },
): Promise<
  | { ok: true; resolved: ResolvedWorkRef; assignment: WorkAssignmentRow }
  | { ok: false; error: "bad_work_id" | "not_found" | "wrong_type" | "already_assigned" | "database"; resolved?: ResolvedWorkRef; assignment?: WorkAssignmentRow }
> {
  const workId = input.work_id.trim().toUpperCase();
  if (!isWorkIdFormat(workId)) return { ok: false, error: "bad_work_id" };
  const resolved = await resolveWorkId(env, workId);
  if (!resolved) return { ok: false, error: "not_found" };
  if (resolved.submission_type !== input.expected_type) return { ok: false, error: "wrong_type", resolved };

  const active = await getActiveAssignment(env, resolved.work_ref.id);
  if (active) return { ok: false, error: "already_assigned", resolved, assignment: active };

  const now = unixNow();
  try {
    const assignment = await env.DB.prepare(
      `INSERT INTO work_assignments (
         submission_type, submission_record_id, work_ref_id,
         assigned_username, assigned_telegram_user_id, assigned_by, assigned_by_username,
         note, status, assigned_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       RETURNING *`,
    )
      .bind(
        resolved.submission_type,
        resolved.work_ref.submission_record_id,
        resolved.work_ref.id,
        input.assigned_username,
        null,
        input.assigned_by,
        input.assigned_by_username ?? null,
        input.note,
        now,
        now,
        now,
      )
      .first<WorkAssignmentRow>();
    if (!assignment) return { ok: false, error: "database", resolved };

    await env.DB.prepare(
      `INSERT INTO work_history (
         event_type, submission_type, submission_record_id, work_ref_id,
         assignment_id, actor_telegram_id, actor_username, metadata, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.event_type,
        resolved.submission_type,
        resolved.work_ref.submission_record_id,
        resolved.work_ref.id,
        assignment.id,
        input.assigned_by,
        input.assigned_by_username ?? null,
        JSON.stringify({
          assigned_username: input.assigned_username,
          assigned_telegram_user_id: null,
          note: input.note,
          status: assignment.status,
        }),
        now,
      )
      .run();

    return { ok: true, resolved: { ...resolved, assignment }, assignment };
  } catch {
    const activeAfterRace = await getActiveAssignment(env, resolved.work_ref.id);
    if (activeAfterRace) return { ok: false, error: "already_assigned", resolved, assignment: activeAfterRace };
    return { ok: false, error: "database", resolved };
  }
}

export async function listWorkHistory(
  env: Env,
  filters: WorkHistoryFilters = {},
  limit = 200,
): Promise<WorkHistoryEntry[]> {
  const rows = (await env.DB.prepare(
    `SELECT * FROM work_history ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(limit, 500))).all<WorkHistoryRow>()).results ?? [];

  const entries: WorkHistoryEntry[] = [];
  for (const row of rows) {
    const workRef = await env.DB.prepare(`SELECT * FROM work_refs WHERE id = ? LIMIT 1`)
      .bind(row.work_ref_id)
      .first<WorkRefRow>();
    if (!workRef) continue;
    const resolved = await resolveWorkRef(env, workRef);
    if (!resolved) continue;
    const assignment = row.assignment_id
      ? await env.DB.prepare(`SELECT * FROM work_assignments WHERE id = ? LIMIT 1`)
        .bind(row.assignment_id)
        .first<WorkAssignmentRow>()
      : resolved.assignment;
    const meta = parseMetadata(row.metadata);
    const entry: WorkHistoryEntry = {
      id: row.id,
      event_type: row.event_type,
      submission_type: row.submission_type,
      submission_record_id: row.submission_record_id,
      public_id: resolved.public_id,
      work_id: resolved.work_ref.work_id,
      app: resolved.app,
      status: resolved.status,
      activity_status: assignment?.status ?? (typeof meta.status === "string" ? meta.status : null),
      assigned_username: assignment?.assigned_username ?? stringOrNull(meta.assigned_username),
      assigned_telegram_user_id: assignment?.assigned_telegram_user_id ?? numberOrNull(meta.assigned_telegram_user_id),
      assigned_by: assignment?.assigned_by ?? row.actor_telegram_id,
      assigned_by_username: assignment?.assigned_by_username ?? row.actor_username,
      note: assignment?.note ?? stringOrNull(meta.note),
      actor_telegram_id: row.actor_telegram_id,
      actor_username: row.actor_username,
      created_at: row.created_at,
    };
    if (matchesFilters(entry, filters)) entries.push(entry);
  }

  return entries;
}

export async function getActiveAssignment(env: Env, workRefId: number): Promise<WorkAssignmentRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM work_assignments WHERE work_ref_id = ? AND status = 'active' ORDER BY assigned_at DESC LIMIT 1`,
  )
    .bind(workRefId)
    .first<WorkAssignmentRow>();
}

async function resolveWorkRef(env: Env, workRef: WorkRefRow): Promise<ResolvedWorkRef | null> {
  const row = workRef.submission_type === "bug"
    ? await getBug(env, workRef.submission_record_id)
    : workRef.submission_type === "idea"
    ? await getIdea(env, workRef.submission_record_id)
    : await getBetaFeedback(env, workRef.submission_record_id);
  if (!row) return null;
  const assignment = await getActiveAssignment(env, workRef.id);
  return {
    work_ref: workRef,
    submission_type: workRef.submission_type,
    submission: row,
    public_id: publicId(row, workRef.submission_type),
    app: row.app,
    status: row.status,
    assignment,
  };
}

function publicId(row: BugRow | IdeaRow | BetaFeedbackRow, type: WorkSubmissionType): string {
  if (type === "bug") return publicIdOf(row as BugRow);
  if (type === "idea") return ideaPublicId(row as IdeaRow);
  return betaFeedbackPublicId(row as BetaFeedbackRow);
}

function generateWorkId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += WORK_ID_ALPHABET[byte % WORK_ID_ALPHABET.length];
  return out;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function matchesFilters(entry: WorkHistoryEntry, filters: WorkHistoryFilters): boolean {
  if (filters.submission_type && entry.submission_type !== filters.submission_type) return false;
  if (filters.app && entry.app !== filters.app) return false;
  if (filters.assignee && entry.assigned_username !== filters.assignee) return false;
  if (filters.event_type && entry.event_type !== filters.event_type) return false;
  if (filters.activity_state && entry.activity_status !== filters.activity_state) return false;
  const q = filters.search?.trim().toLowerCase();
  if (q) {
    const haystack = [
      entry.public_id,
      entry.work_id,
      entry.assigned_username,
      entry.assigned_by_username,
      entry.note,
      entry.app,
      entry.event_type,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}
