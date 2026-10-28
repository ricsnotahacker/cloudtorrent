/* ==========================================================
   CloudTorrent — script.js
   Plain JavaScript, no build step, no dependencies.

   Sections:
   1. Configuration and API contract
   2. Helpers
   3. Settings, theme and runtime styles
   4. Authentication (session handling)
   5. Service layer  <-- all backend calls live here
   6. State
   7. Rendering
   8. Interactions
   9. Navigation
   10. Init

   ----------------------------------------------------------
   API CONTRACT (what the Cloudflare Worker must provide)
   ----------------------------------------------------------
   Every response is JSON. Success: HTTP 2xx with {"ok": true, ...}.
   Failure: HTTP 4xx/5xx with {"ok": false, "error": "readable message"}.
   The frontend only reports success when the Worker answers 2xx
   and does not send {"ok": false}.

   Authentication: after /api/login the frontend sends either
     Authorization: Bearer <token>        (if login returned "token")
     X-CloudTorrent-Password: <password>  (current Worker behaviour)
   on every other request. A 401 means "sign in again". The Worker must
   allow both headers in Access-Control-Allow-Headers.

   EXISTING (already used by the current Worker)
   GET  /api/status                  -> {ok, service:"CloudTorrent API"}
   POST /api/login   {password}      -> {ok} (recommended: also {token})
   GET  /api/torrents                -> {ok, torrents:[Torrent]}
   POST /api/torrents {magnet}       -> {ok, message?, torrent?}
   GET  /api/files[?torrentId=ID]    -> {ok, files:[{torrentId,id,name,size}]}
   GET  /api/download?torrentId=&fileId= -> {ok, url}

   Torrent fields read from each item (anything missing is simply not shown):
     id, name, download_state, download_finished (bool),
     progressPercent (0-100)  OR  progress (TorBox fraction 0-1),
     size (bytes), download_speed (bytes/s), eta (seconds),
     seeds, peers (numbers), error (string)

   NEW (must be implemented in worker.js; the frontend already calls them)
   POST /api/torrents/file   multipart/form-data, field "file" (.torrent)
        -> {ok, message?, torrent?}
   POST /api/torrents/url    {url}   direct .torrent URL
        -> {ok, message?, torrent?}
   POST /api/resolve         {url}   web page that may link to .torrents
        -> {ok, candidates:[{url, name?, size?}]}   (empty = nothing found)

   SECURITY REQUIREMENTS for /api/torrents/url and /api/resolve (SSRF):
   http/https only; no credentials in URLs; resolve DNS and reject
   private, loopback, link-local and metadata addresses (10/8, 127/8,
   169.254/16, 172.16/12, 192.168/16, 100.64/10, ::1, fc00::/7, fe80::/10);
   reject localhost / .local / .internal; re-check every redirect hop
   (max 3); cap response size and time; verify a fetched .torrent really
   is bencoded torrent data; never follow login/CAPTCHA/paywall pages.
   The checks in this file are only a convenience; the Worker must
   enforce them itself.

   Never return a download URL that contains the TorBox API key.
   ========================================================== */

