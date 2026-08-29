// Beta Feedback end-to-end orchestrator.
//
// Mirrors src/ideas/service.ts: reserve public number, persist row, post
// channel ticket, wait for discussion mirror, post Rich Message details,
// relay attachments, then DM reporter.

import type { Env } from "../config";
import {
  getBetaFeedback,
  insertBetaFeedback,
  insertBetaFeedbackAttachment,
  insertBetaFeedbackRevision,
  listBetaFeedbackAttachments,
  nextBetaFeedbackNumber,
  saveBetaFeedbackGitHubMeta,
  setBetaFeedbackGitHubPreviewMessageId,
  setBetaFeedbackAttachmentPostedMessage,
  clearBetaFeedbackTelegramLinkage,
  deleteBetaFeedbackAttachmentsByIds,
  setBetaFeedbackTelegramLinkage,
  updateBetaFeedbackEditableFields,
  updateBetaFeedbackStatus as dbUpdateBetaFeedbackStatus,
} from "../db/queries";
import type { BetaFeedbackAttachmentRow, BetaFeedbackRow, NewBetaFeedbackInput } from "../db/types";
import {
  postBetaFeedbackChannelTicket,
  postBetaFeedbackR2AttachmentToThread,
  postBetaFeedbackReportToThread,
  postBetaFeedbackTelegramAttachmentToThread,
  refreshBetaFeedbackChannelTicket,
  refreshBetaFeedbackRichReport,
  waitForBetaFeedbackDiscussionMirror,
} from "../telegram/channel";
import { deleteMessage, editMessageText, sendMessage, TelegramError } from "../telegram/api";
import {
  type BetaFeedbackAttachmentReference,
  renderBetaFeedbackGitHubComment,
  renderBetaFeedbackReporterDm,
  renderBetaFeedbackSubmissionConfirmation,
} from "./formatting";
import { betaStatusMeta, resolveBetaFeedbackDiscussion, type BetaStatusId } from "./constants";
import { discussionChatId } from "../config";
import { addDiscussionComment, updateDiscussionComment } from "../github/discussions";
import { esc } from "../util/html";
import { log } from "../util/log";

export type IncomingBetaFeedbackAttachment =
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

export interface BetaFeedbackEditInput extends NewBetaFeedbackInput {
  keep_attachment_ids: number[];
}

export async function createBetaFeedback(
  env: Env,
  input: NewBetaFeedbackInput,
  attachments: IncomingBetaFeedbackAttachment[],
): Promise<BetaFeedbackRow> {
  const publicNumber = await nextBetaFeedbackNumber(env);
  let row = await insertBetaFeedback(env, input, publicNumber);
  log.info("beta_feedback_created", { betaFeedbackId: row.id, publicNumber });

  let channelMessageId: number;
  try {
    channelMessageId = await postBetaFeedbackChannelTicket(env, row);
  } catch (e) {
    log.error("beta_feedback_channel_post_failed", e, { betaFeedbackId: row.id });
    throw e;
  }
  row = { ...row, channel_message_id: channelMessageId };

  const mirrorMessageId = await waitForBetaFeedbackDiscussionMirror(env, channelMessageId);
  if (!mirrorMessageId) {
    for (const att of attachments) await persistAttachment(env, row.id, att);
    log.error("beta_feedback_discussion_mirror_missing", new Error("mirror not received"), {
      betaFeedbackId: row.id,
      channelMessageId,
    });
    throw new Error("telegram_comment_mirror_missing");
  }

  await setBetaFeedbackTelegramLinkage(env, row.id, channelMessageId, mirrorMessageId, mirrorMessageId);
  row = { ...row, discussion_message_id: mirrorMessageId, discussion_thread_id: mirrorMessageId };

  const reportMessage = await postBetaFeedbackReportToThread(env, row, mirrorMessageId);
  if (!reportMessage) {
    log.error("beta_feedback_report_post_missing", new Error("no report message"), { betaFeedbackId: row.id });
    throw new Error("telegram_comment_post_failed");
  }
  row = { ...row, report_message_id: reportMessage.message_id };

  for (const att of attachments) {
    try {
      await sleep(1100);
      await persistAndPostAttachment(env, row, att);
    } catch (e) {
      log.error("beta_feedback_attachment_post_failed_nonfatal", e, {
        betaFeedbackId: row.id,
        source: att.source,
        kind: att.kind,
        mime: att.source === "r2" ? att.mime : att.mime ?? null,
        fileName: att.source === "r2" ? att.file_name : att.file_name ?? null,
        sizeBytes: att.size_bytes ?? null,
      });
    }
  }

  try {
    await maybePostGitHubDiscussion(env, row);
  } catch (e) {
    log.warn("beta_feedback_github_unexpected_failed", { betaFeedbackId: row.id, err: String(e) });
  }

  try {
    await sendMessage(env, input.reporter_tg_id, renderBetaFeedbackSubmissionConfirmation(row), { parse_mode: "HTML" });
  } catch (e) {
    log.warn("beta_feedback_confirmation_failed", { betaFeedbackId: row.id, err: String(e) });
  }

  return (await getBetaFeedback(env, row.id)) ?? row;
}

