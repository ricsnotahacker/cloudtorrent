/** CloudTorrent Cloudflare Worker — API compatible with script.js. */
const FRONTEND_ORIGIN = "https://ricsnotahacker.github.io";
const TORBOX_BASE = "https://api.torbox.app/v1/api";
const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CloudTorrent-Password",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    };
    const respond = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && origin !== FRONTEND_ORIGIN) return respond({ ok: false, error: "Origin not allowed." }, 403);
    if (url.pathname === "/api/status" && request.method === "GET")
      return respond({ ok: true, service: "CloudTorrent API" });
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await readJson(request);
      if (!env.CLOUDTORRENT_PASSWORD) return respond({ ok: false, error: "CloudTorrent password is not configured." }, 503);
      if (typeof body.password !== "string" || !constantTimeEqual(body.password, env.CLOUDTORRENT_PASSWORD))
        return respond({ ok: false, error: "Invalid CloudTorrent password." }, 401);
      // Stateless HMAC session; SESSION_SECRET should be a long random Cloudflare secret.
      if (env.SESSION_SECRET) {
        const token = await makeToken(env.SESSION_SECRET);
        if (token) return respond({ ok: true, token });
      }
      // Backwards-compatible with this frontend: password header remains supported.
      return respond({ ok: true });
    }
    if (!isKnownRoute(url.pathname, request.method)) return respond({ ok: false, error: "Not found." }, 404);
    if (!await authenticate(request, env)) return respond({ ok: false, error: "Please sign in with your CloudTorrent password." }, 401);
    if (!env.TORBOX_API_KEY) return respond({ ok: false, error: "TorBox API is not configured." }, 503);

    try {
      if (url.pathname === "/api/torrents" && request.method === "POST") {
        const ct = request.headers.get("Content-Type") || "";
        let form;
        if (ct.toLowerCase().includes("multipart/form-data")) {
          const incoming = await request.formData();
          const file = incoming.get("file");
          if (!(file instanceof File)) return respond({ ok: false, error: "The multipart field 'file' is required." }, 400);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const validation = validateTorrent(bytes);
          if (!validation.ok) return respond({ ok: false, error: validation.error }, 400);
          form = torrentForm(new File([bytes], safeFilename(file.name), { type: "application/x-bittorrent" }));
        } else {
          const body = await readJson(request);
          const magnet = typeof body.magnet === "string" ? body.magnet.trim() : "";
          if (!validMagnet(magnet)) return respond({ ok: false, error: "A valid magnet link with a torrent identifier is required." }, 400);
          form = new FormData(); form.set("magnet", magnet); form.set("seed", "1");
        }
        const result = await torboxFetch("/torrents/createtorrent", env, { method: "POST", body: form });
        if (!result.ok) return respond({ ok: false, error: result.error }, result.status);
        return respond({ ok: true, message: "Torrent submitted to TorBox.", torrent: result.data });
      }
      if (url.pathname === "/api/torrents/file" && request.method === "POST") {
        const incoming = await request.formData();
        const file = incoming.get("file");
        if (!(file instanceof File)) return respond({ ok: false, error: "The multipart field 'file' is required." }, 400);
        if (file.size > MAX_TORRENT_BYTES) return respond({ ok: false, error: "The .torrent file exceeds the 10 MB limit." }, 413);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const check = validateTorrent(bytes);
        if (!check.ok) return respond({ ok: false, error: check.error }, 400);
        const form = torrentForm(new File([bytes], safeFilename(file.name), { type: "application/x-bittorrent" }));
        const result = await torboxFetch("/torrents/createtorrent", env, { method: "POST", body: form });
        if (!result.ok) return respond({ ok: false, error: result.error }, result.status);
        return respond({ ok: true, message: "Torrent file submitted to TorBox.", torrent: result.data });
      }
      if (url.pathname === "/api/torrents/url" && request.method === "POST") {
        const body = await readJson(request);
        let remote;
        try { remote = await safeRemoteFetch(body.url, "torrent"); }
        catch (e) { return respond({ ok: false, error: safeRemoteError(e) }, e.status || 400); }
        const check = validateTorrent(remote.bytes);
        if (!check.ok) return respond({ ok: false, error: "The URL did not return a valid .torrent file." }, 400);
        const name = safeFilename(remote.url.pathname.split("/").pop() || "download.torrent");
        const form = torrentForm(new File([remote.bytes], name.toLowerCase().endsWith(".torrent") ? name : `${name}.torrent`, { type: "application/x-bittorrent" }));
        const result = await torboxFetch("/torrents/createtorrent", env, { method: "POST", body: form });
        if (!result.ok) return respond({ ok: false, error: result.error }, result.status);
        return respond({ ok: true, message: "Torrent URL submitted to TorBox.", torrent: result.data });
      }
      if (url.pathname === "/api/resolve" && request.method === "POST") {
        const body = await readJson(request);
        let remote;
        try { remote = await safeRemoteFetch(body.url, "page"); }
        catch (e) { return respond({ ok: false, error: safeRemoteError(e) }, e.status || 400); }
        const type = remote.response.headers.get("content-type") || "";
        if (type && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(type))
          return respond({ ok: true, candidates: [] });
        const html = new TextDecoder("utf-8", { fatal: false }).decode(remote.bytes);
        if (/captcha|verify you are human|access denied|paywall|sign in to continue|log in to continue/i.test(html.slice(0, 50000)))
          return respond({ ok: true, candidates: [] });
        const candidates = extractTorrentLinks(html, remote.url).slice(0, MAX_CANDIDATES);
        return respond({ ok: true, candidates });
      }
      if (url.pathname === "/api/torrents" && request.method === "GET") {
        const result = await torboxFetch("/torrents/mylist?bypass_cache=true", env);
        if (!result.ok) return respond({ ok: false, error: result.error }, result.status);
        const list = Array.isArray(result.data) ? result.data : Array.isArray(result.data?.torrents) ? result.data.torrents : [];
        return respond({ ok: true, torrents: list.map(mapTorrent) });
      }
      if (url.pathname === "/api/files" && request.method === "GET") {
        const torrentId = url.searchParams.get("torrentId");
        if (torrentId && !/^\d{1,20}$/.test(torrentId)) return respond({ ok: false, error: "Invalid torrentId." }, 400);
        const apiUrl = new URL(`${TORBOX_BASE}/torrents/mylist`); apiUrl.searchParams.set("bypass_cache", "true");
        if (torrentId) apiUrl.searchParams.set("id", torrentId);
        const result = await torboxFetchUrl(apiUrl, env);
        if (!result.ok) return respond({ ok: false, error: result.error }, result.status);
        const torrents = Array.isArray(result.data) ? result.data : result.data && typeof result.data === "object" ? [result.data] : [];
        const files = [];
        for (const t of torrents) {
          const tid = String(t.id ?? t.torrent_id ?? "");
          if (!/^\d+$/.test(tid) || (torrentId && tid !== torrentId)) continue;
          for (const f of Array.isArray(t.files) ? t.files : []) {
            const fid = f.id ?? f.file_id;
            if (fid === undefined || fid === null || !/^\d+$/.test(String(fid))) continue;
            files.push({ torrentId: tid, id: String(fid), name: String(f.name || f.short_name || `File ${fid}`).slice(0, 500), size: finiteNum(f.size) });
          }
        }
        return respond({ ok: true, files });
      }
      if (url.pathname === "/api/download" && request.method === "GET") {
        const torrentId = url.searchParams.get("torrentId"), fileId = url.searchParams.get("fileId");
        if (!torrentId || !fileId || !/^\d{1,20}$/.test(torrentId) || !/^\d{1,20}$/.test(fileId))
          return respond({ ok: false, error: "Valid torrentId and fileId are required." }, 400);
        const apiUrl = new URL(`${TORBOX_BASE}/torrents/requestdl`);
        apiUrl.searchParams.set("torrent_id", torrentId); apiUrl.searchParams.set("file_id", fileId); apiUrl.searchParams.set("token", env.TORBOX_API_KEY);
        const result = await torboxFetchUrl(apiUrl, env);
        if (!result.ok) return respond({ ok: false, error: result.error }, result.status);
        const data = result.data;
        const link = typeof data === "string" ? data : data?.url || data?.download_url || data?.data?.url || (typeof data?.data === "string" ? data.data : "");
        let parsed; try { parsed = new URL(link); } catch { parsed = null; }
        if (!parsed || parsed.protocol !== "https:" || parsed.searchParams.has("token") && parsed.searchParams.get("token") === env.TORBOX_API_KEY || parsed.href.includes(env.TORBOX_API_KEY))
          return respond({ ok: false, error: "TorBox did not return a safe download URL." }, 502);
        return respond({ ok: true, url: parsed.href });
      }
      return respond({ ok: false, error: "Not found." }, 404);
    } catch (err) {
      return respond({ ok: false, error: err instanceof InputError ? err.message : "Unexpected backend error. Check the Worker logs." }, err instanceof InputError ? err.status : 500);
    }
  }
};

