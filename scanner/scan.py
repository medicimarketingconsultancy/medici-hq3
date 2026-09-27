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
from collections import Counter
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
def apify(actor: str, payload: dict, budget: Budget, expected: int, keep: int = 0) -> list[dict]:
    """Run an actor synchronously and return its dataset items. Never exceeds the budget.
    `keep` holds back that many results for later stages (e.g. discovery)."""
    room = budget.left() - keep
    if room <= 0:
        return []
    url = f"{APIFY_BASE}/v2/acts/{actor}/run-sync-get-dataset-items"
    params = {"token": APIFY_TOKEN, "timeout": 290, "maxItems": max(1, min(expected, room))}
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


def scrape_profiles(handles, cfg, budget, keep: int = 0) -> dict[str, dict]:
    out = {}
    for batch in chunks(list(dict.fromkeys(handles)), 30):
        if budget.left() - keep <= 0:
            break
        batch = batch[:budget.left() - keep]
        for p in apify(cfg["profileActor"], {"usernames": batch}, budget, len(batch), keep):
            n = norm_profile(p)
            if n["handle"]:
                out[n["handle"]] = n
    return out


def scrape_reels(handles, cfg, budget, per_user: int, newer_than: str | None, keep: int = 0) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {h: [] for h in handles}
    for batch in chunks(list(handles), 10):
        want = per_user * len(batch)
        if budget.left() - keep < per_user:
            print("  ! Budget cap reached — skipping remaining accounts", file=sys.stderr)
            break
        payload = {"username": batch, "resultsLimit": per_user}
        if newer_than:
            payload["onlyPostsNewerThan"] = newer_than
        for it in apify(cfg["reelActor"], payload, budget, want, keep):
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
    tags = [str(t).lower().lstrip("#") for t in (it.get("hashtags") or []) if t]
    tags += [t.lower() for t in re.findall(r"#([A-Za-z0-9_]{2,50})", caption)]
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
        "hashtags": list(dict.fromkeys(tags)),
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
    # Hold back part of the budget so discovery always gets to run.
    keep = int(budget.left() * float(cfg.get("discoveryShare", 0.4)))
    print(f"Refreshing {len(handles)} watchlist accounts ({len(fresh)} need a baseline); {keep} results reserved for discovery")
    pulled = scrape_reels(fresh, cfg, budget, per_user=12, newer_than=None, keep=keep)
    pulled.update(scrape_reels(known, cfg, budget, per_user=8, newer_than=f"{cfg['reelWindowDays']} days", keep=keep))

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
        profs = scrape_profiles(rh, cfg, budget, keep=keep)
        rreels = {h: pulled[h] for h in rh if h in pulled}
        need = [h for h in rh if h not in rreels]
        rreels.update(scrape_reels(need, cfg, budget, per_user=15, newer_than="30 days", keep=keep))
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

    disc = run_discovery(state, cfg, budget, pulled, mentions, handles, wl, test)
    reels_out += disc["reels"]
    return {"reels": reels_out, "watchlistUpdates": wl_updates, "candidates": disc["candidates"], "rosterSnapshots": roster_snaps}


# ---------------------------------------------------------------- discovery (beyond your sources)
GENERIC_TAGS = {"fyp", "foryou", "foryoupage", "viral", "reels", "reel", "explore", "explorepage", "trending", "instagram",
                "instagood", "love", "like", "likes", "follow", "followme", "photooftheday", "reelsinstagram", "instareels",
                "reelitfeelit", "trend", "tiktok", "fy", "viralreels", "reelsvideo", "insta", "ig", "photography", "model"}


def pick_hashtags(cfg, pulled, run_count, test):
    """Your own hashtags (rotated) + the most-used niche hashtags in your sources' recent captions."""
    user = [t.lower().lstrip("#") for t in cfg.get("hashtags") or [] if t.strip()]
    if user:
        k = run_count % len(user)
        user = user[k:] + user[:k]
    counts = Counter(t for reels in pulled.values() for r in reels for t in r.get("hashtags", []) if t not in GENERIC_TAGS)
    auto = [t for t, n in counts.most_common(20) if n >= 2 and t not in user]
    n_auto = int(cfg.get("autoHashtags", 4))
    tags = list(dict.fromkeys(user[:4] + auto[:n_auto]))
    return tags[:2] if test else tags[:8]


STOPWORDS = set("""a an and the of to in on for with my me i you your our is are be at by it this that from or as not no
just all new more link bio below here dm dms me. only fan fans page acc account backup main official life love""".split())


