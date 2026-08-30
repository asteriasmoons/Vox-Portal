import { $, requireEl } from "./dom";
import { INIT_DATA, haptic } from "./tg";

type CallbackDestination = "dm" | "channel";
type ManualDestination = CallbackDestination | "github";

interface CallbackRecord {
  id: number;
  callback_data: string;
  button_label: string;
  source_kind: string;
  source_public_id: string | null;
  source_title: string | null;
  app: string | null;
  followup_destination: CallbackDestination;
  followup_message: string;
  followup_enabled: number;
  active: number;
  tap_count: number;
  last_tapped_at: number | null;
}

interface CallbackInteraction {
  id: number;
  interaction_type: "tap" | "manual";
  telegram_user_id: number | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  private_chat_id: number | null;
  source_chat_id: number | null;
  source_message_id: number | null;
  source_thread_id: number | null;
  response_destination: ManualDestination | null;
  response_message: string | null;
  response_chat_id: number | null;
  response_message_id: number | null;
  delivery_status: string;
  delivery_error: string | null;
  created_at: number;
}

interface Recipient {
  telegram_user_id: number;
  private_chat_id: number | null;
  label: string;
}

let currentId: number | null = null;
let currentRecipients: Recipient[] = [];

export async function loadCallbacks(): Promise<void> {
  const loading = requireEl("#callbacks-loading");
  const empty = requireEl("#callbacks-empty");
  const list = requireEl<HTMLUListElement>("#callbacks-list");
  const detail = requireEl("#callback-detail");
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  list.classList.add("hidden");
  detail.classList.add("hidden");
  list.innerHTML = "";

  try {
    const res = await fetch("/api/callbacks", { headers: authHeaders() });
    const data = await res.json() as { ok: boolean; callbacks?: CallbackRecord[]; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error ?? "callbacks");
    loading.classList.add("hidden");
    const callbacks = data.callbacks ?? [];
    if (!callbacks.length) {
      empty.classList.remove("hidden");
      return;
    }
    for (const callback of callbacks) list.appendChild(renderCallbackRow(callback));
    list.classList.remove("hidden");
  } catch {
    loading.textContent = "Couldn't load callbacks.";
  }
}

export function initCallbackDetailBack(): void {
  requireEl<HTMLButtonElement>("#callback-detail-back").addEventListener("click", () => {
    requireEl("#callback-detail").classList.add("hidden");
    requireEl("#callbacks-list").classList.remove("hidden");
  });
  requireEl<HTMLSelectElement>("#callback-manual-destination").addEventListener("change", syncRecipientVisibility);
  requireEl<HTMLButtonElement>("#callback-save").addEventListener("click", () => void saveCurrentCallback());
  requireEl<HTMLButtonElement>("#callback-send").addEventListener("click", () => void sendCurrentUpdate());
}

function renderCallbackRow(record: CallbackRecord): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "history-item callback-item";
  li.setAttribute("role", "button");
  li.tabIndex = 0;

  const row1 = document.createElement("div");
  row1.className = "row1";
  const source = document.createElement("span");
  source.className = `type-badge type-badge-${record.source_kind === "idea" ? "idea" : record.source_kind === "beta" ? "beta" : "bug"}`;
  source.textContent = record.source_kind.toUpperCase();
  const taps = document.createElement("span");
  taps.className = "status-pill";
  taps.textContent = `${record.tap_count} taps`;
  row1.append(source, taps);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = record.button_label;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [
    record.source_public_id,
    record.app,
    record.followup_destination.toUpperCase(),
    record.active ? "Active" : "Inactive",
    record.last_tapped_at ? `Last ${formatDate(record.last_tapped_at)}` : "Never tapped",
  ].filter(Boolean).join(" · ");
  li.append(row1, title, meta);

  const open = () => void openCallbackDetail(record.id);
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  return li;
}