async function maybePostGitHubDiscussion(
  env: Env,
  row: BetaFeedbackRow,
): Promise<void> {
  const target = resolveBetaFeedbackDiscussion(row.app);
  if (!target) {
    const reason = `No Beta Feedback discussion configured for "${row.app}"`;
    log.info("beta_feedback_github_no_mapping", { betaFeedbackId: row.id, app: row.app });
    await saveBetaFeedbackGitHubMeta(env, row.id, { github_status: "skipped_no_mapping", github_error: reason });
    return;
  }
  if (!env.GITHUB_TOKEN) {
    log.warn("beta_feedback_github_disabled", { betaFeedbackId: row.id });
    await saveBetaFeedbackGitHubMeta(env, row.id, {
      github_status: "skipped_disabled",
      github_error: "GITHUB_TOKEN not configured",
    });
    return;
  }

  const refs = await betaAttachmentReferences(env, row);
  const res = await addDiscussionComment(env, target, renderBetaFeedbackGitHubComment(row, refs));
  if (res.ok && res.comment_id && res.comment_url) {
    await saveBetaFeedbackGitHubMeta(env, row.id, {
      github_repo: `${target.owner}/${target.repo}`,
      github_discussion_id: target.discussion_node_id,
      github_discussion_url: target.discussion_url,
      github_comment_id: res.comment_id,
      github_comment_url: res.comment_url,
      github_status: "created",
      github_error: null,
      github_created_at: Math.floor(Date.now() / 1000),
    });
    const fresh = await getBetaFeedback(env, row.id);
    if (fresh) await refreshBetaFeedbackRichReport(env, fresh);
    await postBetaFeedbackGitHubPreviewToThread(env, fresh ?? row, res.comment_url);
  } else {
    const reason = res.error ?? "unknown";
    log.warn("beta_feedback_github_failed", { betaFeedbackId: row.id, reason });
    await saveBetaFeedbackGitHubMeta(env, row.id, {
      github_status: "failed",
      github_error: reason.slice(0, 200),
    });
  }
}

async function updateBetaFeedbackGitHubDiscussion(env: Env, row: BetaFeedbackRow): Promise<void> {
  if (!row.github_comment_id) {
    await maybePostGitHubDiscussion(env, row);
    return;
  }
  const refs = await betaAttachmentReferences(env, row);
  const res = await updateDiscussionComment(
    env,
    row.github_comment_id,
    renderBetaFeedbackGitHubComment(row, refs),
  );
  if (res.ok) {
    await saveBetaFeedbackGitHubMeta(env, row.id, {
      github_comment_url: res.comment_url ?? row.github_comment_url,
      github_status: "created",
      github_error: null,
    });
  } else {
    const reason = res.error ?? "unknown";
    log.warn("beta_feedback_github_update_failed", { betaFeedbackId: row.id, reason });
    await saveBetaFeedbackGitHubMeta(env, row.id, {
      github_status: "failed",
      github_error: reason.slice(0, 200),
    });
  }
}

export async function postBetaFeedbackGitHubPreviewToThread(
  env: Env,
  row: BetaFeedbackRow,
  url = row.github_comment_url,
): Promise<void> {
  if (!url || !row.discussion_thread_id) return;
  const replyToMessageId = row.report_message_id ?? row.discussion_message_id ?? row.discussion_thread_id;
  try {
    const message = await sendMessage(env, discussionChatId(env), `<b>GitHub Discussion</b>\n${esc(url)}`, {
      parse_mode: "HTML",
      message_thread_id: row.discussion_thread_id,
      reply_parameters: { message_id: replyToMessageId },
      disable_web_page_preview: false,
      link_preview_options: {
        is_disabled: false,
        url,
        prefer_large_media: true,
        show_above_text: false,
      },
    });
    await setBetaFeedbackGitHubPreviewMessageId(env, row.id, message.message_id);
  } catch (e) {
    log.warn("beta_feedback_crossref_failed", { betaFeedbackId: row.id, err: String(e) });
  }
}

