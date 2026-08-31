// GitHub Issues destination for bug reports.
//
// Contract:
//   • Called once per logical bug report from src/bugs/service.ts, AFTER
//     the Telegram flow has run. Telegram outcome does not affect GitHub
//     and vice-versa — they are independent destinations for the SAME
//     normalized report.
//   • Idempotent per bug row: if the row already has github_issue_number,
//     we short-circuit and return the existing metadata. This guards
//     retries, double-submits, re-entrant calls, and attachment retries.
//   • This module NEVER throws to its caller. All failure modes are
//     returned as a structured GitHubOutcome so the caller can record
//     partial success accurately.
//   • Credentials only come from env.GITHUB_TOKEN. The browser is never
//     trusted to name a repo — the app name is what it sends, and the
//     Worker resolves it here via src/github/repos.ts.

import type { Env } from "../config";
import type { BugRow, AttachmentRow } from "../db/types";
import { resolveRepo, derivedLabelsFor, type GitHubRepo } from "./repos";
import { getBug, listAttachments, saveGitHubMeta, claimGitHubActionKey } from "../db/queries";
import { log } from "../util/log";
import { publicIdOf } from "../bugs/formatting";
import { bugAffectedAreaLabels, bugAppMetadata, bugOptionLabel } from "../bugs/app-metadata";
import { categoryMeta, frequencyMeta, severityMeta, statusMeta } from "../bugs/constants";

const GH_API = "https://api.github.com";
const UA = "vox-bugs-bot";

export type GitHubOutcome =
  | { ok: true; skipped?: false; number: number; url: string; repo: string }
  | { ok: true; skipped: "already_exists"; number: number; url: string; repo: string }
  | { ok: false; skipped: "no_mapping"; reason: string }
  | { ok: false; skipped: "disabled"; reason: string }
  | { ok: false; error: string; status?: number };