async function openCallbackDetail(id: number): Promise<void> {
  currentId = id;
  const list = requireEl("#callbacks-list");
  const detail = requireEl("#callback-detail");
  const loading = requireEl("#callback-detail-loading");
  const content = requireEl("#callback-detail-content");
  list.classList.add("hidden");
  detail.classList.remove("hidden");
  loading.classList.remove("hidden");
  loading.textContent = "Loading callback…";
  content.classList.add("hidden");

  try {
    const res = await fetch(`/api/callbacks/${id}`, { headers: authHeaders() });
    const data = await res.json() as {
      ok: boolean;
      record?: CallbackRecord;
      interactions?: CallbackInteraction[];
      recipients?: Recipient[];
    };
    if (!res.ok || !data.ok || !data.record) throw new Error("detail");
    renderDetail(data.record, data.interactions ?? [], data.recipients ?? []);
    loading.classList.add("hidden");
    content.classList.remove("hidden");
  } catch {
    loading.textContent = "Couldn't load this callback.";
  }
}

function renderDetail(record: CallbackRecord, interactions: CallbackInteraction[], recipients: Recipient[]): void {
  currentRecipients = recipients;
  setText("#callback-button-label", record.button_label);
  setText("#callback-source-title", record.source_title || record.source_public_id || "Published Rich Message");
  setText("#callback-source-meta", [record.source_public_id, record.app, record.source_kind].filter(Boolean).join(" · "));
  setText("#callback-active-pill", record.active ? "ACTIVE" : "INACTIVE");
  setText("#callback-data", record.callback_data);
  setText("#callback-source", [record.source_kind, record.source_public_id].filter(Boolean).join(" · "));
  setText("#callback-destination", record.followup_destination.toUpperCase());
  setText("#callback-taps", String(record.tap_count));
  setText("#callback-last-tapped", record.last_tapped_at ? formatDate(record.last_tapped_at) : "Never");
  setText("#callback-followup-state", record.followup_enabled ? "Enabled" : "Disabled");

  requireEl<HTMLSelectElement>("#callback-followup-destination").value = record.followup_destination;
  requireEl<HTMLTextAreaElement>("#callback-followup-message").value = record.followup_message ?? "";
  requireEl<HTMLInputElement>("#callback-followup-enabled").checked = !!record.followup_enabled;
  requireEl<HTMLInputElement>("#callback-active").checked = !!record.active;
  setText("#callback-save-feedback", "");
  setText("#callback-send-feedback", "");
  requireEl<HTMLTextAreaElement>("#callback-manual-message").value = "";
  renderRecipients();
  renderInteractions(interactions);
}

function renderRecipients(): void {
  const select = requireEl<HTMLSelectElement>("#callback-manual-recipient");
  select.innerHTML = "";
  if (!currentRecipients.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No users have tapped yet";
    select.appendChild(opt);
  } else {
    for (const recipient of currentRecipients) {
      const opt = document.createElement("option");
      opt.value = String(recipient.telegram_user_id);
      opt.textContent = recipient.label;
      select.appendChild(opt);
    }
  }
  syncRecipientVisibility();
}

function syncRecipientVisibility(): void {
  const destination = requireEl<HTMLSelectElement>("#callback-manual-destination").value;
  const label = requireEl<HTMLElement>("#callback-recipient-label");
  label.classList.toggle("hidden", destination !== "dm");
}

