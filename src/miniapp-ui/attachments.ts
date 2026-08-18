// Attachment queue: file picker → /api/upload → visible row per file.
// Exposes attachments() for the successfully-uploaded set ready for submit.
import { requireEl, formatBytes } from "./dom";
import { uploadFile, type SubmitAttachment } from "./api";
import { showTopError } from "./ui";

type Status = "queued" | "uploading" | "done" | "error";

interface Entry {
  id: number;
  file: File;
  status: Status;
  key?: string;
  mime?: string;
  name?: string;
  size?: number;
  error?: string;
}

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;

const queue: Entry[] = [];
let nextId = 1;

export function initAttachments(): void {
  const fileInput = requireEl<HTMLInputElement>("#file-input");
  fileInput.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);
    target.value = "";
    for (const f of files) enqueue(f);
  });
  render();
}

export function attachments(): SubmitAttachment[] {
  return queue
    .filter((u) => u.status === "done" && u.key)
    .map((u) => ({ key: u.key!, name: u.name!, mime: u.mime!, size: u.size }));
}

export function hasPending(): boolean {
  return queue.some((u) => u.status === "uploading" || u.status === "queued");
}

function enqueue(file: File): void {
  if (queue.filter((u) => u.status !== "error").length >= MAX_FILES) {
    showTopError(`You can attach up to ${MAX_FILES} files.`);
    return;
  }
  if (file.size > MAX_BYTES) {
    showTopError(`"${file.name}" is larger than 20 MB.`);
    return;
  }
  const entry: Entry = { id: nextId++, file, status: "queued" };
  queue.push(entry);
  render();
  void upload(entry);
}

async function upload(entry: Entry): Promise<void> {
  entry.status = "uploading";
  render();
  try {
    const data = await uploadFile(entry.file);
    entry.key = data.key;
    entry.mime = data.mime;
    entry.name = data.name;
    entry.size = data.size;
    entry.status = "done";
  } catch (e) {
    entry.status = "error";
    entry.error = e instanceof Error ? e.message : String(e);
  }
  render();
}

function remove(entry: Entry): void {
  const i = queue.indexOf(entry);
  if (i >= 0) queue.splice(i, 1);
  render();
}

function render(): void {
  const list = requireEl<HTMLUListElement>("#file-list");
  list.innerHTML = "";
  for (const u of queue) {
    const li = document.createElement("li");
    if (u.status === "error") li.classList.add("err");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = u.file.name;

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatBytes(u.file.size);

    const stat = document.createElement("span");
    stat.className = "prog";
    stat.textContent =
      u.status === "uploading" ? "uploading…" :
      u.status === "queued"    ? "queued"      :
      u.status === "error"     ? "failed"      : "✓";

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove");
    rm.addEventListener("click", () => remove(u));

    li.append(name, size, stat, rm);
    list.appendChild(li);
  }
}