// Public entry point. Re-reads the bug row (for idempotency), resolves the
// repo, creates the issue, then attempts labels and persistence. Never throws.
export async function createIssueForBug(env: Env, bugId: number): Promise<GitHubOutcome> {
  try {
    const bug = await getBug(env, bugId);
    if (!bug) return { ok: false, error: "bug_not_found" };

    // Idempotency: an existing sub-issue on this row wins. Never create a
    // second issue for the same logical report. Legacy rows may have
    // github_issue_number without github_sub_issue_number; those remain
    // safely untouched and are not treated as sub-issue-backed reports.
    if (bug.github_sub_issue_number && bug.github_sub_issue_url && bug.github_repo) {
      await refreshExistingIssueBody(env, bug);
      log.info("github_issue_already_exists", {
        bugId,
        number: bug.github_sub_issue_number,
        repo: bug.github_repo,
      });
      return {
        ok: true,
        skipped: "already_exists",
        number: bug.github_sub_issue_number,
        url: bug.github_sub_issue_url,
        repo: bug.github_repo,
      };
    }
    const appMeta = bugAppMetadata(bug.app);
    if (bug.github_issue_id && bug.github_issue_number && bug.github_issue_url && bug.github_repo && !bug.github_sub_issue_number && appMeta?.parent_github_issue_number) {
      const [owner, repoNameOnly] = bug.github_repo.split("/");
      if (!owner || !repoNameOnly) return { ok: false, skipped: "no_mapping", reason: "Malformed GitHub repo metadata" };
      const attach = await attachSubIssue(env, { owner, repo: repoNameOnly }, appMeta.parent_github_issue_number, bug.github_issue_id);
      if (!attach.ok) {
        await saveGitHubMeta(env, bugId, {
          github_status: "failed",
          github_error: `Sub-issue attach HTTP ${attach.status}: ${attach.body.slice(0, 160)}`,
        });
        return { ok: false, error: `Sub-issue attach HTTP ${attach.status}`, status: attach.status };
      }
      await saveGitHubMeta(env, bugId, {
        github_sub_issue_number: bug.github_issue_number,
        github_sub_issue_id: bug.github_issue_id,
        github_sub_issue_node_id: bug.github_issue_node_id,
        github_sub_issue_url: bug.github_issue_url,
        github_parent_issue_number: appMeta.parent_github_issue_number,
        github_parent_issue_url: `https://github.com/${owner}/${repoNameOnly}/issues/${appMeta.parent_github_issue_number}`,
        github_status: "created",
        github_error: null,
      });
      await refreshExistingIssueBody(env, {
        ...bug,
        github_sub_issue_number: bug.github_issue_number,
        github_sub_issue_url: bug.github_issue_url,
      });
      return { ok: true, number: bug.github_issue_number, url: bug.github_issue_url, repo: bug.github_repo };
    }
    if (bug.github_issue_number && bug.github_issue_url && bug.github_repo && !bug.github_sub_issue_number) {
      return {
        ok: true,
        skipped: "already_exists",
        number: bug.github_issue_number,
        url: bug.github_issue_url,
        repo: bug.github_repo,
      };
    }

    if (!env.GITHUB_TOKEN) {
      const reason = "GITHUB_TOKEN not configured";
      log.warn("github_disabled", { bugId, reason });
      await saveGitHubMeta(env, bugId, {
        github_status: "skipped_disabled",
        github_error: reason,
      });
      return { ok: false, skipped: "disabled", reason };
    }

    const repo = resolveRepo(bug.app);
    if (!repo) {
      const reason = `No GitHub repository configured for "${bug.app}"`;
      log.info("github_no_mapping", { bugId, app: bug.app });
      await saveGitHubMeta(env, bugId, {
        github_status: "skipped_no_mapping",
        github_error: reason,
      });
      return { ok: false, skipped: "no_mapping", reason };
    }
    if (!appMeta?.parent_github_issue_number) {
      const reason = `No GitHub parent bug issue configured for "${bug.app}"`;
      log.info("github_no_parent_issue", { bugId, app: bug.app });
      await saveGitHubMeta(env, bugId, {
        github_status: "skipped_no_mapping",
        github_error: reason,
      });
      return { ok: false, skipped: "no_mapping", reason };
    }

    log.info("github_routing", { bugId, app: bug.app, repo: `${repo.owner}/${repo.repo}` });

    const attachments = await listAttachments(env, bug.id);
    const title = buildTitle(bug);
    const body = buildBody(env, bug, attachments);

    // Create issue first without labels — labels can fail independently
    // (missing label in repo) and must not block issue creation.
    const create = await ghFetch(env, `${GH_API}/repos/${repo.owner}/${repo.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });

    if (!create.ok) {
      const msg = await create.text();
      log.error("github_issue_create_failed", null, {
        bugId,
        status: create.status,
        body: msg.slice(0, 500),
      });
      await saveGitHubMeta(env, bugId, {
        github_status: "failed",
        github_error: `HTTP ${create.status}: ${msg.slice(0, 200)}`,
      });
      return { ok: false, error: `HTTP ${create.status}`, status: create.status };
    }

    const issue = (await create.json()) as { number: number; html_url: string; id: number; node_id: string };
    const repoName = `${repo.owner}/${repo.repo}`;
    log.info("github_issue_created", { bugId, number: issue.number, repo: repoName });

    const attach = await attachSubIssue(env, repo, appMeta.parent_github_issue_number, issue.id);
    if (!attach.ok) {
      log.error("github_sub_issue_attach_failed", null, {
        bugId,
        status: attach.status,
        parent: appMeta.parent_github_issue_number,
        childIssueId: issue.id,
        body: attach.body.slice(0, 500),
      });
      await saveGitHubMeta(env, bugId, {
        github_repo: repoName,
        github_issue_number: issue.number,
        github_issue_url: issue.html_url,
        github_issue_id: issue.id,
        github_issue_node_id: issue.node_id,
        github_status: "failed",
        github_error: `Sub-issue attach HTTP ${attach.status}: ${attach.body.slice(0, 160)}`,
        github_created_at: Math.floor(Date.now() / 1000),
      });
      return { ok: false, error: `Sub-issue attach HTTP ${attach.status}`, status: attach.status };
    }

    // Labels — best-effort. Isolated so a label failure doesn't affect
    // the recorded outcome. We deliberately await it here (rather than
    // fire-and-forget) so the log ordering stays sensible, but its result
    // is only logged, not returned.
    await tryAddLabels(env, repo, issue.number, bug).catch((e) =>
      log.warn("github_labels_failed", { bugId, err: String(e) }),
    );

    await saveGitHubMeta(env, bugId, {
      github_repo: repoName,
      github_issue_number: issue.number,
      github_issue_url: issue.html_url,
      github_issue_id: issue.id,
      github_issue_node_id: issue.node_id,
      github_sub_issue_number: issue.number,
      github_sub_issue_id: issue.id,
      github_sub_issue_node_id: issue.node_id,
      github_sub_issue_url: issue.html_url,
      github_parent_issue_number: appMeta.parent_github_issue_number,
      github_parent_issue_url: `https://github.com/${repo.owner}/${repo.repo}/issues/${appMeta.parent_github_issue_number}`,
      github_status: "created",
      github_error: null,
      github_created_at: Math.floor(Date.now() / 1000),
    });

    return { ok: true, number: issue.number, url: issue.html_url, repo: repoName };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("github_service_exception", e, { bugId });
    try {
      await saveGitHubMeta(env, bugId, {
        github_status: "failed",
        github_error: msg.slice(0, 200),
      });
    } catch { /* noop */ }
    return { ok: false, error: msg };
  }
}

