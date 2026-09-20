// server.js - tiny local dev server: serves ./public and the /api/voice-token function.
// Run with:  npm start   (needs Node 18+ and ASSEMBLYAI_API_KEY in the environment or .env)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/voice-token.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

// Minimal .env loader (no dependency). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith("#") && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* no .env file: fine */ }

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/voice-token") return handler(req, res);

    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir + path.sep)) {          // block path traversal
      res.statusCode = 403;
      return res.end("Forbidden");
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.statusCode = 404; return res.end("Not found"); }
      res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
      res.end(data);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`FieldLog running at http://localhost:${port}`);
    if (!process.env.ASSEMBLYAI_API_KEY) console.log("Warning: ASSEMBLYAI_API_KEY is not set - sessions will not start.");
  });
}