function isKnownRoute(path, method) {
  return (path === "/api/torrents" && ["GET", "POST"].includes(method)) ||
    (path === "/api/files" && method === "GET") || (path === "/api/download" && method === "GET") ||
    (["/api/torrents/file", "/api/torrents/url", "/api/resolve"].includes(path) && method === "POST");
}
function jsonHeaders() { return { "Accept": "application/json" }; }
async function readJson(request) { try { const v = await request.json(); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
function constantTimeEqual(a, b) { if (typeof a !== "string" || typeof b !== "string") return false; let diff = a.length ^ b.length; const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0); return diff === 0; }
async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && env.SESSION_SECRET) return verifyToken(auth.slice(7), env.SESSION_SECRET);
  const password = request.headers.get("X-CloudTorrent-Password") || "";
  return !!env.CLOUDTORRENT_PASSWORD && constantTimeEqual(password, env.CLOUDTORRENT_PASSWORD);
}
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
async function hmacKey(secret) { return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function makeToken(secret) { try { const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 8*60*60, nonce: b64url(crypto.getRandomValues(new Uint8Array(24))) }))); const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload)); return `${payload}.${b64url(sig)}`; } catch { return ""; } }
async function verifyToken(token, secret) { try { if (!token || token.length > 2048) return false; const p = token.split("."); if (p.length !== 2) return false; const sig = Uint8Array.from(atob(p[1].replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0)); if (!await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, new TextEncoder().encode(p[0]))) return false; const raw = atob(p[0].replace(/-/g,"+").replace(/_/g,"/")); const payload = JSON.parse(decodeURIComponent(escape(raw))); return Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now()/1000); } catch { return false; } }
function validMagnet(m) { return typeof m === "string" && m.length <= 8192 && /^magnet:\?/i.test(m) && /(?:\?|&)xt=urn:(?:btih:[0-9a-f]{40}|btih:[a-z2-7]{32}|btmh:1220[0-9a-f]{64})/i.test(m); }
function torrentForm(file) { const f = new FormData(); f.set("file", file, file.name); f.set("seed", "1"); return f; }
function safeFilename(s) { return String(s || "torrent.torrent").replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 180) || "torrent.torrent"; }
function validateTorrent(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20) return { ok: false, error: "The .torrent file is empty or too small." };
  if (bytes.length > MAX_TORRENT_BYTES) return { ok: false, error: "The .torrent file exceeds the 10 MB limit." };
  // Bencode top-level dictionary, complete end marker, and info dictionary marker.
  if (bytes[0] !== 0x64 || bytes[bytes.length - 1] !== 0x65) return { ok: false, error: "The file is not complete bencoded torrent data." };
  if (!containsSequence(bytes, new TextEncoder().encode("4:info"))) return { ok: false, error: "The torrent has no info dictionary." };
  try { const parser = new BencodeValidator(bytes); parser.parse(); if (parser.pos !== bytes.length) throw new Error(); }
  catch { return { ok: false, error: "The torrent data is malformed or incomplete." }; }
  return { ok: true };
}
function containsSequence(a, b) { outer: for (let i=0;i<=a.length-b.length;i++) { for(let j=0;j<b.length;j++) if(a[i+j]!==b[j]) continue outer; return true; } return false; }
class BencodeValidator { constructor(b){this.b=b;this.pos=0;this.nodes=0;} parse(depth=0){if(depth>64||++this.nodes>1000000)throw Error();const c=this.b[this.pos];if(c===0x64){this.pos++;let prev=null;while(this.b[this.pos]!==0x65){if(this.pos>=this.b.length)throw Error();const k=this.bytes();const key=new TextDecoder().decode(k);if(prev!==null&&key<prev)throw Error();prev=key;this.parse(depth+1);}this.pos++;return;}if(c===0x6c){this.pos++;while(this.b[this.pos]!==0x65){if(this.pos>=this.b.length)throw Error();this.parse(depth+1);}this.pos++;return;}if(c===0x69){this.pos++;const end=this.b.indexOf(0x65,this.pos);if(end<0)throw Error();const n=new TextDecoder().decode(this.b.slice(this.pos,end));if(!/^-?(0|[1-9]\d*)$/.test(n))throw Error();this.pos=end+1;return;}if(c>=0x30&&c<=0x39){this.bytes();return;}throw Error();}bytes(){let colon=this.b.indexOf(0x3a,this.pos);if(colon<0)throw Error();const ns=new TextDecoder().decode(this.b.slice(this.pos,colon));if(!/^(0|[1-9]\d*)$/.test(ns))throw Error();const len=Number(ns);if(!Number.isSafeInteger(len)||len>this.b.length)throw Error();this.pos=colon+1;const end=this.pos+len;if(end>this.b.length)throw Error();const out=this.b.slice(this.pos,end);this.pos=end;return out;} }
async function torboxFetch(path, env, init = {}) { return torboxFetchUrl(new URL(`${TORBOX_BASE}${path.startsWith("/") ? path : "/"+path}`), env, init); }
async function torboxFetchUrl(url, env, init = {}) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000); try { const response = await fetch(url, { ...init, signal: controller.signal, headers: { ...(init.headers || {}), Authorization: `Bearer ${env.TORBOX_API_KEY}`, Accept: "application/json" } }); const data = await response.json().catch(() => null); if (!response.ok || data?.success === false) return { ok:false, status: response.status >= 400 ? (response.status === 401 || response.status === 403 ? 502 : 502) : 502, error: sanitizeUpstream(data, `TorBox request failed (HTTP ${response.status}).`) }; return { ok:true, status:200, data: data && Object.prototype.hasOwnProperty.call(data,"data") ? data.data : data }; } catch { return { ok:false, status:502, error:"Could not reach TorBox. Please try again." }; } finally { clearTimeout(timer); } }
function sanitizeUpstream(d, fallback) { const s = typeof d?.detail === "string" ? d.detail : typeof d?.error === "string" ? d.error : typeof d?.message === "string" ? d.message : fallback; return String(s).replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{32,}/g,"[redacted]").slice(0,300); }
function finiteNum(v) { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; }
function mapTorrent(t) { return { id: t.id ?? t.torrent_id ?? null, name: t.name ?? null, download_state: t.download_state ?? t.status ?? null, download_finished: typeof t.download_finished === "boolean" ? t.download_finished : null, progress: finiteNum(t.progress), progressPercent: finiteNum(t.progressPercent ?? t.download_percent), size: finiteNum(t.size ?? t.total_size), download_speed: finiteNum(t.download_speed ?? t.download_speed_bytes), eta: finiteNum(t.eta), seeds: finiteNum(t.seeds ?? t.seeders), peers: finiteNum(t.peers), error: typeof t.error === "string" ? t.error : null, files: Array.isArray(t.files) ? t.files : [] }; }