// ── Title / body builders ──────────────────────────────
export function buildTitle(bug: BugRow): string {
  const summary = (bug.title || bug.actual_behavior || "Bug report").replace(/\s+/g, " ").trim();
  return `${publicIdOf(bug)}: ${summary.slice(0, 140)}`;
}

export function buildBody(env: Env, bug: BugRow, attachments: AttachmentRow[]): string {
  const parts: string[] = [];
  const bugType = categoryMeta(bug.bug_type ?? bug.category).label;
  const feature = bugOptionLabel(bug.app, "feature", bug.feature) || "Not provided";
  const areas = bugAffectedAreaLabels(bug.app, bug.affected_areas);
  const steps = extractSteps(bug.reproduction_steps);

  parts.push(`# ${publicIdOf(bug)}`);
  parts.push(`> Filed through Vox Portal for ${escapeMd(bug.app)}.`);

  parts.push(`## Device Details\n\n${markdownTable(["Detail", "Value"], [
    ["App", bug.app],
    ["Version", bug.app_version || "Not provided"],
    ["Build", bug.app_build || "Not provided"],
    ["Device", bug.device || "Not provided"],
    ["OS", bug.os || "Not provided"],
  ])}`);

  const context = markdownTable(["Detail", "Value"], [
    ["Bug Type", bugType],
    ["Severity", severityMeta(bug.severity).label],
    ["Reproducibility", bug.frequency ? frequencyMeta(bug.frequency)?.label ?? bug.frequency : "Not specified"],
    ["Feature", feature],
    ["Affected Areas", areas.length ? "See checked affected areas below" : "None selected"],
  ]);
  const checkedAreas = areas.map((area) => `- [x] ${escapeMd(area)}`).join("\n");
  parts.push(`## Context Details\n\n${context}${checkedAreas ? `\n\n${checkedAreas}` : ""}`);

  if (steps.length) {
    parts.push(`## Steps to Reproduce\n\n${markdownTable(["Step", "Action"], steps.map((step, i) => [String(i + 1), step]))}`);
  }

  parts.push(`## Behavior Details\n\n${markdownTable(["Behavior", "Details"], [
    ["Expected", bug.expected_behavior || "Not provided"],
    ["Actual", bug.actual_behavior],
  ])}`);

  if (bug.notes) parts.push(`## Additional Notes\n\n${escapeMd(bug.notes)}`);

  if (attachments.length) {
    parts.push(`## Screenshots & Recordings\n\n${renderAttachmentReferences(env, attachments)}`);
  } else {
    parts.push("## Screenshots & Recordings\n\nNone submitted.");
  }

  const reporter = bug.reporter_username
    ? `@${bug.reporter_username}`
    : bug.reporter_display_name || "anonymous";
  parts.push(`---\n\nSubmitted through the Voxiverse Telegram Mini App — ${publicIdOf(bug)}\n\nReporter: ${escapeMd(reporter)}`);

  return parts.join("\n\n---\n\n");
}