def bio_terms(bios, cfg, limit=6):
    """Distinctive words your sources use in their bios (e.g. 'gymgirl', 'cosplayer', 'uk'), used to widen bio search."""
    words = Counter()
    for b in bios:
        seen = set()
        for w in re.findall(r"[a-z][a-z0-9']{2,20}", (b or "").lower()):
            if w not in STOPWORDS and w not in seen:
                seen.add(w); words[w] += 1
    return [w for w, n in words.most_common(limit * 3) if n >= 2][:limit]


def handle_from_url(url: str) -> str:
    m = re.match(r"https?://(?:www\.)?instagram\.com/([A-Za-z0-9._]{2,30})/?(?:\?|$)", url or "")
    if not m or m.group(1).lower() in {"p", "reel", "reels", "explore", "stories", "tv", "accounts", "about", "legal"}:
        return ""
    return norm_handle(m.group(1))


def rotate(xs, n):
    return xs[n % len(xs):] + xs[:n % len(xs)] if xs else xs


def run_discovery(state, cfg, budget, pulled, mentions, handles, wl, test=False):
    cap = 5 if test else (cfg["firstRunDiscoveryCap"] if state.get("firstRun") else cfg["discoveryCap"])
    known_all = set(state["knownHandles"]) | set(state["roster"]) | set(state["leadHandles"])
    known_reels = set(state.get("knownReelIds", []))
    run_no = int(state.get("runCount", 0))
    now = datetime.now(timezone.utc)
    # One list per discovery channel, so no single channel crowds out the others.
    channels: dict[str, list[tuple[str, str]]] = {"similar": [], "bio": [], "hashtag": [], "search": [], "mention": []}
    tag_reels: dict[str, list] = {}

    def add(ch, h, how):
        if h and h not in known_all:
            channels[ch].append((h, how))

    # 1. SIMILAR ACCOUNTS — Instagram's own suggestions for a rotating sample of your sources.
    source_bios = []
    if handles:
        sample = rotate(handles, run_no * 5)[: 3 if test else max(4, min(15, cap // 4))]
        if budget.left() > len(sample) + 10:
            print(f"Checking similar accounts for {len(sample)} sources")
            for src, prof in scrape_profiles(sample, cfg, budget).items():
                source_bios.append(prof["bio"])
                for rel in prof["related"]:
                    add("similar", rel, f"similar to @{src}")
            if not channels["similar"]:
                print("  ! Instagram returned no similar accounts this run (it sometimes hides them from scrapers)")

    # 2. BIO WORDS — Google indexes Instagram bios, so search it for creator phrases + your niche words.
    if cfg.get("bioSearch", True) and budget.left() > 30:
        phrases = [p for p in (cfg.get("bioSearchPhrases") or []) if p.strip()] or cfg["bioKeywords"][:8]
        niche = [t for t in (cfg.get("hashtags") or [])] + bio_terms(source_bios, cfg) + [x.lower() for x in cfg.get("styles", [])]
        niche = [n for n in dict.fromkeys(n.strip().lstrip("#") for n in niche) if n]
        n_q = 1 if test else int(cfg.get("bioQueriesPerRun", 4))
        queries = []
        for i in range(n_q):
            ph = rotate(phrases, run_no + i)[0] if phrases else ""
            nw = rotate(niche, run_no * 3 + i)[0] if niche else ""
            queries.append(f'site:instagram.com "{ph}" {nw}'.strip())
        print("Bio search: " + " | ".join(queries))
        for q in queries:
            if budget.left() < 15:
                break
            for page in apify(cfg["googleActor"], {"queries": q, "maxPagesPerQuery": 1, "resultsPerPage": 50}, budget, 1):
                for res in page.get("organicResults") or []:
                    add("bio", handle_from_url(res.get("url", "")), f"bio: {q.split(chr(34))[1] if chr(34) in q else q}")

    # 3. HASHTAGS — top reels in your niche hashtags (yours + the ones your sources use most).
    tags = pick_hashtags(cfg, pulled, run_no, test)
    if tags and budget.left() > 20:
        per_tag = 10 if test else int(cfg.get("postsPerHashtag", 30))
        print(f"Searching hashtags: {', '.join('#' + t for t in tags)}")
        found = {}
        for tag in tags:
            items = apify(cfg["hashtagActor"], {"hashtags": [tag], "resultsType": "reels", "resultsLimit": per_tag}, budget, per_tag)
            for r in filter(None, map(norm_reel, items)):
                h = r["handle"]
                if not h or h in known_all:
                    continue
                tag_reels.setdefault(h, []).append({**r, "_tag": tag})
                found.setdefault(h, f"#{tag}")
        for h in sorted(found, key=lambda h: -max(eng(r) for r in tag_reels[h])):
            add("hashtag", h, found[h])

    # 4. ACCOUNT SEARCH by your search terms, and 5. accounts your sources mention.
    for kw in ([] if test else (cfg.get("searchKeywords") or [])[:4]):
        if budget.left() < 25:
            break
        for it in apify(cfg["searchActor"], {"search": kw, "searchType": "user", "searchLimit": 20}, budget, 20):
            add("search", norm_handle(first(it, "username", "userName")), f"search: {kw}")
    for m, how in mentions.items():
        add("mention", m, how)

    # Merge channels round-robin, de-duplicated.
    via: dict[str, str] = {}
    lists = [list(v) for v in channels.values()]
    while any(lists) and len(via) < cap * 3:
        for lst in lists:
            if lst:
                h, how = lst.pop(0)
                via.setdefault(h, how)
    print("  Found: " + ", ".join(f"{k} {len(v)}" for k, v in channels.items()))

    candidates, reels = [], []
    seen = set()

    def classify_batch(hs):
        nonlocal candidates, reels
        next_hop = []
        for h, p in scrape_profiles(hs, cfg, budget).items():
            seen.add(h)
            if p["private"]:
                continue
            score, signals, dest = classify(p, cfg)
            if score < cfg["reviewScore"]:
                continue
            src = via.get(h, "")
            style = wl.get(src.removeprefix("similar to @"), {}).get("style", "") if src.startswith("similar to @") else ""
            candidates.append({"handle": h, "classScore": score, "signals": signals, "linkDest": dest, "bio": p["bio"][:400],
                               "followers": p["followers"], "foundVia": src, "style": style})
            if score >= cfg["autoAddScore"]:
                next_hop += [(r, h) for r in p["related"]]
            followers = p["followers"] or 0
            for r in tag_reels.get(h, []):
                if r["id"] in known_reels or not r["_ts"] or r["_ts"] < now - timedelta(days=30) or followers <= 0:
                    continue
                reach = (r["views"] or 0) / followers if r["views"] else ((r["likes"] or 0) * 20) / followers
                if reach >= float(cfg.get("reachMin", 2)) and ((r["views"] or 0) >= cfg["minViews"] or (not r["views"] and (r["likes"] or 0) >= cfg["minLikes"])):
                    reels.append({**{k2: v for k2, v in r.items() if not k2.startswith("_") and k2 not in ("mentions", "pinned", "hashtags")},
                                  "outperf": round(reach, 2), "basis": "reach", "discovered": True, "foundVia": f"#{r['_tag']}",
                                  "followers": followers, "style": style})
        return next_hop

    first_round = list(via)[:cap]
    print(f"Classifying {len(first_round)} new accounts")
    hop = classify_batch(first_round)
    # Snowball: strong new matches' own similar accounts, while cap and budget allow.
    left = cap - len(first_round)
    hop_hs = []
    for rel, src in hop:
        if rel not in known_all and rel not in seen and rel not in hop_hs:
            hop_hs.append(rel); via.setdefault(rel, f"similar to @{src}")
    if left > 0 and hop_hs and budget.left() > 10:
        print(f"Following similar accounts of {len(hop)} strong matches: {min(left, len(hop_hs))} more")
        classify_batch(hop_hs[:left])
    print(f"  {len(candidates)} look like creators; {len(reels)} of their reels banked")
    return {"candidates": candidates, "reels": reels}


# ---------------------------------------------------------------- prospects mode
def pct(a, b):
    return None if not b else (a - b) / b * 100


def run_prospects(state, cfg, budget, test=False):
    # Priority: website/manual leads waiting for data, then open leads, then every creator the scan has found.
    pool_all = state.get("creatorPool") or [w["handle"] for w in state["watchlist"]]
    if pool_all:  # rotate so every discovered creator gets checked over successive months
        k = int(state.get("runCount", 0)) * 25 % len(pool_all)
        pool_all = pool_all[k:] + pool_all[:k]
    order = list(dict.fromkeys(state["enrich"] + state["leadHandles"] + pool_all))
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
    # Defaults for newer settings, so the scanner still runs if the dashboard hasn't been updated yet.
    cfg = {"hashtagActor": "apify~instagram-hashtag-scraper", "searchActor": "apify~instagram-search-scraper",
           "googleActor": "apify~google-search-scraper", "hashtags": [], "searchKeywords": [], "bioSearchPhrases": [],
           "bioQueriesPerRun": 4, "autoHashtags": 4, "postsPerHashtag": 30, "reachMin": 2, "discoveryShare": 0.4,
           "styles": [], **state["config"]}
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
