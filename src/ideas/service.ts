// Feature Idea end-to-end orchestrator. Parallels bugs/service.ts but posts
// to a completely different destination (GitHub Discussion comment, NOT an
// Issue) and uses its own Rich Message + button set.
//
// Flow:
//   1. Reserve IDEA-#### (atomic).
//   2. Persist the idea row + attachments.
//   3. Post the concise channel ticket into the Bug Reports channel (same
//      infrastructure — one Telegram channel/discussion group serves both
//      workflows; the message content is what differs).
//   4. Wait for the auto-forwarded mirror in the linked discussion group,
//      then post the Rich Message as a REPLY (comment) on the channel post.
//   5. Relay any attachments into the same thread.
//   6. GitHub: `addDiscussionComment` on the mapped "Ideas for <App>"
//      discussion.
//   7. Cross-reference the GitHub URL back into the discussion thread and
//      refresh the Rich Message so the "View on GitHub" button appears.
//   8. DM the reporter with a confirmation.

import type { Env } from "../config";
import { discussionChatId } from "../config";
import {
  insertIdea, nextIdeaNumber, setIdeaTelegramLinkage, saveIdeaGitHubMeta,
  insertIdeaAttachment, setIdeaAttachmentPostedMessage, listIdeaAttachments,
  getIdea, updateIdeaStatus as dbUpdateIdeaStatus,
} from "../db/queries";
import type { IdeaRow, NewIdeaInput, IdeaAttachmentRow } from "../db/types";
import {
  sendMessage, sendRichMessage, editRichMessage,
  sendPhoto, sendVideo, sendDocument, tgCall, tgCallMultipart, TelegramError,
  type TelegramMessage,
} from "../telegram/api";
import { waitForDiscussionMirror } from "../telegram/channel";
import { buildIdeaReportRichMessage } from "../telegram/richmessage";
import {
  renderIdeaChannelTicket, renderIdeaGitHubComment,
  renderIdeaReporterDm, renderIdeaSubmissionConfirmation, ideaPublicId,
} from "./formatting";
import {
  resolveIdeaDiscussion, IDEA_NOTIFY_ON_STATUS, ideaStatusMeta, type IdeaStatusId,
} from "./constants";
import { addDiscussionComment } from "../github/discussions";
import { log } from "../util/log";
import { channelId as bugChannelId } from "../config";

// Attachment payload accepted by createIdea (mirrors bugs).
export type IncomingIdeaAttachment =
  | {
      source: "telegram";
      kind: "photo" | "video" | "document" | "animation";
      telegram_file_id: string;
      mime?: string;
      file_name?: string;
      size_bytes?: number;
      width?: number;
      height?: number;
    }
  | {
      source: "r2";
      kind: "photo" | "video" | "document" | "animation";
      r2_key: string;
      bytes: ArrayBuffer;
      mime: string;
      file_name: string;
      size_bytes?: number;
    };

export interface IdeaOutcome {
  row: IdeaRow;
  telegram: "sent" | "failed";
  github: { status: "created"; comment_id: string; comment_url: string }
        | { status: "skipped_no_mapping"; reason: string }
        | { status: "skipped_disabled"; reason: string }
        | { status: "failed"; reason: string };
}

