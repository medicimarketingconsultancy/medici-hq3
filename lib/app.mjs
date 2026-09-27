// Medici HQ — API core. Framework-free so it runs in a Netlify Function and in local tests.
import crypto from "node:crypto";

export const STAGES = ["New", "Contacted", "Talking", "Proposal", "Signed", "Pass"];
export const TEMPS = ["Hot", "Warm", "Cold"];

export const DEFAULT_CONFIG = {
  // Reel bank
  reelWindowDays: 14,
  outperformMin: 3,
  minViews: 10000,
  minLikes: 500,
  reelArchiveDays: 90,
  // Watchlist classification
  autoAddScore: 60,
  reviewScore: 30,
  inactiveAfterDays: 30,
  discoveryCap: 60,
  firstRunDiscoveryCap: 150,
  // Discovery beyond your sources
  hashtags: [],           // your own niche hashtags (without #), rotated through each run
  searchKeywords: [],     // Instagram account-search terms, e.g. "fitness model"
  bioSearchPhrases: [],   // bio phrases to hunt for via Google (defaults to your bio keywords), e.g. "more of me"
  bioQueriesPerRun: 4,
  autoHashtags: 4,        // extra hashtags picked automatically from your sources' captions each run
  postsPerHashtag: 30,
  reachMin: 2,            // discovered reels are banked at views >= this x the creator's followers
  discoveryShare: 0.4,    // share of each run's results budget reserved for discovery
  // Prospects (struggling creators)
  prospectMinFollowers: 10000,
  prospectMaxFollowers: 300000,
  declineThreshold: 30,
  minPostsPerWeek: 1,
  // Budget
  maxResultsPerRun: 900, // ~$2.40 at official prices; two runs a month stay under the $5 free credit
  costPer1000: 2.7,
  // Scraper actors (Apify ids, "user~actor")
  profileActor: "apify~instagram-profile-scraper",
  reelActor: "apify~instagram-reel-scraper",
  hashtagActor: "apify~instagram-hashtag-scraper",
  searchActor: "apify~instagram-search-scraper",
  googleActor: "apify~google-search-scraper",
  bioKeywords: [
    "more of me", "link below", "link in bio", "exclusive", "vip", "spicy",
    "don't open", "dont open", "18+", "uncensored", "my page", "subscribe", "top 0.", "free trial",
  ],
  highlightKeywords: ["link", "vip", "of", "more", "🔗", "spicy", "exclusive"],
  styles: ["Girl next door", "Fitness", "Cosplay", "Lifestyle", "Glam", "Alt"],
};

const MAX_BODY = 2_000_000;

// ---------- helpers ----------
const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(8).toString("hex");
export const normHandle = (h) =>
  String(h || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 30);

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function signSession(secret, days = 14) {
  const payload = b64u(JSON.stringify({ exp: Date.now() + days * 864e5, n: uid() }));
  const sig = b64u(crypto.createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}
function verifySession(secret, token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expect = b64u(crypto.createHmac("sha256", secret).update(payload).digest());
  if (!safeEq(sig, expect)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); }
  catch { return false; }
}
const cookieOf = (req, name) => {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Body too large");
  const type = req.headers.get("content-type") || "";
  if (!text) return {};
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON"); }
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- storage ----------
const DEFAULTS = { leads: {}, creators: {}, reels: {}, watchlist: {}, runs: [], config: {} };

async function load(store, key) {
  const d = await store.get(key, { type: "json" });
  return d ?? structuredClone(DEFAULTS[key]);
}
// Optimistic read-modify-write so the scanner and the dashboard never clobber each other.
async function mutate(store, key, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const data = cur?.data ?? structuredClone(DEFAULTS[key]);
    const out = await fn(data);
    const res = await store.setJSON(key, data, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res?.modified !== false) return out;
    await new Promise((r) => setTimeout(r, 50 * (i + 1)));
  }
  throw new HttpError(409, "Busy — try again");
}
const getConfig = async (store) => ({ ...DEFAULT_CONFIG, ...(await load(store, "config")) });