function extractSteps(input: string | null): string[] {
  if (!input) return [];
  const raw = input.replace(/\r/g, "").trim();
  if (!raw) return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const numbered = lines.every((l) => /^\d+[.)]/.test(l));
  if (numbered) return lines.map((l) => l.replace(/^\d+[.)]\s*/, ""));
  if (lines.length > 1) return lines;
  return [raw];
}

function markdownTable(headers: [string, string], rows: [string, string][]): string {
  const head = `| ${headers.map(escapeTableCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function escapeTableCell(value: string): string {
  return escapeMd(value).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

function escapeMd(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderAttachmentReferences(env: Env, attachments: AttachmentRow[]): string {
  const images = attachments.filter((a) => a.r2_key && (a.mime_type ?? "").toLowerCase().startsWith("image/"));
  const nonImages = attachments.filter((a) => !a.r2_key || !(a.mime_type ?? "").toLowerCase().startsWith("image/"));
  const chunks: string[] = [];
  if (images.length) chunks.push(renderImageRows(env, images));
  if (nonImages.length) {
    chunks.push(nonImages.map((a) => {
      const name = a.file_name || a.r2_key || `${a.kind}-${a.id}`;
      const url = a.r2_key ? bugAttachmentPublicUrl(env, a) : null;
      return url
        ? `- [${escapeMarkdownLinkText(name)}](${url})${a.mime_type ? ` (${escapeMd(a.mime_type)})` : ""}`
        : `- ${escapeMd(name)}${a.mime_type ? ` (${escapeMd(a.mime_type)})` : ""}`;
    }).join("\n"));
  }
  return chunks.join("\n\n");
}

function renderImageRows(env: Env, images: AttachmentRow[]): string {
  const rows: string[] = [];
  for (let i = 0; i < images.length; i += 2) {
    const first = images[i];
    const second = images[i + 1];
    if (second) {
      rows.push(`<p align="center">${renderImageCell(env, first)}&nbsp;&nbsp;${renderImageCell(env, second)}</p>`);
    } else {
      rows.push(`<p align="center">${renderImageCell(env, first)}</p>`);
    }
  }
  return rows.join("\n\n");
}

function renderImageCell(env: Env, attachment: AttachmentRow): string {
  const name = escapeHtmlAttr(attachment.file_name || attachment.r2_key || `${attachment.kind}-${attachment.id}`);
  const url = escapeHtmlAttr(bugAttachmentPublicUrl(env, attachment));
  const thumbnailUrl = escapeHtmlAttr(`${bugAttachmentPublicUrl(env, attachment)}?variant=rounded`);
  return `<a href="${url}"><img src="${thumbnailUrl}" width="150" alt="${name}"></a>`;
}

function bugAttachmentPublicUrl(env: Env, attachment: AttachmentRow): string {
  const base = env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const name = encodeURIComponent(attachment.file_name || `${attachment.kind}-${attachment.id}`);
  return `${base}/attachments/bugs/${attachment.id}/${name}`;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Labels ──────────────────────────────────────────────
async function attachSubIssue(
  env: Env,
  repo: GitHubRepo,
  parentIssueNumber: number,
  childIssueId: number,
): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
  const res = await ghFetch(env, `${GH_API}/repos/${repo.owner}/${repo.repo}/issues/${parentIssueNumber}/sub_issues`, {
    method: "POST",
    body: JSON.stringify({ sub_issue_id: childIssueId }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status, body: await res.text() };
}

async function tryAddLabels(env: Env, repo: GitHubRepo, issueNumber: number, bug: BugRow): Promise<void> {
  const wanted = [
    ...(repo.labels ?? []),
    ...derivedLabelsFor(bug.severity, bug.category),
  ];
  if (!wanted.length) return;

  const res = await ghFetch(
    env,
    `${GH_API}/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/labels`,
    { method: "POST", body: JSON.stringify({ labels: wanted }) },
  );
  if (!res.ok) log.warn("github_add_labels_failed", { status: res.status });
}

// ── Management-action sync ─────────────────────────────
// Every meaningful admin action calls one of these. Each is idempotent via a
// per-action key so retries / duplicate callbacks cannot post twice.
// GitHub failure is logged; it never throws to the caller so the Telegram
// side always succeeds independently.

export type SyncResult = { ok: true } | { ok: false; skipped: string } | { ok: false; error: string };

function repoOf(bug: BugRow): { owner: string; repo: string } | null {
  if (!bug.github_repo || !bug.github_sub_issue_number) return null;
  const [owner, repo] = bug.github_repo.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function refreshExistingIssueBody(env: Env, bug: BugRow): Promise<void> {
  const r = repoOf(bug);
  if (!r || !env.GITHUB_TOKEN) return;
  const attachments = await listAttachments(env, bug.id);
  const body = buildBody(env, bug, attachments);
  try {
    const res = await ghFetch(env, `${GH_API}/repos/${r.owner}/${r.repo}/issues/${bug.github_sub_issue_number}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const t = await res.text();
      log.warn("github_issue_body_refresh_failed", { bugId: bug.id, status: res.status, body: t.slice(0, 300) });
    }
  } catch (e) {
    log.warn("github_issue_body_refresh_exception", { bugId: bug.id, err: String(e) });
  }
}

