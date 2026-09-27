# Medici HQ

Your private workspace at **hq.medicimarketingconsultancy.com**, styled to match your website (Montserrat, Manrope, JetBrains Mono, your mmc logo). It gives you a lead CRM, roster monitoring and the Reel Bank in one dashboard. It runs on Netlify's free plan, with a scanner that runs on GitHub Actions for free and pulls Instagram data through Apify's free $5 monthly credit.

```
Website form ──webhook──▶  Medici HQ (Netlify: dashboard + API + database)  ◀──results── Scanner (GitHub Actions → Apify)
                              Leads · Creators · Reel Bank · Settings
```

| Tab | What it's for |
| --- | --- |
| Overview | Open and hot leads, website enquiries, follow-ups due, pipeline, top struggling creators, and roster creators who are slipping |
| Leads | The CRM. Every website enquiry, every struggling creator the scan finds, and anyone you add yourself. Each lead has a stage, a temperature (Hot/Warm/Cold, set automatically or by you), a fit score, an 18+ check, a follow-up date, tags, notes and history. You can use a table or a drag-and-drop board, and export to CSV |
| Creators | Your roster. Each scan records followers, average views and posts, and a creator gets flagged **Slipping** when views drop 25%+ |
| Reel Bank | Reels beating their creator's own average by 3× or more. You can save, use or skip each one. It has sub-tabs for **Sources** (the watchlist) and **Review** (accounts the scan found that you approve or reject) |
| Settings | All scan thresholds, the website and scanner connection details, run history and monthly spend |

---

## Setup (about 45 minutes, once)

### 1. Put the code on GitHub (5 min)
1. At github.com, create a **private** repository called `medici-hq`.
2. Unzip `medici-hq.zip`, then click **Add file → Upload files** and drag in everything inside the folder.
   - On a Mac, the `.github` folder is hidden. Press **Cmd + Shift + .** in Finder to show it, and make sure it gets uploaded. Without it, the scanner won't run on schedule.
3. Click **Commit changes**.

