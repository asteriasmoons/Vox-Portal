// Inline keyboards used across the bot.
import { STATUSES, SEVERITIES, CATEGORIES } from "../bugs/constants";

// Callback data format:  "act:<verb>:<bugId>:<value>"
// Kept short so it fits within Telegram's 64-byte callback_data limit.
export function adminActionsKeyboard(bugId: number) {
  return {
    inline_keyboard: [
      [
        { text: "Status", callback_data: `menu:status:${bugId}` },
        { text: "Severity", callback_data: `menu:severity:${bugId}` },
        { text: "Category", callback_data: `menu:category:${bugId}` },
      ],
      [
        { text: "✅ Mark Fixed", callback_data: `act:status:${bugId}:fixed` },
        { text: "⚫ Close", callback_data: `act:status:${bugId}:closed` },
      ],
      [
        { text: "🔄 Reopen", callback_data: `act:status:${bugId}:investigating` },
        { text: "⚪ Cannot Reproduce", callback_data: `act:status:${bugId}:cannot_reproduce` },
      ],
      [{ text: "📝 Add note", callback_data: `menu:note:${bugId}` }],
    ],
  };
}

export function statusPickerKeyboard(bugId: number) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < STATUSES.length; i += 2) {
    const row = STATUSES.slice(i, i + 2).map((s) => ({
      text: `${s.emoji} ${s.label}`,
      callback_data: `act:status:${bugId}:${s.id}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: "‹ Back", callback_data: `menu:back:${bugId}` }]);
  return { inline_keyboard: rows };
}

export function severityPickerKeyboard(bugId: number) {
  const rows = SEVERITIES.map((s) => [
    { text: s.label, callback_data: `act:severity:${bugId}:${s.id}` },
  ]);
  rows.push([{ text: "‹ Back", callback_data: `menu:back:${bugId}` }]);
  return { inline_keyboard: rows };
}

export function categoryPickerKeyboard(bugId: number) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const row = CATEGORIES.slice(i, i + 2).map((c) => ({
      text: c.label,
      callback_data: `act:category:${bugId}:${c.id}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: "‹ Back", callback_data: `menu:back:${bugId}` }]);
  return { inline_keyboard: rows };
}
