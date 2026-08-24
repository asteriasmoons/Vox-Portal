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
import { getBug, listAttachments, saveGitHubMeta } from "../db/queries";
import { log } from "../util/log";
import { publicIdOf } from "../bugs/formatting";

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

    // Idempotency: an existing issue on this row wins. Never create a
    // second issue for the same logical report.
    if (bug.github_issue_number && bug.github_issue_url && bug.github_repo) {
      log.info("github_issue_already_exists", {
        bugId,
        number: bug.github_issue_number,
        repo: bug.github_repo,
      });
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

    log.info("github_routing", { bugId, app: bug.app, repo: `${repo.owner}/${repo.repo}` });

    const attachments = await listAttachments(env, bug.id);
    const title = buildTitle(bug);
    const body = buildBody(bug, attachments);

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

    const issue = (await create.json()) as { number: number; html_url: string; id: number };
    const repoName = `${repo.owner}/${repo.repo}`;
    log.info("github_issue_created", { bugId, number: issue.number, repo: repoName });

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
  const t = bug.title.trim();
  return `[Bug] ${t}`;
}

export function buildBody(bug: BugRow, attachments: AttachmentRow[]): string {
  const parts: string[] = [];
  const push = (heading: string, body: string | null | undefined) => {
    const v = (body ?? "").trim();
    if (!v) return;
    parts.push(`## ${heading}\n\n${v}`);
  };
  const kv = (label: string, v: string | null | undefined) => {
    const val = (v ?? "").trim();
    return val ? `- **${label}:** ${val}` : "";
  };

  parts.push(`> **${publicIdOf(bug)}** — filed via Vox Bugs Bot`);

  push("Bug Description", bug.actual_behavior);
  push("Expected Behavior", bug.expected_behavior);

  const steps = formatReproSteps(bug.reproduction_steps);
  if (steps) parts.push(`## Steps to Reproduce\n\n${steps}`);

  const meta = [
    kv("Severity", bug.severity),
    kv("Category", bug.category),
    kv("Frequency", bug.frequency),
  ].filter(Boolean).join("\n");
  if (meta) parts.push(`## Classification\n\n${meta}`);

  const envInfo = [
    kv("App", bug.app),
    kv("Version", bug.app_version),
    kv("Build", bug.app_build),
    kv("Device", bug.device),
    kv("OS", bug.os),
  ].filter(Boolean).join("\n");
  if (envInfo) parts.push(`## Environment\n\n${envInfo}`);

  push("Additional Notes", bug.notes);

  const reporter = bug.reporter_username
    ? `- Telegram: @${bug.reporter_username}`
    : bug.reporter_display_name
      ? `- Telegram: ${bug.reporter_display_name}`
      : "";
  if (reporter) parts.push(`## Reporter\n\n${reporter}`);

  // Attachments block. Telegram file_id values are NOT public URLs and
  // would give broken links in GitHub, so we do not embed them here.
  // The Telegram thread remains the canonical place for the raw media.
  if (attachments.length) {
    const lines: string[] = [];
    for (const a of attachments) {
      const name = a.file_name || a.r2_key || `${a.kind}-${a.id}`;
      lines.push(`- ${name}${a.mime_type ? ` (${a.mime_type})` : ""}`);
    }
    parts.push(
      `## Attachments\n\n${lines.join("\n")}\n\n_See the linked Telegram thread for the full media._`,
    );
  }

  return parts.join("\n\n");
}

function formatReproSteps(input: string | null): string {
  if (!input) return "";
  const raw = input.replace(/\r/g, "").trim();
  if (!raw) return "";
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const numbered = lines.every((l) => /^\d+[.)]/.test(l));
  if (numbered) {
    return lines
      .map((l) => l.replace(/^\d+[.)]\s*/, ""))
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
  }
  if (lines.length > 1) return lines.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return raw;
}

// ── Labels ──────────────────────────────────────────────
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

// ── HTTP ────────────────────────────────────────────────
async function ghFetch(env: Env, url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