// ---------- scoring ----------
export function fitScore(lead, cfg) {
  const m = lead.metrics || {};
  let s = 0;
  if (typeof m.declineScore === "number") s += Math.min(50, m.declineScore * 0.5);
  if (lead.followers) {
    const inRange = lead.followers >= cfg.prospectMinFollowers && lead.followers <= cfg.prospectMaxFollowers;
    s += inRange ? 30 : 10;
  }
  if ((lead.classScore || 0) >= cfg.autoAddScore) s += 20;
  else if ((lead.classScore || 0) >= cfg.reviewScore) s += 10;
  if (lead.source === "inbound") s += 15; // they came to us
  if (lead.source === "inbound" && !lead.metrics) s = Math.max(s, 45); // un-enriched enquiry: warm until scanned
  return Math.round(Math.min(100, s));
}
const tempFor = (score) => (score >= 70 ? "Hot" : score >= 40 ? "Warm" : "Cold");
function rescore(lead, cfg) {
  lead.fitScore = fitScore(lead, cfg);
  if (!lead.tempOverride) lead.temperature = tempFor(lead.fitScore);
}

function newLead(fields, cfg) {
  const l = {
    id: uid(), handle: "", name: "", source: "manual", stage: "New", temperature: "Warm", tempOverride: false,
    fitScore: 0, classScore: null, followers: null, metrics: null, bio: "", bioLink: "", linkDest: "",
    message: "", email: "", ageVerified: false, nextFollowUp: "", tags: [], notes: [], activity: [],
    createdAt: now(), updatedAt: now(), lastEnrichedAt: null, ...fields,
  };
  rescore(l, cfg);
  return l;
}
const findLeadByHandle = (leads, h) => Object.values(leads).find((l) => l.handle && l.handle === h);
const log = (entity, text) => {
  entity.activity = [{ at: now(), text }, ...(entity.activity || [])].slice(0, 100);
  entity.updatedAt = now();
};

// ---------- inbound form ----------
function parseInbound(body) {
  // Netlify outgoing webhook: { data: {...fields}, form_name, created_at } — or a plain field map.
  const f = body && typeof body.data === "object" && body.data ? body.data : body || {};
  const entries = Object.entries(f).filter(([, v]) => typeof v === "string" || typeof v === "number");
  const pick = (re) => entries.find(([k]) => re.test(k))?.[1];
  const handle = normHandle(pick(/insta|handle|ig/i) || "");
  const name = String(pick(/^(full[\s_-]?)?name$|full.?name/i) || pick(/name/i) || "").slice(0, 120);
  const email = String(pick(/e-?mail/i) || "").slice(0, 200);
  const message = String(pick(/situation|message|about|describe|details|notes?/i) || "").slice(0, 4000);
  if (pick(/bot-field|honeypot/i)) return null; // spam trap filled
  if (!handle && !email && !name) return null;
  return { handle, name, email, message };
}

