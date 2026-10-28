
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://ricsnotahacker.github.io",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    const respond = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/api/status") {
      return respond({ ok: true, service: "CloudTorrent API" });
    }

    if (request.headers.get("Origin") !== "https://ricsnotahacker.github.io") {
      return respond({ error: "Origin not allowed" }, 403);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));

      if (!env.CLOUDTORRENT_PASSWORD ||
          body.password !== env.CLOUDTORRENT_PASSWORD) {
        return respond({ error: "Invalid password" }, 401);
      }

      return respond({
        ok: true,
        message: "Login successful. API authentication will be added next."
      });
    }

    return respond({ error: "Not found" }, 404);
  },
};