function renderInteractions(interactions: CallbackInteraction[]): void {
  const list = requireEl<HTMLUListElement>("#callback-interactions");
  list.innerHTML = "";
  if (!interactions.length) {
    const li = document.createElement("li");
    li.className = "detail-attachment empty-attachment";
    li.textContent = "No interactions yet.";
    list.appendChild(li);
    return;
  }
  for (const item of interactions) {
    const li = document.createElement("li");
    li.className = "callback-interaction";
    const top = document.createElement("div");
    top.className = "callback-interaction-top";
    const kind = document.createElement("strong");
    kind.textContent = `${item.interaction_type.toUpperCase()} · ${item.delivery_status}`;
    const when = document.createElement("span");
    when.textContent = formatDate(item.created_at);
    top.append(kind, when);
    const user = document.createElement("p");
    user.textContent = [
      displayUser(item),
      item.response_destination ? `to ${item.response_destination.toUpperCase()}` : null,
    ].filter(Boolean).join(" · ");
    li.append(top, user);
    const context = document.createElement("p");
    context.textContent = [
      item.private_chat_id ? `private ${item.private_chat_id}` : null,
      item.source_chat_id ? `source chat ${item.source_chat_id}` : null,
      item.source_message_id ? `message ${item.source_message_id}` : null,
      item.source_thread_id ? `thread ${item.source_thread_id}` : null,
      item.response_chat_id ? `sent chat ${item.response_chat_id}` : null,
      item.response_message_id ? `sent message ${item.response_message_id}` : null,
    ].filter(Boolean).join(" · ");
    if (context.textContent) li.appendChild(context);
    if (item.response_message) {
      const msg = document.createElement("p");
      msg.className = "callback-message-preview";
      msg.textContent = item.response_message;
      li.appendChild(msg);
    }
    if (item.delivery_error) {
      const err = document.createElement("p");
      err.className = "callback-error";
      err.textContent = item.delivery_error;
      li.appendChild(err);
    }
    list.appendChild(li);
  }
}

async function saveCurrentCallback(): Promise<void> {
  if (!currentId) return;
  const btn = requireEl<HTMLButtonElement>("#callback-save");
  const feedback = requireEl("#callback-save-feedback");
  btn.disabled = true;
  feedback.textContent = "Saving…";
  try {
    const res = await fetch(`/api/callbacks/${currentId}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        followup_destination: requireEl<HTMLSelectElement>("#callback-followup-destination").value,
        followup_message: requireEl<HTMLTextAreaElement>("#callback-followup-message").value,
        followup_enabled: requireEl<HTMLInputElement>("#callback-followup-enabled").checked,
        active: requireEl<HTMLInputElement>("#callback-active").checked,
      }),
    });
    const data = await res.json() as { ok: boolean; record?: CallbackRecord; error?: string };
    if (!res.ok || !data.ok || !data.record) throw new Error(data.error ?? "save");
    feedback.textContent = "Saved.";
    haptic("success");
    await openCallbackDetail(currentId);
  } catch (e) {
    feedback.textContent = e instanceof Error ? e.message : "Couldn't save.";
    haptic("error");
  } finally {
    btn.disabled = false;
  }
}

async function sendCurrentUpdate(): Promise<void> {
  if (!currentId) return;
  const btn = requireEl<HTMLButtonElement>("#callback-send");
  const feedback = requireEl("#callback-send-feedback");
  btn.disabled = true;
  feedback.textContent = "Sending…";
  try {
    const destination = requireEl<HTMLSelectElement>("#callback-manual-destination").value as ManualDestination;
    const res = await fetch(`/api/callbacks/${currentId}/send`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        destination,
        recipient_user_id: destination === "dm" ? requireEl<HTMLSelectElement>("#callback-manual-recipient").value : null,
        message: requireEl<HTMLTextAreaElement>("#callback-manual-message").value,
      }),
    });
    const data = await res.json() as { ok: boolean; error?: string; record?: CallbackRecord; interactions?: CallbackInteraction[]; recipients?: Recipient[] };
    if (!res.ok || !data.ok || !data.record) throw new Error(data.error ?? "send");
    feedback.textContent = "Sent.";
    haptic("success");
    renderDetail(data.record, data.interactions ?? [], data.recipients ?? []);
  } catch (e) {
    feedback.textContent = e instanceof Error ? e.message : "Couldn't send.";
    haptic("error");
  } finally {
    btn.disabled = false;
  }
}

function authHeaders(): Record<string, string> {
  return { "x-telegram-init-data": INIT_DATA };
}

function setText(sel: string, value: string): void {
  const el = $(sel);
  if (el) el.textContent = value;
}

function displayUser(item: CallbackInteraction): string {
  const username = item.telegram_username ? `@${item.telegram_username}` : "";
  const name = [item.telegram_first_name, item.telegram_last_name].filter(Boolean).join(" ");
  return [username, name, item.telegram_user_id ? String(item.telegram_user_id) : null].filter(Boolean).join(" · ") || "No user";
}

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}
