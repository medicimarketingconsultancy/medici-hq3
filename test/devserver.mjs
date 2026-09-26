import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { handle } from "../lib/app.mjs"; import { memStore } from "./memstore.mjs";
const store = memStore();
export const env = { ADMIN_PASSWORD: "test-pass", SESSION_SECRET: "s".repeat(32), SCANNER_TOKEN: "scan-tok", INBOUND_TOKEN: "in-tok" };
const port = Number(process.env.PORT || 8888);
http.createServer(async (req, res) => {
  const url = `http://localhost:${port}${req.url}`;
  if (req.url.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), { store, env });
    const h = Object.fromEntries(r.headers); res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = path.join("public", decodeURIComponent(new URL(url).pathname)); if (p.endsWith("/")) p += "index.html";
  if (!fs.existsSync(p)) p = "public/index.html";
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type }); fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`dev on ${port}`));
