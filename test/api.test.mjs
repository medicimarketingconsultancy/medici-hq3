import assert from "node:assert/strict";
import { handle } from "../lib/app.mjs";
import { memStore } from "./memstore.mjs";

const store = memStore();
const env = { ADMIN_PASSWORD: "pw", SESSION_SECRET: "x".repeat(32), SCANNER_TOKEN: "st", INBOUND_TOKEN: "it" };
let cookie = "";
const call = async (method, path, body, headers = {}) => {
  const r = await handle(new Request("https://hq.test/api" + path, {
    method, headers: { "content-type": "application/json", "x-requested-with": "hq", cookie, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), { store, env });
  return { status: r.status, body: await r.json(), headers: r.headers };
};

// auth
assert.equal((await call("GET", "/bootstrap")).status, 401);
assert.equal((await call("POST", "/login", { password: "nope" })).status, 401);
const login = await call("POST", "/login", { password: "pw" });
assert.equal(login.status, 200);
cookie = login.headers.get("set-cookie").split(";")[0];
assert.equal((await call("GET", "/session")).body.authed, true);
assert.equal((await call("POST", "/leads", { handle: "x" }, { "x-requested-with": "" })).status, 403, "csrf");

// inbound: Netlify webhook shape + bad token + honeypot
assert.equal((await call("POST", "/inbound?token=bad", { data: { name: "A" } })).status, 401);
const inb = await call("POST", "/inbound?token=it", { form_name: "meeting", data: { "full-name": "Jess Doe", "instagram-handle": "@Jess.Doe", situation: "Views dropped since summer" } });
assert.equal(inb.status, 200);
assert.equal((await call("POST", "/inbound?token=it", { data: { name: "Bot", "bot-field": "x" } })).body.ignored, true);
// plain urlencoded form post
await call("POST", "/inbound?token=it", "name=Kay&instagram=https%3A%2F%2Finstagram.com%2Fkay_k%2F&message=hi", { "content-type": "application/x-www-form-urlencoded" });

let boot = (await call("GET", "/bootstrap")).body;
assert.equal(boot.leads.length, 2);
const jess = boot.leads.find((l) => l.handle === "jess.doe");
assert.ok(jess && jess.source === "inbound" && jess.message.includes("Views"));
assert.ok(boot.leads.find((l) => l.handle === "kay_k"));

// manual lead, duplicate
assert.equal((await call("POST", "/leads", { handle: "@newgirl", name: "New" })).status, 200);
assert.equal((await call("POST", "/leads", { handle: "newgirl" })).status, 409);

// patch lead + notes + convert guard
const p = await call("PATCH", "/leads/" + jess.id, { stage: "Talking", temperature: "Hot", tags: ["fitness"] });
assert.equal(p.body.stage, "Talking"); assert.equal(p.body.temperature, "Hot"); assert.equal(p.body.tempOverride, true);
assert.equal((await call("POST", `/leads/${jess.id}/notes`, { text: "Call booked Tue" })).body.notes.length, 1);
assert.equal((await call("POST", `/leads/${jess.id}/convert`)).status, 400, "age guard");
await call("PATCH", "/leads/" + jess.id, { ageVerified: true });
assert.equal((await call("POST", `/leads/${jess.id}/convert`)).body.stage, "Signed");

// watchlist seeds
assert.deepEqual((await call("POST", "/watchlist", { handles: ["@seed1", "seed2", "seed1"], style: "Fitness" })).body.added, ["seed1", "seed2"]);

// scanner
assert.equal((await call("GET", "/scanner/state", undefined, { authorization: "Bearer wrong" })).status, 401);
const st = (await call("GET", "/scanner/state", undefined, { authorization: "Bearer st" })).body;
assert.equal(st.firstRun, true);
assert.deepEqual(st.watchlist.map((w) => w.handle).sort(), ["seed1", "seed2"]);
assert.ok(st.roster.includes("jess.doe"));
assert.ok(st.enrich.includes("kay_k"));

const res = await call("POST", "/scanner/results", {
  run: { mode: "all", results: 420, estCost: 1.13 },
  reels: [{ id: "ABC", url: "https://www.instagram.com/reel/ABC/", handle: "seed1", views: 90000, likes: 4000, comments: 120, outperf: 4.2, audio: "song", hook: "POV:" }],
  watchlistUpdates: [{ handle: "seed1", followers: 50000, medianEng: 1000, lastReelAt: new Date().toISOString() }],
  candidates: [
    { handle: "cand_hi", classScore: 75, signals: ["link→onlyfans"], foundVia: "related:seed1" },
    { handle: "cand_mid", classScore: 40 },
    { handle: "cand_lo", classScore: 10 },
  ],
  prospects: [
    { handle: "struggler", followers: 80000, classScore: 70, qualifies: true, metrics: { viewsChange: -45, declineScore: 60 } },
    { handle: "fine_one", followers: 80000, classScore: 70, qualifies: false, metrics: { viewsChange: 5, declineScore: 0 } },
    { handle: "kay_k", followers: 20000, classScore: 65, qualifies: false, metrics: { viewsChange: -10, declineScore: 20 } },
  ],
  rosterSnapshots: [{ handle: "jess.doe", followers: 31000, views30: 12000, eng30: 800, posts30: 14 }],
}, { authorization: "Bearer st" });
assert.equal(res.status, 200, JSON.stringify(res.body));
boot = (await call("GET", "/bootstrap")).body;
assert.equal(boot.reels.length, 1);
const wl = Object.fromEntries(boot.watchlist.map((w) => [w.handle, w]));
assert.equal(wl.cand_hi.state, "active"); assert.equal(wl.cand_mid.state, "pending"); assert.ok(!wl.cand_lo);
assert.equal(wl.seed1.followers, 50000);
assert.ok(boot.leads.find((l) => l.handle === "struggler" && l.source === "scan"));
assert.ok(!boot.leads.find((l) => l.handle === "fine_one"));
const kay = boot.leads.find((l) => l.handle === "kay_k");
assert.equal(kay.source, "inbound"); assert.equal(kay.followers, 20000); assert.ok(kay.lastEnrichedAt);
assert.equal(boot.creators[0].snapshots.length, 1); assert.equal(boot.creators[0].snapshots[0].followers, 31000);
assert.equal(boot.runs.length, 1);
// activity not duplicated
assert.equal(boot.leads.find((l) => l.handle === "struggler").activity.length, 1);

// reel status survives rescan
const reelPatch = await call("PATCH", "/reels/ABC", { status: "Used", usedBy: "Jess" });
assert.equal(reelPatch.body.status, "Used");
await call("POST", "/scanner/results", { reels: [{ id: "ABC", views: 120000 }] }, { authorization: "Bearer st" });
boot = (await call("GET", "/bootstrap")).body;
assert.equal(boot.reels[0].status, "Used"); assert.equal(boot.reels[0].views, 120000);

// config
const cfg = await call("PUT", "/config", { outperformMin: 4, bogus: 1, bioKeywords: ["a", " b "] });
assert.equal(cfg.body.outperformMin, 4); assert.ok(!("bogus" in cfg.body)); assert.deepEqual(cfg.body.bioKeywords, ["a", "b"]);

// concurrency: parallel note writes all land
await Promise.all(Array.from({ length: 5 }, (_, i) => call("POST", `/leads/${jess.id}/notes`, { text: "n" + i })));
boot = (await call("GET", "/bootstrap")).body;
assert.equal(boot.leads.find((l) => l.id === jess.id).notes.length, 6);

console.log("All API tests passed");
