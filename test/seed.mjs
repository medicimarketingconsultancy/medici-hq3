// Fills a local dev server with realistic demo data (fake handles) for UI testing.
const B = process.env.BASE || "http://localhost:8888";
const post = (p, b, h = {}) => fetch(B + "/api" + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
const scan = { authorization: "Bearer scan-tok" };
const d = (n) => new Date(Date.now() - n * 864e5).toISOString();
await post("/inbound?token=in-tok", { data: { "full-name": "Ava Demo", "instagram-handle": "@ava.demo", situation: "Growth has stalled since June, reels getting half the views they used to." } });
await post("/inbound?token=in-tok", { data: { "full-name": "Rae Sample", "instagram-handle": "rae_sample", situation: "Currently self-managed, looking for an agency in the UK." } });
const login = await fetch(B + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-pass" }) });
const cookie = login.headers.get("set-cookie").split(";")[0];
const authed = { cookie, "x-requested-with": "hq" };
await post("/watchlist", { handles: ["seed_alpha", "seed_bravo", "seed_charlie", "seed_delta"], style: "Fitness" }, authed);
await post("/creators", { handle: "roster_one", name: "Roster One", style: "Glam" }, authed);
await post("/creators", { handle: "roster_two", name: "Roster Two", style: "Fitness" }, authed);
const hooks = ["POV: you finally tried the 5am routine", "Rating my gym fits 1–10", "Things men do that are instant ick", "Get ready with me for a first date", "He said I look different on camera…", "Replying to @user — yes this is real", "3 poses that always work", "Day in my life in Marbella"];
const reels = hooks.map((h, i) => ({ id: "R" + i, url: `https://www.instagram.com/reel/R${i}/`, handle: ["seed_alpha", "seed_bravo", "seed_charlie"][i % 3], views: 40000 + i * 21000, likes: 2000 + i * 900, comments: 60 + i * 20, outperf: 3 + ((i * 7) % 9) / 2, audio: ["Espresso — Sabrina Carpenter", "original audio", "Pedro — Jaxomy"][i % 3], hook: h, postedAt: d(i + 1) }));
const prospects = [
  { handle: "fading_star", name: "Fading Star", followers: 84000, classScore: 85, qualifies: true, bio: "more of me ↓ 🔞", linkDest: "onlyfans.com", metrics: { views30: 8000, viewsPrev: 21000, viewsChange: -62, engChange: -48, postingChange: -10, declineScore: 72 } },
  { handle: "slow_month", name: "", followers: 42000, classScore: 70, qualifies: true, bio: "link below 💋", linkDest: "fansly.com", metrics: { viewsChange: -38, engChange: -30, postingChange: 5, declineScore: 41 } },
  { handle: "big_dip", name: "Big Dip", followers: 260000, classScore: 90, qualifies: true, metrics: { viewsChange: -51, engChange: -40, postingChange: -45, declineScore: 58 } },
  { handle: "ava.demo", followers: 23000, classScore: 65, qualifies: false, metrics: { viewsChange: -44, engChange: -35, postingChange: 0, declineScore: 50 } },
];
const candidates = [
  { handle: "maybe_creator", classScore: 45, followers: 31000, bio: "exclusive content 👇 link in bio", signals: ["bio: exclusive", "linktree"], foundVia: "related:seed_alpha", linkDest: "linktr.ee" },
  { handle: "strong_match", classScore: 80, followers: 120000, signals: ["link→onlyfans"], foundVia: "related:seed_bravo" },
];
const snaps = (followers, views) => [{ handle: "roster_one", followers, views30: views, eng30: views / 20, posts30: 12 }, { handle: "roster_two", followers: followers * 0.6, views30: views * 0.7, eng30: views / 30, posts30: 8 }];
await post("/scanner/results", { run: { mode: "all", results: 640, estCost: 1.73 }, reels, prospects, candidates, rosterSnapshots: snaps(51000, 30000), watchlistUpdates: [{ handle: "seed_alpha", followers: 150000, medianEng: 9000, lastReelAt: d(1) }] }, scan);
console.log("seeded");