export async function createIdea(
  env: Env,
  input: NewIdeaInput,
  attachments: IncomingIdeaAttachment[],
): Promise<IdeaOutcome> {
  const publicNumber = await nextIdeaNumber(env);
  let row = await insertIdea(env, input, publicNumber);
  log.info("idea_created", { ideaId: row.id, publicNumber });

  let telegram: IdeaOutcome["telegram"] = "failed";

  // 1) Channel ticket.
  let channelMessageId: number | null = null;
  try {
    const ticket = await sendMessage(env, bugChannelId(env), renderIdeaChannelTicket(row), {
      parse_mode: "HTML",
    });
    channelMessageId = ticket.message_id;
  } catch (e) {
    log.error("idea_channel_post_failed", e, { ideaId: row.id });
  }

  // 2) Wait for the discussion mirror; post rich report + attachments.
  if (channelMessageId != null) {
    await setIdeaTelegramLinkage(env, row.id, channelMessageId, null, null);
    row = { ...row, channel_message_id: channelMessageId };

    const mirrorId = await waitForDiscussionMirror(env, channelMessageId);
    if (mirrorId) {
      await setIdeaTelegramLinkage(env, row.id, channelMessageId, mirrorId, mirrorId);
      row = { ...row, discussion_message_id: mirrorId, discussion_thread_id: mirrorId };

      const report = await postIdeaRichReport(env, row, mirrorId);
      if (report) {
        row = { ...row, report_message_id: report.message_id };
        telegram = "sent";
      }

      for (const att of attachments) {
        try {
          await sleep(1100);
          await persistAndPostIdeaAttachment(env, row, att);
        } catch (e) {
          log.warn("idea_attachment_post_failed", { ideaId: row.id, err: String(e) });
        }
      }
    } else {
      log.error("idea_discussion_mirror_missing", new Error("mirror missing"), { ideaId: row.id });
    }
  }

  // 3) GitHub Discussion comment.
  let github: IdeaOutcome["github"] = { status: "failed", reason: "not_run" };
  const target = resolveIdeaDiscussion(row.app);
  if (!target) {
    const reason = `No Ideas discussion configured for "${row.app}"`;
    log.info("idea_github_no_mapping", { ideaId: row.id, app: row.app });
    await saveIdeaGitHubMeta(env, row.id, { github_status: "skipped_no_mapping", github_error: reason });
    github = { status: "skipped_no_mapping", reason };
  } else if (!env.GITHUB_TOKEN) {
    const reason = "GITHUB_TOKEN not configured";
    log.warn("idea_github_disabled", { ideaId: row.id });
    await saveIdeaGitHubMeta(env, row.id, { github_status: "skipped_disabled", github_error: reason });
    github = { status: "skipped_disabled", reason };
  } else {
    const attNotes = attachments.map((a) => a.source === "r2" ? a.file_name : (a.file_name ?? `${a.kind} attachment`));
    const body = renderIdeaGitHubComment(row, attNotes);
    const res = await addDiscussionComment(env, target, body);
    if (res.ok && res.comment_id && res.comment_url) {
      await saveIdeaGitHubMeta(env, row.id, {
        github_repo: `${target.owner}/${target.repo}`,
        github_discussion_id: target.discussion_node_id,
        github_discussion_url: target.discussion_url,
        github_comment_id: res.comment_id,
        github_comment_url: res.comment_url,
        github_status: "created",
        github_error: null,
        github_created_at: Math.floor(Date.now() / 1000),
      });
      row = { ...row,
        github_repo: `${target.owner}/${target.repo}`,
        github_discussion_id: target.discussion_node_id,
        github_discussion_url: target.discussion_url,
        github_comment_id: res.comment_id,
        github_comment_url: res.comment_url,
        github_status: "created",
      };
      github = { status: "created", comment_id: res.comment_id, comment_url: res.comment_url };
      // Refresh the Rich Message so the "View on GitHub" button appears.
      await refreshIdeaRichReport(env, row);
      // Small cross-reference message inside the thread.
      if (row.discussion_thread_id) {
        try {
          await sendMessage(env, discussionChatId(env),
            `🔗 <b>GitHub Discussion:</b> <a href="${res.comment_url}">comment</a>`,
            { parse_mode: "HTML", message_thread_id: row.discussion_thread_id });
        } catch (e) { log.warn("idea_crossref_failed", { ideaId: row.id, err: String(e) }); }
      }
    } else {
      const reason = res.error ?? "unknown";
      await saveIdeaGitHubMeta(env, row.id, { github_status: "failed", github_error: reason.slice(0, 200) });
      github = { status: "failed", reason };
    }
  }

  // 4) Confirm to reporter.
  try {
    await sendMessage(env, row.reporter_tg_id, renderIdeaSubmissionConfirmation(row), { parse_mode: "HTML" });
  } catch (e) { log.warn("idea_confirmation_failed", { ideaId: row.id, err: String(e) }); }

  return { row: (await getIdea(env, row.id)) ?? row, telegram, github };
}

// ── Rich Message posting/refresh ─────────────────────
export async function postIdeaRichReport(env: Env, row: IdeaRow, mirrorId: number): Promise<TelegramMessage | null> {
  try {
    const rich = buildIdeaReportRichMessage(row);
    log.info("idea_rich_report_sending", {
      ideaId: row.id,
      mirrorId,
      block_count: rich.blocks.length,
    });
    const msg = await sendRichMessage(env, discussionChatId(env), rich, {
      message_thread_id: mirrorId,
      reply_parameters: { message_id: mirrorId, allow_sending_without_reply: true },
    });
    const { setIdeaReportMessageId } = await import("../db/queries");
    await setIdeaReportMessageId(env, row.id, msg.message_id);
    return msg;
  } catch (e) {
    // Log with the concrete Telegram error so we can see WHY the send failed —
    // silent failures were producing an unhelpful "Telegram delivery failed"
    // banner with no diagnostic.
    const errMsg = e instanceof Error ? e.message : String(e);
    log.error("idea_rich_report_post_failed", e, {
      ideaId: row.id,
      mirrorId,
      err: errMsg,
    });
    return null;
  }
}