class InputError extends Error { constructor(message,status=400){super(message);this.status=status;} }

function ipv6BigInt(input) {
  let s = input.toLowerCase();
  if (s.includes("%")) return null;
  // Convert an IPv4 tail into two IPv6 words.
  if (s.includes(".")) {
    const i = s.lastIndexOf(":"); const v = s.slice(i + 1).split(".").map(Number);
    if (v.length !== 4 || v.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    s = s.slice(0, i) + ":" + ((v[0] << 8) | v[1]).toString(16) + ":" + ((v[2] << 8) | v[3]).toString(16);
  }
  if ((s.match(/::/g) || []).length > 1) return null;
  let words;
  if (s.includes("::")) {
    const [left, right] = s.split("::");
    const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
    const zeros = 8 - a.length - b.length; if (zeros < 1) return null;
    words = [...a, ...Array(zeros).fill("0"), ...b];
  } else { words = s.split(":"); if (words.length !== 8) return null; }
  if (words.length !== 8 || words.some(w => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return words.reduce((n,w) => (n << 16n) | BigInt(parseInt(w,16)), 0n);
}
function validateRemoteUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 2048 || /\s/.test(raw)) throw new InputError("Enter a valid HTTP or HTTPS URL.");
  let u; try { u = new URL(raw); } catch { throw new InputError("Enter a valid HTTP or HTTPS URL."); }
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new InputError("Only HTTP/HTTPS URLs without credentials are allowed.");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g,"");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".test") || h.endsWith(".invalid")) throw new InputError("Local or internal hostnames are not allowed.",403);
  if (isForbiddenIp(h)) throw new InputError("Private, loopback, link-local or reserved IP addresses are not allowed.",403);
  return u;
}
function isForbiddenIp(h) {
  if (h.includes(":")) {
    const n = ipv6BigInt(h); if (n === null) return true;
    const isRange = (prefix, bits) => (n >> BigInt(128 - bits)) === BigInt(prefix);
    if (n === 0n || n === 1n || isRange(0xfcn >> 0n, 7) || isRange(0x3fan, 10) || isRange(0xffn, 8) || isRange(0x2001n, 23) && ((n >> 64n) & 0xffffffffn) === 0x0000n) return true;
    // IPv4-mapped IPv6 (::ffff:0:0/96): apply IPv4 policy to the embedded address.
    if ((n >> 32n) === 0xffffn) { const v = Number(n & 0xffffffffn); return isForbiddenIp([v>>>24,(v>>>16)&255,(v>>>8)&255,v&255].join(".")); }
    // IPv4-compatible /96 and NAT64 well-known prefix are not accepted as destinations.
    if ((n >> 32n) === 0n || (n >> 32n) === 0x64ff9bn) return true;
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { const p=h.split(".").map(Number); if(p.some(n=>n>255)) return true; const [a,b]=p; return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0)||(a===198&&(b===18||b===19)); }
  return false;
}
async function resolveAndCheckDns(host) {
  // Workers do not expose a pinned-DNS/custom-connect API. DNS-over-HTTPS screening is best-effort;
  // see limitation note in final response. Literal IPs are checked directly above.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),4000);
  try { const r=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,{headers:{accept:"application/dns-json"},signal:controller.signal}); if(!r.ok) throw new InputError("Could not validate the destination hostname.",403); const d=await r.json(); const ips=(d.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>a.data); if(!ips.length) throw new InputError("The destination hostname did not resolve to a public address.",403); if(ips.some(ip=>isForbiddenIp(ip))) throw new InputError("The destination resolves to a private or reserved address.",403); } catch(e) { if(e instanceof InputError) throw e; throw new InputError("Could not safely validate the destination hostname.",403); } finally {clearTimeout(timer);} }
