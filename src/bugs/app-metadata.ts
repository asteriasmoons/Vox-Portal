import { APPS, type AppName } from "./constants";

export interface BugOption {
  id: string;
  label: string;
  hint?: string;
}

export interface BugAppMetadata {
  id: AppName;
  display_name: AppName;
  parent_github_issue_number: number | null;
  features: readonly BugOption[];
  affected_areas: readonly BugOption[];
}

const areas = <const T extends readonly BugOption[]>(items: T) => items;

const LURELIA = areas([
  { id: "home", label: "Home", hint: "Home screen, cards, summaries, navigation" },
  { id: "routines", label: "Routines", hint: "Routines, tasks, contracts, notifications, alarms, widgets" },
  { id: "journeys", label: "Journeys", hint: "Journeys, steps, progress, details, notifications, actions" },
  { id: "reminders", label: "Reminders", hint: "Reminders, notifications, alarms, interactive widget" },
  { id: "habits", label: "Habits", hint: "Habits, details, notifications, alarms, interactive widget" },
  { id: "events", label: "Events", hint: "Events, Apple Calendar sync, details, notifications" },
  { id: "shared_events", label: "Shared Events", hint: "Sharing, RSVP, links, QR codes, posts, comments" },
  { id: "kanban", label: "Kanban", hint: "Boards, columns, assignments, timeline, task actions" },
  { id: "widgets", label: "Widgets", hint: "Home Screen widgets and interactive widget behavior" },
  { id: "sync_data", label: "Sync & Data", hint: "Saving, syncing, duplication, missing data, inconsistent state" },
  { id: "settings_profile", label: "Settings & Profile", hint: "Settings, account, profile, preferences" },
  { id: "interface", label: "Interface", hint: "Layout, animations, sheets, navigation, visual problems" },
  { id: "other", label: "Other", hint: "Anything that does not fit above" },
]);

const LUNIXIA = areas([
  { id: "home", label: "Home", hint: "Navigation, home content, cards, summaries, shortcuts" },
  { id: "journals", label: "Journals", hint: "Journal books, entries, block editor, appearance, fonts" },
  { id: "journal_analysis", label: "Journal Analysis", hint: "AI analysis, overlays, insights, analysis history" },
  { id: "mood", label: "Mood", hint: "Mood logging, emotions, activities, stats, AI mood chat" },
  { id: "health", label: "Health", hint: "Health overview, state summaries, cards, goals, histories" },
  { id: "medications", label: "Medications", hint: "Schedules, doses, decrementing, refills, notifications" },
  { id: "symptoms", label: "Symptoms", hint: "Symptom logging, history, details, severity" },
  { id: "sleep", label: "Sleep", hint: "Sleep analytics, health cards, history, trends" },
  { id: "vitals", label: "Vitals", hint: "Vital logging, history, measurements, health data" },
  { id: "exercise", label: "Exercise", hint: "Exercise logging, history, activity, progress" },
  { id: "water_steps", label: "Water & Steps", hint: "Hydration, step counts, daily progress, history" },
  { id: "notes", label: "Notes", hint: "Notes, editing, checklists, formatting, fonts, organization" },
  { id: "spiritual", label: "Spiritual", hint: "Horoscopes, moon phases, Tarot, Lenormand" },
  { id: "widgets", label: "Widgets", hint: "Widgets, data, refresh behavior, Home Screen presentation" },
  { id: "account_profile", label: "Account & Profile", hint: "Authentication, account state, profile" },
  { id: "premium", label: "Premium", hint: "Premium screens, locked features, purchases, subscriptions" },
  { id: "sync_data", label: "Sync & Data", hint: "Saving, syncing, duplication, missing data, inconsistent state" },
  { id: "interface", label: "Interface", hint: "Layout, animations, sheets, menus, navigation, scrolling" },
  { id: "other", label: "Other", hint: "Anything that does not fit above" },
]);