async function refreshBetaFeedbackGitHubPreview(env: Env, row: BetaFeedbackRow): Promise<void> {
  if (!row.github_preview_message_id || !row.github_comment_url) return;
  try {
    await editMessageText(
      env,
      discussionChatId(env),
      row.github_preview_message_id,
      `<b>GitHub Discussion</b>\n${esc(row.github_comment_url)}`,
      {
        parse_mode: "HTML",
        disable_web_page_preview: false,
        link_preview_options: {
          is_disabled: false,
          url: row.github_comment_url,
          prefer_large_media: true,
          show_above_text: false,
        },
      },
    );
  } catch (e) {
    log.warn("beta_feedback_crossref_refresh_failed", { betaFeedbackId: row.id, err: String(e) });
  }
}

function betaAttachmentReferences(
  env: Env,
  row: BetaFeedbackRow,
): Promise<BetaFeedbackAttachmentReference[]> {
  return listBetaFeedbackAttachments(env, row.id).then((attachments) =>
    attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      file_name: a.file_name,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      url: a.r2_key ? betaAttachmentPublicUrl(env, a) : null,
      thumbnail_url: a.r2_key && (a.mime_type ?? "").toLowerCase().startsWith("image/")
        ? `${betaAttachmentPublicUrl(env, a)}?variant=rounded`
        : null,
    })),
  );
}

function betaAttachmentPublicUrl(env: Env, attachment: BetaFeedbackAttachmentRow): string {
  const base = env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const name = encodeURIComponent(attachment.file_name || `${attachment.kind}-${attachment.id}`);
  return `${base}/attachments/beta-feedback/${attachment.id}/${name}`;
}

export async function updateBetaFeedbackSubmission(
  env: Env,
  betaFeedbackId: number,
  input: BetaFeedbackEditInput,
  attachments: IncomingBetaFeedbackAttachment[],
): Promise<BetaFeedbackRow> {
  const current = await getBetaFeedback(env, betaFeedbackId);
  if (!current) throw new Error("beta_feedback_not_found");
  if (current.reporter_tg_id !== input.reporter_tg_id) throw new Error("forbidden");

  const beforeAttachments = await listBetaFeedbackAttachments(env, current.id);
  const validExistingIds = new Set(beforeAttachments.map((a) => a.id));
  const keepIds = new Set(input.keep_attachment_ids.filter((id) => validExistingIds.has(id)));
  const removed = beforeAttachments.filter((a) => !keepIds.has(a.id));
  if (keepIds.size + attachments.length > 10) throw new Error("too_many_attachments");

  await insertBetaFeedbackRevision(env, current, beforeAttachments, input.reporter_tg_id);

  const editedAt = Math.floor(Date.now() / 1000);
  await updateBetaFeedbackEditableFields(env, current.id, {
    app: input.app,
    app_version: input.app_version ?? null,
    app_build: input.app_build ?? null,
    testing: input.testing,
    feedback_types: JSON.stringify(input.feedback_types),
    what_did_you_do: input.what_did_you_do,
    what_happened: input.what_happened,
    expected_behavior: input.expected_behavior ?? null,
    overall_experience: input.overall_experience,
    would_use_feature: input.would_use_feature,
    changes: input.changes ?? null,
    notes: input.notes ?? null,
  }, editedAt);

  for (const attachment of removed) {
    if (!attachment.posted_message_id) continue;
    try {
      await deleteMessage(env, discussionChatId(env), attachment.posted_message_id);
    } catch (e) {
      log.warn("beta_feedback_removed_attachment_delete_failed", {
        betaFeedbackId,
        attachmentId: attachment.id,
        err: String(e),
      });
    }
  }
  await deleteBetaFeedbackAttachmentsByIds(env, current.id, removed.map((a) => a.id));

  let fresh = (await getBetaFeedback(env, current.id)) ?? current;
  for (const att of attachments) {
    try {
      await sleep(1100);
      if (fresh.discussion_message_id) {
        await persistAndPostAttachment(env, fresh, att);
      } else {
        await persistAttachment(env, fresh.id, att);
      }
    } catch (e) {
      log.warn("beta_feedback_edit_attachment_failed", {
        betaFeedbackId,
        source: att.source,
        kind: att.kind,
        err: String(e),
      });
    }
  }

  fresh = (await getBetaFeedback(env, current.id)) ?? fresh;
  await refreshBetaFeedbackChannelTicket(env, fresh);
  await refreshBetaFeedbackRichReport(env, fresh);
  try {
    await updateBetaFeedbackGitHubDiscussion(env, fresh);
  } catch (e) {
    log.warn("beta_feedback_edit_github_sync_failed", { betaFeedbackId, err: String(e) });
  }

  fresh = (await getBetaFeedback(env, current.id)) ?? fresh;
  await refreshBetaFeedbackGitHubPreview(env, fresh);

  return fresh;
}