(() => {
  "use strict";

  /* ========================================================
     1. CONFIGURATION
     Never put API keys, passwords or tokens in this public file.
     ======================================================== */
  const CONFIG = {
    backendUrl: "https://weathered-hill-176a.ericofelixlopes.workers.dev",
    storageKey: "cloudtorrent.settings.v1",
    sessionKey: "cloudtorrent.session.v1",
    legacyPasswordKey: "cloudtorrent.sessionPassword", // old localStorage key, migrated then deleted
    maxMagnetLength: 8192,
    maxUrlLength: 2048,
    minTorrentFileBytes: 20,
    maxTorrentFileBytes: 10 * 1024 * 1024,
    maxCandidates: 20,
    requestTimeoutMs: 30000,
    longRequestTimeoutMs: 60000,
    pollActiveMs: 10000,
    pollMaxMs: 60000,
    staleMs: 15000
  };

  const ENDPOINTS = {
    status: "/api/status",
    login: "/api/login",
    torrents: "/api/torrents",
    torrentFile: "/api/torrents/file",
    torrentUrl: "/api/torrents/url",
    resolve: "/api/resolve",
    files: "/api/files",
    download: "/api/download"
  };

  const VIEWS = ["dashboard", "files", "activity", "settings"];
  const VIEW_TITLES = { dashboard: "Dashboard", files: "My Files", activity: "Activity", settings: "Settings" };
  const ACCENTS = ["violet", "indigo", "lavender"];
  const THEMES = ["dark", "light"];
  const THEME_COLORS = { dark: "#0c0d14", light: "#f4f5fa" };
  const SVG_NS = "http://www.w3.org/2000/svg";
  // iOS Safari can grey out unknown extensions, so octet-stream is allowed too.
  // The real check happens after selection (extension, size, content).
  const TORRENT_ACCEPT = ".torrent,application/x-bittorrent,application/octet-stream";
  const ACTIVE_STATUSES = ["downloading", "waiting", "unknown"];

  const TYPE_LABELS = {
    folder: "Folder",
    disk: "Disk image",
    document: "Document",
    video: "Video",
    audio: "Audio",
    archive: "Archive",
    image: "Image",
    file: "File"
  };

  /* ========================================================
     2. HELPERS
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

  /** Inline SVG icon that references the sprite in index.html. */
  function icon(id) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#" + id);
    svg.append(use);
    return svg;
  }

  /** Standalone SVG icon (used for the sun/moon, which are not in the sprite). */
  function drawnIcon(shapes) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
      svg.append(shape);
    }
    return svg;
  }

  function themeIcon(theme) {
    if (theme === "light") {
      // Sun: the light theme is active.
      return drawnIcon([
        ["circle", { cx: 12, cy: 12, r: 4.5 }],
        ["path", { d: "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" }]
      ]);
    }
    // Moon: the dark theme is active.
    return drawnIcon([["path", { d: "M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" }]]);
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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

  const timeFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  function fileType(name = "") {
    const ext = String(name).split(".").pop().toLowerCase();
    if (["mp4", "mkv", "mov", "avi", "webm"].includes(ext)) return "video";
    if (["mp3", "wav", "flac", "m4a", "aac"].includes(ext)) return "audio";
    if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return "archive";
    if (["pdf", "doc", "docx", "txt", "epub"].includes(ext)) return "document";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
    if (["iso", "img", "dmg"].includes(ext)) return "disk";
    return "file";
  }

  /* ========================================================
     3. SETTINGS, THEME AND RUNTIME STYLES
     ======================================================== */
  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const defaultSettings = {
    accent: "violet",
    compact: false,
    reduceMotion: prefersReducedMotion,
    theme: "dark" // dark is the default look
  };

  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(CONFIG.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        const merged = { ...defaultSettings };
        if (ACCENTS.includes(parsed.accent)) merged.accent = parsed.accent;
        if (typeof parsed.compact === "boolean") merged.compact = parsed.compact;
        if (typeof parsed.reduceMotion === "boolean") merged.reduceMotion = parsed.reduceMotion;
        if (THEMES.includes(parsed.theme)) merged.theme = parsed.theme;
        return merged; // any old "demo" key is ignored and dropped on the next save
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

  function setMeta(name, content) {
    const meta = document.querySelector('meta[name="' + name + '"]');
    if (meta) meta.setAttribute("content", content);
  }

  function applySettings() {
    const root = document.documentElement;
    root.setAttribute("data-accent", settings.accent);
    root.setAttribute("data-theme", settings.theme);
    root.style.colorScheme = settings.theme; // native controls and scrollbars follow the theme
    setMeta("color-scheme", settings.theme);
    setMeta("theme-color", THEME_COLORS[settings.theme]);
    if (settings.compact) root.setAttribute("data-compact", "true");
    else root.removeAttribute("data-compact");
    if (settings.reduceMotion) root.setAttribute("data-reduce-motion", "true");
    else root.removeAttribute("data-reduce-motion");
  }

  /* Runtime styles. style.css is not modified in this version, so the light
     palette (which only overrides the existing CSS variables, plus the few
     colours that are hard-coded for dark in style.css) and the styles of the
     new controls are injected once. They can be moved into style.css later. */
  const RUNTIME_CSS = `
html[data-theme="light"]{
  --bg:#f4f5fa; --bg-elev:#ffffff; --surface:#ffffff; --surface-2:#eceef5;
  --border:rgba(20,23,42,.10); --border-strong:rgba(20,23,42,.18);
  --text:#161a2e; --text-dim:#454b66; --text-faint:#666c88;
  --ok:#0f7a4a; --ok-soft:rgba(15,122,74,.12);
  --warn:#8a5a00; --warn-soft:rgba(176,112,0,.13);
  --err:#c22b2e; --err-soft:rgba(194,43,46,.10);
  --shadow:0 1px 2px rgba(20,23,42,.06),0 10px 28px -14px rgba(20,23,42,.22);
}
html[data-theme="light"][data-accent="violet"]{--accent:#6652e6;--accent-strong:#5a45e0;--accent-soft:rgba(102,82,230,.12);--accent-ring:rgba(102,82,230,.40)}
html[data-theme="light"][data-accent="indigo"]{--accent:#3f5ee6;--accent-strong:#3350d6;--accent-soft:rgba(63,94,230,.12);--accent-ring:rgba(63,94,230,.40)}
html[data-theme="light"][data-accent="lavender"]{--accent:#7357ee;--accent-strong:#6446e6;--accent-soft:rgba(115,87,238,.12);--accent-ring:rgba(115,87,238,.40)}
html[data-theme="light"] .topbar{background:rgba(244,245,250,.86)}
html[data-theme="light"] .tabbar{background:rgba(255,255,255,.92)}
html[data-theme="light"] .nav-item:hover{background:var(--surface-2)}
html[data-theme="light"] .btn-secondary:hover:not(:disabled){background:#e2e5f0}
html[data-theme="light"] .menu button:hover{background:rgba(20,23,42,.06)}
html[data-theme="light"] .slider::before{box-shadow:0 1px 3px rgba(20,23,42,.35)}
.ct-topbar-actions{display:flex;align-items:center;gap:8px}
.ct-sidebar-theme{margin:4px 0 0 4px}
.ct-upload{display:grid;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--border)}
.ct-upload-label{font-size:13px;font-weight:600;color:var(--text-dim)}
.ct-upload-actions{display:flex;flex-wrap:wrap;gap:10px}
.ct-file-chip{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg)}
.ct-candidates{display:grid;gap:10px;margin-top:14px;padding:12px;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg)}
.ct-cand-list{display:grid;gap:8px}
.ct-cand-list li{display:flex;align-items:center;gap:10px}
.ct-dialog{border:1px solid var(--border-strong);border-radius:16px;padding:20px;width:calc(100% - 32px);max-width:420px;background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.ct-dialog::backdrop{background:rgba(5,6,12,.62)}
.ct-dialog h2{font-size:17px;margin-bottom:6px}
.ct-dialog form{display:grid;gap:10px;margin-top:14px}
.ct-dialog .actions{margin-top:6px}
.toast a{pointer-events:auto}
`;

  function injectRuntimeStyles() {
    if (document.getElementById("ct-runtime-styles")) return;
    const style = el("style", { id: "ct-runtime-styles" });
    style.textContent = RUNTIME_CSS;
    document.head.append(style);
  }

  // Apply saved settings and the theme as early as possible to limit any flash.
  let settings = loadSettings();
  injectRuntimeStyles();
  applySettings();

  /* ========================================================
     4. AUTHENTICATION
     - The password / token is kept in sessionStorage (this tab only),
       never in localStorage, and is never logged or displayed.
     - The TorBox API key never reaches the browser.
     - Sign-in uses a masked dialog, and parallel requests share one dialog.
     - Limitation: until the Worker returns a session token from /api/login,
       the password itself is what gets stored and re-sent.
     ======================================================== */
  class ApiError extends Error {
    constructor(message, { status = 0, code = "" } = {}) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }

  const Auth = {
    credential: null, // { type: "token" | "password", value }
    pending: null,

    load() {
      try {
        const raw = window.sessionStorage.getItem(CONFIG.sessionKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.type === "token" || parsed.type === "password") && typeof parsed.value === "string" && parsed.value) {
            this.credential = { type: parsed.type, value: parsed.value };
          }
        }
        if (!this.credential) {
          // Migrate the old localStorage password into this tab's session.
          const legacy = window.localStorage.getItem(CONFIG.legacyPasswordKey);
          if (legacy) {
            this.credential = { type: "password", value: legacy };
            this.persist();
          }
        }
      } catch {
        // Storage unavailable: the credential just won't survive a reload.
      }
      try {
        window.localStorage.removeItem(CONFIG.legacyPasswordKey);
      } catch {
        // Ignore.
      }
    },

    persist() {
      try {
        if (this.credential) window.sessionStorage.setItem(CONFIG.sessionKey, JSON.stringify(this.credential));
        else window.sessionStorage.removeItem(CONFIG.sessionKey);
      } catch {
        // Ignore.
      }
      window.dispatchEvent(new Event("ct-auth-change"));
    },

    hasCredential() {
      return this.credential !== null;
    },

    clear() {
      const had = this.credential !== null;
      this.credential = null;
      this.persist();
      return had;
    },

    headers() {
      if (!this.credential) return {};
      if (this.credential.type === "token") return { Authorization: "Bearer " + this.credential.value };
      return { "X-CloudTorrent-Password": this.credential.value };
    },

    async login(password) {
      const data = await Service.request(ENDPOINTS.login, { method: "POST", json: { password }, auth: false, interactive: false });
      if (data.ok !== true) throw new ApiError(data.error || "Login failed. Check your CloudTorrent password.", { code: "AUTH_FAILED" });
      const token = typeof data.token === "string" && data.token ? data.token : typeof data.sessionToken === "string" ? data.sessionToken : "";
      this.credential = token ? { type: "token", value: token } : { type: "password", value: password };
      this.persist();
    },

    /** Resolves true when a usable session exists, false if the user cancelled. */
    ensureSession({ reason = "" } = {}) {
      if (this.credential) return Promise.resolve(true);
      if (!this.pending) {
        this.pending = this.signIn({ reason }).finally(() => {
          this.pending = null;
        });
      }
      return this.pending;
    },

    signIn({ reason = "" } = {}) {
      return new Promise((resolve) => {
        if (typeof HTMLDialogElement === "undefined" || typeof HTMLDialogElement.prototype.showModal !== "function") {
          // Very old browsers only: window.prompt cannot mask what is typed.
          const typed = window.prompt("Enter your CloudTorrent password (this basic prompt does not hide what you type):");
          if (!typed) {
            resolve(false);
            return;
          }
          this.login(typed).then(
            () => resolve(true),
            (error) => {
              toast(error.message || "Sign-in failed.");
              resolve(false);
            }
          );
          return;
        }

        const title = el("h2", { id: "ct-auth-title", text: "Sign in to CloudTorrent" });
        const intro = el("p", { class: "muted", text: reason || "Enter your CloudTorrent password to unlock your private torrent session." });
        const label = el("label", { class: "field-label", for: "ct-auth-password", text: "Password" });
        const input = el("input", {
          id: "ct-auth-password",
          name: "password",
          type: "password",
          autocomplete: "current-password",
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false"
        });
        const error = el("p", { class: "feedback error", role: "alert" });
        const cancelBtn = el("button", { type: "button", class: "btn btn-secondary", text: "Cancel" });
        const submitBtn = el("button", { type: "submit", class: "btn btn-primary", text: "Sign in" });
        const form = el("form", { novalidate: true }, [
          label,
          el("div", { class: "magnet-field" }, input),
          error,
          el("div", { class: "actions" }, [cancelBtn, submitBtn])
        ]);
        const dialog = el("dialog", { class: "ct-dialog", "aria-labelledby": "ct-auth-title" }, [title, intro, form]);

        let success = false;
        let working = false;
        const setWorking = (value) => {
          working = value;
          input.disabled = value;
          submitBtn.disabled = value;
          cancelBtn.disabled = value;
          submitBtn.textContent = value ? "Signing in…" : "Sign in";
        };

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (working) return;
          const password = input.value;
          if (!password) {
            error.textContent = "Enter your password.";
            input.focus();
            return;
          }
          error.textContent = "";
          setWorking(true);
          try {
            await this.login(password);
            success = true;
            dialog.close();
          } catch (err) {
            error.textContent = err.message || "Sign-in failed.";
            setWorking(false);
            input.focus();
            input.select();
          }
        });
        cancelBtn.addEventListener("click", () => dialog.close());
        dialog.addEventListener("cancel", (event) => {
          if (working) event.preventDefault();
        });
        dialog.addEventListener("close", () => {
          input.value = "";
          dialog.remove();
          resolve(success);
        });

        document.body.append(dialog);
        dialog.showModal();
        input.focus();
      });
    }
  };

  /* ========================================================
     5. SERVICE LAYER
     All backend-related logic lives here. It never touches the DOM
     (apart from the File API for reading a chosen .torrent file).
     ======================================================== */

  /** Checks a URL string. Client-side screening only; the Worker must enforce its own rules. */
  function screenUrl(text) {
    if (text.length > CONFIG.maxUrlLength) return { valid: false, error: "That web address is too long." };
    if (/\s/.test(text)) return { valid: false, error: "Web addresses can't contain spaces or line breaks. Check that you copied the whole link." };
    let url;
    try {
      url = new URL(text);
    } catch {
      return { valid: false, error: "That doesn't look like a valid web address." };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { valid: false, error: "Only http and https links are supported." };
    if (url.username || url.password) return { valid: false, error: "Links that contain a username or password aren't supported." };
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":") || host.startsWith("[")) {
      return { valid: false, error: "Local or internal addresses aren't allowed." };
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      const isPrivate =
        a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
      if (isPrivate) return { valid: false, error: "Local or private network addresses aren't allowed." };
    }
    return { valid: true, url };
  }

  function normalizeCandidate(entry) {
    const raw = typeof entry === "string" ? { url: entry } : entry;
    if (!raw || typeof raw.url !== "string") return null;
    const screened = screenUrl(raw.url.trim());
    if (!screened.valid) return null;
    const label = typeof raw.name === "string" ? raw.name : typeof raw.label === "string" ? raw.label : "";
    let fallbackName = "";
    try {
      fallbackName = decodeURIComponent(screened.url.pathname.split("/").filter(Boolean).pop() || "");
    } catch {
      fallbackName = screened.url.pathname.split("/").filter(Boolean).pop() || "";
    }
    return {
      url: screened.url.href,
      name: (label || fallbackName || screened.url.hostname).trim(),
      host: screened.url.hostname,
      size: toNumber(raw.size)
    };
  }

  function readBytes(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsArrayBuffer(file);
    });
  }

  function containsBytes(bytes, pattern) {
    outer: for (let i = 0; i <= bytes.length - pattern.length; i += 1) {
      if (bytes[i] !== pattern[0]) continue;
      for (let j = 1; j < pattern.length; j += 1) {
        if (bytes[i + j] !== pattern[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function withTimeout(signal, ms) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return { signal: controller.signal, timedOut: () => timedOut, done: () => window.clearTimeout(timer) };
  }

  function messageFrom(data) {
    if (!data || typeof data !== "object") return "";
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") return data.error.message;
    if (typeof data.message === "string") return data.message;
    return "";
  }

  function normalizeStatus(stateText, finished, errorValue) {
    const s = String(stateText || "").toLowerCase();
    if (typeof errorValue === "string" && errorValue.trim()) return "error";
    if (/error|fail|missingfiles|expired/.test(s)) return "error";
    if (finished === true || s === "completed" || s === "cached" || /^(uploading|seeding|stalledup|pausedup|queuedup|checkingup|forcedup)/.test(s)) return "completed";
    if (s === "downloading" || s === "forceddl") return "downloading";
    if (/^(metadl|queueddl|pauseddl|checkingdl|checkingresumedata|allocating|moving|paused|queued|waiting|stalled)/.test(s)) return "waiting";
    return "unknown"; // never guess "downloading"
  }

  function progressPercent(t) {
    const percent = toNumber(t.progressPercent ?? t.download_percent);
    if (percent !== null) return Math.max(0, Math.min(100, percent));
    const raw = toNumber(t.progress);
    if (raw === null) return null;
    return Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw)); // TorBox sends a 0-1 fraction
  }

  function mapJob(t) {
    if (!t || typeof t !== "object") return null;
    const rawId = t.id ?? t.torrent_id ?? t.hash;
    if (rawId === undefined || rawId === null || rawId === "") return null;
    const stateSource = t.download_state ?? t.status;
    const stateText = typeof stateSource === "string" ? stateSource : "";
    const status = normalizeStatus(stateText, t.download_finished, t.error);
    let progress = progressPercent(t);
    if (status === "completed") progress = 100;
    return {
      id: "torbox-" + rawId,
      torboxId: String(rawId),
      name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : "Torrent " + rawId,
      status,
      stateText,
      progress,
      totalBytes: toNumber(t.size ?? t.total_size),
      speedBps: toNumber(t.download_speed ?? t.download_speed_bytes),
      etaSeconds: toNumber(t.eta),
      seeds: toNumber(t.seeds),
      peers: toNumber(t.peers),
      errorMessage: typeof t.error === "string" ? t.error : ""
    };
  }

  function mapFile(f) {
    if (!f || typeof f !== "object") return null;
    const torrentId = f.torrentId ?? f.torrent_id;
    if (torrentId === undefined || torrentId === null || f.id === undefined || f.id === null) return null;
    const name = typeof f.name === "string" && f.name ? f.name : "File " + f.id;
    return {
      id: "torbox-file-" + torrentId + "-" + f.id,
      torrentId: String(torrentId),
      fileId: String(f.id),
      jobId: "torbox-" + torrentId,
      name,
      type: f.type && TYPE_LABELS[f.type] ? f.type : fileType(name),
      size: toNumber(f.size) ?? 0,
      itemCount: toNumber(f.itemCount)
    };
  }

  const Service = {
    isBackendConfigured() {
      return CONFIG.backendUrl.trim() !== "";
    },

    /**
     * One place for every backend call.
     * Throws ApiError (message is safe to show). Options:
     *   method, json, form, signal, auth (default true), interactive (default true),
     *   timeoutMs, unsupported (message used when the endpoint does not exist yet).
     */
    async request(path, options = {}) {
      const { method = "GET", json, form, signal, auth = true, interactive = true, timeoutMs = CONFIG.requestTimeoutMs, unsupported = "" } = options;
      if (!this.isBackendConfigured()) throw new ApiError("The backend URL is not configured.", { code: "NO_BACKEND" });
      const url = CONFIG.backendUrl.replace(/\/$/, "") + path;

      const attempt = async () => {
        const headers = { Accept: "application/json" };
        if (json !== undefined) headers["Content-Type"] = "application/json";
        if (auth) Object.assign(headers, Auth.headers());
        const timer = withTimeout(signal, timeoutMs);
        try {
          return await fetch(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : form, signal: timer.signal });
        } catch (err) {
          if (timer.timedOut()) throw new ApiError("The backend took too long to respond. Please try again.", { code: "TIMEOUT" });
          if (err && err.name === "AbortError") throw new ApiError("Cancelled.", { code: "ABORTED" });
          throw new ApiError("Couldn't reach the backend. Check your internet connection and that the Worker is online.", { code: "NETWORK" });
        } finally {
          timer.done();
        }
      };

      if (auth && !Auth.hasCredential()) {
        if (!interactive) throw new ApiError("Sign in to continue.", { status: 401, code: "AUTH_REQUIRED" });
        if (!(await Auth.ensureSession())) throw new ApiError("Sign-in was cancelled.", { code: "AUTH_CANCELLED" });
      }

      let response = await attempt();

      if (response.status === 401 && auth) {
        Auth.clear();
        if (!interactive) throw new ApiError("Your session has ended. Sign in to continue.", { status: 401, code: "AUTH_REQUIRED" });
        if (!(await Auth.ensureSession({ reason: "Your session is no longer valid. Please sign in again." }))) {
          throw new ApiError("Sign-in was cancelled.", { code: "AUTH_CANCELLED" });
        }
        response = await attempt();
        if (response.status === 401) {
          Auth.clear();
          throw new ApiError("The backend rejected your credentials.", { status: 401, code: "AUTH_REQUIRED" });
        }
      }

      let data = null;
      try {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null; // non-JSON body (for example an HTML error page)
      }

      if (!response.ok || (data && data.ok === false)) {
        if (unsupported && [404, 405, 501].includes(response.status)) {
          throw new ApiError(unsupported, { status: response.status, code: "NOT_SUPPORTED" });
        }
        throw new ApiError(messageFrom(data) || "The backend returned an error (HTTP " + response.status + ").", {
          status: response.status,
          code: data && typeof data.code === "string" ? data.code : "BACKEND_ERROR"
        });
      }
      if (!data || typeof data !== "object") throw new ApiError("The backend returned an unexpected response.", { status: response.status, code: "BAD_RESPONSE" });
      return data;
    },

    async checkStatus() {
      try {
        const data = await this.request(ENDPOINTS.status, { auth: false, interactive: false, timeoutMs: 10000 });
        if (data.ok !== true || data.service !== "CloudTorrent API") throw new ApiError("Unexpected API response.");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message || "Unknown error" };
      }
    },

    /** Validates a magnet URI. Runs in the browser. */
    validateMagnet(magnetUri) {
      const text = typeof magnetUri === "string" ? magnetUri.trim() : "";
      if (!text) return { valid: false, error: "Paste a magnet link first." };
      if (text.length > CONFIG.maxMagnetLength) return { valid: false, error: "That link is too long to be a normal magnet link." };
      if (/\s/.test(text)) return { valid: false, error: "Magnet links can't contain spaces or line breaks. Check that you copied the whole link." };
      if (/^https?:\/\//i.test(text) || /\.torrent(\?|$)/i.test(text)) return { valid: false, error: "That looks like a web address or a .torrent file. Please paste a magnet link that starts with magnet:?" };
      if (!/^magnet:\?/i.test(text)) return { valid: false, error: "That doesn't look like a magnet link. It should start with magnet:?" };
      const params = {};
      for (const part of text.slice(text.indexOf("?") + 1).split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
        let value = eq === -1 ? "" : part.slice(eq + 1);
        try {
          value = decodeURIComponent(value.replace(/\+/g, " "));
        } catch {
          // keep the raw value
        }
        (params[key] = params[key] || []).push(value);
      }
      const topics = params.xt || [];
      if (!topics.length) return { valid: false, error: "The link is missing its xt parameter (the torrent identifier). It may have been cut off when copying." };
      let infoHash = null;
      let hashType = null;
      let sawTopic = false;
      for (const topic of topics) {
        const btih = /^urn:btih:(.+)$/i.exec(topic);
        const btmh = /^urn:btmh:(.+)$/i.exec(topic);
        if (btih) {
          sawTopic = true;
          if (/^[0-9a-f]{40}$/i.test(btih[1]) || /^[a-z2-7]{32}$/i.test(btih[1])) {
            infoHash = btih[1].toLowerCase();
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
      if (!infoHash) return { valid: false, error: !sawTopic ? "The xt parameter should start with urn:btih: followed by the torrent hash." : "The torrent hash looks wrong. The link may be incomplete." };
      return { valid: true, infoHash, hashType, name: params.dn?.[0] || "", trackerCount: (params.tr || []).length };
    },

    /**
     * Decides what the user pasted: "magnet", "torrent-url" (path ends in .torrent)
     * or "page-url". The ".torrent" check is only used to choose the endpoint;
     * the backend verifies that real torrent data was found.
     */
    classifyInput(raw) {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) return { valid: false, error: "Paste a magnet link or a torrent URL first." };
      if (/^magnet:/i.test(text)) {
        const magnet = this.validateMagnet(text);
        return magnet.valid ? { ...magnet, kind: "magnet" } : magnet;
      }
      if (/^https?:\/\//i.test(text)) {
        const screened = screenUrl(text);
        if (!screened.valid) return screened;
        const direct = /\.torrent$/i.test(screened.url.pathname);
        return { valid: true, kind: direct ? "torrent-url" : "page-url", url: screened.url.href, host: screened.url.hostname };
      }
      if (/\.torrent$/i.test(text)) return { valid: false, error: "That looks like a file name. Use “Choose .torrent file” below to upload it." };
      return { valid: false, error: "That doesn't look like a magnet link or a web address. Magnet links start with magnet:? and web addresses with https://" };
    },

    async validateTorrentFile(file) {
      if (!file || typeof file.name !== "string") return { ok: false, error: "No file selected." };
      if (!/\.torrent$/i.test(file.name)) return { ok: false, error: "That file doesn't end in .torrent. Choose a .torrent file." };
      if (file.size < CONFIG.minTorrentFileBytes) return { ok: false, error: "That file is empty or too small to be a torrent." };
      if (file.size > CONFIG.maxTorrentFileBytes) return { ok: false, error: "That file is too large (maximum " + formatBytes(CONFIG.maxTorrentFileBytes) + ")." };
      const type = String(file.type || "").toLowerCase().split(";")[0].trim();
      if (type && !["application/x-bittorrent", "application/octet-stream", "binary/octet-stream"].includes(type)) {
        return { ok: false, error: "This file is reported as “" + truncate(type, 40) + "”, not a torrent file." };
      }
      let bytes;
      try {
        bytes = await readBytes(file);
      } catch {
        return { ok: false, error: "Couldn't read that file. Try choosing it again." };
      }
      let end = bytes.length - 1;
      while (end > 0 && (bytes[end] === 0x0a || bytes[end] === 0x0d)) end -= 1;
      if (bytes[0] !== 0x64) return { ok: false, error: "This file doesn't contain valid torrent data." };
      if (bytes[end] !== 0x65) return { ok: false, error: "This torrent file looks incomplete or damaged." };
      if (!containsBytes(bytes, [0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f])) return { ok: false, error: "This file has no torrent info section, so it can't be a valid torrent." };
      return { ok: true };
    },

    async submit(path, options, fallbackMessage) {
      try {
        const data = await this.request(path, options);
        return { ok: true, message: (typeof data.message === "string" && data.message) || fallbackMessage, torrent: data.torrent || null };
      } catch (error) {
        return { ok: false, code: error.code || "BACKEND_ERROR", message: error.message || "Could not submit the torrent." };
      }
    },

    /** Submits a magnet link. Success only if the backend confirms. */
    async addTorrent(magnetUri) {
      const validation = this.validateMagnet(magnetUri);
      if (!validation.valid) return { ok: false, code: "INVALID_MAGNET", message: validation.error };
      const result = await this.submit(ENDPOINTS.torrents, { method: "POST", json: { magnet: magnetUri.trim() } }, "Torrent sent to TorBox.");
      return { ...result, validation };
    },

    /** Submits a direct .torrent URL. Needs POST /api/torrents/url in the Worker. */
    async addTorrentUrl(url) {
      const screened = screenUrl(String(url || "").trim());
      if (!screened.valid) return { ok: false, code: "INVALID_URL", message: screened.error };
      return this.submit(
        ENDPOINTS.torrentUrl,
        { method: "POST", json: { url: screened.url.href }, timeoutMs: CONFIG.longRequestTimeoutMs, unsupported: "The backend can't add torrents from a URL yet (POST /api/torrents/url is not implemented)." },
        "Torrent sent to TorBox."
      );
    },

    /** Asks the backend to look for .torrent links on a web page. Needs POST /api/resolve. */
    async resolveTorrentUrl(url) {
      const screened = screenUrl(String(url || "").trim());
      if (!screened.valid) return { ok: false, code: "INVALID_URL", message: screened.error };
      try {
        const data = await this.request(ENDPOINTS.resolve, {
          method: "POST",
          json: { url: screened.url.href },
          timeoutMs: CONFIG.longRequestTimeoutMs,
          unsupported: "The backend can't inspect web pages yet (POST /api/resolve is not implemented)."
        });
        const list = Array.isArray(data.candidates) ? data.candidates : [];
        const candidates = list.map(normalizeCandidate).filter(Boolean).slice(0, CONFIG.maxCandidates);
        if (!candidates.length) {
          return { ok: false, code: "NO_TORRENT_FOUND", message: (typeof data.message === "string" && data.message) || "Couldn't find an accessible .torrent link at that address, so nothing was added." };
        }
        return { ok: true, candidates };
      } catch (error) {
        return { ok: false, code: error.code || "BACKEND_ERROR", message: error.message || "Could not inspect that web page." };
      }
    },

    /** Uploads a .torrent file. Needs POST /api/torrents/file (multipart, field "file"). */
    async addTorrentFile(file, { signal } = {}) {
      const check = await this.validateTorrentFile(file);
      if (!check.ok) return { ok: false, code: "INVALID_FILE", message: check.error };
      const form = new FormData();
      form.append("file", new Blob([file], { type: "application/x-bittorrent" }), file.name);
      return this.submit(
        ENDPOINTS.torrentFile,
        { method: "POST", form, signal, timeoutMs: CONFIG.longRequestTimeoutMs, unsupported: "The backend can't accept .torrent files yet (POST /api/torrents/file is not implemented)." },
        "Torrent file sent to TorBox."
      );
    },

    /** Real torrent jobs. Throws on failure so the UI can show the genuine error. */
    async getTorrentJobs({ interactive = false } = {}) {
      const data = await this.request(ENDPOINTS.torrents, { interactive });
      if (data.torrents === null) return [];
      if (!Array.isArray(data.torrents)) throw new ApiError("The backend returned an unexpected torrent list.", { code: "BAD_RESPONSE" });
      return data.torrents.map(mapJob).filter(Boolean);
    },

    /** Real files (all, or one torrent's). Throws on failure. */
    async getTorrentFiles(jobId = null, { interactive = false } = {}) {
      const torrentId = jobId && String(jobId).startsWith("torbox-") ? String(jobId).slice(7) : "";
      const query = torrentId ? "?torrentId=" + encodeURIComponent(torrentId) : "";
      const data = await this.request(ENDPOINTS.files + query, { interactive });
      if (data.files === null) return [];
      if (!Array.isArray(data.files)) throw new ApiError("The backend returned an unexpected file list.", { code: "BAD_RESPONSE" });
      return data.files.map(mapFile).filter(Boolean);
    },

    /** Asks the backend for a download link. The UI opens it; this layer never does. */
    async downloadFile(ref) {
      const torrentId = ref && ref.torrentId !== undefined ? String(ref.torrentId) : "";
      const fileId = ref && ref.fileId !== undefined ? String(ref.fileId) : "";
      if (!/^\d+$/.test(torrentId) || !/^\d+$/.test(fileId)) return { ok: false, message: "This file has no valid download reference." };
      try {
        const data = await this.request(ENDPOINTS.download + "?torrentId=" + encodeURIComponent(torrentId) + "&fileId=" + encodeURIComponent(fileId), { interactive: true });
        let link = null;
        try {
          link = new URL(String(data.url || ""));
        } catch {
          link = null;
        }
        if (!link || link.protocol !== "https:") return { ok: false, message: "The backend did not return a valid download link." };
        return { ok: true, url: link.href, message: "Download link ready." };
      } catch (error) {
        return { ok: false, message: error.message || "Download unavailable." };
      }
    }
  };

  /* ========================================================
     6. STATE
     ======================================================== */
  const state = {
    jobs: [],
    files: [],
    events: [], // events from this browser session only
    errors: { jobs: null, files: null },
    loaded: { jobs: false, files: false },
    loading: false,
    lastRefresh: 0,
    prevStatus: new Map(),
    busy: false,
    selectedFile: null,
    uploadController: null
  };

  /* ========================================================
     7. RENDERING
     ======================================================== */

  /* ---- Toasts ---- */
  function toast(message, { href = "", hrefText = "", duration = 3800 } = {}) {
    const region = $("#toast-region");
    if (!region) return;
    const node = el("div", { class: "toast" });
    node.append(String(message));
    let ms = duration;
    if (href) {
      try {
        const link = new URL(href);
        if (link.protocol === "https:" || link.protocol === "http:") {
          const anchor = el("a", { href: link.href, target: "_blank", rel: "noopener noreferrer", text: hrefText || "Open" });
          anchor.style.cssText = "margin-left:8px;color:var(--accent);font-weight:600;text-decoration:underline";
          node.append(" ", anchor);
          node.style.pointerEvents = "auto";
          ms = Math.max(ms, 12000);
        }
      } catch {
        // ignore a malformed link
      }
    }
    region.append(node);
    while (region.children.length > 3) region.firstElementChild.remove();
    window.setTimeout(() => node.remove(), ms);
  }

  /* ---- Backend status ---- */
  async function renderBackendStatus() {
    const pill = $("#backend-pill");
    const topbar = $("#topbar-status");
    const text = $("#backend-text");
    const setStatus = (kind, label, topLabel, message) => {
      pill.className = "pill " + kind;
      topbar.className = "pill " + kind;
      pill.textContent = label;
      topbar.textContent = topLabel;
      text.textContent = message;
    };

    if (!Service.isBackendConfigured()) {
      setStatus("pill-warn", "Not connected", "Backend not connected", "No backend URL is configured in script.js, so nothing can be submitted or loaded.");
      return;
    }
    setStatus("pill-warn", "Checking…", "Checking backend…", "Checking the CloudTorrent API connection…");
    const result = await Service.checkStatus();
    if (result.ok) {
      setStatus(
        "pill-ok", "API online", "API online",
        "The Worker responded to /api/status. Whether torrents and downloads work depends on the Worker's TorBox integration; any error it returns is shown here as it happens."
      );
    } else {
      setStatus("pill-warn", "Connection failed", "Backend unavailable", "The backend could not be verified: " + result.error + " Check the Worker deployment and try again.");
    }
  }

  /* ---- Notices and empty states ---- */
  function setNotice(id, beforeNode, message) {
    let notice = document.getElementById(id);
    if (!message) {
      if (notice) notice.hidden = true;
      return;
    }
    if (!notice && beforeNode && beforeNode.parentNode) {
      notice = el("p", { id, class: "feedback error", role: "alert" });
      beforeNode.parentNode.insertBefore(notice, beforeNode);
    }
    if (notice) {
      notice.hidden = false;
      notice.textContent = message;
    }
  }

  function setEmptyState(root, { title, text, action }) {
    if (!root) return;
    const heading = root.querySelector("h3");
    const paragraph = root.querySelector("p");
    if (heading) heading.textContent = title;
    if (paragraph) paragraph.textContent = text;
    const old = root.querySelector("[data-ct-action]");
    if (old) old.remove();
    if (action) {
      const button = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-ct-action": "true", text: action.label });
      button.addEventListener("click", action.onClick);
      root.append(button);
    }
  }

  function dataEmptyState(kind) {
    // kind: "jobs" | "files"
    const noun = kind === "jobs" ? "torrents" : "files";
    if (!Auth.hasCredential()) {
      return { title: "Sign in to see your " + noun, text: "Your " + noun + " are stored in your private TorBox account, which needs your CloudTorrent password.", action: { label: "Sign in", onClick: startSignIn } };
    }
    if (state.loading && !state.loaded[kind]) return { title: "Loading your " + noun + "…", text: "Contacting the backend.", action: null };
    if (state.errors[kind]) {
      return { title: "Couldn't load your " + noun, text: state.errors[kind], action: { label: "Try again", onClick: () => refreshAll({ interactive: true, force: true }) } };
    }
    return kind === "jobs"
      ? { title: "No torrents yet", text: "Torrents you add will appear here with their real status.", action: null }
      : { title: "No files yet", text: "Files appear here once a torrent in your account has files.", action: null };
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
      menu.append(menuItem("Retry", () => toast("To retry, submit the magnet link or torrent again after checking the error.")));
    }
    menu.append(
      menuItem("Open My Files to download", () => {
        window.location.hash = "#files";
        toast("Choose a file in My Files to get its download link.");
      })
    );
    actions.append(menu);
    trigger.setAttribute("aria-expanded", "true");
    const first = menu.querySelector("button:not([disabled])");
    if (first) first.focus();
  }

  function renderJob(job) {
    const labels = { waiting: "Waiting", downloading: "Downloading", completed: "Completed", error: "Error", unknown: "Status unknown" };
    const label = labels[job.status] || "Status unknown";
    const percent = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Math.round(job.progress))) : null;
    const known = Number.isFinite(job.totalBytes) && job.totalBytes > 0;

    const trigger = el("button", { type: "button", class: "menu-btn", "aria-label": "Actions for " + job.name, "aria-haspopup": "menu", "aria-expanded": "false" }, icon("i-more"));
    const actions = el("div", { class: "job-actions" }, trigger);
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const alreadyOpen = actions.querySelector(".menu");
      closeMenus();
      if (!alreadyOpen) openJobMenu(job, actions, trigger);
    });

    const meta = el("div", { class: "job-meta" });
    if (percent !== null) meta.append(el("span", { text: percent + "%" }));
    if (known) {
      const sizeText = job.status === "completed" || percent === null
        ? formatBytes(job.totalBytes)
        : formatBytes((job.totalBytes * percent) / 100) + " of " + formatBytes(job.totalBytes);
      meta.append(el("span", { text: sizeText }));
    }
    if (job.seeds !== null) meta.append(el("span", { text: "Seeds: " + job.seeds }));
    if (job.peers !== null) meta.append(el("span", { text: "Peers: " + job.peers }));

    if (job.status === "downloading" && job.speedBps > 0) {
      meta.append(el("span", { text: formatBytes(job.speedBps) + "/s" }));
      let eta = "";
      if (job.etaSeconds > 0 && job.etaSeconds < 8640000) eta = formatEta(job.etaSeconds); // 8640000 s is TorBox's "unknown" placeholder
      else if (known && percent !== null) eta = formatEta((job.totalBytes * (1 - percent / 100)) / job.speedBps);
      if (eta) meta.append(el("span", { text: eta }));
    }
    if (job.status === "error" && job.errorMessage) meta.append(el("span", { text: job.errorMessage }));
    else if (job.stateText && (job.status === "waiting" || job.status === "unknown" || job.status === "error")) {
      meta.append(el("span", { text: "State: " + job.stateText }));
    }

    const heading = el("div", {}, [
      el("div", { class: "job-name", text: job.name }),
      el("span", { class: "status status-" + (job.status === "unknown" ? "waiting" : job.status), text: label })
    ]);
    const children = [el("div", { class: "job-top" }, [heading, actions]), meta];

    if (percent !== null) {
      const bar = el("div", { class: "progress-bar" });
      bar.style.width = percent + "%";
      children.push(el("div", { class: "progress", role: "progressbar", "aria-label": "Progress for " + job.name, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) }, bar));
    }
    return el("li", { class: "job is-" + job.status }, children);
  }

  function renderJobs() {
    const list = $("#jobs-list");
    const empty = $("#jobs-empty");
    list.replaceChildren();
    for (const job of state.jobs) list.append(renderJob(job));
    const has = state.jobs.length > 0;
    list.hidden = !has;
    empty.hidden = has;
    if (!has) setEmptyState(empty, dataEmptyState("jobs"));
    const notice = has && state.errors.jobs && Auth.hasCredential() ? "Couldn't refresh your torrents: " + state.errors.jobs : "";
    setNotice("jobs-notice", list, notice);
  }

  /* ---- Files ---- */
  function getVisibleFiles() {
    const query = $("#file-search").value.trim().toLowerCase();
    const sort = $("#file-sort").value;
    const files = state.files
      .filter((file) => !query || (file.name + " " + (TYPE_LABELS[file.type] || "")).toLowerCase().includes(query))
      .sort((a, b) => {
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
      const metaText = file.type === "folder" && Number.isFinite(file.itemCount) ? typeLabel + " · " + file.itemCount + " items" : typeLabel;
      const download = el("button", {
        type: "button",
        class: "menu-btn",
        title: "Get a download link for " + file.name,
        "aria-label": "Download " + file.name
      }, icon("i-download"));
      download.addEventListener("click", () => handleDownload(file, download));

      list.append(
        el("li", {}, [
          el("span", { class: "file-icon" + (file.type === "folder" ? " is-folder" : "") }, icon(file.type === "folder" ? "i-folder" : "i-file")),
          el("div", { class: "file-info" }, [
            el("div", { class: "file-name", title: file.name, text: file.name }),
            el("div", { class: "file-meta", text: metaText })
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
    $("#files-count").textContent = total === 0 ? "" : files.length + (files.length === 1 ? " item" : " items");

    if (isEmpty) {
      const view = total > 0
        ? { title: "No matching files", text: "Nothing matches “" + truncate(query, 40) + "”. Try a different search.", action: null }
        : dataEmptyState("files");
      setEmptyState($("#files-empty"), view);
    }
    const notice = !isEmpty && state.errors.files && Auth.hasCredential() ? "Couldn't refresh your files: " + state.errors.files : "";
    setNotice("files-notice", list, notice);
  }

  async function handleDownload(file, button) {
    if (button.dataset.busy === "1") return;
    button.dataset.busy = "1";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await Service.downloadFile({ torrentId: file.torrentId, fileId: file.fileId });
      if (!result.ok) {
        toast(result.message);
        addEvent("Couldn't get a download link for " + truncate(file.name, 80) + ": " + result.message, "error");
        return;
      }
      const win = window.open(result.url, "_blank");
      if (win) {
        try { win.opener = null; } catch { /* ignore */ }
        addEvent("Opened the download link for " + truncate(file.name, 80) + ".", "info");
      } else {
        toast("Your browser blocked the download window.", { href: result.url, hrefText: "Tap to open the download" });
      }
    } finally {
      button.dataset.busy = "";
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  /* ---- Activity (events from this browser session only) ---- */
  function renderActivity() {
    const list = $("#activity-list");
    list.replaceChildren();
    for (const event of state.events) {
      const dotClass = "event-dot" + (event.kind === "ok" ? " is-ok" : event.kind === "error" ? " is-error" : "");
      list.append(
        el("li", { class: "event" }, [
          el("span", { class: dotClass, "aria-hidden": "true" }),
          el("div", { class: "event-body" }, [
            el("div", {}, [el("span", { class: "tag tag-real", text: "Local" }), " ", event.text]),
            el("div", { class: "event-time", text: timeFormatter.format(new Date(event.time)) })
          ])
        ])
      );
    }
    list.hidden = state.events.length === 0;
    $("#activity-empty").hidden = state.events.length > 0;
  }

  function addEvent(text, kind = "info") {
    state.events.unshift({ id: "ev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), text: String(text), kind, time: Date.now() });
    if (state.events.length > 100) state.events.length = 100;
    renderActivity();
  }

  function renderAll() {
    renderJobs();
    renderFiles();
    renderActivity();
  }

  /* ---- Refresh and polling ---- */
  let refreshPromise = null;
  let pollTimer = null;
  let pollFailures = 0;

  function hasActiveJobs() {
    return state.jobs.some((job) => ACTIVE_STATUSES.includes(job.status));
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = null;
    if (document.visibilityState !== "visible" || !Auth.hasCredential() || !hasActiveJobs()) return;
    const delay = Math.min(CONFIG.pollMaxMs, CONFIG.pollActiveMs * Math.pow(2, Math.min(pollFailures, 3)));
    pollTimer = window.setTimeout(() => refreshAll(), delay);
  }

  function noteTransitions(jobs) {
    if (state.loaded.jobs) {
      for (const job of jobs) {
        const before = state.prevStatus.get(job.id);
        if (before && before !== job.status && (job.status === "completed" || job.status === "error")) {
          addEvent((job.status === "completed" ? "Download completed: " : "Download reported an error: ") + truncate(job.name, 80), job.status === "completed" ? "ok" : "error");
        }
      }
    }
    state.prevStatus = new Map(jobs.map((job) => [job.id, job.status]));
  }

  async function doRefresh(interactive) {
    if (interactive && !Auth.hasCredential()) {
      if (!(await Auth.ensureSession())) {
        renderAll();
        return;
      }
    }
    if (!Auth.hasCredential()) {
      renderAll();
      return;
    }
    state.loading = true;
    if (!state.loaded.jobs || !state.loaded.files) renderAll();

    const [jobsResult, filesResult] = await Promise.allSettled([
      Service.getTorrentJobs({ interactive }),
      Service.getTorrentFiles(null, { interactive })
    ]);
    state.loading = false;
    state.lastRefresh = Date.now();
    let failed = false;

    if (jobsResult.status === "fulfilled") {
      noteTransitions(jobsResult.value);
      state.jobs = jobsResult.value;
      state.errors.jobs = null;
      state.loaded.jobs = true;
    } else {
      failed = true;
      state.errors.jobs = jobsResult.reason?.code === "AUTH_REQUIRED" ? null : jobsResult.reason?.message || "Unknown error.";
    }
    if (filesResult.status === "fulfilled") {
      state.files = filesResult.value;
      state.errors.files = null;
      state.loaded.files = true;
    } else {
      failed = true;
      state.errors.files = filesResult.reason?.code === "AUTH_REQUIRED" ? null : filesResult.reason?.message || "Unknown error.";
    }
    pollFailures = failed ? pollFailures + 1 : 0;
    renderAll();
  }

  /** Reloads torrents and files. Concurrent calls share one request unless force is set. */
  function refreshAll({ interactive = false, force = false } = {}) {
    if (refreshPromise) {
      return force ? refreshPromise.then(() => refreshAll({ interactive })) : refreshPromise;
    }
    refreshPromise = (async () => {
      try {
        await doRefresh(interactive);
      } finally {
        refreshPromise = null;
        schedulePoll();
      }
    })();
    return refreshPromise;
  }

  function maybeRefresh() {
    if (Auth.hasCredential() && Date.now() - state.lastRefresh > CONFIG.staleMs) refreshAll();
  }

  /* ========================================================
     8. INTERACTIONS
     ======================================================== */

  /* ---- Sign in / out ---- */
  async function startSignIn() {
    if (await Auth.ensureSession()) {
      addEvent("Signed in.", "ok");
      await refreshAll({ interactive: true, force: true });
    }
  }

  function signOut() {
    Auth.clear();
    addEvent("Signed out. The saved password was removed from this browser tab.", "info");
    toast("Signed out.");
  }

  function handleAuthChange() {
    if (!Auth.hasCredential()) {
      state.jobs = [];
      state.files = [];
      state.errors = { jobs: null, files: null };
      state.loaded = { jobs: false, files: false };
      state.prevStatus = new Map();
      window.clearTimeout(pollTimer);
    }
    renderSessionRow();
    renderAll();
  }

  function renderSessionRow() {
    const text = $("#session-text");
    const button = $("#session-btn");
    if (!text || !button) return;
    if (Auth.hasCredential()) {
      text.textContent = Auth.credential.type === "token"
        ? "Signed in. A session token is kept for this browser tab only."
        : "Signed in. Your password is kept for this browser tab only.";
      button.textContent = "Sign out";
    } else {
      text.textContent = "Not signed in.";
      button.textContent = "Sign in";
    }
  }

  /* ---- Theme ---- */
  const themeButtons = [];

  function makeThemeButton(variant) {
    const button = el("button", { type: "button", class: variant === "settings" ? "btn btn-secondary btn-sm" : "menu-btn" + (variant === "sidebar" ? " ct-sidebar-theme" : ""), "data-theme-toggle": variant });
    button.addEventListener("click", toggleTheme);
    themeButtons.push({ button, variant });
    return button;
  }

  function syncThemeButtons() {
    const next = settings.theme === "light" ? "dark" : "light";
    for (const { button, variant } of themeButtons) {
      button.replaceChildren(themeIcon(settings.theme));
      if (variant === "settings") button.append(el("span", { text: settings.theme === "light" ? "Light" : "Dark" }));
      button.setAttribute("aria-label", "Switch to " + next + " theme. Current theme: " + settings.theme + ".");
      button.title = "Switch to " + next + " theme";
    }
    const description = $("#theme-desc");
    if (description) description.textContent = "Currently " + settings.theme + ". Tap the button to switch to " + next + ".";
  }

  function toggleTheme() {
    settings.theme = settings.theme === "light" ? "dark" : "light";
    applySettings();
    saveSettings();
    syncThemeButtons();
  }

  function mountThemeControls() {
    const status = $("#topbar-status");
    if (status && status.parentNode) {
      const wrap = el("div", { class: "ct-topbar-actions" });
      status.replaceWith(wrap);
      wrap.append(makeThemeButton("topbar"), status);
    }
    const sidebar = $(".sidebar");
    if (sidebar) sidebar.append(makeThemeButton("sidebar"));

    const card = $("#h-appearance") && $("#h-appearance").closest(".card");
    if (card) {
      const row = el("div", { class: "setting" }, [
        el("div", {}, [el("strong", { text: "Theme" }), el("p", { class: "muted", id: "theme-desc" })]),
        makeThemeButton("settings")
      ]);
      const head = card.querySelector(".card-head");
      if (head && head.nextSibling) card.insertBefore(row, head.nextSibling);
      else card.append(row);
    }
    syncThemeButtons();
  }

  function mountSessionRow() {
    const card = $("#h-backend") && $("#h-backend").closest(".card");
    if (!card) return;
    const button = el("button", { type: "button", id: "session-btn", class: "btn btn-secondary btn-sm", text: "Sign in" });
    button.addEventListener("click", () => (Auth.hasCredential() ? signOut() : startSignIn()));
    card.append(el("div", { class: "setting" }, [el("div", {}, [el("strong", { text: "Session" }), el("p", { class: "muted", id: "session-text" })]), button]));
    renderSessionRow();
  }

  /* ---- Magnet / URL form ---- */
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
    document.querySelectorAll(".ct-cand-btn").forEach((node) => { node.disabled = isBusy; });
    renderSelectedFile();
  }

  function validateInline() {
    const input = $("#magnet-input");
    if (!input.value.trim()) {
      clearFeedback();
      return;
    }
    const check = Service.classifyInput(input.value);
    if (!check.valid) {
      input.setAttribute("aria-invalid", "true");
      setFeedback("error", check.error);
      return;
    }
    input.setAttribute("aria-invalid", "false");
    const messages = {
      magnet: "Looks like a valid magnet link. Tap “Add torrent” to continue.",
      "torrent-url": "Looks like a direct .torrent link. The backend will check it before adding.",
      "page-url": "This looks like a web page. The backend will look for a .torrent link on it."
    };
    setFeedback("success", messages[check.kind]);
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
        setFeedback("info", "Your clipboard is empty. Copy a magnet link or torrent URL first.");
        return;
      }
      input.value = text;
      hideCandidates();
      syncClearButton();
      validateInline();
    } catch {
      fallback();
    }
  }

  function handleClear() {
    const input = $("#magnet-input");
    input.value = "";
    hideCandidates();
    clearFeedback();
    syncClearButton();
    input.focus();
  }

  function hideCandidates() {
    const box = document.getElementById("ct-candidates");
    if (box) box.remove();
  }

  function showCandidates(candidates) {
    hideCandidates();
    const list = el("ul", { class: "ct-cand-list" });
    for (const candidate of candidates) {
      const meta = [candidate.host, Number.isFinite(candidate.size) ? formatBytes(candidate.size) : ""].filter(Boolean).join(" · ");
      const add = el("button", { type: "button", class: "btn btn-secondary btn-sm ct-cand-btn", text: "Add" });
      add.disabled = state.busy;
      add.addEventListener("click", () => submitCandidate(candidate));
      list.append(el("li", {}, [
        el("div", { class: "file-info" }, [el("div", { class: "file-name", title: candidate.name, text: candidate.name }), el("div", { class: "file-meta", text: meta })]),
        add
      ]));
    }
    const cancel = el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "Cancel" });
    cancel.addEventListener("click", () => {
      hideCandidates();
      clearFeedback();
    });
    const box = el("div", { id: "ct-candidates", class: "ct-candidates" }, [
      el("div", { class: "field-label", text: "Choose which torrent to add" }),
      list,
      cancel
    ]);
    $("#magnet-feedback").after(box);
  }

  /** Reports a submission result. Success is shown only when the backend confirmed it. */
  async function reportResult(result, label) {
    const suffix = label ? " “" + truncate(label, 80) + "”" : "";
    if (result.ok) {
      setFeedback("success", result.message);
      addEvent("Torrent submitted" + suffix + ".", "ok");
      hideCandidates();
      $("#magnet-input").value = "";
      syncClearButton();
      await refreshAll({ interactive: true, force: true });
    } else {
      setFeedback("error", result.message || "The torrent could not be submitted.");
      addEvent("Torrent not submitted" + suffix + ": " + (result.message || "backend error"), "error");
      if (result.code !== "INVALID_MAGNET") toast(result.message || "Torrent not submitted.");
    }
  }

  async function submitCandidate(candidate) {
    if (state.busy) return;
    setBusy(true);
    try {
      setFeedback("info", "Sending the selected torrent to your backend…");
      await reportResult(await Service.addTorrentUrl(candidate.url), candidate.name);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busy) return;

    const input = $("#magnet-input");
    const value = input.value.trim();
    hideCandidates();
    const parsed = Service.classifyInput(value);

    if (!parsed.valid) {
      input.setAttribute("aria-invalid", "true");
      setFeedback("error", parsed.error);
      addEvent("Input rejected: " + parsed.error, "error");
      input.focus();
      return;
    }

    input.setAttribute("aria-invalid", "false");
    setBusy(true);
    try {
      if (parsed.kind === "magnet") {
        setFeedback("info", "Sending the magnet link to your backend…");
        await reportResult(await Service.addTorrent(value), parsed.name);
      } else if (parsed.kind === "torrent-url") {
        setFeedback("info", "Sending the .torrent link to your backend…");
        await reportResult(await Service.addTorrentUrl(parsed.url), parsed.host);
      } else {
        setFeedback("info", "Looking for a .torrent link on that page…");
        const resolved = await Service.resolveTorrentUrl(parsed.url);
        if (!resolved.ok) {
          setFeedback("error", resolved.message);
          addEvent("Page not resolved (" + parsed.host + "): " + resolved.message, "error");
          if (resolved.code !== "NO_TORRENT_FOUND") toast(resolved.message);
        } else if (resolved.candidates.length === 1) {
          const only = resolved.candidates[0];
          setFeedback("info", "Found a torrent link on that page. Sending it to your backend…");
          await reportResult(await Service.addTorrentUrl(only.url), only.name);
        } else {
          setFeedback("info", "Found " + resolved.candidates.length + " torrent links on that page. Choose one below.");
          showCandidates(resolved.candidates);
        }
      }
    } catch (error) {
      setFeedback("error", error.message || "Something went wrong. Please try again.");
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
    input.addEventListener("paste", () => {
      window.setTimeout(() => {
        input.value = input.value.trim();
        syncClearButton();
        validateInline();
      }, 0);
    });
    syncClearButton();
  }

  /* ---- .torrent file upload ---- */
  function setTorrentFeedback(type, message) {
    const feedback = $("#torrent-feedback");
    if (!feedback) return;
    feedback.className = "feedback " + type;
    feedback.textContent = message;
  }

  function renderSelectedFile() {
    const chip = $("#torrent-file-chip");
    const upload = $("#torrent-upload-btn");
    const choose = $("#torrent-choose-btn");
    if (!chip || !upload || !choose) return;
    const file = state.selectedFile;
    chip.replaceChildren();
    chip.hidden = !file;
    upload.hidden = !file;
    upload.disabled = state.busy || !file;
    choose.disabled = state.busy;
    choose.querySelector("span").textContent = file ? "Replace file" : "Choose .torrent file";
    if (!file) return;
    const remove = el("button", { type: "button", class: "btn btn-ghost btn-sm", text: state.uploadController ? "Cancel upload" : "Remove" });
    remove.addEventListener("click", () => {
      if (state.uploadController) state.uploadController.abort();
      else clearSelectedFile();
    });
    chip.append(
      el("span", { class: "file-icon" }, icon("i-file")),
      el("div", { class: "file-info" }, [el("div", { class: "file-name", title: file.name, text: file.name }), el("div", { class: "file-meta", text: formatBytes(file.size) })]),
      remove
    );
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    const input = $("#torrent-file-input");
    if (input) input.value = ""; // lets the same file be chosen again
    renderSelectedFile();
    setTorrentFeedback("", "");
  }

  async function handleFileSelected() {
    const input = $("#torrent-file-input");
    const file = input.files && input.files[0];
    setTorrentFeedback("", "");
    if (!file) return;
    setTorrentFeedback("info", "Checking the file…");
    const check = await Service.validateTorrentFile(file);
    if (!check.ok) {
      input.value = "";
      state.selectedFile = null;
      renderSelectedFile();
      setTorrentFeedback("error", check.error);
      return;
    }
    state.selectedFile = file;
    renderSelectedFile();
    setTorrentFeedback("info", "File ready. Tap “Upload torrent” to send it to your backend.");
  }

  async function handleUpload() {
    const file = state.selectedFile;
    if (state.busy || !file) return;
    state.uploadController = new AbortController();
    setBusy(true);
    setTorrentFeedback("info", "Uploading “" + truncate(file.name, 60) + "”…");
    try {
      const result = await Service.addTorrentFile(file, { signal: state.uploadController.signal });
      if (result.ok) {
        addEvent("Torrent file submitted: " + truncate(file.name, 80), "ok");
        state.uploadController = null;
        clearSelectedFile();
        setTorrentFeedback("success", result.message);
        await refreshAll({ interactive: true, force: true });
      } else if (result.code === "ABORTED") {
        setTorrentFeedback("info", "Upload cancelled.");
      } else {
        setTorrentFeedback("error", result.message);
        addEvent("Torrent file not submitted (" + truncate(file.name, 60) + "): " + result.message, "error");
      }
    } finally {
      state.uploadController = null;
      setBusy(false);
    }
  }

  function bindTorrentUpload() {
    const form = $("#magnet-form");
    if (!form || $("#torrent-upload")) return;
    const fileInput = el("input", { type: "file", id: "torrent-file-input", accept: TORRENT_ACCEPT, hidden: true, tabindex: "-1", "aria-hidden": "true" });
    const choose = el("button", { type: "button", id: "torrent-choose-btn", class: "btn btn-secondary" }, [icon("i-folder"), el("span", { text: "Choose .torrent file" })]);
    const upload = el("button", { type: "button", id: "torrent-upload-btn", class: "btn btn-primary", hidden: true }, [icon("i-plus"), el("span", { text: "Upload torrent" })]);
    const chip = el("div", { id: "torrent-file-chip", class: "ct-file-chip", hidden: true });
    const feedback = el("p", { id: "torrent-feedback", class: "feedback", role: "alert", "aria-live": "polite" });
    form.append(el("div", { id: "torrent-upload", class: "ct-upload" }, [
      el("div", { class: "ct-upload-label", text: "Or upload a .torrent file" }),
      fileInput,
      chip,
      el("div", { class: "ct-upload-actions" }, [choose, upload]),
      feedback
    ]));
    choose.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", handleFileSelected);
    upload.addEventListener("click", handleUpload);
    renderSelectedFile();
  }

  /* ---- Files / Activity ---- */
  function bindFiles() {
    $("#file-search").addEventListener("input", renderFiles);
    $("#file-sort").addEventListener("change", renderFiles);
  }

  function bindActivity() {
    $("#clear-activity-btn").addEventListener("click", () => {
      state.events = [];
      renderActivity();
      toast("Activity log cleared.");
    });
  }

  /* ---- Settings ---- */
  function bindSettings() {
    const accent = $("#accent-select");
    const compact = $("#compact-toggle");
    const motion = $("#motion-toggle");

    accent.value = settings.accent;
    compact.checked = settings.compact;
    motion.checked = settings.reduceMotion;

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
  }

  /* ---- Global listeners ---- */
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
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        maybeRefresh();
        schedulePoll();
      } else {
        window.clearTimeout(pollTimer);
      }
    });
    window.addEventListener("ct-auth-change", handleAuthChange);
  }

  /* ---- Static page text that must match the live behaviour ---- */
  function prepareStaticUi() {
    const banner = $("#demo-banner");
    if (banner) banner.hidden = true;
    for (const selector of ["#jobs-tag", "#files-tag"]) {
      const node = $(selector);
      if (node) node.hidden = true;
    }
    const demoToggle = $("#demo-toggle");
    if (demoToggle) {
      demoToggle.checked = false;
      const card = demoToggle.closest(".card");
      if (card && card.querySelectorAll(".setting").length <= 1) card.hidden = true;
      else (demoToggle.closest(".setting") || demoToggle.parentElement).hidden = true;
    }

    const label = document.querySelector('label[for="magnet-input"]');
    if (label) label.textContent = "Magnet link or torrent URL";
    const hint = $("#magnet-hint");
    if (hint) hint.textContent = "Paste a magnet link, a direct .torrent URL, or a web page that links to a .torrent file.";
    $("#magnet-input").setAttribute("placeholder", "Magnet link or .torrent URL");
    const addLabel = $("#add-btn span");
    if (addLabel) addLabel.textContent = "Add torrent";

    const filesLead = document.querySelector("#view-files .lead");
    if (filesLead) filesLead.textContent = "Files from the torrents in your account. A download link is requested when you tap download.";
    const activityLead = document.querySelector("#view-activity .lead");
    if (activityLead) activityLead.textContent = "A log of what happened in this browser session.";

    // These three statements in index.html described the old static prototype.
    const privacy = document.querySelectorAll('aside[aria-labelledby="h-privacy"] .checklist li span');
    const privacyText = [
      "Links and .torrent files are sent only to your own CloudTorrent Worker, which forwards them to your TorBox account.",
      "Your password is kept for this browser tab only and is never shown or logged. The TorBox key never reaches your browser.",
      "Use only content you are legally allowed to download."
    ];
    privacy.forEach((node, index) => {
      if (privacyText[index]) node.textContent = privacyText[index];
    });
  }

  /* ========================================================
     9. NAVIGATION
     Uses the URL hash (#dashboard, #files, #activity, #settings).
     ======================================================== */
  function currentRoute() {
    const name = window.location.hash.replace("#", "");
    return VIEWS.includes(name) ? name : "dashboard";
  }

  function route(moveFocus) {
    const name = currentRoute();
    for (const view of VIEWS) $("#view-" + view).hidden = view !== name;
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
      if (name === "dashboard" || name === "files") maybeRefresh();
    }
  }

  /* ========================================================
     10. INIT
     ======================================================== */
  let initialized = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    Auth.load();
    prepareStaticUi();
    bindSettings();
    mountThemeControls();
    bindMagnetForm();
    bindTorrentUpload();
    bindFiles();
    bindActivity();
    bindGlobal();
    mountSessionRow();

    window.addEventListener("hashchange", () => route(true));
    route(false);
    renderAll();

    await Promise.all([renderBackendStatus(), refreshAll()]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