const LOOMEY = areas([
  { id: "home", label: "Home", hint: "Reading home, cards, summaries, current reading, shortcuts" },
  { id: "library", label: "Library", hint: "Library, collections, book details, adding/editing books" },
  { id: "epub_reader", label: "EPUB Reader", hint: "Imported EPUBs, reading interface, position, navigation" },
  { id: "book_notes_quotes", label: "Book Notes & Quotes", hint: "Notes, quotes, management, book-attached information" },
  { id: "reviews_insights", label: "Reviews & Insights", hint: "Reviews, insights, ratings, reflections" },
  { id: "reading_sessions", label: "Reading Sessions", hint: "Timed/manual sessions, duration, pages, activity" },
  { id: "reading_goals", label: "Reading Goals", hint: "Goals, progress, check-ins, completion" },
  { id: "statistics", label: "Statistics", hint: "Stats, history, streaks, totals, calculated data" },
  { id: "streaks", label: "Streaks", hint: "Daily or scheduled streak behavior and calculations" },
  { id: "challenges", label: "Challenges", hint: "Challenge progress, proof, submissions, conversations" },
  { id: "reading_bingo", label: "Reading Bingo", hint: "Boards, progress, prompts, completion states" },
  { id: "reading_sprints", label: "Reading Sprints", hint: "Sprint rooms, timing, participants, leaderboards" },
  { id: "buddy_reading", label: "Buddy Reading", hint: "Buddy groups and collaborative reading" },
  { id: "social_messages", label: "Social & Messages", hint: "Conversations, comments, messages, community" },
  { id: "profile", label: "Profile", hint: "Profile and reading/account information" },
  { id: "settings", label: "Settings", hint: "Reader preferences, app configuration, account options" },
  { id: "sign_in_account", label: "Sign In & Account", hint: "Authentication, sign in/out, account state" },
  { id: "widgets", label: "Widgets", hint: "Widgets, data, refresh behavior, reading information" },
  { id: "sync_data", label: "Sync & Data", hint: "Saving, syncing, duplication, missing data, inconsistent state" },
  { id: "interface", label: "Interface", hint: "Layout, animations, sheets, menus, navigation, scrolling" },
  { id: "other", label: "Other", hint: "Anything that does not fit above" },
]);

const STERIUM = areas([
  { id: "homepage", label: "Homepage", hint: "Homepage content, spiritual information, cards, summaries" },
  { id: "correspondences", label: "Correspondences", hint: "Browsing, generated correspondences, categories, results" },
  { id: "grimoire", label: "Grimoire", hint: "Home, categories, saved entries, creation, organization" },
  { id: "grimoire_entries", label: "Grimoire Entries", hint: "Journal, workings, dreams, moon phases, devotion, more" },
  { id: "linked_entries", label: "Linked Entries", hint: "Linked workings, attachments, tags, relationships" },
  { id: "spells", label: "Spells", hint: "Spell generation, properties, ingredients, instructions" },
  { id: "correspondence_engine", label: "Correspondence Engine", hint: "Generated correspondences and contextual recommendations" },
  { id: "moon_phases", label: "Moon Phases", hint: "Phase calculations and moon-related information" },
  { id: "planetary_day_hour", label: "Planetary Day & Hour", hint: "Planetary day/hour timing and rulers" },
  { id: "solar_data", label: "Solar Data", hint: "Solar calculations, sunrise/sunset, location and time data" },
  { id: "daily_spiritual_data", label: "Daily Spiritual Data", hint: "Daily calculations, energies, correspondences" },
  { id: "navigation", label: "Navigation", hint: "Tabs, controls, sheets, back navigation, transitions" },
  { id: "sync_data", label: "Sync & Data", hint: "Saving, syncing, duplication, missing data, inconsistent state" },
  { id: "interface", label: "Interface", hint: "Layout, animations, visual problems, sheets, menus" },
  { id: "other", label: "Other", hint: "Anything that does not fit above" },
]);

