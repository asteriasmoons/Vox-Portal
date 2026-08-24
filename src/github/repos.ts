// SINGLE SOURCE OF TRUTH: app name → GitHub repository.
//
// Only apps listed here get GitHub Issues. Apps not listed (older names,
// experimental picks) are still valid Telegram-only reports — the GitHub
// path safely skips and logs a "no_mapping" reason.
//
// The frontend NEVER decides the destination repo. It sends the app name
// verbatim; the Worker resolves it to a repo through this table.
//
// To change a routing target: edit this file and redeploy. Do NOT scatter
// per-app conditionals elsewhere.

export interface GitHubRepo {
  owner: string;
  repo: string;
  /** Labels to try applying to issues in this repo. Non-existent labels
   *  are dropped by GitHub — we also apply them AFTER the issue is created
   *  so label errors never block issue creation. */
  labels?: string[];
}

// Fill in `owner` for each entry with the real GitHub org/user that owns
// the repository. `repo` is the repository name.
export const GITHUB_REPOS: Readonly<Record<string, GitHubRepo>> = {
  VoxTerm: { owner: "asteriasmoons", repo: "VoxTerm", labels: ["bug"] },
  Lurelia: { owner: "asteriasmoons", repo: "lurelia", labels: ["bug"] },
  Lunixia: { owner: "asteriasmoons", repo: "lunixia", labels: ["bug"] },
  Sterium: { owner: "asteriasmoons", repo: "Sterium", labels: ["bug"] },
  Dotti:   { owner: "asteriasmoons", repo: "Dotti",   labels: ["bug"] },
  Loomey:  { owner: "asteriasmoons", repo: "loomey",  labels: ["bug"] },
};

// Resolve an app name to its repo mapping, or null if the app is not routed.
// Older stored names without a mapping return null — that's intentional.
export function resolveRepo(appName: string | null | undefined): GitHubRepo | null {
  if (!appName) return null;
  return GITHUB_REPOS[appName] ?? null;
}

// Labels derived from the bug's severity + category. Applied only when the
// resolved repo lists them; a repo whose team doesn't use these labels can
// safely leave `labels` empty and none of these will be applied.
export function derivedLabelsFor(severity: string, category: string): string[] {
  const out: string[] = [];
  const sev = severity.toLowerCase();
  const cat = category.toLowerCase();
  if (sev === "critical") out.push("severity:critical");
  else if (sev === "high") out.push("severity:high");
  else if (sev === "medium") out.push("severity:medium");
  else if (sev === "low") out.push("severity:low");
  if (cat) out.push(`category:${cat}`);
  return out;
}
