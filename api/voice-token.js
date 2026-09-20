// api/voice-token.js - runs on the server (Vercel function, or server.js locally).
//
// The browser must never hold the AssemblyAI API key. Instead it asks this
// endpoint for a short-lived, one-time token and uses THAT to open the
// WebSocket. Every token starts exactly one session and is billed to the key
// stored in the ASSEMBLYAI_API_KEY environment variable.
//
// Because this URL is public, it is also the place where abuse must be limited:
//   * each session is capped (MAX_SESSION_SECONDS, default 300 s)
//   * a simple per-IP rate limit (best effort: in-memory, per server instance)
//   * an optional DEMO_PASSCODE that visitors must supply
//
// Written against plain Node req/res so it works on Vercel and in server.js.

const TOKEN_URL = "https://agents.assemblyai.com/v1/token";

const RATE_LIMIT = { max: 12, windowMs: 10 * 60 * 1000 };

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function clampSeconds(raw) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return 300;
  return Math.min(10800, Math.max(60, n));
}

export function createHandler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const hits = new Map(); // ip -> [timestamps]

  function limited(ip) {
    const t = now();
    const recent = (hits.get(ip) ?? []).filter((ts) => t - ts < RATE_LIMIT.windowMs);
    if (recent.length >= RATE_LIMIT.max) {
      hits.set(ip, recent);
      return true;
    }
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear(); // keep memory bounded
    return false;
  }

  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader?.("Allow", "GET");
      return json(res, 405, { error: "method_not_allowed", message: "Use GET." });
    }

    const apiKey = env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      return json(res, 500, {
        error: "server_not_configured",
        message: "The server is missing ASSEMBLYAI_API_KEY. Add it in the hosting settings.",
      });
    }

    if (env.DEMO_PASSCODE) {
      const supplied = req.headers?.["x-demo-passcode"];
      if (supplied !== env.DEMO_PASSCODE) {
        return json(res, 401, { error: "passcode_required", message: "A demo passcode is required." });
      }
    }

    if (limited(clientIp(req))) {
      return json(res, 429, {
        error: "rate_limited",
        message: "Too many sessions from this network. Please wait a few minutes.",
      });
    }

    const maxSeconds = clampSeconds(env.MAX_SESSION_SECONDS);
    const url = new URL(TOKEN_URL);
    url.searchParams.set("expires_in_seconds", "120");
    url.searchParams.set("max_session_duration_seconds", String(maxSeconds));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const upstream = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!upstream.ok) {
        // Log the detail server-side only; never forward upstream text to visitors.
        console.error(`AssemblyAI token request failed: HTTP ${upstream.status}`);
        return json(res, 502, {
          error: "upstream_error",
          message: "Could not start a voice session right now. Please try again shortly.",
        });
      }
      const body = await upstream.json();
      if (!body?.token) throw new Error("token missing in upstream response");
      return json(res, 200, { token: body.token, max_session_seconds: maxSeconds });
    } catch (error) {
      console.error("Token request error:", error?.name === "AbortError" ? "timeout" : error?.message);
      return json(res, 502, {
        error: "upstream_error",
        message: "Could not start a voice session right now. Please try again shortly.",
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export default createHandler();