// ---------- scanner merge ----------
function mergeScan(state, payload, cfg) {
  const { leads, creators, reels, watchlist } = state;
  const t = now();
  const summary = { reelsAdded: 0, reelsUpdated: 0, candidatesAdded: 0, autoAdded: 0, prospectsNew: 0, prospectsUpdated: 0, snapshots: 0 };

  for (const r of payload.reels || []) {
    if (!r.id) continue;
    const cur = reels[r.id];
    const metrics = { views: r.views ?? null, likes: r.likes ?? null, comments: r.comments ?? null, outperf: r.outperf ?? null };
    if (cur) { Object.assign(cur, metrics, { lastSeenAt: t }); summary.reelsUpdated++; }
    else {
      reels[r.id] = {
        id: r.id, url: r.url, handle: normHandle(r.handle), style: r.style || watchlist[normHandle(r.handle)]?.style || "",
        postedAt: r.postedAt || null, foundAt: t, lastSeenAt: t, followers: r.followers ?? null, ...metrics,
        audio: r.audio || "", hook: (r.hook || "").slice(0, 280), thumb: r.thumb || "", status: "New", usedBy: "", archived: false,
        basis: r.basis === "reach" ? "reach" : "median", discovered: !!r.discovered, foundVia: String(r.foundVia || "").slice(0, 80),
      };
      summary.reelsAdded++;
    }
  }
  for (const u of payload.watchlistUpdates || []) {
    const h = normHandle(u.handle); const w = watchlist[h];
    if (!w) continue;
    for (const k of ["followers", "medianEng", "lastReelAt", "classScore", "signals", "bio", "linkDest"]) if (u[k] !== undefined) w[k] = u[k];
    w.lastScannedAt = t;
  }
  for (const c of payload.candidates || []) {
    const h = normHandle(c.handle);
    if (!h || watchlist[h]) continue;
    if ((c.classScore || 0) < cfg.reviewScore) continue;
    const auto = c.classScore >= cfg.autoAddScore;
    watchlist[h] = {
      handle: h, style: c.style || "", state: auto ? "active" : "pending", source: "discovered", classScore: c.classScore,
      signals: c.signals || [], followers: c.followers ?? null, bio: (c.bio || "").slice(0, 400), linkDest: c.linkDest || "",
      foundVia: c.foundVia || "", medianEng: null, lastReelAt: null, addedAt: t,
    };
    summary.candidatesAdded++; if (auto) summary.autoAdded++;
  }
  for (const p of payload.prospects || []) {
    const h = normHandle(p.handle); if (!h) continue;
    let lead = findLeadByHandle(leads, h);
    const fields = {
      followers: p.followers ?? null, metrics: p.metrics || null, classScore: p.classScore ?? null,
      bio: (p.bio || "").slice(0, 400), bioLink: p.bioLink || "", linkDest: p.linkDest || "", lastEnrichedAt: t,
    };
    if (!lead) {
      if (!p.qualifies) continue; // only create new scan leads for real decliners
      lead = newLead({ handle: h, name: p.name || "", source: "scan", ...fields }, cfg);
      log(lead, `Found by scan — views ${fmtPct(p.metrics?.viewsChange)} over 90 days`);
      leads[lead.id] = lead; summary.prospectsNew++;
    } else {
      Object.assign(lead, fields, { name: lead.name || p.name || "" });
      rescore(lead, cfg);
      log(lead, "Metrics refreshed by scan");
      summary.prospectsUpdated++;
    }
  }
  for (const s of payload.rosterSnapshots || []) {
    const h = normHandle(s.handle);
    const c = Object.values(creators).find((x) => x.handle === h); if (!c) continue;
    const snap = { date: t.slice(0, 10), followers: s.followers ?? null, views30: s.views30 ?? null, eng30: s.eng30 ?? null, posts30: s.posts30 ?? null };
    c.snapshots = [...(c.snapshots || []).filter((x) => x.date !== snap.date), snap].slice(-60);
    c.updatedAt = t; summary.snapshots++;
  }
  // housekeeping
  const cutoff = Date.now() - cfg.inactiveAfterDays * 864e5;
  for (const w of Object.values(watchlist)) {
    if (w.state === "active" && w.lastReelAt && Date.parse(w.lastReelAt) < cutoff) w.state = "inactive";
  }
  const archiveCut = Date.now() - cfg.reelArchiveDays * 864e5;
  for (const r of Object.values(reels)) if (!r.archived && Date.parse(r.foundAt) < archiveCut) r.archived = true;
  return summary;
}
const fmtPct = (v) => (typeof v === "number" ? `${v > 0 ? "+" : ""}${Math.round(v)}%` : "n/a");

