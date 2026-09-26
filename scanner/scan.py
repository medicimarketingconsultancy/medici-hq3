#!/usr/bin/env python3
"""Medici HQ scanner.

Pulls Instagram data through Apify, scores it, and posts the results to the
Medici HQ dashboard. Runs from GitHub Actions (see .github/workflows/scan.yml).

Modes
  reels      Refresh the watchlist + roster, rank breakout reels, discover new sources.
  prospects  Pull 90 days of reels for creators and leads, flag the ones in decline.
  all        Both.
  test       Reels mode on 5 accounts, discovery capped at 5. Use before the first real run.

Env
  HQ_URL          e.g. https://hq.medicimarketingconsultancy.com
  SCANNER_TOKEN   same value as the SCANNER_TOKEN env var in Netlify
  APIFY_TOKEN     Apify API token
  APIFY_BASE      optional, defaults to https://api.apify.com (used by tests)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import requests

HQ_URL = os.environ.get("HQ_URL", "").rstrip("/")
SCANNER_TOKEN = os.environ.get("SCANNER_TOKEN", "")
APIFY_TOKEN = os.environ.get("APIFY_TOKEN", "")
APIFY_BASE = os.environ.get("APIFY_BASE", "https://api.apify.com").rstrip("/")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

FAN_SITES = ("onlyfans.com", "fansly.com", "fanvue.com", "fansone.co", "justfor.fans", "loyalfans.com", "fanfix.io", "passes.com")
LINK_HUBS = ("linktr.ee", "beacons.ai", "allmylinks.com", "linkme.bio", "link.me", "getallmylinks.com", "hoo.be", "snipfeed.co",
             "lnk.bio", "campsite.bio", "solo.to", "bio.link", "tap.bio", "withkoji.com", "stan.store", "carrd.co", "direct.me", "fans.ly", "unfollow.me")
ADULT_GATE = ("sensitive content", "sensitive-content", "18+", "adult content", "age-restricted", "age restricted", "you must be 18", "over 18", "nsfw")
LINK_CUES = ("link", "below", "bio", "👇", "⬇", "↓", "🔗")
SPICY_EMOJI = ("🔞", "😈", "🍑", "💋", "🔥", "🍒", "💦", "👅")


class Budget:
    def __init__(self, cap: int, cost_per_1000: float):
        self.cap, self.used, self.cost = cap, 0, cost_per_1000

    def left(self) -> int:
        return max(0, self.cap - self.used)

    def spend(self, n: int):
        self.used += n

    @property
    def est_cost(self) -> float:
        return round(self.used * self.cost / 1000, 2)


# ---------------------------------------------------------------- HQ API
def hq(method: str, path: str, body=None):
    r = requests.request(method, f"{HQ_URL}/api{path}", json=body, timeout=60,
                         headers={"authorization": f"Bearer {SCANNER_TOKEN}"})
    if r.status_code >= 400:
        raise SystemExit(f"HQ {method} {path} failed: {r.status_code} {r.text[:300]}")
    return r.json()


# ---------------------------------------------------------------- Apify
def apify(actor: str, payload: dict, budget: Budget, expected: int) -> list[dict]:
    """Run an actor synchronously and return its dataset items. Never exceeds the budget."""
    if budget.left() <= 0:
        return []
    url = f"{APIFY_BASE}/v2/acts/{actor}/run-sync-get-dataset-items"
    params = {"token": APIFY_TOKEN, "timeout": 290, "maxItems": max(1, min(expected, budget.left()))}
    for attempt in range(3):
        try:
            r = requests.post(url, params=params, json=payload, timeout=320)
            if r.status_code in (429, 502, 503, 504):
                time.sleep(10 * (attempt + 1)); continue
            if r.status_code >= 400:
                print(f"  ! Apify {actor} error {r.status_code}: {r.text[:200]}", file=sys.stderr)
                return []
            items = [i for i in r.json() if isinstance(i, dict) and not i.get("error")]
            budget.spend(len(items))
            return items
        except requests.RequestException as e:
            print(f"  ! Apify request failed ({e}); retrying", file=sys.stderr)
            time.sleep(5)
    return []


def chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def scrape_profiles(handles, cfg, budget) -> dict[str, dict]:
    out = {}
    for batch in chunks(list(dict.fromkeys(handles)), 30):
        if budget.left() <= 0:
            break
        batch = batch[:budget.left()]
        for p in apify(cfg["profileActor"], {"usernames": batch}, budget, len(batch)):
            n = norm_profile(p)
            if n["handle"]:
                out[n["handle"]] = n
    return out


def scrape_reels(handles, cfg, budget, per_user: int, newer_than: str | None) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {h: [] for h in handles}
    for batch in chunks(list(handles), 10):
        want = per_user * len(batch)
        if budget.left() < per_user:
            print("  ! Budget cap reached — skipping remaining accounts", file=sys.stderr)
            break
        payload = {"username": batch, "resultsLimit": per_user}
        if newer_than:
            payload["onlyPostsNewerThan"] = newer_than
        for it in apify(cfg["reelActor"], payload, budget, want):
            r = norm_reel(it)
            if r and r["handle"] in out:
                out[r["handle"]].append(r)
    return out


# ---------------------------------------------------------------- normalisers (defensive: actors differ)
def first(d: dict, *keys, default=None):
    for k in keys:
        v = d.get(k)
        if v not in (None, "", []):
            return v
    return default


def norm_handle(h) -> str:
    h = str(h or "").strip().lower()
    h = re.sub(r"^https?://(www\.)?instagram\.com/", "", h).split("/")[0].split("?")[0].lstrip("@")
    return re.sub(r"[^a-z0-9._]", "", h)[:30]


def norm_profile(p: dict) -> dict:
    ext = first(p, "externalUrl", "external_url", "website")
    if not ext and isinstance(p.get("externalUrls"), list) and p["externalUrls"]:
        e0 = p["externalUrls"][0]
        ext = e0.get("url") if isinstance(e0, dict) else e0
    related = [norm_handle(x.get("username") if isinstance(x, dict) else x) for x in (p.get("relatedProfiles") or [])]
    highlights = []
    for h in p.get("highlights") or p.get("highlightReels") or []:
        if isinstance(h, dict) and h.get("title"):
            highlights.append(str(h["title"]))
    return {
        "handle": norm_handle(first(p, "username", "userName", "ownerUsername")),
        "name": first(p, "fullName", "full_name", default="") or "",
        "bio": first(p, "biography", "bio", default="") or "",
        "link": ext or "",
        "followers": first(p, "followersCount", "followers", "follower_count"),
        "private": bool(p.get("private") or p.get("isPrivate")),
        "related": [r for r in related if r],
        "highlights": highlights,
        "posts": p.get("latestPosts") or [],
    }


def parse_ts(v):
    if v in (None, ""):
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v, tz=timezone.utc)
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def norm_reel(it: dict) -> dict | None:
    code = first(it, "shortCode", "shortcode", "code", "id")
    if not code:
        return None
    ts = parse_ts(first(it, "timestamp", "takenAt", "taken_at", "createdAt"))
    music = it.get("musicInfo") or it.get("audio") or {}
    audio = ""
    if isinstance(music, dict):
        audio = " — ".join(x for x in [music.get("song_name") or music.get("title"), music.get("artist_name") or music.get("artist")] if x)
        if music.get("uses_original_audio") and not audio:
            audio = "original audio"
    caption = first(it, "caption", "text", default="") or ""
    mentions = [norm_handle(m) for m in (it.get("mentions") or []) if m]
    mentions += [norm_handle(t.get("username")) for t in (it.get("taggedUsers") or []) if isinstance(t, dict)]
    mentions += [norm_handle(m) for m in re.findall(r"@([A-Za-z0-9._]{2,30})", caption)]
    return {
        "id": str(code),
        "url": first(it, "url", default=f"https://www.instagram.com/reel/{code}/"),
        "handle": norm_handle(first(it, "ownerUsername", "username", "owner_username")),
        "views": first(it, "videoPlayCount", "videoViewCount", "playCount", "viewCount", "igPlayCount"),
        "likes": first(it, "likesCount", "likes", "likeCount", default=0),
        "comments": first(it, "commentsCount", "comments", "commentCount", default=0),
        "postedAt": ts.isoformat() if ts else None,
        "_ts": ts,
        "pinned": bool(it.get("isPinned") or it.get("pinned")),
        "audio": audio,
        "hook": caption.strip().split("\n")[0][:280],
        "thumb": first(it, "displayUrl", "thumbnailUrl", default=""),
        "mentions": [m for m in mentions if m],
    }


def eng(r: dict) -> float:
    if isinstance(r.get("views"), (int, float)) and r["views"] > 0:
        return float(r["views"])
    return float((r.get("likes") or 0) + 3 * (r.get("comments") or 0))


# ---------------------------------------------------------------- classification
def resolve_link(url: str) -> tuple[str, list[str], int]:
    """Follow a bio link (and one hop through a link hub) looking for a fan site."""
    if not url:
        return "", [], 0
    if not url.startswith("http"):
        url = "https://" + url
    signals, score, dest = [], 0, urlparse(url).netloc.lower().removeprefix("www.")
    try:
        r = requests.get(url, headers={"user-agent": UA}, timeout=12, allow_redirects=True)
        final = urlparse(r.url).netloc.lower().removeprefix("www.")
        html = r.text[:400_000].lower() if "text" in r.headers.get("content-type", "") else ""
    except requests.RequestException:
        return dest, ["link unreachable"], 0
    dest = final or dest
    fan = next((f for f in FAN_SITES if f in final), None) or next((f for f in FAN_SITES if f in html), None)
    if fan:
        return fan, [f"link → {fan}"], 50
    if any(h in final for h in LINK_HUBS):
        signals.append(f"link hub ({final})"); score += 10
    if any(g in html for g in ADULT_GATE):
        signals.append("18+ / sensitive-content gate"); score += 25
    return dest, signals, score


def classify(p: dict, cfg: dict) -> tuple[int, list[str], str]:
    bio = (p.get("bio") or "").lower()
    signals, score = [], 0
    dest, link_sig, link_score = resolve_link(p.get("link", ""))
    signals += link_sig; score += link_score
    hits = [k for k in cfg["bioKeywords"] if k.lower() in bio]
    if hits:
        score += min(30, 10 * len(hits)); signals.append("bio: " + ", ".join(hits[:4]))
    if any(e in bio for e in SPICY_EMOJI) and any(c in bio for c in LINK_CUES):
        score += 10; signals.append("suggestive emoji + link cue")
    hl = [t for t in p.get("highlights", []) if any(k.lower() == t.lower().strip() or k.lower() in t.lower() for k in cfg["highlightKeywords"])]
    if hl:
        score += min(20, 10 * len(hl)); signals.append("highlights: " + ", ".join(hl[:3]))
    return min(100, score), signals, dest


# ---------------------------------------------------------------- reels mode
def run_reels(state, cfg, budget, test=False):
    wl = {w["handle"]: w for w in state["watchlist"]}
    handles = list(wl)[:5] if test else list(wl)
    roster = [h for h in state["roster"] if h not in wl]
    now = datetime.now(timezone.utc)
    window = now - timedelta(days=cfg["reelWindowDays"])
    reels_out, wl_updates, roster_snaps, mentions = [], [], [], {}

    # Accounts with a known median only need recent reels; new ones need a baseline.
    known = [h for h in handles if wl[h].get("medianEng")]
    fresh = [h for h in handles if not wl[h].get("medianEng")]
    print(f"Refreshing {len(handles)} watchlist accounts ({len(fresh)} need a baseline)")
    pulled = scrape_reels(fresh, cfg, budget, per_user=12, newer_than=None)
    pulled.update(scrape_reels(known, cfg, budget, per_user=8, newer_than=f"{cfg['reelWindowDays']} days"))

    for h, reels in pulled.items():
        reels = [r for r in reels if not r["pinned"]]
        if not reels:
            continue
        engs = [eng(r) for r in reels]
        batch_median = statistics.median(engs) if len(engs) >= 6 else None
        prev = wl[h].get("medianEng")
        median = batch_median if prev is None else (0.7 * prev + 0.3 * batch_median if batch_median else prev)
        median = median or statistics.median(engs)
        latest_ts = max((r["_ts"] for r in reels if r["_ts"]), default=None)
        wl_updates.append({"handle": h, "medianEng": round(median, 1), "lastReelAt": latest_ts.isoformat() if latest_ts else None})
        for r in reels:
            for m in r["mentions"]:
                if m != h:
                    mentions.setdefault(m, f"mentioned by @{h}")
            if not r["_ts"] or r["_ts"] < window or median <= 0:
                continue
            ratio = eng(r) / median
            big_enough = (r["views"] or 0) >= cfg["minViews"] or (not r["views"] and (r["likes"] or 0) >= cfg["minLikes"])
            if ratio >= cfg["outperformMin"] and big_enough:
                reels_out.append({**{k: v for k, v in r.items() if not k.startswith("_") and k not in ("mentions", "pinned")},
                                  "outperf": round(ratio, 2), "style": wl[h].get("style", "")})

    # Roster snapshots: profile (followers) + last 30 days of reels.
    if roster or state["roster"]:
        rh = list(dict.fromkeys(state["roster"]))
        print(f"Snapshotting {len(rh)} roster creators")
        profs = scrape_profiles(rh, cfg, budget)
        rreels = {h: pulled[h] for h in rh if h in pulled}
        need = [h for h in rh if h not in rreels]
        rreels.update(scrape_reels(need, cfg, budget, per_user=15, newer_than="30 days"))
        cut = now - timedelta(days=30)
        for h in rh:
            rs = [r for r in rreels.get(h, []) if r["_ts"] and r["_ts"] >= cut]
            views = [r["views"] for r in rs if r["views"]]
            roster_snaps.append({
                "handle": h, "followers": profs.get(h, {}).get("followers"),
                "views30": round(statistics.mean(views)) if views else None,
                "eng30": round(statistics.mean([(r["likes"] or 0) + (r["comments"] or 0) for r in rs])) if rs else None,
                "posts30": len(rs),
            })

    # Discovery: related accounts of a rotating sample + accounts mentioned in reels.
    cap = 5 if test else (cfg["firstRunDiscoveryCap"] if state.get("firstRun") else cfg["discoveryCap"])
    known_all = set(state["knownHandles"]) | set(state["roster"]) | set(state["leadHandles"])
    sample = handles[: max(3, min(15, cap // 5))] if handles else []
    candidates_via = dict(mentions)
    if sample and budget.left() > len(sample) + 5:
        for src, prof in scrape_profiles(sample, cfg, budget).items():
            for rel in prof["related"]:
                candidates_via.setdefault(rel, f"related:{src}")
    cand = [h for h in candidates_via if h and h not in known_all][:cap]
    print(f"Classifying {len(cand)} candidate accounts")
    candidates = []
    for h, p in scrape_profiles(cand, cfg, budget).items():
        if p["private"]:
            continue
        score, signals, dest = classify(p, cfg)
        if score >= cfg["reviewScore"]:
            candidates.append({"handle": h, "classScore": score, "signals": signals, "linkDest": dest, "bio": p["bio"][:400],
                               "followers": p["followers"], "foundVia": candidates_via.get(h, "")})
    return {"reels": reels_out, "watchlistUpdates": wl_updates, "candidates": candidates, "rosterSnapshots": roster_snaps}


# ---------------------------------------------------------------- prospects mode
def pct(a, b):
    return None if not b else (a - b) / b * 100


def run_prospects(state, cfg, budget, test=False):
    # Priority: website/manual leads waiting for data, then open leads, then watchlist creators.
    order = list(dict.fromkeys(state["enrich"] + state["leadHandles"] + [w["handle"] for w in state["watchlist"]]))
    order = [h for h in order if h not in set(state["roster"])]
    per = 31  # one profile + ~30 reels over 90 days
    fit = max(0, budget.left() // per)
    pool = order[: min(fit, 5 if test else len(order))]
    if len(pool) < len(order):
        print(f"  Budget allows {len(pool)} of {len(order)} prospect accounts this run")
    print(f"Analysing 90-day trends for {len(pool)} accounts")
    profs = scrape_profiles(pool, cfg, budget)
    reels = scrape_reels(pool, cfg, budget, per_user=30, newer_than="90 days")
    now = datetime.now(timezone.utc)
    a_cut, b_start, b_end = now - timedelta(days=30), now - timedelta(days=90), now - timedelta(days=60)
    out = []
    for h in pool:
        p = profs.get(h)
        if not p or p["private"]:
            continue
        rs = [r for r in reels.get(h, []) if r["_ts"] and not r["pinned"]]
        A = [r for r in rs if r["_ts"] >= a_cut]
        B = [r for r in rs if b_start <= r["_ts"] < b_end]
        mv = lambda xs: statistics.mean([r["views"] for r in xs if r["views"]]) if any(r["views"] for r in xs) else None
        me = lambda xs: statistics.mean([(r["likes"] or 0) + (r["comments"] or 0) for r in xs]) if xs else None
        vA, vB, eA, eB = mv(A), mv(B), me(A), me(B)
        views_ch, eng_ch, post_ch = pct(vA, vB) if vA and vB else None, pct(eA, eB) if eA and eB else None, pct(len(A), len(B)) if B else None
        parts = [(views_ch, .5), (eng_ch, .3), (post_ch, .2)]
        wsum = sum(w for v, w in parts if v is not None)
        drop = sum(-v * w for v, w in parts if v is not None) / wsum if wsum else 0
        decline = int(max(0, min(100, drop * 1.2)))
        score, signals, dest = classify(p, cfg)
        followers = p["followers"] or 0
        qualifies = (
            cfg["prospectMinFollowers"] <= followers <= cfg["prospectMaxFollowers"]
            and views_ch is not None and views_ch <= -cfg["declineThreshold"]
            and len(A) / (30 / 7) >= cfg["minPostsPerWeek"]
            and score >= cfg["reviewScore"]
        )
        out.append({
            "handle": h, "name": p["name"], "followers": p["followers"], "bio": p["bio"][:400], "bioLink": p["link"], "linkDest": dest,
            "classScore": score, "qualifies": qualifies,
            "metrics": {"views30": round(vA) if vA else None, "viewsPrev": round(vB) if vB else None, "viewsChange": round(views_ch, 1) if views_ch is not None else None,
                        "eng30": round(eA) if eA else None, "engPrev": round(eB) if eB else None, "engChange": round(eng_ch, 1) if eng_ch is not None else None,
                        "posts30": len(A), "postsPrev": len(B), "postingChange": round(post_ch, 1) if post_ch is not None else None, "declineScore": decline, "signals": signals},
        })
    return {"prospects": out}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="reels", choices=["reels", "prospects", "all", "test"])
    ap.add_argument("--dry-run", action="store_true", help="print the payload instead of posting it")
    args = ap.parse_args()
    for k, v in {"HQ_URL": HQ_URL, "SCANNER_TOKEN": SCANNER_TOKEN, "APIFY_TOKEN": APIFY_TOKEN}.items():
        if not v:
            raise SystemExit(f"Missing environment variable {k}")

    state = hq("GET", "/scanner/state")
    cfg = state["config"]
    test = args.mode == "test"
    budget = Budget(min(cfg["maxResultsPerRun"], 200) if test else cfg["maxResultsPerRun"], cfg["costPer1000"])
    payload: dict = {}
    if args.mode in ("reels", "all", "test"):
        payload.update(run_reels(state, cfg, budget, test))
    if args.mode in ("prospects", "all"):
        payload.update(run_prospects(state, cfg, budget, test))
    payload["run"] = {"mode": args.mode, "results": budget.used, "estCost": budget.est_cost,
                      "notes": "budget cap reached" if budget.left() == 0 else ""}
    print(f"Used {budget.used} Apify results (~${budget.est_cost}).", {k: len(v) for k, v in payload.items() if isinstance(v, list)})
    if args.dry_run:
        print(json.dumps(payload, indent=2, default=str)[:20000]); return
    res = hq("POST", "/scanner/results", payload)
    print("Dashboard updated:", res.get("summary"))


if __name__ == "__main__":
    main()