export async function postIssueComment(env: Env, bug: BugRow, body: string): Promise<SyncResult> {
  const r = repoOf(bug);
  if (!r) return { ok: false, skipped: "no_issue" };
  if (!env.GITHUB_TOKEN) return { ok: false, skipped: "disabled" };
  try {
    const res = await ghFetch(env, `${GH_API}/repos/${r.owner}/${r.repo}/issues/${bug.github_sub_issue_number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const t = await res.text();
      log.error("github_comment_failed", null, { bugId: bug.id, status: res.status, body: t.slice(0, 400) });
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    log.error("github_comment_exception", e, { bugId: bug.id });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function setIssueState(env: Env, bug: BugRow, state: "open" | "closed", state_reason?: string): Promise<SyncResult> {
  const r = repoOf(bug);
  if (!r) return { ok: false, skipped: "no_issue" };
  if (!env.GITHUB_TOKEN) return { ok: false, skipped: "disabled" };
  try {
    const res = await ghFetch(env, `${GH_API}/repos/${r.owner}/${r.repo}/issues/${bug.github_sub_issue_number}`, {
      method: "PATCH",
      body: JSON.stringify(state_reason ? { state, state_reason } : { state }),
    });
    if (!res.ok) {
      const t = await res.text();
      log.error("github_state_change_failed", null, { bugId: bug.id, status: res.status, body: t.slice(0, 400) });
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    log.error("github_state_change_exception", e, { bugId: bug.id });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Wrap any sync in the idempotency guard. `actionKey` MUST uniquely identify
// this logical action (typically includes bug_id, verb, and a monotonic
// discriminator like the new value or timestamp).
async function withActionKey(
  env: Env,
  bug: BugRow,
  actionKey: string,
  run: () => Promise<SyncResult>,
): Promise<SyncResult> {
  const claimed = await claimGitHubActionKey(env, bug.id, actionKey);
  if (!claimed) {
    log.info("github_action_already_synced", { bugId: bug.id, actionKey });
    return { ok: false, skipped: "already_synced" };
  }
  return await run();
}

export async function syncStatusChange(env: Env, bug: BugRow, from: string | null, to: string): Promise<SyncResult> {
  const body =
`### Status Update

**${prettyStatus(from ?? "—")} → ${prettyStatus(to)}**

_Updated through Vox Bugs._`;
  const key = `${bug.id}:status:${to}:${Math.floor(Date.now() / 1000)}`;
  const result = await withActionKey(env, bug, key, () => postIssueComment(env, bug, body));

  // Terminal-state transitions also change the GitHub issue state.
  if (to === "closed") {
    await withActionKey(env, bug, `${bug.id}:close:${Math.floor(Date.now() / 1000)}`,
      () => setIssueState(env, bug, "closed", "completed"));
  } else if (to === "cannot_reproduce") {
    await withActionKey(env, bug, `${bug.id}:notplanned:${Math.floor(Date.now() / 1000)}`,
      () => setIssueState(env, bug, "closed", "not_planned"));
  } else if ((from === "closed" || from === "cannot_reproduce" || from === "fixed") && to !== "fixed") {
    await withActionKey(env, bug, `${bug.id}:reopen:${Math.floor(Date.now() / 1000)}`,
      () => setIssueState(env, bug, "open"));
  } else if (to === "fixed") {
    await withActionKey(env, bug, `${bug.id}:fixed:${Math.floor(Date.now() / 1000)}`, async () => {
      const c = await postIssueComment(env, bug,
`### Fix Completed

This bug has been marked as fixed through Vox Bugs.${bug.fixed_in_version ? `\n\nFixed in v${bug.fixed_in_version}${bug.fixed_in_build ? ` (build ${bug.fixed_in_build})` : ""}.` : ""}`);
      return c;
    });
    await withActionKey(env, bug, `${bug.id}:fixedclose:${Math.floor(Date.now() / 1000)}`,
      () => setIssueState(env, bug, "closed", "completed"));
  }
  return result;
}

export async function syncSeverityChange(env: Env, bug: BugRow, from: string, to: string): Promise<SyncResult> {
  const body =
`### Severity Updated

**${cap(from)} → ${cap(to)}**

_Updated through Vox Bugs._`;
  return await withActionKey(env, bug, `${bug.id}:severity:${to}:${Math.floor(Date.now() / 1000)}`,
    () => postIssueComment(env, bug, body));
}

export async function syncCategoryChange(env: Env, bug: BugRow, from: string, to: string): Promise<SyncResult> {
  const body =
`### Category Updated

**${cap(from)} → ${cap(to)}**

_Updated through Vox Bugs._`;
  return await withActionKey(env, bug, `${bug.id}:category:${to}:${Math.floor(Date.now() / 1000)}`,
    () => postIssueComment(env, bug, body));
}

export async function syncAdminNote(env: Env, bug: BugRow, note: string, byUsername: string): Promise<SyncResult> {
  const body =
`### Developer Note

${note}

_Added through Vox Bugs by ${byUsername}._`;
  return await withActionKey(env, bug, `${bug.id}:note:${hashNote(note)}:${Math.floor(Date.now() / 1000)}`,
    () => postIssueComment(env, bug, body));
}

function prettyStatus(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function cap(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function hashNote(s: string): string {
  // Cheap short hash — good enough for action-key uniqueness on same-bug/same-note.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// ── HTTP ────────────────────────────────────────────────
async function ghFetch(env: Env, url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": UA,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