// ---------- router ----------
export async function handle(req, { store, env }) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";
  const method = req.method.toUpperCase();
  const parts = path.split("/").filter(Boolean);
  const secret = env.SESSION_SECRET;
  const cors = corsHeaders(req, env);

  try {
    if (!secret || !env.ADMIN_PASSWORD) return json(500, { error: "Server not configured: set ADMIN_PASSWORD and SESSION_SECRET" });

    // ---- public: inbound website form ----
    if (parts[0] === "inbound") {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (method !== "POST") throw new HttpError(405, "POST only");
      const tok = url.searchParams.get("token") || req.headers.get("x-inbound-token");
      if (!env.INBOUND_TOKEN || !safeEq(tok || "", env.INBOUND_TOKEN)) return json(401, { error: "Bad token" }, cors);
      const parsed = parseInbound(await readBody(req));
      if (!parsed) return json(202, { ok: true, ignored: true }, cors);
      const cfg = await getConfig(store);
      const id = await mutate(store, "leads", (leads) => {
        let lead = parsed.handle && findLeadByHandle(leads, parsed.handle);
        if (lead) {
          lead.source = "inbound";
          lead.message = parsed.message || lead.message;
          lead.email = parsed.email || lead.email;
          lead.name = parsed.name || lead.name;
          if (lead.stage === "Pass") lead.stage = "New";
          rescore(lead, cfg);
          log(lead, "Submitted the website form again");
        } else {
          lead = newLead({ ...parsed, source: "inbound" }, cfg);
          log(lead, "Submitted the website form");
          leads[lead.id] = lead;
        }
        return lead.id;
      });
      return json(200, { ok: true, id }, cors);
    }

    // ---- scanner (bearer token) ----
    if (parts[0] === "scanner") {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.SCANNER_TOKEN || !safeEq(auth, env.SCANNER_TOKEN)) return json(401, { error: "Bad scanner token" });
      const cfg = await getConfig(store);
      if (method === "GET" && parts[1] === "state") {
        const [watchlist, creators, leads, runs] = await Promise.all(["watchlist", "creators", "leads", "runs"].map((k) => load(store, k)));
        const reels = await load(store, "reels");
        return json(200, {
          config: cfg,
          firstRun: runs.length === 0,
          watchlist: Object.values(watchlist).filter((w) => w.state === "active").map(({ handle, style, medianEng }) => ({ handle, style, medianEng })),
          knownHandles: Object.keys(watchlist),
          roster: Object.values(creators).filter((c) => c.status !== "Paused").map((c) => c.handle),
          leadHandles: Object.values(leads).filter((l) => l.handle && !["Signed", "Pass"].includes(l.stage)).map((l) => l.handle),
          enrich: Object.values(leads).filter((l) => l.handle && !l.lastEnrichedAt).map((l) => l.handle),
          // every account classified as a creator (not just active sources) is a potential prospect
          creatorPool: Object.values(watchlist).filter((w) => w.state !== "rejected" && (w.source === "seed" || (w.classScore ?? 0) >= cfg.reviewScore)).map((w) => w.handle),
          runCount: runs.length,
          knownReelIds: Object.keys(reels),
        });
      }
      if (method === "POST" && parts[1] === "results") {
        const payload = await readBody(req);
        const keys = ["leads", "creators", "reels", "watchlist"];
        // Merge each collection under its own lock; read the others fresh for context.
        let summary;
        const snap = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await load(store, k)])));
        summary = mergeScan(snap, payload, cfg); // dry pass for summary + computed state
        for (const k of keys) {
          await mutate(store, k, (fresh) => {
            // Re-apply against the fresh copy so concurrent dashboard edits survive.
            const st = { ...snap, [k]: fresh };
            mergeScan(st, payload, cfg);
          });
        }
        const run = { at: now(), mode: payload.run?.mode || "scan", results: payload.run?.results ?? null, estCost: payload.run?.estCost ?? null, notes: payload.run?.notes || "", summary };
        await mutate(store, "runs", (runs) => { runs.unshift(run); runs.splice(100); });
        return json(200, { ok: true, summary });
      }
      throw new HttpError(404, "Unknown scanner route");
    }

    // ---- session ----
    if (parts[0] === "login" && method === "POST") {
      const { password } = await readBody(req);
      await new Promise((r) => setTimeout(r, 400)); // slow down guessing
      if (!safeEq(password || "", env.ADMIN_PASSWORD)) return json(401, { error: "Wrong password" });
      const secure = url.protocol === "https:" ? "; Secure" : "";
      return json(200, { ok: true }, { "set-cookie": `hq_session=${signSession(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${14 * 86400}${secure}` });
    }
    if (parts[0] === "logout") return json(200, { ok: true }, { "set-cookie": "hq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });

    const authed = verifySession(secret, cookieOf(req, "hq_session"));
    if (parts[0] === "session") return json(200, { authed });
    if (!authed) return json(401, { error: "Not signed in" });
    if (method !== "GET" && req.headers.get("x-requested-with") !== "hq") throw new HttpError(403, "Missing CSRF header");

    const cfg = await getConfig(store);

    if (parts[0] === "bootstrap" && method === "GET") {
      const [leads, creators, reels, watchlist, runs] = await Promise.all(["leads", "creators", "reels", "watchlist", "runs"].map((k) => load(store, k)));
      return json(200, {
        config: cfg, stages: STAGES,
        leads: Object.values(leads), creators: Object.values(creators),
        reels: Object.values(reels).filter((r) => !r.archived), archivedReels: Object.values(reels).filter((r) => r.archived).length,
        watchlist: Object.values(watchlist), runs: runs.slice(0, 30),
        inboundConfigured: Boolean(env.INBOUND_TOKEN), scannerConfigured: Boolean(env.SCANNER_TOKEN),
      });
    }

    // leads
    if (parts[0] === "leads") {
      if (method === "POST" && parts.length === 1) {
        const b = await readBody(req);
        const handle = normHandle(b.handle);
        const lead = await mutate(store, "leads", (leads) => {
          if (handle && findLeadByHandle(leads, handle)) throw new HttpError(409, `@${handle} is already a lead`);
          const l = newLead({ handle, name: String(b.name || "").slice(0, 120), email: String(b.email || "").slice(0, 200), message: String(b.message || "").slice(0, 4000), source: "manual" }, cfg);
          log(l, "Added manually"); leads[l.id] = l; return l;
        });
        return json(200, lead);
      }
      const id = parts[1];
      if (parts[2] === "notes" && method === "POST") {
        const { text } = await readBody(req);
        if (!text?.trim()) throw new HttpError(400, "Empty note");
        const lead = await mutate(store, "leads", (leads) => {
          const l = leads[id]; if (!l) throw new HttpError(404, "No such lead");
          l.notes = [{ id: uid(), at: now(), text: String(text).slice(0, 4000) }, ...(l.notes || [])]; l.updatedAt = now(); return l;
        });
        return json(200, lead);
      }
      if (parts[2] === "notes" && method === "DELETE") {
        const lead = await mutate(store, "leads", (leads) => {
          const l = leads[id]; if (!l) throw new HttpError(404, "No such lead");
          l.notes = (l.notes || []).filter((n) => n.id !== parts[3]); return l;
        });
        return json(200, lead);
      }
      if (parts[2] === "convert" && method === "POST") {
        const lead = await mutate(store, "leads", (leads) => {
          const l = leads[id]; if (!l) throw new HttpError(404, "No such lead");
          if (!l.ageVerified) throw new HttpError(400, "Confirm age (18+) before signing");
          l.stage = "Signed"; log(l, "Signed and moved to the creator roster"); return l;
        });
        await mutate(store, "creators", (creators) => {
          if (Object.values(creators).some((c) => c.handle && c.handle === lead.handle)) return;
          const c = { id: uid(), handle: lead.handle, name: lead.name, style: "", status: "Active", since: now().slice(0, 10), notes: lead.message ? `From lead: ${lead.message}` : "", snapshots: [], leadId: lead.id, createdAt: now(), updatedAt: now() };
          if (lead.followers) c.snapshots.push({ date: now().slice(0, 10), followers: lead.followers, views30: lead.metrics?.views30 ?? null, eng30: lead.metrics?.eng30 ?? null, posts30: lead.metrics?.posts30 ?? null });
          creators[c.id] = c;
        });
        return json(200, lead);
      }
      if (method === "PATCH") {
        const b = await readBody(req);
        const lead = await mutate(store, "leads", (leads) => {
          const l = leads[id]; if (!l) throw new HttpError(404, "No such lead");
          if (b.stage !== undefined) { if (!STAGES.includes(b.stage)) throw new HttpError(400, "Bad stage"); if (b.stage !== l.stage) log(l, `Stage: ${l.stage} → ${b.stage}`); l.stage = b.stage; }
          if (b.temperature !== undefined) {
            if (b.temperature === "auto") { l.tempOverride = false; rescore(l, cfg); }
            else { if (!TEMPS.includes(b.temperature)) throw new HttpError(400, "Bad temperature"); l.temperature = b.temperature; l.tempOverride = true; }
          }
          if (b.ageVerified !== undefined) { l.ageVerified = !!b.ageVerified; if (l.ageVerified) log(l, "Age confirmed 18+"); }
          for (const k of ["name", "email", "nextFollowUp"]) if (b[k] !== undefined) l[k] = String(b[k]).slice(0, 200);
          if (b.handle !== undefined) l.handle = normHandle(b.handle);
          if (Array.isArray(b.tags)) l.tags = b.tags.map((x) => String(x).slice(0, 30)).slice(0, 12);
          l.updatedAt = now(); return l;
        });
        return json(200, lead);
      }
      if (method === "DELETE") { await mutate(store, "leads", (leads) => { delete leads[id]; }); return json(200, { ok: true }); }
    }

    // creators (your roster)
    if (parts[0] === "creators") {
      if (method === "POST" && parts.length === 1) {
        const b = await readBody(req);
        const handle = normHandle(b.handle); if (!handle) throw new HttpError(400, "Handle required");
        const c = await mutate(store, "creators", (creators) => {
          if (Object.values(creators).some((x) => x.handle === handle)) throw new HttpError(409, `@${handle} is already on the roster`);
          const c = { id: uid(), handle, name: String(b.name || "").slice(0, 120), style: String(b.style || "").slice(0, 40), status: "Active", since: now().slice(0, 10), notes: "", snapshots: [], createdAt: now(), updatedAt: now() };
          creators[c.id] = c; return c;
        });
        return json(200, c);
      }
      const id = parts[1];
      if (method === "PATCH") {
        const b = await readBody(req);
        const c = await mutate(store, "creators", (creators) => {
          const c = creators[id]; if (!c) throw new HttpError(404, "No such creator");
          for (const k of ["name", "style", "notes", "since"]) if (b[k] !== undefined) c[k] = String(b[k]).slice(0, 4000);
          if (b.status !== undefined) c.status = b.status === "Paused" ? "Paused" : "Active";
          c.updatedAt = now(); return c;
        });
        return json(200, c);
      }
      if (method === "DELETE") { await mutate(store, "creators", (c) => { delete c[id]; }); return json(200, { ok: true }); }
    }

    // reels
    if (parts[0] === "reels" && method === "PATCH") {
      const b = await readBody(req);
      const r = await mutate(store, "reels", (reels) => {
        const r = reels[parts[1]]; if (!r) throw new HttpError(404, "No such reel");
        if (b.status !== undefined) { if (!["New", "Saved", "Used", "Skip"].includes(b.status)) throw new HttpError(400, "Bad status"); r.status = b.status; }
        if (b.usedBy !== undefined) r.usedBy = String(b.usedBy).slice(0, 80);
        if (b.style !== undefined) r.style = String(b.style).slice(0, 40);
        return r;
      });
      return json(200, r);
    }

    // watchlist
    if (parts[0] === "watchlist") {
      if (method === "POST" && parts.length === 1) {
        const b = await readBody(req);
        const handles = (Array.isArray(b.handles) ? b.handles : [b.handle]).map(normHandle).filter(Boolean);
        if (!handles.length) throw new HttpError(400, "Handle required");
        const added = await mutate(store, "watchlist", (wl) => {
          const out = [];
          for (const h of handles) if (!wl[h]) { wl[h] = { handle: h, style: String(b.style || "").slice(0, 40), state: "active", source: "seed", classScore: null, signals: [], followers: null, medianEng: null, lastReelAt: null, addedAt: now(), foundVia: "" }; out.push(h); }
          return out;
        });
        return json(200, { added });
      }
      const h = normHandle(parts[1]);
      if (method === "PATCH") {
        const b = await readBody(req);
        const w = await mutate(store, "watchlist", (wl) => {
          const w = wl[h]; if (!w) throw new HttpError(404, "Not on watchlist");
          if (b.state !== undefined) { if (!["active", "pending", "inactive", "rejected"].includes(b.state)) throw new HttpError(400, "Bad state"); w.state = b.state; }
          if (b.style !== undefined) w.style = String(b.style).slice(0, 40);
          return w;
        });
        return json(200, w);
      }
      if (method === "DELETE") { await mutate(store, "watchlist", (wl) => { delete wl[h]; }); return json(200, { ok: true }); }
    }

    if (parts[0] === "config" && method === "PUT") {
      const b = await readBody(req);
      const clean = {};
      for (const [k, v] of Object.entries(b)) {
        if (!(k in DEFAULT_CONFIG)) continue;
        const d = DEFAULT_CONFIG[k];
        if (typeof d === "number") { const n = Number(v); if (Number.isFinite(n) && n >= 0) clean[k] = n; }
        else if (Array.isArray(d)) { if (Array.isArray(v)) clean[k] = v.map((x) => String(x).trim()).filter(Boolean).slice(0, 60); }
        else if (typeof v === "string") clean[k] = v.trim().slice(0, 120);
      }
      await mutate(store, "config", (c) => { Object.assign(c, clean); });
      return json(200, await getConfig(store));
    }

    throw new HttpError(404, "Not found");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return json(status, { error: status === 500 ? "Server error" : e.message }, parts[0] === "inbound" ? cors : {});
  }
}

function corsHeaders(req, env) {
  const origin = req.headers.get("origin") || "";
  const allowed = (env.SITE_ORIGINS || "https://medicimarketingconsultancy.com,https://www.medicimarketingconsultancy.com").split(",").map((s) => s.trim());
  return allowed.includes(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, x-inbound-token", vary: "origin" }
    : {};
}