async function persistAndPostAttachment(
  env: Env,
  row: BetaFeedbackRow,
  att: IncomingBetaFeedbackAttachment,
) {
  const inserted = await persistAttachment(env, row.id, att);
  const posted = await postAttachmentWithRetry(env, row, att);
  if (!posted) {
    log.error("beta_feedback_attachment_post_missing", new Error("no attachment message"), {
      betaFeedbackId: row.id,
      attachmentId: inserted.id,
    });
    throw new Error("telegram_beta_feedback_attachment_post_failed");
  }
  await setBetaFeedbackAttachmentPostedMessage(env, inserted.id, posted);
}

async function postAttachmentWithRetry(
  env: Env,
  row: BetaFeedbackRow,
  att: IncomingBetaFeedbackAttachment,
): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return att.source === "telegram"
        ? await postBetaFeedbackTelegramAttachmentToThread(env, row, att.kind, att.telegram_file_id)
        : await postBetaFeedbackR2AttachmentToThread(env, row, att.bytes, att.mime, att.file_name);
    } catch (e) {
      if (!(e instanceof TelegramError) || e.error_code !== 429 || attempt === 2) throw e;
      const retryAfter = Number((e.parameters as { retry_after?: number } | undefined)?.retry_after ?? 1);
      await sleep(Math.max(1100, (retryAfter + 0.1) * 1000));
    }
  }
  return null;
}

async function persistAttachment(
  env: Env,
  betaFeedbackId: number,
  att: IncomingBetaFeedbackAttachment,
): Promise<BetaFeedbackAttachmentRow> {
  const shared = {
    beta_feedback_id: betaFeedbackId,
    kind: att.kind,
    mime_type: att.source === "telegram" ? att.mime ?? null : att.mime,
    file_name: att.source === "telegram" ? att.file_name ?? null : att.file_name,
    size_bytes: att.size_bytes ?? null,
  };
  if (att.source === "telegram") {
    return await insertBetaFeedbackAttachment(env, {
      ...shared,
      telegram_file_id: att.telegram_file_id,
      width: att.width ?? null,
      height: att.height ?? null,
    });
  }
  return await insertBetaFeedbackAttachment(env, { ...shared, r2_key: att.r2_key });
}

