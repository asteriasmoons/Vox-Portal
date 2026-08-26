// Feature-idea specific enums + GitHub Discussion mapping.
//
// All Voxiverse Ideas discussions live in ONE repo — `Vox-Apps-Docs`.
// Each app has its own persistent "Ideas for <App>" discussion inside
// that repo, so only the discussion node id + number + url differ per app.

export const IDEAS_REPO_OWNER = "asteriasmoons";      // GitHub owner/org of Vox-Apps-Docs
export const IDEAS_REPO_NAME  = "Vox-Apps-Docs";

export interface IdeaDiscussion {
  owner: string;
  repo: string;
  discussion_number: number;
  discussion_node_id: string;   // GraphQL node id (base64), e.g. "D_kwDO..."
  discussion_url: string;
}

// Per-app pointer into Vox-Apps-Docs. To find each node id (one-time):
//   1. Open the "Ideas for <App>" discussion on GitHub. Note its number (e.g. #42).
//   2. In https://docs.github.com/en/graphql/overview/explorer run:
//        query { repository(owner:"OWNER", name:"Vox-Apps-Docs") {
//          discussion(number:42) { id title url } } }
//   3. Paste the returned `id` into `discussion_node_id` below, along with
//      the number and url. Set IDEAS_REPO_OWNER above once.
// Apps NOT listed here still submit their Telegram side normally; only the
// GitHub side is skipped (with a logged reason).
export const IDEA_DISCUSSIONS: Readonly<Record<string, IdeaDiscussion>> = {
  VoxTerm: idea(9, "D_kwDOR_ikos4An6ue"),
  Lurelia: idea(6, "D_kwDOR_ikos4An6uM"),
  Lunixia: idea(5, "D_kwDOR_ikos4An6uE"),
  Sterium: idea(11, "D_kwDOR_ikos4An6um"),
  Dotti: idea(13, "D_kwDOR_ikos4Aoyqd"),
  Loomey: idea(4, "D_kwDOR_ikos4An6t1"),
};

function idea(number: number, nodeId: string): IdeaDiscussion {
  return {
    owner: IDEAS_REPO_OWNER,
    repo: IDEAS_REPO_NAME,
    discussion_number: number,
    discussion_node_id: nodeId,
    discussion_url: number
      ? `https://github.com/${IDEAS_REPO_OWNER}/${IDEAS_REPO_NAME}/discussions/${number}`
      : `https://github.com/${IDEAS_REPO_OWNER}/${IDEAS_REPO_NAME}/discussions`,
  };
}

export function resolveIdeaDiscussion(appName: string | null | undefined): IdeaDiscussion | null {
  if (!appName) return null;
  const entry = IDEA_DISCUSSIONS[appName];
  if (!entry) return null;
  if (entry.owner === "REPLACE_ME" || entry.discussion_node_id === "REPLACE_ME" || !entry.discussion_number) return null;
  return entry;
}

// Idea lifecycle. Emoji chosen so Rich Message tables + buttons stay
// visually distinct from Bug Reports.
export const IDEA_STATUSES = [
  { id: "new",         label: "New",         emoji: "💡" },
  { id: "accepted",    label: "Accepted",    emoji: "✅" },
  { id: "rejected",    label: "Rejected",    emoji: "❌" },
  { id: "in_progress", label: "In Progress", emoji: "🔵" },
  { id: "in_testing",  label: "In Testing",  emoji: "🟣" },
  { id: "shipped",     label: "Shipped",     emoji: "🚢" },
] as const;
export type IdeaStatusId = (typeof IDEA_STATUSES)[number]["id"];
export const IDEA_STATUS_IDS: readonly IdeaStatusId[] = IDEA_STATUSES.map((s) => s.id);
export function ideaStatusMeta(id: string) {
  return IDEA_STATUSES.find((s) => s.id === id) ?? IDEA_STATUSES[0];
}

// Statuses that DM the reporter with an update.
export const IDEA_NOTIFY_ON_STATUS: readonly IdeaStatusId[] = [
  "accepted", "rejected", "in_progress", "in_testing", "shipped",
];
