/**
 * CloudTorrent Worker — TorBox integration
 * Cloudflare Worker secrets required:
 *   TORBOX_API_KEY
 *   CLOUDTORRENT_PASSWORD
 * Keep secrets out of frontend files.
 */
const FRONTEND_ORIGIN = "https://ricsnotahacker.github.io";
const TORBOX_BASE = "https://api.torbox.app/v1/api";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-CloudTorrent-Password",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    };
    const respond = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (origin && origin !== FRONTEND_ORIGIN) return respond({ ok: false, error: "Origin not allowed." }, 403);

    if (url.pathname === "/api/status" && request.method === "GET") {
      return respond({
        ok: true,
        service: "CloudTorrent API",
        torboxConfigured: Boolean(env.TORBOX_API_KEY),
        passwordConfigured: Boolean(env.CLOUDTORRENT_PASSWORD)
      });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!env.CLOUDTORRENT_PASSWORD) return respond({ ok: false, error: "CLOUDTORRENT_PASSWORD is not configured in Cloudflare." }, 503);
      if (typeof body.password !== "string" || body.password !== env.CLOUDTORRENT_PASSWORD) {
        return respond({ ok: false, error: "Invalid CloudTorrent password." }, 401);
      }
      if (!env.TORBOX_API_KEY) return respond({ ok: false, error: "TORBOX_API_KEY is not configured in Cloudflare." }, 503);
      return respond({ ok: true, message: "Authenticated." });
    }

    const suppliedPassword = request.headers.get("X-CloudTorrent-Password") || "";
    if (!env.CLOUDTORRENT_PASSWORD || suppliedPassword !== env.CLOUDTORRENT_PASSWORD) {
      return respond({ ok: false, error: "Please sign in with your CloudTorrent password." }, 401);
    }
    if (!env.TORBOX_API_KEY) return respond({ ok: false, error: "TORBOX_API_KEY is not configured in Cloudflare." }, 503);

    try {
      if (url.pathname === "/api/torrents" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const magnet = typeof body.magnet === "string" ? body.magnet.trim() : "";
        if (!/^magnet:\?/i.test(magnet) || !/([?&])xt=urn:(btih|btmh):/i.test(magnet)) {
          return respond({ ok: false, error: "A valid magnet link with a torrent identifier is required." }, 400);
        }
        const form = new FormData();
        form.set("magnet", magnet);
        form.set("seed", "1");
        const upstream = await fetch(`${TORBOX_BASE}/torrents/createtorrent`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}` },
          body: form
        });
        const result = await upstream.json().catch(() => ({}));
        if (!upstream.ok || result.success === false) {
          return respond({ ok: false, error: safeMessage(result, `TorBox rejected the torrent (HTTP ${upstream.status}).`) }, upstream.status >= 400 ? upstream.status : 502);
        }
        return respond({ ok: true, message: "Torrent submitted to TorBox.", torrent: result.data || result });
      }

      if (url.pathname === "/api/torrents" && request.method === "GET") {
        const upstreamUrl = new URL(`${TORBOX_BASE}/torrents/mylist`);
        upstreamUrl.searchParams.set("bypass_cache", "true");
        const upstream = await fetch(upstreamUrl, {
          headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}` }
        });
        const result = await upstream.json().catch(() => ({}));
        if (!upstream.ok || result.success === false) {
          return respond({ ok: false, error: safeMessage(result, `Could not retrieve torrents from TorBox (HTTP ${upstream.status}).`) }, upstream.status >= 400 ? upstream.status : 502);
        }
        const list = Array.isArray(result.data) ? result.data :
          Array.isArray(result.data?.torrents) ? result.data.torrents :
          Array.isArray(result) ? result : [];
        return respond({ ok: true, torrents: list });
      }

      if (url.pathname === "/api/files" && request.method === "GET") {
        const torrentId = url.searchParams.get("torrentId");
        const upstreamUrl = new URL(`${TORBOX_BASE}/torrents/mylist`);
        upstreamUrl.searchParams.set("bypass_cache", "true");
        if (torrentId && /^\d+$/.test(torrentId)) upstreamUrl.searchParams.set("id", torrentId);
        const upstream = await fetch(upstreamUrl, {
          headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}` }
        });
        const result = await upstream.json().catch(() => ({}));
        if (!upstream.ok || result.success === false) {
          return respond({ ok: false, error: safeMessage(result, `Could not retrieve files from TorBox (HTTP ${upstream.status}).`) }, upstream.status >= 400 ? upstream.status : 502);
        }
        const torrents = Array.isArray(result.data) ? result.data :
          result.data && typeof result.data === "object" ? [result.data] : [];
        const files = [];
        for (const torrent of torrents) {
          const tid = String(torrent.id ?? torrent.torrent_id ?? "");
          if (torrentId && tid !== torrentId) continue;
          const items = Array.isArray(torrent.files) ? torrent.files : [];
          for (const file of items) {
            const id = file.id ?? file.file_id;
            if (id === undefined || id === null) continue;
            files.push({
              id: String(id), torrentId: tid,
              name: file.name || file.short_name || `File ${id}`,
              size: Number(file.size || 0), itemCount: 0
            });
          }
        }
        return respond({ ok: true, files });
      }

      if (url.pathname === "/api/download" && request.method === "GET") {
        const torrentId = url.searchParams.get("torrentId");
        const fileId = url.searchParams.get("fileId");
        if (!torrentId || !/^\d+$/.test(torrentId) || !fileId || !/^\d+$/.test(fileId)) {
          return respond({ ok: false, error: "Valid torrentId and fileId are required." }, 400);
        }
        const downloadUrl = new URL(`${TORBOX_BASE}/torrents/requestdl`);
        downloadUrl.searchParams.set("torrent_id", torrentId);
        downloadUrl.searchParams.set("file_id", fileId);
        // TorBox accepts the API token for this endpoint; it is sent server-side only.
        downloadUrl.searchParams.set("token", env.TORBOX_API_KEY);
        const upstream = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}` }
        });
        const result = await upstream.json().catch(() => null);
        if (!upstream.ok || result?.success === false) {
          return respond({ ok: false, error: safeMessage(result, `TorBox could not create a download link (HTTP ${upstream.status}).`) }, upstream.status >= 400 ? upstream.status : 502);
        }
        const link = result?.data;
        const downloadLink = typeof link === "string" ? link : (link?.url || link?.download_url || result?.url);
        if (!downloadLink || typeof downloadLink !== "string" || !/^https?:\/\//i.test(downloadLink)) {
          return respond({ ok: false, error: safeMessage(result, "TorBox did not return a valid download URL.") }, 502);
        }
        return respond({ ok: true, url: downloadLink });
      }

      return respond({ ok: false, error: "Not found." }, 404);
    } catch (error) {
      // Do not leak secrets or raw upstream responses in client-facing errors.
      return respond({ ok: false, error: "Unexpected backend error. Check the Cloudflare Worker logs." }, 500);
    }
  }
};

function safeMessage(result, fallback) {
  if (typeof result?.detail === "string") return result.detail.slice(0, 300);
  if (typeof result?.error === "string") return result.error.slice(0, 300);
  if (typeof result?.message === "string") return result.message.slice(0, 300);
  return fallback;
}