export async function resendBetaFeedbackToTelegram(
  env: Env,
  betaFeedbackId: number,
  opts: { force?: boolean } = {},
): Promise<{ row: BetaFeedbackRow; telegram: "posted" | "already_posted" | "failed" }> {
  let row = await getBetaFeedback(env, betaFeedbackId);
  if (!row) throw new Error("beta_feedback_not_found");

  if (row.channel_message_id && !opts.force) {
    log.info("beta_feedback_resend_skipped_channel_present", { betaFeedbackId });
    return { row, telegram: "already_posted" };
  }

  if (opts.force && row.channel_message_id) {
    await clearBetaFeedbackTelegramLinkage(env, betaFeedbackId);
    row = (await getBetaFeedback(env, betaFeedbackId))!;
  }

  let channelMessageId = row.channel_message_id;
  if (!channelMessageId) {
    try {
      channelMessageId = await postBetaFeedbackChannelTicket(env, row);
    } catch (e) {
      log.error("beta_feedback_resend_channel_post_failed", e, { betaFeedbackId });
      return { row, telegram: "failed" };
    }
    row = { ...row, channel_message_id: channelMessageId };
  }

  let mirrorMessageId = row.discussion_message_id
    ?? await waitForBetaFeedbackDiscussionMirror(env, channelMessageId, 8000);
  if (!mirrorMessageId) {
    channelMessageId = await postBetaFeedbackChannelTicket(env, row);
    mirrorMessageId = await waitForBetaFeedbackDiscussionMirror(env, channelMessageId, 8000);
    if (!mirrorMessageId) {
      log.error("beta_feedback_resend_mirror_missing", new Error("no discussion mirror"), { betaFeedbackId, channelMessageId });
      return { row, telegram: "failed" };
    }
  }

  await setBetaFeedbackTelegramLinkage(env, row.id, channelMessageId, mirrorMessageId, mirrorMessageId);
  row = { ...row, channel_message_id: channelMessageId, discussion_message_id: mirrorMessageId, discussion_thread_id: mirrorMessageId };

  const reportMessage = await postBetaFeedbackReportToThread(env, row, mirrorMessageId);
  if (!reportMessage) {
    row = (await getBetaFeedback(env, betaFeedbackId)) ?? row;
    return { row, telegram: "failed" };
  }
  row = { ...row, report_message_id: reportMessage.message_id };

  if (row.github_comment_url) {
    await postBetaFeedbackGitHubPreviewToThread(env, row);
  }

  const stored = await listBetaFeedbackAttachments(env, row.id);
  for (const a of stored) {
    if (a.posted_message_id) continue;
    try {
      await sleep(1100);
      let posted: number | null = null;
      if (a.telegram_file_id) {
        posted = await postBetaFeedbackTelegramAttachmentToThread(env, row, a.kind, a.telegram_file_id);
      } else if (a.r2_key) {
        const obj = await env.ATTACHMENTS.get(a.r2_key);
        if (obj) {
          posted = await postBetaFeedbackR2AttachmentToThread(
            env,
            row,
            await obj.arrayBuffer(),
            a.mime_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream",
            a.file_name ?? "attachment",
          );
        }
      }
      if (posted) await setBetaFeedbackAttachmentPostedMessage(env, a.id, posted);
    } catch (e) {
      log.warn("beta_feedback_resend_attachment_failed", { betaFeedbackId, attachmentId: a.id, err: String(e) });
    }
  }

  row = (await getBetaFeedback(env, betaFeedbackId)) ?? row;
  if (!row.github_comment_id) {
    try {
      await maybePostGitHubDiscussion(env, row);
    } catch (e) {
      log.warn("beta_feedback_resend_github_retry_failed", { betaFeedbackId, err: String(e) });
    }
  }

  return { row: (await getBetaFeedback(env, betaFeedbackId)) ?? row, telegram: "posted" };
}

export async function changeBetaFeedbackStatus(
  env: Env,
  betaFeedbackId: number,
  toStatus: BetaStatusId,
  adminTgId: number,
): Promise<BetaFeedbackRow | null> {
  const change = await dbUpdateBetaFeedbackStatus(env, betaFeedbackId, toStatus, adminTgId, null);
  if (!change) return null;
  const row = await getBetaFeedback(env, betaFeedbackId);
  if (!row) return null;

  await refreshBetaFeedbackChannelTicket(env, row);
  await refreshBetaFeedbackRichReport(env, row);

  if (row.discussion_thread_id) {
    const from = change.from ? betaStatusMeta(change.from) : null;
    const to = betaStatusMeta(change.to);
    const line = from
      ? `${from.emoji} ${from.label} → ${to.emoji} ${to.label}`
      : `→ ${to.emoji} ${to.label}`;
    const replyToMessageId = row.report_message_id ?? row.discussion_message_id ?? row.discussion_thread_id;
    try {
      await sendMessage(env, discussionChatId(env),
        `<b>BETA FEEDBACK STATUS UPDATE</b>\n${esc(line)}`,
        {
          parse_mode: "HTML",
          message_thread_id: row.discussion_thread_id,
          reply_parameters: { message_id: replyToMessageId },
        });
    } catch (e) {
      log.warn("beta_feedback_history_post_failed", { betaFeedbackId, err: String(e) });
    }
  }

  if (change.from !== toStatus) {
    try {
      await sendMessage(env, row.reporter_tg_id, renderBetaFeedbackReporterDm(row, change.from), { parse_mode: "HTML" });
    } catch (e) {
      log.warn("beta_feedback_reporter_dm_failed", { betaFeedbackId, err: String(e) });
    }
  }

  return row;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
