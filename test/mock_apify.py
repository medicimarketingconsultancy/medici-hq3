"""Fake Apify + fake link pages for an end-to-end scanner test."""
import json, random, re
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
PORT = 8899
now = datetime.now(timezone.utc)
def reels_for(u, n, newer):
    rnd = random.Random(u)
    base = rnd.randint(8000, 40000)
    days_max = 90 if newer and "90" in newer else 30 if newer and "30" in newer else 14 if newer else 60
    out = []
    for i in range(n):
        age = rnd.uniform(0, days_max)
        decl = 0.4 if u.startswith("fading") and age < 30 else 1.0
        views = int(base * rnd.uniform(.6, 1.4) * decl * (5 if i == 0 else 1))
        out.append({"shortCode": f"{u}_{i}", "url": f"https://www.instagram.com/reel/{u}_{i}/", "ownerUsername": u, "videoPlayCount": views,
                    "likesCount": views // 25, "commentsCount": views // 900, "timestamp": (now - timedelta(days=age if i else 2)).isoformat(),
                    "caption": f"POV hook number {i} @newface_{u[:3]} #fyp", "musicInfo": {"song_name": "Track", "artist_name": "Artist"}})
    return out
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code); self.send_header("content-type", ctype); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/link/of"): return self._send(200, '<a href="https://onlyfans.com/abc">my page</a>', "text/html")
        if self.path.startswith("/link/gate"): return self._send(200, "<h1>Sensitive content</h1> you must be 18", "text/html")
        return self._send(200, "<p>hello</p>", "text/html")
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        if "profile" in self.path:
            out = []
            for u in body["usernames"]:
                link = f"http://localhost:{PORT}/link/of" if u.startswith(("newface", "fading", "cand", "seed")) else f"http://localhost:{PORT}/link/gate" if "strong" in u else ""
                out.append({"username": u, "fullName": u.title(), "biography": "more of me 👇 link below 🔞" if link else "coffee lover",
                            "externalUrl": link, "followersCount": 60000, "relatedProfiles": [{"username": f"newface_rel{u[-1]}"}]})
            return self._send(200, json.dumps(out))
        if "reel" in self.path:
            out = []
            for u in body["username"]: out += reels_for(u, body.get("resultsLimit", 10), body.get("onlyPostsNewerThan"))
            return self._send(200, json.dumps(out))
        self._send(404, "{}")
HTTPServer(("localhost", PORT), H).serve_forever()