const VOXTERM = areas([
  { id: "home", label: "Home", hint: "Home screen, summaries, recent activity, shortcuts" },
  { id: "terminal", label: "Terminal", hint: "Command input/output, shell interaction, scrolling, sessions" },
  { id: "hosts", label: "Hosts", hint: "Saved hosts, details, management, remote setup" },
  { id: "ssh_connections", label: "SSH Connections", hint: "Authentication, attempts, keys, credentials, reconnecting" },
  { id: "projects", label: "Projects", hint: "Project creation, details, files, folders, actions" },
  { id: "editor", label: "Editor", hint: "File editing, syntax, opening files, saving changes" },
  { id: "sftp", label: "SFTP", hint: "Remote files/folders, browsing, uploads, downloads, transfers" },
  { id: "sessions", label: "Sessions", hint: "Saved sessions, active sessions, restoration, state" },
  { id: "profile", label: "Profile", hint: "Profile information and account-related data" },
  { id: "sign_in_account", label: "Sign In & Account", hint: "Authentication, sign in/out, account state" },
  { id: "settings", label: "Settings", hint: "Terminal/editor preferences, app configuration, appearance" },
  { id: "sync_data", label: "Sync & Data", hint: "Saving, syncing, duplication, missing data, inconsistent state" },
  { id: "interface", label: "Interface", hint: "Layout, animations, sheets, menus, navigation, scrolling" },
  { id: "other", label: "Other", hint: "Anything that does not fit above" },
]);

const DOTTI = areas([
  { id: "home", label: "Home", hint: "Home screen, overview, cards, summaries, shortcuts" },
  { id: "today_tasks", label: "Today & Tasks", hint: "Today view, household tasks, status, details" },
  { id: "calendar", label: "Calendar", hint: "Calendar views, scheduled housekeeping, dates, planned tasks" },
  { id: "suggestions", label: "Suggestions", hint: "Cleaning suggestions and generated recommended actions" },
  { id: "evaluation", label: "Evaluation", hint: "Household evaluations, progress assessments, results" },
  { id: "history", label: "History", hint: "Past housekeeping activity, completed work, previous records" },
  { id: "sync_data", label: "Sync & Data", hint: "Saving, syncing, duplication, missing data, inconsistent state" },
  { id: "interface", label: "Interface", hint: "Layout, animations, sheets, menus, navigation" },
  { id: "other", label: "Other", hint: "Anything that does not fit above" },
]);

export const BUG_APP_METADATA: Readonly<Record<AppName, BugAppMetadata>> = {
  Loomey: { id: "Loomey", display_name: "Loomey", parent_github_issue_number: 1, features: LOOMEY, affected_areas: LOOMEY },
  Lurelia: { id: "Lurelia", display_name: "Lurelia", parent_github_issue_number: 2, features: LURELIA, affected_areas: LURELIA },
  Lunixia: { id: "Lunixia", display_name: "Lunixia", parent_github_issue_number: 1, features: LUNIXIA, affected_areas: LUNIXIA },
  VoxTerm: { id: "VoxTerm", display_name: "VoxTerm", parent_github_issue_number: 1, features: VOXTERM, affected_areas: VOXTERM },
  Sterium: { id: "Sterium", display_name: "Sterium", parent_github_issue_number: 1, features: STERIUM, affected_areas: STERIUM },
  Dotti: { id: "Dotti", display_name: "Dotti", parent_github_issue_number: 1, features: DOTTI, affected_areas: DOTTI },
};

export const BUG_APP_CONFIGS: readonly BugAppMetadata[] = APPS.map((app) => BUG_APP_METADATA[app]);

export function bugAppMetadata(app: string | null | undefined): BugAppMetadata | null {
  return app && app in BUG_APP_METADATA ? BUG_APP_METADATA[app as AppName] : null;
}

export function bugOptionLabel(app: string | null | undefined, kind: "feature" | "affected_area", value: string | null | undefined): string {
  if (!value) return "";
  const meta = bugAppMetadata(app);
  const options = kind === "feature" ? meta?.features : meta?.affected_areas;
  return options?.find((o) => o.id === value)?.label ?? value;
}

export function bugAffectedAreaLabels(app: string | null | undefined, raw: string | null | undefined): string[] {
  if (!raw) return [];
  let values: string[];
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return values.map((v) => bugOptionLabel(app, "affected_area", v)).filter(Boolean);
}

export function isValidBugFeature(app: string, value: string): boolean {
  return !!bugAppMetadata(app)?.features.some((o) => o.id === value);
}

export function areValidBugAffectedAreas(app: string, values: string[]): boolean {
  const valid = new Set(bugAppMetadata(app)?.affected_areas.map((o) => o.id) ?? []);
  return values.length > 0 && values.every((v) => valid.has(v));
}
