// Vox Bugs Bot — Mini App front-end.
// Validates on client, uploads attachments to R2 via /api/upload, then
// submits the full report via /api/submit. Server re-validates initData;
// nothing here is trusted authoritatively.

(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("secondary_bg_color"); } catch (_) {}
  }

  const INIT_DATA = (tg && tg.initData) || "";
  if (!INIT_DATA) {
    // Not launched from Telegram — refuse silently so the page can still be inspected.
    showTopError("This form must be opened from inside Telegram.");
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const form = $("#form");
  const submitBtn = $("#submit-btn");
  const fileInput = $("#file-input");
  const fileList = $("#file-list");
  const catSelect = $("#category-select");
  const sevSelect = $("#severity-select");
  const freqSelect = $("#frequency-select");
  const catHint = $("#category-hint");
  const sevHint = $("#severity-hint");
  const success = $("#success");
  const successId = $("#success-id");
  const closeBtn = $("#close-btn");

  // In-memory queue of uploaded/uploading attachments.
  // Each entry: { id, file, status: 'queued'|'uploading'|'done'|'error', key?, mime?, name?, size?, error? }
  const uploads = [];
  let nextUploadId = 1;

  // ── init ────────────────────────────────────────────────
  loadConfig();
  wireEvents();

  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      const cfg = await res.json();
      if (!cfg.ok) throw new Error("config");
      for (const c of cfg.categories) {
        const opt = document.createElement("option");
        opt.value = c.id; opt.textContent = c.label; opt.dataset.hint = c.hint || "";
        catSelect.appendChild(opt);
      }
      for (const s of cfg.severities) {
        const opt = document.createElement("option");
        opt.value = s.id; opt.textContent = s.label; opt.dataset.hint = s.hint || "";
        sevSelect.appendChild(opt);
      }
      for (const f of cfg.frequencies) {
        const opt = document.createElement("option");
        opt.value = f.id; opt.textContent = f.label;
        freqSelect.appendChild(opt);
      }
      catSelect.dispatchEvent(new Event("change"));
      sevSelect.dispatchEvent(new Event("change"));
    } catch (e) {
      showTopError("Couldn't load the form options. Please close and reopen.");
    }
  }

  function wireEvents() {
    catSelect.addEventListener("change", () => {
      const opt = catSelect.selectedOptions[0];
      catHint.textContent = opt && opt.dataset.hint ? opt.dataset.hint : "";
    });
    sevSelect.addEventListener("change", () => {
      const opt = sevSelect.selectedOptions[0];
      sevHint.textContent = opt && opt.dataset.hint ? opt.dataset.hint : "";
    });

    fileInput.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = ""; // allow re-selecting same file
      for (const f of files) enqueueUpload(f);
    });

    form.addEventListener("submit", onSubmit);
    if (closeBtn) closeBtn.addEventListener("click", () => { if (tg) tg.close(); });
  }

  // ── attachments ─────────────────────────────────────────
  function enqueueUpload(file) {
    if (uploads.filter((u) => u.status !== "error").length >= 10) {
      showTopError("You can attach up to 10 files.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showTopError(`"${file.name}" is larger than 20 MB.`);
      return;
    }
    const entry = { id: nextUploadId++, file, status: "queued" };
    uploads.push(entry);
    renderFileList();
    doUpload(entry);
  }

  async function doUpload(entry) {
    entry.status = "uploading";
    renderFileList();
    try {
      const fd = new FormData();
      fd.append("file", entry.file, entry.file.name);
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "x-telegram-init-data": INIT_DATA },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "upload failed");
      entry.key = data.key;
      entry.mime = data.mime;
      entry.name = data.name;
      entry.size = data.size;
      entry.status = "done";
    } catch (e) {
      entry.status = "error";
      entry.error = String(e && e.message || e);
    }
    renderFileList();
  }

  function renderFileList() {
    fileList.innerHTML = "";
    for (const u of uploads) {
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
      rm.type = "button"; rm.className = "rm"; rm.textContent = "×";
      rm.setAttribute("aria-label", "Remove");
      rm.addEventListener("click", () => {
        const i = uploads.indexOf(u);
        if (i >= 0) uploads.splice(i, 1);
        renderFileList();
      });
      li.append(name, size, stat, rm);
      fileList.appendChild(li);
    }
  }

  // ── submit ──────────────────────────────────────────────
  async function onSubmit(ev) {
    ev.preventDefault();
    clearFieldErrors();

    const data = readForm();
    const errs = validate(data);
    if (errs.length) {
      showFieldErrors(errs);
      return;
    }
    if (uploads.some((u) => u.status === "uploading" || u.status === "queued")) {
      showTopError("Please wait for attachments to finish uploading.");
      return;
    }

    data.attachments = uploads
      .filter((u) => u.status === "done" && u.key)
      .map((u) => ({ key: u.key, name: u.name, mime: u.mime, size: u.size }));

    // Idempotency guard: disable button and include a submit_token; the
    // server currently ignores it but it lets us safely reuse the payload.
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    data.submit_token = crypto.randomUUID();

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": INIT_DATA,
        },
        body: JSON.stringify(data),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error || "submit failed");
      showSuccess(out.public_id);
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit report";
      showTopError("Couldn't submit your report. Please try again.");
    }
  }

  function readForm() {
    const fd = new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) obj[k] = typeof v === "string" ? v : "";
    return obj;
  }

  function validate(d) {
    const errs = [];
    if (!d.app || !d.app.trim())               errs.push(["app", "Required"]);
    if (!d.category)                           errs.push(["category", "Required"]);
    if (!d.severity)                           errs.push(["severity", "Required"]);
    if (!d.title || !d.title.trim())           errs.push(["title", "Required"]);
    if (!d.actual_behavior || !d.actual_behavior.trim())
                                               errs.push(["actual_behavior", "Required"]);
    return errs;
  }

  function clearFieldErrors() {
    $$(".field-error").forEach((n) => n.remove());
    $$(".top-error").forEach((n) => n.remove());
  }
  function showFieldErrors(errs) {
    for (const [name, msg] of errs) {
      const el = form.querySelector(`[name="${name}"]`);
      if (!el) continue;
      const label = el.closest("label") || el.parentNode;
      const s = document.createElement("div");
      s.className = "field-error";
      s.textContent = msg;
      label.appendChild(s);
    }
    showTopError("Please fix the highlighted fields.");
  }
  function showTopError(msg) {
    $$(".top-error").forEach((n) => n.remove());
    const d = document.createElement("div");
    d.className = "top-error";
    d.textContent = msg;
    form.parentNode.insertBefore(d, form);
  }

  function showSuccess(publicId) {
    successId.textContent = publicId;
    form.classList.add("hidden");
    success.classList.remove("hidden");
    if (tg) {
      try { tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success"); } catch (_) {}
    }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
})();
