// Slash-command handlers for private chats with the bot.

import type { Env } from "../config";
import { sendMessage, type TelegramMessage, setMyCommands } from "./api";
import { startBugWizard, cancelBugWizard } from "./conversation";
import { listBugsByReporter } from "../db/queries";
import { publicIdOf } from "../bugs/formatting";
import { statusMeta } from "../bugs/constants";
import { esc, trunc } from "../util/html";

export async function registerCommands(env: Env) {
  await setMyCommands(env, [
    { command: "start", description: "About Vox Bugs Bot" },
    { command: "bug", description: "Submit a new bug report" },
    { command: "mybugs", description: "See reports you've submitted" },
    { command: "cancel", description: "Cancel an in-progress bug report" },
    { command: "help", description: "How this bot works" },
  ]);
}

export async function handleCommand(env: Env, msg: TelegramMessage, cmd: string, args: string): Promise<boolean> {
  const chatId = msg.chat.id;
  const tgId = msg.from?.id;
  if (!tgId) return false;

  // Only respond to commands in private chats. Ignore commands elsewhere so
  // the discussion group doesn't get bot chatter.
  if (msg.chat.type !== "private") return false;

  switch (cmd) {
    case "start":
      await sendStart(env, chatId);
      return true;
    case "help":
      await sendHelp(env, chatId);
      return true;
    case "bug":
      await startBugWizard(env, chatId, tgId);
      return true;
    case "cancel":
      await cancelBugWizard(env, chatId, tgId);
      return true;
    case "mybugs":
      await sendMyBugs(env, chatId, tgId);
      return true;
    default:
      return false;
  }
}

async function sendStart(env: Env, chatId: number) {
  const miniAppUrl = `${env.PUBLIC_ORIGIN}/app/`;
  await sendMessage(
    env,
    chatId,
    [
      `👋 <b>Welcome to Vox Bugs Bot</b>`,
      ``,
      `This is the official bug-reporting system for our apps.`,
      ``,
      `Two ways to submit:`,
      `• Tap <b>Open Mini App</b> below for a polished form`,
      `• Or send <b>/bug</b> to walk through it step-by-step`,
      ``,
      `You'll receive updates here when the status of your report changes.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🐛 Open Mini App", web_app: { url: miniAppUrl } }],
          [{ text: "Use /bug instead", callback_data: "start:usebug" }],
        ],
      },
    },
  );
}

async function sendHelp(env: Env, chatId: number) {
  await sendMessage(
    env,
    chatId,
    [
      `<b>Commands</b>`,
      `/bug — start a new bug report`,
      `/cancel — abort an in-progress report`,
      `/mybugs — list your submitted reports`,
      `/help — show this message`,
      ``,
      `You can also tap the Mini App button from /start for a polished form.`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

async function sendMyBugs(env: Env, chatId: number, tgId: number) {
  const rows = await listBugsByReporter(env, tgId, 25);
  if (!rows.length) {
    await sendMessage(env, chatId, "You haven't submitted any reports yet. Send /bug to file one.");
    return;
  }
  const lines = rows.map((r) => {
    const st = statusMeta(r.status);
    return `${st.emoji} <b>${esc(publicIdOf(r))}</b> — ${esc(trunc(r.title, 60))} · <i>${esc(st.label)}</i>`;
  });
  await sendMessage(env, chatId, `<b>Your reports</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
}
