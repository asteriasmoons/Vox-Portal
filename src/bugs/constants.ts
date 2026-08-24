// Vox Bugs Bot — canonical enums for categories, severities, statuses.
// These strings are stored in D1 verbatim; do not rename without a migration.

// Every app that may appear in the App picker. Older names stay in the
// list so historical bugs still round-trip; adding a name here does NOT
// automatically create GitHub Issues — that is gated by the presence of
// a matching entry in src/github/repos.ts.
export const APPS = [
  "Loomey",
  "Lurelia",
  "Lunixia",
  "VoxTerm",
  "Sterium",
  "Dotti",
] as const;
export type AppName = (typeof APPS)[number];

export const CATEGORIES = [
  { id: "ui",             label: "UI / Visual",       hint: "Layout, colors, or something that just looks off." },
  { id: "crash",          label: "Crash",             hint: "The app closes or freezes." },
  { id: "data",           label: "Data",              hint: "Something is saved wrong, missing, or lost." },
  { id: "sync",           label: "Sync",              hint: "Data isn't matching between devices or accounts." },
  { id: "notifications",  label: "Notifications",     hint: "A push, reminder, or alert didn't arrive or was wrong." },
  { id: "performance",    label: "Performance",       hint: "Slowness, lag, or high battery/heat." },
  { id: "navigation",     label: "Navigation",        hint: "A button, link, or screen doesn't go where it should." },
  { id: "auth",           label: "Authentication",    hint: "Sign-in, sign-out, or account access." },
  { id: "widget",         label: "Widget",            hint: "Home-screen or lock-screen widget." },
  { id: "incorrect",      label: "Incorrect Behavior",hint: "Feature works, but not the way it should." },
  { id: "missing",        label: "Missing Content",   hint: "Text, image, or item that should be there isn't." },
  { id: "other",          label: "Other",             hint: "Doesn't fit any category above." },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_IDS: readonly CategoryId[] = CATEGORIES.map((c) => c.id);

export const SEVERITIES = [
  { id: "low",      label: "Low",      hint: "Cosmetic or minor annoyance." },
  { id: "medium",   label: "Medium",   hint: "Noticeable, but there's a workaround." },
  { id: "high",     label: "High",     hint: "Blocks an important feature." },
  { id: "critical", label: "Critical", hint: "Crash, data loss, or app is unusable." },
] as const;

export type SeverityId = (typeof SEVERITIES)[number]["id"];
export const SEVERITY_IDS: readonly SeverityId[] = SEVERITIES.map((s) => s.id);

export const STATUSES = [
  { id: "new",             label: "New",               emoji: "🔴" },
  { id: "confirmed",       label: "Confirmed",         emoji: "🟠" },
  { id: "investigating",   label: "Investigating",     emoji: "🟡" },
  { id: "in_progress",     label: "In Progress",       emoji: "🔵" },
  { id: "fix_in_testing",  label: "Fix In Testing",    emoji: "🟣" },
  { id: "fixed",           label: "Fixed",             emoji: "🟢" },
  { id: "closed",          label: "Closed",            emoji: "⚫" },
  { id: "cannot_reproduce",label: "Cannot Reproduce",  emoji: "⚪" },
] as const;

export type StatusId = (typeof STATUSES)[number]["id"];
export const STATUS_IDS: readonly StatusId[] = STATUSES.map((s) => s.id);

// Statuses that trigger a DM to the reporter when set.
export const NOTIFY_ON_STATUS: readonly StatusId[] = [
  "confirmed",
  "investigating",
  "in_progress",
  "fix_in_testing",
  "fixed",
  "closed",
  "cannot_reproduce",
];

export const FREQUENCIES = [
  { id: "every_time",  label: "Every time" },
  { id: "often",       label: "Often" },
  { id: "sometimes",   label: "Sometimes" },
  { id: "once",        label: "Only once so far" },
  { id: "unknown",     label: "Not sure" },
] as const;

export type FrequencyId = (typeof FREQUENCIES)[number]["id"];

export function statusMeta(id: string) {
  return STATUSES.find((s) => s.id === id) ?? STATUSES[0];
}
export function severityMeta(id: string) {
  return SEVERITIES.find((s) => s.id === id) ?? SEVERITIES[0];
}
export function categoryMeta(id: string) {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}
export function frequencyMeta(id: string) {
  return FREQUENCIES.find((f) => f.id === id);
}
