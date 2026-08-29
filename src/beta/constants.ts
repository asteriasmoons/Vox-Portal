// Beta Feedback enums. Stored values are ids; labels are rendered at the edges.
//
// Beta Feedback mirrors the Feature Ideas GitHub Discussion flow: each app can
// point at a persistent GitHub Discussion, and each BETA submission posts a
// comment into that discussion after the Telegram flow succeeds.

export const BETA_FEEDBACK_REPO_OWNER = "asteriasmoons";
export const BETA_FEEDBACK_REPO_NAME = "Vox-Apps-Docs";

export interface BetaFeedbackDiscussion {
  owner: string;
  repo: string;
  discussion_number: number;
  discussion_node_id: string;
  discussion_url: string;
}

export const BETA_FEEDBACK_DISCUSSIONS: Readonly<
  Record<string, BetaFeedbackDiscussion>
> = {
  VoxTerm: betaDiscussion(18, "D_kwDOR_ikos4Ao2VX"),
  Lurelia: betaDiscussion(14, "D_kwDOR_ikos4Ao0g7"),
  Lunixia: betaDiscussion(15, "D_kwDOR_ikos4Ao153"),
  Sterium: betaDiscussion(17, "D_kwDOR_ikos4Ao2Ng"),
  Dotti: betaDiscussion(19, "D_kwDOR_ikos4Ao2Vl"),
  Loomey: betaDiscussion(16, "D_kwDOR_ikos4Ao19s"),
};

function betaDiscussion(number: number, nodeId: string): BetaFeedbackDiscussion {
  return {
    owner: BETA_FEEDBACK_REPO_OWNER,
    repo: BETA_FEEDBACK_REPO_NAME,
    discussion_number: number,
    discussion_node_id: nodeId,
    discussion_url: number
      ? `https://github.com/${BETA_FEEDBACK_REPO_OWNER}/${BETA_FEEDBACK_REPO_NAME}/discussions/${number}`
      : `https://github.com/${BETA_FEEDBACK_REPO_OWNER}/${BETA_FEEDBACK_REPO_NAME}/discussions`,
  };
}

export function resolveBetaFeedbackDiscussion(appName: string | null | undefined): BetaFeedbackDiscussion | null {
  if (!appName) return null;
  const entry = BETA_FEEDBACK_DISCUSSIONS[appName];
  if (!entry) return null;
  if (entry.discussion_node_id === "REPLACE_ME" || !entry.discussion_number) return null;
  return entry;
}

export const BETA_FEEDBACK_TYPES = [
  { id: "worked_well", label: "Worked Well" },
  { id: "confusing", label: "Confusing" },
  { id: "difficult_to_use", label: "Difficult to Use" },
  { id: "looks_great", label: "Looks Great" },
  { id: "needs_polish", label: "Needs Polish" },
  { id: "too_slow", label: "Too Slow" },
  { id: "unexpected_behavior", label: "Unexpected Behavior" },
  { id: "missing_something", label: "Missing Something" },
  { id: "accessibility", label: "Accessibility" },
  { id: "general_impression", label: "General Impression" },
] as const;
export type BetaFeedbackTypeId = (typeof BETA_FEEDBACK_TYPES)[number]["id"];
export const BETA_FEEDBACK_TYPE_IDS: readonly BetaFeedbackTypeId[] = BETA_FEEDBACK_TYPES.map((t) => t.id);

export const BETA_OVERALL_EXPERIENCES = [
  { id: "terrible", label: "Terrible" },
  { id: "frustrating", label: "Frustrating" },
  { id: "okay", label: "Okay" },
  { id: "good", label: "Good" },
  { id: "excellent", label: "Excellent" },
] as const;
export type BetaOverallExperienceId = (typeof BETA_OVERALL_EXPERIENCES)[number]["id"];
export const BETA_OVERALL_EXPERIENCE_IDS: readonly BetaOverallExperienceId[] = BETA_OVERALL_EXPERIENCES.map((o) => o.id);

export const BETA_WOULD_USE_OPTIONS = [
  { id: "yes", label: "Yes" },
  { id: "maybe", label: "Maybe" },
  { id: "no", label: "No" },
  { id: "not_applicable", label: "Not Applicable" },
] as const;
export type BetaWouldUseId = (typeof BETA_WOULD_USE_OPTIONS)[number]["id"];
export const BETA_WOULD_USE_IDS: readonly BetaWouldUseId[] = BETA_WOULD_USE_OPTIONS.map((w) => w.id);

export const BETA_STATUSES = [
  { id: "new", label: "New", emoji: "🧪" },
  { id: "reviewed", label: "Reviewed", emoji: "👀" },
  { id: "noted", label: "Noted", emoji: "📝" },
  { id: "needs_follow_up", label: "Needs Follow-Up", emoji: "🔵" },
  { id: "incorporated", label: "Incorporated", emoji: "🟢" },
  { id: "closed", label: "Closed", emoji: "⚫" },
] as const;
export type BetaStatusId = (typeof BETA_STATUSES)[number]["id"];
export const BETA_STATUS_IDS: readonly BetaStatusId[] = BETA_STATUSES.map((s) => s.id);

export const BETA_NOTIFY_ON_STATUS: readonly BetaStatusId[] = [
  "reviewed",
  "needs_follow_up",
  "incorporated",
  "closed",
];

export function betaStatusMeta(id: string) {
  return BETA_STATUSES.find((s) => s.id === id) ?? BETA_STATUSES[0];
}

export function betaFeedbackTypeMeta(id: string) {
  return BETA_FEEDBACK_TYPES.find((t) => t.id === id);
}

export function betaOverallExperienceMeta(id: string) {
  return BETA_OVERALL_EXPERIENCES.find((o) => o.id === id) ?? BETA_OVERALL_EXPERIENCES[2];
}

export function betaWouldUseMeta(id: string) {
  return BETA_WOULD_USE_OPTIONS.find((w) => w.id === id) ?? BETA_WOULD_USE_OPTIONS[3];
}
