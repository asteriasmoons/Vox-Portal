// GitHub Discussions GraphQL client — used by Feature Ideas ONLY.
//
// Bugs go through src/github/service.ts (REST /issues/*). Ideas post as
// COMMENTS on the pre-existing "Ideas for <App>" discussion via the
// GraphQL `addDiscussionComment` mutation. We never create a new
// discussion here; only add replies to the mapped one.
//
// Auth: reuses env.GITHUB_TOKEN (same secret bugs use). The token needs
// the `discussion:write` scope on the target repo — classic PATs use
// `public_repo` / `repo`; fine-grained tokens use Discussions: Read & Write.

import type { Env } from "../config";
import type { IdeaDiscussion } from "../ideas/constants";
import { log } from "../util/log";

const GH_GRAPHQL = "https://api.github.com/graphql";

export interface DiscussionCommentResult {
  ok: boolean;
  comment_id?: string;
  comment_url?: string;
  error?: string;
  status?: number;
}

const ADD_COMMENT = `
mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
    comment { id url }
  }
}`;

export async function addDiscussionComment(
  env: Env,
  target: IdeaDiscussion,
  body: string,
): Promise<DiscussionCommentResult> {
  if (!env.GITHUB_TOKEN) return { ok: false, error: "GITHUB_TOKEN not configured" };
  try {
    const res = await fetch(GH_GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vox-bugs-bot",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: ADD_COMMENT,
        variables: { discussionId: target.discussion_node_id, body },
      }),
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok || !data || data.errors) {
      const msg = data?.errors ? JSON.stringify(data.errors).slice(0, 300) : text.slice(0, 300);
      log.error("github_discussion_add_failed", null, { status: res.status, body: msg });
      return { ok: false, error: msg, status: res.status };
    }
    const comment = data.data?.addDiscussionComment?.comment;
    if (!comment) {
      log.error("github_discussion_no_comment_returned", null, { data: JSON.stringify(data).slice(0, 300) });
      return { ok: false, error: "no comment returned" };
    }
    return { ok: true, comment_id: comment.id, comment_url: comment.url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("github_discussion_exception", e);
    return { ok: false, error: msg };
  }
}