export async function refreshIdeaRichReport(env: Env, row: IdeaRow): Promise<void> {
  if (!row.report_message_id) return;
  try {
    await editRichMessage(env, discussionChatId(env), row.report_message_id, buildIdeaReportRichMessage(row));
  } catch (e) {
    log.warn("idea_rich_refresh_failed", { ideaId: row.id, err: String(e) });
  }
}

// ── Attachments (mirrors bug flow) ───────────────────
async function persistAndPostIdeaAttachment(env: Env, row: IdeaRow, att: IncomingIdeaAttachment): Promise<void> {
  const inserted = await insertIdeaAttachment(env, {
    idea_id: row.id,
    kind: att.kind,
    telegram_file_id: att.source === "telegram" ? att.telegram_file_id : null,
    r2_key: att.source === "r2" ? att.r2_key : null,
    mime_type: att.source === "telegram" ? att.mime ?? null : att.mime,
    file_name: att.source === "telegram" ? att.file_name ?? null : att.file_name,
    size_bytes: att.size_bytes ?? null,
    width: att.source === "telegram" ? att.width ?? null : null,
    height: att.source === "telegram" ? att.height ?? null : null,
  });

  const chat = discussionChatId(env);
  const opts = { message_thread_id: row.discussion_thread_id ?? undefined, parse_mode: "HTML" as const };
  let posted: number | null = null;

  if (att.source === "telegram") {
    try {
      let msg: TelegramMessage;
      switch (att.kind) {
        case "photo":     msg = await sendPhoto(env, chat, att.telegram_file_id, opts); break;
        case "video":     msg = await sendVideo(env, chat, att.telegram_file_id, opts); break;
        case "animation": msg = await tgCall<TelegramMessage>(env, "sendAnimation", { chat_id: chat, animation: att.telegram_file_id, ...opts }); break;
        default:          msg = await sendDocument(env, chat, att.telegram_file_id, opts);
      }
      posted = msg.message_id;
    } catch (e) {
      log.warn("idea_tg_attachment_failed", { ideaId: row.id, err: String(e) });
    }
  } else {
    const form = new FormData();
    form.append("chat_id", String(chat));
    if (row.discussion_thread_id) form.append("message_thread_id", String(row.discussion_thread_id));
    const blob = new Blob([att.bytes], { type: att.mime });
    let method = "sendDocument"; let field = "document";
    if (att.mime.startsWith("image/") && att.mime !== "image/gif") { method = "sendPhoto"; field = "photo"; }
    else if (att.mime.startsWith("video/")) { method = "sendVideo"; field = "video"; }
    else if (att.mime === "image/gif") { method = "sendAnimation"; field = "animation"; }
    form.append(field, blob, att.file_name);
    try {
      const msg = await tgCallMultipart<TelegramMessage>(env, method, form);
      posted = msg.message_id;
    } catch (e) {
      log.warn("idea_r2_attachment_failed", { ideaId: row.id, err: String(e) });
    }
  }
  if (posted) await setIdeaAttachmentPostedMessage(env, inserted.id, posted);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Status changes (used by admin callbacks) ─────────
export async function changeIdeaStatus(
  env: Env,
  ideaId: number,
  toStatus: IdeaStatusId,
  adminTgId: number,
  reason: string | null,
): Promise<IdeaRow | null> {
  const change = await dbUpdateIdeaStatus(env, ideaId, toStatus, adminTgId, reason);
  if (!change) return null;
  const row = await getIdea(env, ideaId);
  if (!row) return null;

  await refreshIdeaRichReport(env, row);
  // Permanent history line inside the thread.
  if (row.discussion_thread_id) {
    const { esc } = await import("../util/html");
    const from = change.from ? ideaStatusMeta(change.from) : null;
    const to = ideaStatusMeta(change.to);
    const line = from
      ? `${from.emoji} ${from.label} → ${to.emoji} ${to.label}`
      : `→ ${to.emoji} ${to.label}`;
    try {
      await sendMessage(env, discussionChatId(env),
        `<b>IDEA STATUS UPDATE</b>\n${esc(line)}${reason ? `\n\n<i>${esc(reason)}</i>` : ""}`,
        { parse_mode: "HTML", message_thread_id: row.discussion_thread_id });
    } catch (e) { log.warn("idea_history_post_failed", { ideaId, err: String(e) }); }
  }

  // Reporter DM on notify-worthy transitions.
  if (IDEA_NOTIFY_ON_STATUS.includes(toStatus) && change.from !== toStatus) {
    try {
      await sendMessage(env, row.reporter_tg_id, renderIdeaReporterDm(row, change.from), { parse_mode: "HTML" });
    } catch (e) { log.warn("idea_reporter_dm_failed", { ideaId, err: String(e) }); }
  }

  return row;
}
