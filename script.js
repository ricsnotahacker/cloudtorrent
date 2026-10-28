/* ==========================================================
   CloudTorrent — script.js
   Plain JavaScript, no build step, no dependencies.

   Sections:
   1. Configuration
   2. Demo data (always labelled "Demo" in the interface)
   3. Service layer  <-- the ONLY part to change when a backend is added
   4. Helpers
   5. State and settings
   6. Rendering
   7. Interactions
   8. Navigation
   9. Init
   ========================================================== */

(() => {
  "use strict";

  /* ========================================================
     1. CONFIGURATION
     Leave backendUrl empty. Never put API keys, passwords or
     tokens in this file: it is public and visible to everyone.
     ======================================================== */
  const CONFIG = {
    backendUrl: "",
    storageKey: "cloudtorrent.settings.v1",
    maxMagnetLength: 8192
  };

  const VIEWS = ["dashboard", "files", "activity", "settings"];
  const VIEW_TITLES = {
    dashboard: "Dashboard",
    files: "My Files",
    activity: "Activity",
    settings: "Settings"
  };
  const ACCENTS = ["violet", "indigo", "lavender"];
  const SVG_NS = "http://www.w3.org/2000/svg";

  /* ========================================================
     2. DEMO DATA
     Sample data only. Nothing here is real, and nothing here
     is downloading. Every place that shows it is labelled.
     ======================================================== */
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const minutesAgo = (n) => Date.now() - n * 60 * 1000;

  const DEMO_JOBS = [
    { id: "job-1", name: "open-source-distro-24.04-desktop.iso", status: "downloading", progress: 62, totalBytes: 5.8 * GB, speedBps: 8.4 * MB, demo: true },
    { id: "job-2", name: "Public Domain Film Collection", status: "downloading", progress: 18, totalBytes: 12.4 * GB, speedBps: 3.1 * MB, demo: true },
    { id: "job-3", name: "Creative Commons Album (sample)", status: "completed", progress: 100, totalBytes: 412 * MB, demo: true },
    { id: "job-4", name: "lecture-series-archive.zip", status: "waiting", progress: 0, totalBytes: 1.2 * GB, demo: true },
    { id: "job-5", name: "project-backup.tar.gz", status: "error", progress: 34, totalBytes: 860 * MB, errorMessage: "Sample error: tracker unreachable", demo: true }
  ];

  const DEMO_FILES = [
    { id: "file-1", jobId: "job-3", name: "Creative Commons Album", type: "folder", itemCount: 12, size: 412 * MB, demo: true },
    { id: "file-2", jobId: "job-2", name: "Public Domain Films", type: "folder", itemCount: 4, size: 2.3 * GB, demo: true },
    { id: "file-3", jobId: "job-1", name: "open-source-distro-24.04-desktop.iso", type: "disk", size: 5.8 * GB, demo: true },
    { id: "file-4", jobId: "job-4", name: "lecture-notes.pdf", type: "document", size: 3.4 * MB, demo: true },
    { id: "file-5", jobId: "job-2", name: "nature-timelapse.mkv", type: "video", size: 1.1 * GB, demo: true },
    { id: "file-6", jobId: "job-3", name: "podcast-episode-12.mp3", type: "audio", size: 48 * MB, demo: true },
    { id: "file-7", jobId: "job-5", name: "project-backup-part1.zip", type: "archive", size: 210 * MB, demo: true },
    { id: "file-8", jobId: "job-3", name: "cover-art.png", type: "image", size: 2.1 * MB, demo: true }
  ];

  const TYPE_LABELS = {
    folder: "Folder",
    disk: "Disk image",
    document: "Document",
    video: "Video",
    audio: "Audio",
    archive: "Archive",
    image: "Image"
  };

  const DEMO_EVENTS = [
    { id: "demo-ev-1", text: "Magnet link added: Creative Commons Album (sample)", kind: "info", time: minutesAgo(190), demo: true },
    { id: "demo-ev-2", text: "Download completed: Creative Commons Album (sample)", kind: "ok", time: minutesAgo(70), demo: true },
    { id: "demo-ev-3", text: "Download failed: project-backup.tar.gz", kind: "error", time: minutesAgo(25), demo: true },
    { id: "demo-ev-4", text: "Magnet link validation passed", kind: "ok", time: minutesAgo(8), demo: true }
  ];

  /* ========================================================
     3. SERVICE LAYER
     All backend-related logic lives here, separate from the UI.
     To connect a real backend later, implement the marked
     branches below. The rest of the interface keeps working.
     Every function returns plain objects and never touches the DOM.
     ======================================================== */
  const Service = {
    isBackendConfigured() {
      return CONFIG.backendUrl.trim() !== "";
    },

    /**
     * Validates a magnet URI. Runs entirely in the browser and is real validation.
     * Returns { valid: true, infoHash, hashType, name, trackerCount }
     *      or { valid: false, error }.
     */
    validateMagnet(magnetUri) {
      const text = typeof magnetUri === "string" ? magnetUri.trim() : "";

      if (!text) {
        return { valid: false, error: "Paste a magnet link first." };
      }
      if (text.length > CONFIG.maxMagnetLength) {
        return { valid: false, error: "That link is too long to be a normal magnet link." };
      }
      if (/\s/.test(text)) {
        return { valid: false, error: "Magnet links can't contain spaces or line breaks. Check that you copied the whole link." };
      }
      if (/^https?:\/\//i.test(text) || /\.torrent(\?|$)/i.test(text)) {
        return { valid: false, error: "That looks like a web address or a .torrent file. Please paste a magnet link that starts with magnet:?" };
      }
      if (!/^magnet:\?/i.test(text)) {
        return { valid: false, error: "That doesn't look like a magnet link. It should start with magnet:?" };
      }

      // Split the query string manually and decode each value safely.
      const query = text.slice(text.indexOf("?") + 1);
      const params = {};
      for (const part of query.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const rawKey = eq === -1 ? part : part.slice(0, eq);
        const rawValue = eq === -1 ? "" : part.slice(eq + 1);
        const key = rawKey.toLowerCase();
        let value = rawValue;
        try {
          value = decodeURIComponent(rawValue.replace(/\+/g, " "));
        } catch {
          // Keep the raw value if it is not valid percent-encoding.
        }
        (params[key] = params[key] || []).push(value);
      }

      const topics = params.xt || [];
      if (topics.length === 0) {
        return { valid: false, error: "The link is missing its xt parameter (the torrent identifier). It may have been cut off when copying." };
      }

      let infoHash = null;
      let hashType = null;
      let sawTopic = false;

      for (const topic of topics) {
        const btih = /^urn:btih:(.+)$/i.exec(topic);
        const btmh = /^urn:btmh:(.+)$/i.exec(topic);
        if (btih) {
          sawTopic = true;
          const hash = btih[1];
          if (/^[0-9a-f]{40}$/i.test(hash) || /^[a-z2-7]{32}$/i.test(hash)) {
            infoHash = hash.toLowerCase();
            hashType = "btih";
            break;
          }
        } else if (btmh) {
          sawTopic = true;
          if (/^1220[0-9a-f]{64}$/i.test(btmh[1])) {
            infoHash = btmh[1].toLowerCase();
            hashType = "btmh";
            break;
          }
        }
      }

      if (!infoHash) {
        if (!sawTopic) {
          return { valid: false, error: "The xt parameter should start with urn:btih: followed by the torrent hash." };
        }
        return { valid: false, error: "The torrent hash looks wrong. It should be 40 hexadecimal characters (or 32 Base32 characters). The link may be incomplete." };
      }

      return {
        valid: true,
        infoHash,
        hashType,
        name: params.dn && params.dn[0] ? params.dn[0] : "",
        trackerCount: (params.tr || []).length
      };
    },

    /**
     * Submits a magnet to the backend.
     * Currently NEVER starts a download: no backend exists yet.
     * Returns { ok, code, message, validation? }.
     *
     * FUTURE: when a backend exists, replace the final return with a call such as:
     *   const res = await fetch(CONFIG.backendUrl + "/torrents", {
     *     method: "POST",
     *     headers: { "Content-Type": "application/json" },
     *     body: JSON.stringify({ magnet: magnetUri })
     *   });
     * Authentication must be handled by the backend (for example with a
     * session cookie), never by a secret stored in this file.
     */
    async addTorrent(magnetUri) {
      const validation = Service.validateMagnet(magnetUri);
      if (!validation.valid) {
        return { ok: false, code: "INVALID_MAGNET", message: validation.error };
      }
      if (!Service.isBackendConfigured()) {
        return {
          ok: false,
          code: "BACKEND_NOT_CONFIGURED",
          message: "No backend is connected, so nothing was sent or downloaded.",
          validation
        };
      }
      return {
        ok: false,
        code: "NOT_IMPLEMENTED",
        message: "A backend URL is set, but the integration has not been implemented yet.",
        validation
      };
    },

    /**
     * Returns the list of torrent jobs.
     * Demo jobs are included only when includeDemo is true.
     * FUTURE: when a backend exists, fetch real jobs and return them with demo: false.
     */
    async getTorrentJobs({ includeDemo = false } = {}) {
      const realJobs = []; // FUTURE: fetch from the backend.
      const demoJobs = includeDemo ? DEMO_JOBS.map((job) => ({ ...job })) : [];
      return [...realJobs, ...demoJobs];
    },

    /**
     * Returns files. Pass a jobId to get one job's files, or null for all files.
     * FUTURE: fetch real files from the backend.
     */
    async getTorrentFiles(jobId = null, { includeDemo = false } = {}) {
      const realFiles = []; // FUTURE: fetch from the backend.
      let demoFiles = includeDemo ? DEMO_FILES.map((file) => ({ ...file })) : [];
      if (jobId) demoFiles = demoFiles.filter((file) => file.jobId === jobId);
      return [...realFiles, ...demoFiles];
    },

    /**
     * Requests a file download. Currently always unavailable.
     * FUTURE: return a short-lived download URL created by the backend.
     */
    async downloadFile(fileId) {
      return {
        ok: false,
        code: "BACKEND_NOT_CONFIGURED",
        fileId,
        message: "Downloads are unavailable until a backend is connected and the file really exists."
      };
    },

    /** Demo events for the Activity view. Real events are created by the UI. */
    async getActivity({ includeDemo = false } = {}) {
      return includeDemo ? DEMO_EVENTS.map((event) => ({ ...event })) : [];
    }
  };

  /* ========================================================
     4. HELPERS
     ======================================================== */
  const $ = (selector) => document.querySelector(selector);

  /** Builds an element safely. Text always goes in as textContent, never as HTML. */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  }

  /** Creates an inline SVG icon that references the sprite in index.html. */
  function icon(id) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#" + id);
    svg.append(use);
    return svg;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return (unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m left";
    if (m > 0) return m + "m left";
    return s + "s left";
  }

  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  /* ========================================================
     5. STATE AND SETTINGS
     ======================================================== */
  const state = {
    jobs: [],
    files: [],
    demoEvents: [],
    events: [], // events created in this browser session
    removedJobIds: new Set(),
    demoEventsCleared: false,
    busy: false
  };

  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const defaultSettings = {
    accent: "violet",
    compact: false,
    reduceMotion: prefersReducedMotion,
    demo: true
  };

  let settings = { ...defaultSettings };

  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(CONFIG.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        const merged = { ...defaultSettings };
        if (ACCENTS.includes(parsed.accent)) merged.accent = parsed.accent;
        if (typeof parsed.compact === "boolean") merged.compact = parsed.compact;
        if (typeof parsed.reduceMotion === "boolean") merged.reduceMotion = parsed.reduceMotion;
        if (typeof parsed.demo === "boolean") merged.demo = parsed.demo;
        return merged;
      }
    } catch {
      // Storage can be unavailable (private mode); fall back to defaults.
    }
    return { ...defaultSettings };
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(CONFIG.storageKey, JSON.stringify(settings));
    } catch {
      // Ignore: settings simply won't persist.
    }
  }

  function applySettings() {
    const root = document.documentElement;
    root.setAttribute("data-accent", settings.accent);
    if (settings.compact) root.setAttribute("data-compact", "true");
    else root.removeAttribute("data-compact");
    if (settings.reduceMotion) root.setAttribute("data-reduce-motion", "true");
    else root.removeAttribute("data-reduce-motion");
  }

  /* ========================================================
     6. RENDERING
     ======================================================== */

  /* ---- Toasts ---- */
  function toast(message) {
    const region = $("#toast-region");
    const node = el("div", { class: "toast", text: message });
    region.append(node);
    while (region.children.length > 3) region.firstElementChild.remove();
    window.setTimeout(() => node.remove(), 3800);
  }

  /* ---- Backend status ---- */
  function renderBackendStatus() {
    const configured = Service.isBackendConfigured();
    const pill = $("#backend-pill");
    const topbar = $("#topbar-status");
    pill.className = "pill pill-warn";
    topbar.className = "pill pill-warn";
    if (configured) {
      pill.textContent = "Not verified";
      topbar.textContent = "Backend not verified";
      $("#backend-text").textContent =
        "A backend URL is set, but this prototype does not verify the connection yet. Nothing is downloaded until the integration is implemented and tested.";
    } else {
      pill.textContent = "Not connected";
      topbar.textContent = "Backend not connected";
    }
  }

  /* ---- Torrent jobs ---- */
  function closeMenus() {
    document.querySelectorAll(".job-actions .menu").forEach((menu) => {
      const button = menu.parentElement.querySelector(".menu-btn");
      if (button) button.setAttribute("aria-expanded", "false");
      menu.remove();
    });
  }

  function menuItem(label, onClick, disabled = false) {
    const button = el("button", { type: "button", role: "menuitem", text: label });
    if (disabled) {
      button.disabled = true;
    } else {
      button.addEventListener("click", () => {
        closeMenus();
        onClick();
      });
    }
    return button;
  }

  function openJobMenu(job, actions, trigger) {
    const menu = el("div", { class: "menu", role: "menu", "aria-label": "Actions for " + job.name });

    menu.append(
      menuItem("Open My Files", () => {
        window.location.hash = "#files";
      }),
      menuItem("Copy name", async () => {
        try {
          await navigator.clipboard.writeText(job.name);
          toast("Name copied.");
        } catch {
          toast("Couldn't copy automatically. Press and hold the name to copy it.");
        }
      })
    );

    if (job.status === "error") {
      menu.append(
        menuItem("Retry", () => {
          toast("Retry is unavailable until a backend is connected.");
        })
      );
    }

    menu.append(menuItem("Download (needs backend)", () => {}, true));

    if (job.demo) {
      menu.append(
        menuItem("Remove from demo list", () => {
          state.removedJobIds.add(job.id);
          state.jobs = state.jobs.filter((item) => item.id !== job.id);
          renderJobs();
          toast("Removed from the demo list.");
        })
      );
    }

    actions.append(menu);
    trigger.setAttribute("aria-expanded", "true");
    const first = menu.querySelector("button:not([disabled])");
    if (first) first.focus();
  }

  function renderJob(job) {
    const label = { waiting: "Waiting", downloading: "Downloading", completed: "Completed", error: "Error" }[job.status] || "Waiting";
    const percent = Math.max(0, Math.min(100, Math.round(job.progress)));
    const downloadedBytes = (job.totalBytes * percent) / 100;

    const trigger = el("button", {
      type: "button",
      class: "menu-btn",
      "aria-label": "Actions for " + job.name,
      "aria-haspopup": "menu",
      "aria-expanded": "false"
    }, icon("i-more"));

    const actions = el("div", { class: "job-actions" }, trigger);
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const alreadyOpen = actions.querySelector(".menu");
      closeMenus();
      if (!alreadyOpen) openJobMenu(job, actions, trigger);
    });

    const meta = el("div", { class: "job-meta" });
    if (job.demo) meta.append(el("span", { class: "tag tag-demo", text: "Demo" }));
    meta.append(el("span", { text: percent + "%" }));
    meta.append(el("span", { text: formatBytes(downloadedBytes) + " of " + formatBytes(job.totalBytes) }));

    if (job.status === "downloading" && job.speedBps > 0) {
      const remaining = job.totalBytes - downloadedBytes;
      meta.append(el("span", { text: formatBytes(job.speedBps) + "/s" }));
      const eta = formatEta(remaining / job.speedBps);
      if (eta) meta.append(el("span", { text: eta }));
    }
    if (job.status === "error" && job.errorMessage) {
      meta.append(el("span", { text: job.errorMessage }));
    }

    const bar = el("div", { class: "progress-bar" });
    bar.style.width = percent + "%";
    const progress = el("div", {
      class: "progress",
      role: "progressbar",
      "aria-label": "Progress for " + job.name,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(percent)
    }, bar);

    const heading = el("div", {}, [
      el("div", { class: "job-name", text: job.name }),
      el("span", { class: "status status-" + job.status, text: label })
    ]);

    return el("li", { class: "job is-" + job.status }, [
      el("div", { class: "job-top" }, [heading, actions]),
      meta,
      progress
    ]);
  }

  function renderJobs() {
    const list = $("#jobs-list");
    list.replaceChildren();
    for (const job of state.jobs) list.append(renderJob(job));
    list.hidden = state.jobs.length === 0;
    $("#jobs-empty").hidden = state.jobs.length > 0;
    $("#jobs-tag").hidden = !state.jobs.some((job) => job.demo);
  }

  /* ---- Files ---- */
  function getVisibleFiles() {
    const query = $("#file-search").value.trim().toLowerCase();
    const sort = $("#file-sort").value;

    let files = state.files.filter((file) => {
      if (!query) return true;
      const haystack = (file.name + " " + (TYPE_LABELS[file.type] || "")).toLowerCase();
      return haystack.includes(query);
    });

    files = files.slice().sort((a, b) => {
      switch (sort) {
        case "name-desc": return collator.compare(b.name, a.name);
        case "size-desc": return b.size - a.size;
        case "size-asc": return a.size - b.size;
        case "type-asc": {
          const byType = collator.compare(TYPE_LABELS[a.type] || "", TYPE_LABELS[b.type] || "");
          return byType !== 0 ? byType : collator.compare(a.name, b.name);
        }
        default: return collator.compare(a.name, b.name);
      }
    });

    return { files, query };
  }

  function renderFiles() {
    const list = $("#files-list");
    list.replaceChildren();

    const { files, query } = getVisibleFiles();

    for (const file of files) {
      const typeLabel = TYPE_LABELS[file.type] || "File";
      const metaText = file.type === "folder"
        ? typeLabel + " · " + file.itemCount + " items"
        : typeLabel;

      const meta = el("div", { class: "file-meta" });
      if (file.demo) meta.append(el("span", { class: "tag tag-demo", text: "Demo" }), " ");
      meta.append(metaText);

      const download = el("button", {
        type: "button",
        class: "menu-btn",
        title: "Download unavailable until a backend is connected",
        "aria-label": "Download " + file.name + " (unavailable until a backend is connected)",
        "aria-disabled": "true"
      }, icon("i-download"));
      download.style.opacity = "0.55";
      download.addEventListener("click", async () => {
        const result = await Service.downloadFile(file.id);
        toast(result.message);
      });

      list.append(
        el("li", {}, [
          el("span", { class: "file-icon" + (file.type === "folder" ? " is-folder" : "") },
            icon(file.type === "folder" ? "i-folder" : "i-file")),
          el("div", { class: "file-info" }, [
            el("div", { class: "file-name", title: file.name, text: file.name }),
            meta
          ]),
          el("span", { class: "file-size", text: formatBytes(file.size) }),
          download
        ])
      );
    }

    const total = state.files.length;
    const isEmpty = files.length === 0;
    list.hidden = isEmpty;
    $("#files-empty").hidden = !isEmpty;
    $("#files-tag").hidden = !state.files.some((file) => file.demo);
    $("#files-count").textContent = total === 0 ? "" : files.length + (files.length === 1 ? " item" : " items");

    if (isEmpty) {
      if (total === 0) {
        $("#files-empty-title").textContent = "No files yet";
        $("#files-empty-text").textContent = "Completed downloads will be listed here once a backend is connected.";
      } else {
        $("#files-empty-title").textContent = "No matching files";
        $("#files-empty-text").textContent = "Nothing matches “" + truncate(query, 40) + "”. Try a different search.";
      }
    }
  }

  /* ---- Activity ---- */
  function renderActivity() {
    const list = $("#activity-list");
    list.replaceChildren();

    const demoEvents = state.demoEventsCleared ? [] : state.demoEvents;
    const all = [...state.events, ...demoEvents].sort((a, b) => b.time - a.time);

    for (const event of all) {
      const dotClass = "event-dot" + (event.kind === "ok" ? " is-ok" : event.kind === "error" ? " is-error" : "");
      const tag = event.demo
        ? el("span", { class: "tag tag-demo", text: "Demo" })
        : el("span", { class: "tag tag-real", text: "Local" });

      list.append(
        el("li", { class: "event" }, [
          el("span", { class: dotClass, "aria-hidden": "true" }),
          el("div", { class: "event-body" }, [
            el("div", {}, [tag, " ", event.text]),
            el("div", { class: "event-time", text: timeFormatter.format(new Date(event.time)) })
          ])
        ])
      );
    }

    list.hidden = all.length === 0;
    $("#activity-empty").hidden = all.length > 0;
  }

  function addEvent(text, kind = "info") {
    state.events.unshift({
      id: "ev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      text,
      kind,
      time: Date.now(),
      demo: false
    });
    if (state.events.length > 100) state.events.length = 100;
    renderActivity();
  }

  async function refreshAll() {
    const includeDemo = settings.demo;
    const [jobs, files, demoEvents] = await Promise.all([
      Service.getTorrentJobs({ includeDemo }),
      Service.getTorrentFiles(null, { includeDemo }),
      Service.getActivity({ includeDemo })
    ]);
    state.jobs = jobs.filter((job) => !state.removedJobIds.has(job.id));
    state.files = files;
    state.demoEvents = demoEvents;
    renderJobs();
    renderFiles();
    renderActivity();
  }

  /* ========================================================
     7. INTERACTIONS
     ======================================================== */

  /* ---- Magnet form ---- */
  function setFeedback(type, message) {
    const feedback = $("#magnet-feedback");
    feedback.className = "feedback " + type;
    feedback.textContent = message;
  }

  function clearFeedback() {
    const feedback = $("#magnet-feedback");
    feedback.className = "feedback";
    feedback.textContent = "";
    $("#magnet-input").removeAttribute("aria-invalid");
  }

  function syncClearButton() {
    $("#clear-btn").hidden = $("#magnet-input").value.length === 0;
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    const button = $("#add-btn");
    button.disabled = isBusy;
    button.classList.toggle("is-loading", isBusy);
    button.setAttribute("aria-busy", isBusy ? "true" : "false");
  }

  /** Validates what is currently in the field and shows the result, without submitting. */
  function validateInline() {
    const input = $("#magnet-input");
    if (!input.value.trim()) {
      clearFeedback();
      return;
    }
    const check = Service.validateMagnet(input.value);
    if (check.valid) {
      input.setAttribute("aria-invalid", "false");
      setFeedback("success", "Looks like a valid magnet link. Tap “Add magnet” to continue.");
    } else {
      input.setAttribute("aria-invalid", "true");
      setFeedback("error", check.error);
    }
  }

  async function handlePaste() {
    const input = $("#magnet-input");
    const fallback = () => {
      input.focus();
      setFeedback("info", "Couldn't read the clipboard automatically. Touch and hold the field, then tap Paste.");
    };

    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      fallback();
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        setFeedback("info", "Your clipboard is empty. Copy a magnet link first.");
        return;
      }
      input.value = text;
      syncClearButton();
      validateInline();
    } catch {
      fallback();
    }
  }

  function handleClear() {
    const input = $("#magnet-input");
    input.value = "";
    clearFeedback();
    syncClearButton();
    input.focus();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busy) return;

    const input = $("#magnet-input");
    const value = input.value.trim();
    const check = Service.validateMagnet(value);

    if (!check.valid) {
      input.setAttribute("aria-invalid", "true");
      setFeedback("error", check.error);
      addEvent("Magnet link rejected: " + check.error, "error");
      input.focus();
      return;
    }

    input.setAttribute("aria-invalid", "false");
    setBusy(true);
    try {
      const result = await Service.addTorrent(value);
      const label = check.name ? " “" + truncate(check.name, 80) + "”" : "";

      if (result.ok) {
        // FUTURE: runs only when a real backend confirms the torrent was accepted.
        setFeedback("success", "Torrent submitted" + label + ".");
        addEvent("Torrent submitted" + label + ".", "ok");
        await refreshAll();
      } else if (result.code === "INVALID_MAGNET") {
        setFeedback("error", result.message);
        addEvent("Magnet link rejected: " + result.message, "error");
      } else {
        setFeedback(
          "success",
          "Valid magnet link" + label + ". It was checked in your browser only. Nothing was sent or downloaded because no backend is connected."
        );
        addEvent("Magnet link validated locally" + label + ". Not submitted: no backend is connected.", "info");
        toast("Valid magnet link. Not submitted: backend not connected.");
      }
    } catch {
      setFeedback("error", "Something went wrong while checking the link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function bindMagnetForm() {
    const input = $("#magnet-input");

    $("#magnet-form").addEventListener("submit", handleSubmit);
    $("#paste-btn").addEventListener("click", handlePaste);
    $("#clear-btn").addEventListener("click", handleClear);

    input.addEventListener("input", () => {
      syncClearButton();
      clearFeedback();
    });
    // After a native paste, check the link once the field has updated.
    input.addEventListener("paste", () => {
      window.setTimeout(() => {
        input.value = input.value.trim();
        syncClearButton();
        validateInline();
      }, 0);
    });

    syncClearButton();
  }

  /* ---- Files ---- */
  function bindFiles() {
    $("#file-search").addEventListener("input", renderFiles);
    $("#file-sort").addEventListener("change", renderFiles);
  }

  /* ---- Activity ---- */
  function bindActivity() {
    $("#clear-activity-btn").addEventListener("click", () => {
      state.events = [];
      state.demoEventsCleared = true;
      renderActivity();
      toast("Activity log cleared.");
    });
  }

  /* ---- Settings ---- */
  function bindSettings() {
    const accent = $("#accent-select");
    const compact = $("#compact-toggle");
    const motion = $("#motion-toggle");
    const demo = $("#demo-toggle");

    accent.value = settings.accent;
    compact.checked = settings.compact;
    motion.checked = settings.reduceMotion;
    demo.checked = settings.demo;

    accent.addEventListener("change", () => {
      settings.accent = ACCENTS.includes(accent.value) ? accent.value : "violet";
      applySettings();
      saveSettings();
    });
    compact.addEventListener("change", () => {
      settings.compact = compact.checked;
      applySettings();
      saveSettings();
    });
    motion.addEventListener("change", () => {
      settings.reduceMotion = motion.checked;
      applySettings();
      saveSettings();
    });
    demo.addEventListener("change", async () => {
      settings.demo = demo.checked;
      if (settings.demo) {
        state.removedJobIds.clear();
        state.demoEventsCleared = false;
      }
      saveSettings();
      await refreshAll();
      toast(settings.demo ? "Demonstration data is on." : "Demonstration data is off.");
    });
  }

  /* ---- Global listeners for job menus ---- */
  function bindGlobal() {
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".job-actions")) closeMenus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const openMenu = document.querySelector(".job-actions .menu");
      if (!openMenu) return;
      const trigger = openMenu.parentElement.querySelector(".menu-btn");
      closeMenus();
      if (trigger) trigger.focus();
    });
  }

  /* ========================================================
     8. NAVIGATION
     Uses the URL hash (#dashboard, #files, #activity, #settings),
     which works on GitHub Pages without any server setup.
     ======================================================== */
  function currentRoute() {
    const name = window.location.hash.replace("#", "");
    return VIEWS.includes(name) ? name : "dashboard";
  }

  function route(moveFocus) {
    const name = currentRoute();

    for (const view of VIEWS) {
      $("#view-" + view).hidden = view !== name;
    }

    document.querySelectorAll("[data-nav]").forEach((link) => {
      const active = link.dataset.nav === name;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    document.title = VIEW_TITLES[name] + " · CloudTorrent";
    closeMenus();

    if (moveFocus) {
      window.scrollTo(0, 0);
      $("#main").focus({ preventScroll: true });
    }
  }

  /* ========================================================
     9. INIT
     ======================================================== */
  async function init() {
    settings = loadSettings();
    applySettings();
    bindSettings();
    bindMagnetForm();
    bindFiles();
    bindActivity();
    bindGlobal();
    renderBackendStatus();

    window.addEventListener("hashchange", () => route(true));
    route(false);

    await refreshAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
