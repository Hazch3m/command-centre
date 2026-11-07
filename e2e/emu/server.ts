import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { makeCtx } from "./mock";
const [port, staticDir, dbdir] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
fs.mkdirSync(dbdir, { recursive: true });
// A pretend Garmin for the service (token swaps and the fixture data).
const fx = JSON.parse(fs.readFileSync(process.env.FIX + "/garmin.json", "utf8"));
const realFetch = globalThis.fetch;
const garminLog: string[] = [];
(globalThis as any).__garminLog = garminLog;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = String(input?.url ?? input);
  if (u.includes("diauth.garmin.com")) { garminLog.push("token " + String(init?.body ?? "").slice(0, 80)); return Response.json({ access_token: "acc-" + Date.now(), refresh_token: "ref", expires_in: 3600 }); }
  if (u.startsWith("https://connectapi.garmin.com")) {
    const p = new URL(u).pathname; garminLog.push((init?.method ?? "GET") + " " + p);
    if ((init?.method ?? "GET") !== "GET") return Response.json({ workoutId: 5000 + garminLog.length, workoutScheduleId: 9000 + garminLog.length });
    if (p.startsWith("/calendar-service/")) return Response.json({ calendarItems: [] });
    const key = Object.keys(fx).filter((k) => p.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return key ? Response.json(fx[key]) : new Response("null", { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;
const { default: worker, Store } = await import("./worker-shim");
const stores = new Map<string, any>();
const env: any = { ASSETS: null, STORE: { idFromName: (n: string) => n, get: (n: string) => ({ fetch: (u: any, i?: any) => storeFor(n).fetch(u instanceof Request ? u : new Request(u, i)) }) } };
function storeFor(name: string) {
  let s = stores.get(name);
  if (!s) {
    const file = path.join(dbdir, name.replace(/[^a-z0-9]/gi, "_").slice(0, 60) + ".db");
    let timer: any = null;
    s = new Store(makeCtx(file, (at) => { clearTimeout(timer); if (at) timer = setTimeout(() => s.alarm().catch((e: any) => console.error("alarm", e)), Math.max(0, Math.min(at - Date.now(), 3000))); }) as any, env);
    stores.set(name, s);
  }
  return s;
}
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".json": "application/json" };
http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${port}`);
  if (url.pathname === "/__garmin") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(garminLog)); }
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    try {
      const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers as any, body: req.method === "GET" || req.method === "OPTIONS" ? undefined : body }), env);
      const h: Record<string, string> = {}; r.headers.forEach((v: string, k: string) => (h[k] = v));
      res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { console.error(e); res.writeHead(500); return res.end(String(e)); }
  }
  let f = path.join(staticDir, decodeURIComponent(url.pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(staticDir, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1", () => console.log("emu on", port));