### 2. Create the Netlify site (10 min)
1. In Netlify, go to **Add new site → Import an existing project → GitHub** and pick `medici-hq`. Leave the build settings as they are; `netlify.toml` handles them. Click **Deploy**.
2. Go to **Site configuration → Environment variables** and add these four. Use a password generator to make each secret: 32+ random characters, all different.

   | Key | Value |
   | --- | --- |
   | `ADMIN_PASSWORD` | The password you'll sign in with |
   | `SESSION_SECRET` | A random 32+ character string |
   | `SCANNER_TOKEN` | A random 32+ character string (you'll also give this to GitHub) |
   | `INBOUND_TOKEN` | A random 32+ character string (used by your website form) |

3. Go to **Deploys → Trigger deploy → Deploy site** so the variables take effect.
4. Go to **Domain management → Add a domain** and enter `hq.medicimarketingconsultancy.com`. If your domain's DNS is managed in Netlify, this is automatic. Otherwise add the CNAME record Netlify shows you.
5. Open the site and sign in with `ADMIN_PASSWORD`.

### 3. Connect your website form (5 min)
**If your "Request a meeting" form is a Netlify Form** (it will appear under Forms on your **website's** Netlify site):
1. On the website's Netlify site, go to **Forms → Form notifications → Add notification → Outgoing webhook**.
2. Event: *New form submission*. URL: `https://hq.medicimarketingconsultancy.com/api/inbound?token=YOUR_INBOUND_TOKEN`.
3. Submit a test enquiry on your site. It should appear in **Leads** within seconds, marked *Website*.

**If it isn't a Netlify Form,** add this just before `</body>` on the page with the form. Change the selector if your form has a different id:

```html
<script>
document.querySelector("form").addEventListener("submit", function (e) {
  var data = Object.fromEntries(new FormData(e.target));
  fetch("https://hq.medicimarketingconsultancy.com/api/inbound?token=YOUR_INBOUND_TOKEN", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data), keepalive: true
  });
});
</script>
```

The dashboard finds the name, Instagram handle, email and message fields automatically, whatever they're called. Duplicate handles are merged into the existing lead instead of creating a second one.

### 4. Connect the scanner (10 min)
1. Sign up for Apify (Free plan) and copy your API token from **Settings → API & Integrations**.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add three secrets:

   | Secret | Value |
   | --- | --- |
   | `HQ_URL` | `https://hq.medicimarketingconsultancy.com` |
   | `SCANNER_TOKEN` | The same value you set in Netlify |
   | `APIFY_TOKEN` | Your Apify token |

3. Open the **Actions** tab and enable workflows if GitHub asks.

### 5. First run (15 min)
1. In the dashboard, go to **Reel Bank → Sources** and add your 10–20 seed accounts with their style.
2. Go to **Creators** and add your roster.
3. In GitHub, go to **Actions → Medici scan → Run workflow** and choose **test**. It checks 5 accounts and uses about 75–200 results.
4. Check Apify → **Usage** to see what it cost, and look over the dashboard. If it looks right, run **all**.
5. Clear the **Review** queue. After that it runs itself.

---

## Schedule and what each run does

| When | Mode | What happens |
| --- | --- | --- |
| 1st of the month, 10:00 Dubai | `all` | Reel Bank refresh + roster snapshot + discovery + prospect scan (90-day decline check) |
| 15th of the month, 10:00 Dubai | `reels` | Reel Bank refresh + roster snapshot + discovery |
| Any time | pick one | GitHub → Actions → Medici scan → Run workflow (works in the GitHub mobile app) |

To change the schedule, edit the `cron:` line in `.github/workflows/scan.yml`. For example, `"0 6 * * 1"` is every Monday.

## How it finds creators beyond your list

Each reel scan saves part of its budget, and takes new accounts from every method in turn so no single one crowds out the rest (**Budget share for discovery**, default 40%) for looking beyond your sources:

1. **Bio words:** Google indexes Instagram bios, so it searches Google (`site:instagram.com`) for creator bio phrases (your **Bio phrases**, or your bio keywords if blank), combined with your niche words, hashtags and the distinctive words in your sources' own bios.
1. **Hashtag feeds:** it takes your own **Niche hashtags** (Settings), plus the hashtags your sources use most often (picked automatically from their captions), and pulls the top reels for each from anyone on Instagram.
2. **Account search:** it looks up any **Account search terms** you set, e.g. `fitness model`.
3. **Similar accounts:** it checks Instagram's "similar accounts" for a rotating sample of your sources, then follows the similar accounts of the strongest new matches it finds (snowballing). Instagram sometimes hides these from scrapers; the run log says when that happens.
4. **Mentions:** it collects accounts your sources tag or mention.

Every account it finds is checked for creator signals (bio link, bio wording, highlights). Clear matches become new sources automatically, and borderline ones go to **Review**. Their breakout reels go straight into the Reel Bank, marked **Discovered**, and are judged against their follower count: a reel with 2× more views than the creator has followers counts as a breakout. The monthly prospect scan checks **every** creator found this way for a 90-day decline, rotating through them if the budget can't cover everyone in one run, so prospects come from the whole pool, not just your seed list.

## Budget

Every run stops at **Max results per run** (Settings; default 900). The Apify Free plan can't exceed $5, so the worst case is a run that stops early, never a bill.

- The default scrapers are Apify's official ones (`apify~instagram-profile-scraper`, `apify~instagram-reel-scraper`). They're reliable but cost about $2.70 per 1,000 results, which is enough for roughly **50 sources + your roster** twice a month.
- Community scrapers list prices of $0.35–$0.45 per 1,000, which would let you track 200+ accounts or scan weekly. To switch, change the two scraper ids and **Cost per 1,000** in Settings, then run **test** to confirm the data still comes through. Community scrapers sometimes name fields differently. The scanner handles the common variants, but always test after switching.

## How the scoring works

**Is it an OF creator?** (0–100) The bio link ends at a fan site: +50. An 18+ or sensitive-content gate on the link page: +25. A link hub with no clear destination: +10. Bio keywords: +10 each, up to 30. Suggestive emoji next to a link cue: +10. Highlight titles, when the scraper returns them: +10 each, up to 20. A score of 60+ goes on the watchlist automatically, 30–59 goes to Review, and anything lower is ignored.

**Is the reel worth copying?** The reel's views (or likes + 3 × comments) are divided by that creator's median. It's banked at 3× or more, if it was posted in the last 14 days and has 10k+ views.

**Is the creator struggling?** Their last 30 days are compared with days 61–90. The decline score weighs views (50%), engagement (30%) and posting rate (20%). A creator becomes a new lead when views are down 30%+, followers are between 10k and 300k, they still post at least weekly, and they look like a creator (score 30+). Follower trends come from the dashboard's own snapshots and build up over time.

**Fit score and temperature.** The fit score combines the decline score (up to 50), whether followers are in range (30), creator signals (up to 20), and +15 if they came through your website. Hot is 70+, Warm is 40–69, Cold is below 40. You can override the temperature on any lead.

## Security

- The whole site is behind your password: a signed, HttpOnly session cookie that lasts 14 days. Pages are marked `noindex` and can't be embedded in other sites.
- The website webhook and the scanner each use their own secret token. If one leaks, change it in Netlify (and GitHub or the form) and redeploy.
- Only contact creators you've confirmed are 18+. The dashboard won't move a lead to your roster until you tick the age check.

## Local development

```bash
npm install
npm test               # API tests
npm run dev            # http://localhost:8888, password: test-pass (in-memory data)
node test/seed.mjs     # optional demo data
```