async function safeRemoteFetch(raw, kind) {
  let u=validateRemoteUrl(raw); let response, bytes;
  for(let hop=0;hop<=MAX_REDIRECTS;hop++) {
    await resolveAndCheckDns(u.hostname.replace(/^\[|\]$/g,""));
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
    try { response=await fetch(u.href,{redirect:"manual",signal:controller.signal,headers:{"User-Agent":"CloudTorrent/1.0","Accept":kind==="page"?"text/html,application/xhtml+xml,text/plain;q=0.8":"application/x-bittorrent,application/octet-stream,*/*;q=0.1"}}); }
    catch { throw new InputError("The remote site could not be reached in time.",502); } finally {clearTimeout(timer);}
    if([301,302,303,307,308].includes(response.status)) { const loc=response.headers.get("location"); if(!loc) throw new InputError("The remote site returned an invalid redirect.",502); if(hop===MAX_REDIRECTS) throw new InputError("Too many redirects.",400); try{u=validateRemoteUrl(new URL(loc,u).href);}catch(e){throw e;} continue; }
    if(!response.ok) throw new InputError(`The remote site returned HTTP ${response.status}.`,502);
    const max=kind==="page"?MAX_PAGE_BYTES:MAX_TORRENT_BYTES;
    const declared=Number(response.headers.get("content-length")||0); if(declared>max) throw new InputError("The remote response is too large.",413);
    const reader=response.body?.getReader(); if(!reader) throw new InputError("The remote site returned an empty response.",502);
    const chunks=[]; let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new InputError("The remote response is too large.",413);}chunks.push(value);}
    bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    return {url:u,response,bytes};
  }
  throw new InputError("Could not safely fetch the remote URL.",400);
}
function safeRemoteError(e){return e instanceof InputError?e.message:"Could not safely fetch that URL.";}
function extractTorrentLinks(html, base) {
  const out=[], seen=new Set(); const re=/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi; let m;
  while((m=re.exec(html))&&out.length<MAX_CANDIDATES*3){const href=decodeHtml(m[1]??m[2]??m[3]??"").trim();if(!href||href.startsWith("#")||/^javascript:|^data:|^mailto:/i.test(href))continue;let u;try{u=validateRemoteUrl(new URL(href,base).href);}catch{continue;}if(!/\.torrent(?:$|[?#])/i.test(u.href)||seen.has(u.href))continue;seen.add(u.href);const name=decodeHtml((m[4]||"").replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim()||decodeURIComponentSafe(u.pathname.split("/").pop()||"torrent.torrent");out.push({url:u.href,name:name.slice(0,180),size:null});}
  return out;
}
function decodeHtml(s){return String(s).replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">");}
function decodeURIComponentSafe(s){try{return decodeURIComponent(s);}catch{return s;}}
