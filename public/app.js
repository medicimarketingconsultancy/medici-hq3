/* Medici HQ — dashboard client. Vanilla JS, no build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("hq:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hq:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const S = {
  data: null,
  tab: store.get("tab", "overview"),
  leads: { q: "", stage: "open", temp: "", source: "", view: store.get("leadView", "table"), sort: store.get("leadSort", ["fitScore", -1]) },
  reels: { sub: "reels", q: "", style: "", status: "active", sort: "outperf", origin: "" },
  creators: { q: "" },
  openLead: null, openCreator: null,
};

// ---------- api ----------
async function api(method, path, body) {
  const r = await fetch("/api" + path, {
    method, credentials: "same-origin",
    headers: { "content-type": "application/json", "x-requested-with": "hq" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && !path.startsWith("/login")) { showLogin(); throw new Error("Signed out"); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
function toast(msg, err = false) {
  const t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), err ? 4200 : 2200);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { if (e.message !== "Signed out") toast(e.message, true); throw e; }
}

// ---------- formatting ----------
const fmtN = (n) => n == null || n === "" ? "—" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));
const fmtPct = (v) => typeof v !== "number" ? "—" : `<span class="${v < 0 ? "down" : v > 0 ? "up" : ""}">${v > 0 ? "+" : ""}${Math.round(v)}%</span>`;
const fmtDate = (d) => { if (!d) return "—"; const x = new Date(d); return isNaN(x) ? "—" : x.toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
const ago = (d) => {
  if (!d) return "never"; const s = (Date.now() - Date.parse(d)) / 1000;
  if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago";
  const days = Math.round(s / 86400); return days < 45 ? days + "d ago" : fmtDate(d);
};
const today = () => new Date().toISOString().slice(0, 10);
const igUrl = (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`;
const handleLink = (h) => h ? `<a href="${igUrl(h)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">@${esc(h)}</a>` : "—";
const OPEN = ["New", "Contacted", "Talking", "Proposal"];
const safeUrl = (u) => /^https:\/\//i.test(u || "") ? esc(u) : "";

// ---------- boot ----------
function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); $("#layer").innerHTML = ""; }
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("#login-err").textContent = "";
  const pw = new FormData(e.target).get("password");
  try { await api("POST", "/login", { password: pw }); e.target.reset(); await load(); }
  catch (err) { $("#login-err").textContent = err.message; }
});
async function load() {
  const data = await api("GET", "/bootstrap");
  S.data = data;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#last-sync").textContent = "Synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  render();
}
document.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; store.set("tab", S.tab); render(); $("#view").focus(); window.scrollTo(0, 0); return; }
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action === "refresh") act(load, "Refreshed");
  if (a?.dataset.action === "logout") api("POST", "/logout").finally(showLogin);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLayer(); });
(async () => {
  try { const s = await api("GET", "/session"); if (s.authed) await load(); else showLogin(); }
  catch { showLogin(); }
})();

// ---------- render ----------
function render() {
  const d = S.data; if (!d) return;
  $$(".nav-btn[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.tab));
  const newLeads = d.leads.filter((l) => l.stage === "New").length;
  const pending = d.watchlist.filter((w) => w.state === "pending").length;
  setBadge("#badge-leads", newLeads); setBadge("#badge-reels", pending);
  const v = $("#view");
  ({ overview: renderOverview, leads: renderLeads, creators: renderCreators, reels: renderReels, settings: renderSettings }[S.tab] || renderOverview)(v);
}
function setBadge(sel, n) { const b = $(sel); b.textContent = n; b.classList.toggle("hidden", !n); }

// ---------- overview ----------
function renderOverview(v) {
  const d = S.data;
  const open = d.leads.filter((l) => OPEN.includes(l.stage));
  const hot = open.filter((l) => l.temperature === "Hot");
  const weekAgo = Date.now() - 7 * 864e5;
  const inboundWeek = d.leads.filter((l) => l.source === "inbound" && Date.parse(l.createdAt) > weekAgo);
  const due = open.filter((l) => l.nextFollowUp && l.nextFollowUp <= today()).sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const lastRun = d.runs[0];
  const newReels = d.reels.filter((r) => r.status === "New").length;
  const counts = Object.fromEntries(d.stages.map((s) => [s, d.leads.filter((l) => l.stage === s).length]));
  const max = Math.max(1, ...Object.values(counts));
  const inbound = [...d.leads].filter((l) => l.source === "inbound").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const decliners = open.filter((l) => l.source === "scan").sort((a, b) => b.fitScore - a.fitScore).slice(0, 6);

  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Overview</div><h1>Good ${greeting()},<br><span class="dim">Gabe.</span></h1><p>${lastRun ? `Last scan ${ago(lastRun.at)} · ${esc(lastRun.mode)}` : "No scans yet — the first one runs on the 1st or 15th, or trigger it from GitHub."}</p></div>
      <button class="btn primary" data-new-lead>+ Add lead</button></div>
    <div class="grid kpis">
      ${kpi("Open leads", open.length, `${counts.New} new`, "leads")}
      ${kpi("Hot leads", hot.length, "fit score 70+", "leads:hot")}
      ${kpi("Enquiries", inboundWeek.length, "last 7 days", "leads:inbound")}
      ${kpi("Follow-ups due", due.length, due.length ? "today or overdue" : "all clear", "leads:due")}
      ${kpi("Roster", d.creators.filter((c) => c.status !== "Paused").length, "active creators", "creators")}
      ${kpi("New reels", newReels, "in the bank", "reels")}
    </div>
    <div class="card card-pad" style="margin-bottom:16px"><h2>Pipeline</h2>
      <div class="pipeline">${d.stages.map((s) => `<div class="pipe-step" data-stage="${s}"><div class="n">${counts[s]}</div><div class="s">${s}</div><div class="pipe-bar" style="width:${Math.max(4, (counts[s] / max) * 100)}%;${s === "Pass" ? "background:var(--line-strong)" : ""}"></div></div>`).join("")}</div>
    </div>
    <div class="grid two">
      <div class="card card-pad"><h2>Follow-ups due</h2>${due.length ? `<div class="list">${due.slice(0, 8).map(leadRow).join("")}</div>` : `<div class="empty">Nothing due. Set a follow-up date on any lead to see it here.</div>`}</div>
      <div class="card card-pad"><h2>Latest website enquiries</h2>${inbound.length ? `<div class="list">${inbound.map(leadRow).join("")}</div>` : `<div class="empty">No enquiries yet. Connect the website form in Settings.</div>`}</div>
      <div class="card card-pad"><h2>Top struggling creators</h2>${decliners.length ? `<div class="list">${decliners.map(leadRow).join("")}</div>` : `<div class="empty">The monthly prospect scan fills this with creators whose views are falling.</div>`}</div>
      <div class="card card-pad"><h2>Roster movement (30 days)</h2>${rosterMovers()}</div>
    </div>`;
  $$("[data-go]", v).forEach((k) => k.addEventListener("click", () => {
    const [tab, f] = k.dataset.go.split(":"); S.tab = tab; store.set("tab", tab);
    if (tab === "leads") Object.assign(S.leads, { stage: "open", temp: f === "hot" ? "Hot" : "", source: f === "inbound" ? "inbound" : "", due: f === "due" });
    render();
  }));
  $$("[data-stage]", v).forEach((p) => p.addEventListener("click", () => { S.tab = "leads"; Object.assign(S.leads, { stage: p.dataset.stage, temp: "", source: "", due: false }); render(); }));
  bindLeadRows(v); $("[data-new-lead]", v).addEventListener("click", newLeadModal);
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"; };
const kpi = (label, value, sub, go) => `<div class="card kpi" ${go ? `data-go="${go}"` : ""}><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
function leadRow(l) {
  const extra = l.nextFollowUp && OPEN.includes(l.stage) && l.nextFollowUp <= today() ? `<span class="chip warn">Due ${fmtDate(l.nextFollowUp)}</span>` : l.metrics?.viewsChange != null ? `<span class="small">${fmtPct(l.metrics.viewsChange)} views</span>` : `<span class="small muted">${ago(l.createdAt)}</span>`;
  return `<div class="list-row" data-lead="${l.id}"><span class="chip ${l.temperature}">${l.temperature}</span><div style="min-width:0;flex:1"><div class="who">${esc(l.name || "@" + l.handle)}</div><div class="small muted">${l.handle ? "@" + esc(l.handle) : esc(l.email)} · ${esc(l.stage)}</div></div>${extra}</div>`;
}
function rosterMovers() {
  const rows = S.data.creators.map((c) => ({ c, ch: growth(c) })).filter((x) => x.ch != null).sort((a, b) => a.ch - b.ch);
  if (!rows.length) return `<div class="empty">Add creators to your roster to track their growth after each scan.</div>`;
  return `<div class="list">${rows.slice(0, 6).map(({ c, ch }) => `<div class="list-row" data-creator="${c.id}"><div style="flex:1"><div class="who">@${esc(c.handle)}</div><div class="small muted">${fmtN(latest(c)?.followers)} followers</div></div>${spark(c.snapshots.map((s) => s.views30))}<span class="small">${fmtPct(ch)}</span></div>`).join("")}</div>`;
}
function bindLeadRows(root) {
  $$("[data-lead]", root).forEach((r) => r.addEventListener("click", () => openLead(r.dataset.lead)));
  $$("[data-creator]", root).forEach((r) => r.addEventListener("click", () => openCreator(r.dataset.creator)));
}

// ---------- leads ----------
function filteredLeads() {
  const f = S.leads; const q = f.q.trim().toLowerCase();
  let rows = S.data.leads.filter((l) =>
    (f.stage === "all" || (f.stage === "open" ? OPEN.includes(l.stage) : l.stage === f.stage)) &&
    (!f.temp || l.temperature === f.temp) && (!f.source || l.source === f.source) &&
    (!f.due || (l.nextFollowUp && l.nextFollowUp <= today())) &&
    (!q || [l.handle, l.name, l.email, l.message, ...(l.tags || [])].join(" ").toLowerCase().includes(q)));
  const [k, dir] = f.sort;
  const val = (l) => k === "views" ? l.metrics?.viewsChange ?? 999 : k === "decline" ? l.metrics?.declineScore ?? -1 : l[k] ?? "";
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  return rows;
}
function renderLeads(v) {
  const f = S.leads; const rows = filteredLeads(); const stages = S.data.stages;
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">CRM</div><h1>Leads</h1><p>Website enquiries, struggling creators found by the scan, and anyone you add.</p></div>
      <div style="display:flex;gap:8px"><button class="btn" data-export>Export CSV</button><button class="btn primary" data-new-lead>+ Add lead</button></div></div>
    <div class="toolbar">
      <input class="input search" placeholder="Search handle, name, notes, tags…" value="${esc(f.q)}" data-f="q">
      <select class="input" data-f="stage"><option value="open">Open stages</option><option value="all">All stages</option>${stages.map((s) => `<option ${f.stage === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <select class="input" data-f="temp"><option value="">Any temperature</option>${["Hot", "Warm", "Cold"].map((t) => `<option ${f.temp === t ? "selected" : ""}>${t}</option>`).join("")}</select>
      <select class="input" data-f="source"><option value="">Any source</option><option value="inbound" ${f.source === "inbound" ? "selected" : ""}>Website</option><option value="scan" ${f.source === "scan" ? "selected" : ""}>Scan</option><option value="manual" ${f.source === "manual" ? "selected" : ""}>Manual</option></select>
      ${f.due ? `<button class="chip warn" data-clear-due style="border:0;cursor:pointer">Follow-ups due ✕</button>` : ""}
      <div class="seg" style="margin-left:auto"><button class="${f.view === "table" ? "on" : ""}" data-view="table">Table</button><button class="${f.view === "board" ? "on" : ""}" data-view="board">Board</button></div>
    </div>
    <div id="leads-body"></div>`;
  $("[data-f=stage]", v).value = f.stage;
  $$("[data-f]", v).forEach((el) => el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => { f[el.dataset.f] = el.value; drawLeadsBody(); }));
  $$("[data-view]", v).forEach((b) => b.addEventListener("click", () => { f.view = b.dataset.view; store.set("leadView", f.view); if (f.view === "board" && f.stage === "open") f.stage = "all"; renderLeads(v); }));
  $("[data-clear-due]", v)?.addEventListener("click", () => { f.due = false; renderLeads(v); });
  $("[data-new-lead]", v).addEventListener("click", newLeadModal);
  $("[data-export]", v).addEventListener("click", exportCsv);
  drawLeadsBody();
}
function drawLeadsBody() {
  const body = $("#leads-body"); if (!body) return;
  const rows = filteredLeads();
  if (S.leads.view === "board") return drawBoard(body, rows);
  if (!rows.length) { body.innerHTML = `<div class="card empty">No leads match these filters.</div>`; return; }
  const cols = [["name", "Creator"], ["source", "Source"], ["stage", "Stage"], ["temperature", "Temp"], ["fitScore", "Fit"], ["followers", "Followers"], ["views", "Views trend"], ["nextFollowUp", "Follow-up"], ["updatedAt", "Updated"]];
  const [sk, sd] = S.leads.sort;
  body.innerHTML = `<div class="card table-wrap"><table><thead><tr>${cols.map(([k, l]) => `<th data-sort="${k}">${l}${sk === k ? (sd > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((l) => `<tr data-lead="${l.id}">
      <td><div class="who">${esc(l.name || "@" + (l.handle || "unknown"))}</div><div class="small muted">${l.handle ? handleLink(l.handle) : esc(l.email)}${l.ageVerified ? ' · <span title="Age confirmed 18+">18+ ✓</span>' : ""}</div></td>
      <td><span class="chip ${l.source}">${l.source === "inbound" ? "Website" : l.source === "scan" ? "Scan" : "Manual"}</span></td>
      <td><select class="input" data-stage-of="${l.id}" onclick="event.stopPropagation()">${S.data.stages.map((s) => `<option ${s === l.stage ? "selected" : ""}>${s}</option>`).join("")}</select></td>
      <td><span class="chip ${l.temperature}">${l.temperature}</span></td>
      <td><span class="score num"><span class="score-bar"><i style="width:${l.fitScore}%"></i></span>${l.fitScore}</span></td>
      <td class="num">${fmtN(l.followers)}</td>
      <td class="num">${fmtPct(l.metrics?.viewsChange)}</td>
      <td class="${l.nextFollowUp && l.nextFollowUp <= today() && OPEN.includes(l.stage) ? "down" : ""}">${fmtDate(l.nextFollowUp)}</td>
      <td class="muted small">${ago(l.updatedAt)}</td></tr>`).join("")}
  </tbody></table></div><div class="small muted" style="margin-top:8px">${rows.length} lead${rows.length === 1 ? "" : "s"}</div>`;
  $$("th[data-sort]", body).forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort; S.leads.sort = [k, S.leads.sort[0] === k ? -S.leads.sort[1] : -1]; store.set("leadSort", S.leads.sort); drawLeadsBody();
  }));
  $$("[data-stage-of]", body).forEach((sel) => sel.addEventListener("change", () => updateLead(sel.dataset.stageOf, { stage: sel.value }, "Stage updated")));
  bindLeadRows(body);
}
function drawBoard(body, rows) {
  body.innerHTML = `<div class="board">${S.data.stages.map((s) => {
    const items = rows.filter((l) => l.stage === s);
    return `<div class="col" data-col="${s}"><h3><span>${s}</span><span>${items.length}</span></h3>${items.map((l) => `
      <div class="bcard" draggable="true" data-lead="${l.id}"><div class="who">${esc(l.name || "@" + l.handle)}</div><div class="small muted">${l.handle ? "@" + esc(l.handle) : esc(l.email)}</div>
      <div class="row"><span class="chip ${l.temperature}">${l.temperature} · ${l.fitScore}</span><span class="small">${l.metrics?.viewsChange != null ? fmtPct(l.metrics.viewsChange) : `<span class="chip ${l.source}">${l.source === "inbound" ? "Website" : l.source}</span>`}</span></div></div>`).join("")}</div>`;
  }).join("")}</div>`;
  bindLeadRows(body);
  $$(".bcard", body).forEach((c) => c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", c.dataset.lead); }));
  $$(".col", body).forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
    col.addEventListener("dragleave", () => col.classList.remove("drop"));
    col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("drop"); const id = e.dataTransfer.getData("text/plain"); const l = S.data.leads.find((x) => x.id === id); if (l && l.stage !== col.dataset.col) updateLead(id, { stage: col.dataset.col }, `Moved to ${col.dataset.col}`); });
  });
}
async function updateLead(id, patch, msg) {
  const l = await act(() => api("PATCH", "/leads/" + id, patch), msg);
  replaceLead(l);
}
function replaceLead(l) {
  const i = S.data.leads.findIndex((x) => x.id === l.id);
  if (i >= 0) S.data.leads[i] = l; else S.data.leads.push(l);
  render(); if (S.openLead === l.id) openLead(l.id, true);
}
function exportCsv() {
  const cols = ["handle", "name", "email", "source", "stage", "temperature", "fitScore", "followers", "viewsChange", "declineScore", "ageVerified", "nextFollowUp", "tags", "message", "createdAt"];
  const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const lines = [cols.join(","), ...filteredLeads().map((l) => cols.map((c) => cell(c === "viewsChange" || c === "declineScore" ? l.metrics?.[c] : c === "tags" ? (l.tags || []).join("; ") : l[c])).join(","))];
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = `medici-leads-${today()}.csv`; a.click();
}
function newLeadModal() {
  modal(`<h2>Add lead</h2>
    <label class="field">Instagram handle<input class="input" name="handle" placeholder="@handle" required></label>
    <label class="field">Name<input class="input" name="name"></label>
    <label class="field">Email<input class="input" name="email" type="email"></label>
    <label class="field">Context<textarea class="input" name="message" placeholder="How you found them, what they need…"></textarea></label>
    <div class="small muted">The next scan pulls their followers and 90-day trend and scores the lead automatically.</div>`,
  "Add lead", async (fd) => { const l = await act(() => api("POST", "/leads", fd), "Lead added"); S.data.leads.push(l); render(); openLead(l.id); });
}

function openLead(id, keepScroll = false) {
  const l = S.data.leads.find((x) => x.id === id); if (!l) return closeLayer();
  S.openLead = id; S.openCreator = null;
  const prev = keepScroll ? $(".drawer-body")?.scrollTop : 0;
  const m = l.metrics || {};
  const onRoster = S.data.creators.some((c) => c.handle && c.handle === l.handle);
  $("#layer").innerHTML = `<div class="scrim" data-close></div>
  <aside class="drawer" role="dialog" aria-label="Lead details">
    <div class="drawer-head"><div><h2>${esc(l.name || "@" + l.handle)}</h2><div class="small muted">${handleLink(l.handle)} · added ${ago(l.createdAt)} · <span class="chip ${l.source}">${l.source === "inbound" ? "Website" : l.source === "scan" ? "Scan" : "Manual"}</span></div></div><button class="x-btn" data-close aria-label="Close">×</button></div>
    <div class="drawer-body">
      <div class="fields">
        <label class="field">Stage<select class="input" data-p="stage">${S.data.stages.map((s) => `<option ${s === l.stage ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="field">Temperature<select class="input" data-p="temperature"><option value="auto">Auto (${autoTemp(l.fitScore)})</option>${["Hot", "Warm", "Cold"].map((t) => `<option ${l.tempOverride && l.temperature === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field">Next follow-up<input class="input" type="date" data-p="nextFollowUp" value="${esc(l.nextFollowUp)}"></label>
        <label class="field">Tags<input class="input" data-p="tags" value="${esc((l.tags || []).join(", "))}" placeholder="fitness, UK, warm intro"></label>
        <label class="field">Name<input class="input" data-p="name" value="${esc(l.name)}"></label>
        <label class="field">Email<input class="input" data-p="email" value="${esc(l.email)}"></label>
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" data-p="ageVerified" ${l.ageVerified ? "checked" : ""}> Age confirmed 18+ <span class="small muted">(required before signing)</span></label>
      <div><div class="section-title">Classification</div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${l.fitScore}</div><div class="l">Fit score</div></div>
          <div class="stat"><div class="v">${l.classScore ?? "—"}</div><div class="l">Creator signals</div></div>
          <div class="stat"><div class="v">${fmtN(l.followers)}</div><div class="l">Followers</div></div>
          <div class="stat"><div class="v">${fmtPct(m.viewsChange)}</div><div class="l">Views, 30d vs prior</div></div>
          <div class="stat"><div class="v">${fmtPct(m.engChange)}</div><div class="l">Engagement</div></div>
          <div class="stat"><div class="v">${fmtPct(m.postingChange)}</div><div class="l">Posting rate</div></div>
        </div>
        <div class="small muted" style="margin-top:6px">${l.lastEnrichedAt ? `Metrics from scan ${ago(l.lastEnrichedAt)}.` : "Waiting for the next scan to pull metrics."} ${l.linkDest ? `Link goes to ${esc(l.linkDest)}.` : ""}</div>
      </div>
      ${l.message ? `<div><div class="section-title">${l.source === "inbound" ? "Their message" : "Context"}</div><div class="quote">${esc(l.message)}</div></div>` : ""}
      ${l.bio ? `<div><div class="section-title">Bio</div><div class="quote">${esc(l.bio)}</div></div>` : ""}
      <div><div class="section-title">Notes</div>
        <form data-note style="display:grid;gap:6px"><textarea class="input" name="text" placeholder="Add a note — call outcome, next step…"></textarea><div><button class="btn sm primary">Add note</button></div></form>
        ${(l.notes || []).map((n) => `<div class="note"><p>${esc(n.text)}<br><span class="small muted">${ago(n.at)}</span></p><button class="btn sm" data-del-note="${n.id}" aria-label="Delete note">✕</button></div>`).join("")}
      </div>
      <div><div class="section-title">Activity</div><div class="activity">${(l.activity || []).map((a) => `<div>${esc(a.text)} · ${ago(a.at)}</div>`).join("") || "—"}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:14px">
        ${l.handle ? `<a class="btn" href="${igUrl(l.handle)}" target="_blank" rel="noopener noreferrer">Open Instagram</a>` : ""}
        ${onRoster ? `<span class="chip ok" style="align-self:center">On roster</span>` : `<button class="btn gold" data-convert ${l.ageVerified ? "" : "disabled title='Confirm age first'"}>Sign → add to roster</button>`}
        <button class="btn danger" data-del-lead style="margin-left:auto">Delete</button>
      </div>
    </div></aside>`;
  const drawer = $(".drawer"); if (prev) $(".drawer-body").scrollTop = prev;
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeLayer));
  $$("[data-p]", drawer).forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.p;
    const val = k === "ageVerified" ? el.checked : k === "tags" ? el.value.split(",").map((s) => s.trim()).filter(Boolean) : el.value;
    updateLead(id, { [k]: val }, "Saved");
  }));
  $("[data-note]", drawer).addEventListener("submit", async (e) => {
    e.preventDefault(); const text = new FormData(e.target).get("text"); if (!String(text).trim()) return;
    replaceLead(await act(() => api("POST", `/leads/${id}/notes`, { text }), "Note added"));
  });
  $$("[data-del-note]", drawer).forEach((b) => b.addEventListener("click", async () => replaceLead(await act(() => api("DELETE", `/leads/${id}/notes/${b.dataset.delNote}`)))));
  $("[data-convert]", drawer)?.addEventListener("click", async () => { const r = await act(() => api("POST", `/leads/${id}/convert`), "Signed — added to roster"); await load(); openLead(r.id); });
  $("[data-del-lead]", drawer).addEventListener("click", async () => {
    if (!confirm(`Delete ${l.name || "@" + l.handle}? This can't be undone.`)) return;
    await act(() => api("DELETE", "/leads/" + id), "Lead deleted"); S.data.leads = S.data.leads.filter((x) => x.id !== id); closeLayer(); render();
  });
}
const autoTemp = (s) => (s >= 70 ? "Hot" : s >= 40 ? "Warm" : "Cold");
function closeLayer() { $("#layer").innerHTML = ""; S.openLead = S.openCreator = null; }
function modal(inner, submitLabel, onSubmit) {
  $("#layer").innerHTML = `<div class="scrim" data-close></div><form class="modal">${inner}<div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${submitLabel}</button></div></form>`;
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeLayer));
  const f = $(".modal"); f.querySelector("input,textarea")?.focus();
  f.addEventListener("submit", async (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(f)); try { closeLayer(); await onSubmit(fd); } catch { /* toasted */ } });
}

// ---------- creators ----------
const latest = (c) => c.snapshots?.[c.snapshots.length - 1];
function growth(c, key = "followers") {
  const s = c.snapshots || []; if (s.length < 2) return null;
  const last = s[s.length - 1]; const cut = Date.parse(last.date) - 30 * 864e5;
  const base = [...s].reverse().find((x) => Date.parse(x.date) <= cut) || s[0];
  if (!base[key] || last[key] == null || base === last) return null;
  return ((last[key] - base[key]) / base[key]) * 100;
}
function spark(vals, w = 80, h = 24) {
  const v = vals.filter((x) => typeof x === "number"); if (v.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * (w - 4) + 2},${h - 2 - ((x - mn) / r) * (h - 4)}`).join(" ");
  const down = v[v.length - 1] < v[0];
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${down ? "var(--bad)" : "var(--gold)"}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function renderCreators(v) {
  const q = S.creators.q.toLowerCase();
  const rows = S.data.creators.filter((c) => !q || [c.handle, c.name, c.style, c.notes].join(" ").toLowerCase().includes(q)).sort((a, b) => (a.status === "Paused") - (b.status === "Paused") || a.handle.localeCompare(b.handle));
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Roster</div><h1>Creators</h1><p>Your roster. Each scan records followers, views and posting so you can spot anyone slipping early.</p></div><button class="btn primary" data-add>+ Add creator</button></div>
    <div class="toolbar"><input class="input search" placeholder="Search roster…" value="${esc(S.creators.q)}" data-q></div>
    ${rows.length ? `<div class="card table-wrap"><table><thead><tr><th class="nosort">Creator</th><th class="nosort">Style</th><th class="nosort">Followers</th><th class="nosort">30d growth</th><th class="nosort">Views (30d avg)</th><th class="nosort">Trend</th><th class="nosort">Posts / 30d</th><th class="nosort">Status</th></tr></thead><tbody>
      ${rows.map((c) => { const L = latest(c) || {}; const g = growth(c); const vg = growth(c, "views30"); return `<tr data-creator="${c.id}">
        <td><div class="who">${esc(c.name || "@" + c.handle)}</div><div class="small muted">${handleLink(c.handle)}</div></td>
        <td>${esc(c.style) || "—"}</td><td class="num">${fmtN(L.followers)}</td><td class="num">${fmtPct(g)}</td>
        <td class="num">${fmtN(L.views30)} ${vg != null ? `<span class="small">${fmtPct(vg)}</span>` : ""}</td><td>${spark((c.snapshots || []).map((s) => s.views30))}</td>
        <td class="num">${L.posts30 ?? "—"}</td><td>${c.status === "Paused" ? '<span class="chip">Paused</span>' : vg != null && vg <= -25 ? '<span class="chip warn">Slipping</span>' : '<span class="chip ok">Active</span>'}</td></tr>`; }).join("")}
    </tbody></table></div>` : `<div class="card empty">No creators yet. Add your roster, or sign a lead to move them here.</div>`}`;
  $("[data-q]", v).addEventListener("input", (e) => { S.creators.q = e.target.value; const pos = e.target.selectionStart; renderCreators(v); const i = $("[data-q]", v); i.focus(); i.setSelectionRange(pos, pos); });
  $("[data-add]", v).addEventListener("click", () => modal(`<h2>Add creator to roster</h2>
    <label class="field">Instagram handle<input class="input" name="handle" required placeholder="@handle"></label>
    <label class="field">Name<input class="input" name="name"></label>
    <label class="field">Style<select class="input" name="style"><option value="">—</option>${S.data.config.styles.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>`,
  "Add", async (fd) => { const c = await act(() => api("POST", "/creators", fd), "Creator added"); S.data.creators.push(c); render(); }));
  bindLeadRows(v);
}
function openCreator(id) {
  const c = S.data.creators.find((x) => x.id === id); if (!c) return closeLayer();
  S.openCreator = id; S.openLead = null;
  const snaps = c.snapshots || []; const L = latest(c) || {};
  $("#layer").innerHTML = `<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-label="Creator details">
    <div class="drawer-head"><div><h2>${esc(c.name || "@" + c.handle)}</h2><div class="small muted">${handleLink(c.handle)} · on roster since ${fmtDate(c.since)}</div></div><button class="x-btn" data-close aria-label="Close">×</button></div>
    <div class="drawer-body">
      <div class="stat-grid">
        <div class="stat"><div class="v">${fmtN(L.followers)}</div><div class="l">Followers</div></div>
        <div class="stat"><div class="v">${fmtPct(growth(c))}</div><div class="l">30d growth</div></div>
        <div class="stat"><div class="v">${fmtN(L.views30)}</div><div class="l">Avg views, 30d</div></div>
      </div>
      <div><div class="section-title">Views trend</div>${lineChart(snaps, "views30")}</div>
      <div><div class="section-title">Followers trend</div>${lineChart(snaps, "followers")}</div>
      <div class="fields">
        <label class="field">Name<input class="input" data-c="name" value="${esc(c.name)}"></label>
        <label class="field">Style<select class="input" data-c="style"><option value="">—</option>${S.data.config.styles.map((s) => `<option ${s === c.style ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <label class="field">Status<select class="input" data-c="status"><option ${c.status !== "Paused" ? "selected" : ""}>Active</option><option ${c.status === "Paused" ? "selected" : ""}>Paused</option></select></label>
        <label class="field">On roster since<input class="input" type="date" data-c="since" value="${esc(c.since)}"></label>
      </div>
      <label class="field">Notes<textarea class="input" data-c="notes" rows="5">${esc(c.notes)}</textarea></label>
      ${snaps.length ? `<div><div class="section-title">Scan history</div><div class="table-wrap"><table><thead><tr><th class="nosort">Date</th><th class="nosort">Followers</th><th class="nosort">Avg views</th><th class="nosort">Avg eng.</th><th class="nosort">Posts</th></tr></thead><tbody>${[...snaps].reverse().map((s) => `<tr><td>${fmtDate(s.date)}</td><td class="num">${fmtN(s.followers)}</td><td class="num">${fmtN(s.views30)}</td><td class="num">${fmtN(s.eng30)}</td><td class="num">${s.posts30 ?? "—"}</td></tr>`).join("")}</tbody></table></div></div>` : `<div class="muted small">No scan data yet — it appears after the next scan.</div>`}
      <div style="display:flex;border-top:1px solid var(--line);padding-top:14px"><button class="btn danger" data-del style="margin-left:auto">Remove from roster</button></div>
    </div></aside>`;
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeLayer));
  $$("[data-c]").forEach((el) => el.addEventListener("change", async () => {
    const u = await act(() => api("PATCH", "/creators/" + id, { [el.dataset.c]: el.value }), "Saved");
    S.data.creators[S.data.creators.findIndex((x) => x.id === id)] = u; render();
  }));
  $("[data-del]").addEventListener("click", async () => {
    if (!confirm(`Remove @${c.handle} from the roster?`)) return;
    await act(() => api("DELETE", "/creators/" + id), "Removed"); S.data.creators = S.data.creators.filter((x) => x.id !== id); closeLayer(); render();
  });
}
function lineChart(snaps, key) {
  const pts = snaps.filter((s) => typeof s[key] === "number");
  if (pts.length < 2) return `<div class="small muted">Needs at least two scans.</div>`;
  const W = 460, H = 120, P = 28; const vals = pts.map((p) => p[key]); const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
  const x = (i) => P + (i / (pts.length - 1)) * (W - P - 8); const y = (v) => H - 18 - ((v - mn) / r) * (H - 34);
  const line = pts.map((p, i) => `${x(i)},${y(p[key])}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${key} over time">
    <line x1="${P}" x2="${W - 8}" y1="${H - 18}" y2="${H - 18}" stroke="var(--line)"/>
    <text x="${P - 4}" y="${y(mx) + 4}" text-anchor="end" font-size="10" font-family="JetBrains Mono, monospace" fill="var(--muted)">${fmtN(mx)}</text>
    <text x="${P - 4}" y="${y(mn) + 4}" text-anchor="end" font-size="10" font-family="JetBrains Mono, monospace" fill="var(--muted)">${fmtN(mn)}</text>
    <polyline points="${line}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p[key])}" r="3" fill="var(--gold)"><title>${fmtDate(p.date)}: ${fmtN(p[key])}</title></circle>`).join("")}
    <text x="${P}" y="${H - 4}" font-size="10" font-family="JetBrains Mono, monospace" fill="var(--muted)">${fmtDate(pts[0].date)}</text>
    <text x="${W - 8}" y="${H - 4}" font-size="10" fill="var(--muted)" text-anchor="end">${fmtDate(pts[pts.length - 1].date)}</text></svg>`;
}

// ---------- reel bank ----------
function renderReels(v) {
  const f = S.reels; const d = S.data;
  const pending = d.watchlist.filter((w) => w.state === "pending");
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Reel monitoring</div><h1>Reel Bank</h1><p>Breakout reels from your sources (${d.config.outperformMin}× or more their usual views) and from creators discovered across Instagram (views ${d.config.reachMin}× or more their follower count).</p></div>
      <div class="seg"><button class="${f.sub === "reels" ? "on" : ""}" data-sub="reels">Reels</button><button class="${f.sub === "sources" ? "on" : ""}" data-sub="sources">Sources</button><button class="${f.sub === "review" ? "on" : ""}" data-sub="review">Review${pending.length ? ` (${pending.length})` : ""}</button></div></div>
    <div id="reels-body"></div>`;
  $$("[data-sub]", v).forEach((b) => b.addEventListener("click", () => { f.sub = b.dataset.sub; renderReels(v); }));
  const body = $("#reels-body", v);
  ({ reels: drawReelGrid, sources: drawSources, review: drawReview })[f.sub](body);
}
function drawReelGrid(body) {
  const f = S.reels; const q = f.q.toLowerCase();
  let rows = S.data.reels.filter((r) => (f.status === "all" || (f.status === "active" ? !["Used", "Skip"].includes(r.status) : r.status === f.status)) && (!f.style || r.style === f.style) && (!f.origin || (f.origin === "discovered" ? r.discovered : !r.discovered)) && (!q || [r.handle, r.hook, r.audio].join(" ").toLowerCase().includes(q)));
  const key = { outperf: (r) => r.outperf ?? 0, views: (r) => r.views ?? 0, recent: (r) => Date.parse(r.postedAt || r.foundAt) }[f.sort];
  rows.sort((a, b) => key(b) - key(a));
  body.innerHTML = `<div class="toolbar">
      <input class="input search" placeholder="Search hook, audio, creator…" value="${esc(f.q)}" data-f="q">
      <select class="input" data-f="style"><option value="">All styles</option>${S.data.config.styles.map((s) => `<option ${f.style === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      <select class="input" data-f="status">${[["active", "New + Saved"], ["New", "New"], ["Saved", "Saved"], ["Used", "Used"], ["Skip", "Skipped"], ["all", "All"]].map(([k, l]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select class="input" data-f="origin"><option value="">All creators</option><option value="sources" ${f.origin === "sources" ? "selected" : ""}>My sources</option><option value="discovered" ${f.origin === "discovered" ? "selected" : ""}>Discovered</option></select>
      <select class="input" data-f="sort"><option value="outperf" ${f.sort === "outperf" ? "selected" : ""}>Most outperforming</option><option value="views" ${f.sort === "views" ? "selected" : ""}>Most views</option><option value="recent" ${f.sort === "recent" ? "selected" : ""}>Most recent</option></select>
    </div>
    ${rows.length ? `<div class="reels">${rows.map(reelCard).join("")}</div>` : `<div class="card empty">${S.data.reels.length ? "No reels match these filters." : "The bank fills after the first scan. Add seed accounts under Sources to get started."}</div>`}
    ${S.data.archivedReels ? `<div class="small muted" style="margin-top:12px">${S.data.archivedReels} reels older than ${S.data.config.reelArchiveDays} days are archived.</div>` : ""}`;
  $$("[data-f]", body).forEach((el) => el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
    f[el.dataset.f] = el.value;
    if (el.tagName === "INPUT") { const pos = el.selectionStart; drawReelGrid(body); const i = $("[data-f=q]", body); i.focus(); i.setSelectionRange(pos, pos); } else drawReelGrid(body);
  }));
  $$("[data-reel-status]", body).forEach((b) => b.addEventListener("click", async () => {
    const [id, status] = b.dataset.reelStatus.split("|"); const r = S.data.reels.find((x) => x.id === id);
    const next = r.status === status ? "New" : status;
    let usedBy = r.usedBy;
    if (next === "Used") { usedBy = prompt("Which creator is using this reel? (optional)", r.usedBy || "") ?? r.usedBy; }
    const u = await act(() => api("PATCH", "/reels/" + encodeURIComponent(id), { status: next, usedBy }), next === "New" ? "Reset" : next);
    Object.assign(r, u); drawReelGrid(body);
  }));
}
function reelCard(r) {
  const thumb = safeUrl(r.thumb);
  return `<div class="card reel ${r.status === "Used" || r.status === "Skip" ? "used" : ""}">
    <div class="reel-top">${thumb ? `<img src="${thumb}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span class="x" title="${r.basis === "reach" ? "Views vs their follower count" : "Views vs their usual reels"}">${r.outperf != null ? r.outperf.toFixed(1) + "×" + (r.basis === "reach" ? " reach" : "") : "—"}</span><div class="hook">${esc(r.hook || "No caption")}</div></div>
    <div class="reel-body">
      <div style="display:flex;justify-content:space-between;gap:6px"><span class="who">${handleLink(r.handle)}</span><span class="small muted">${fmtDate(r.postedAt)}</span></div>
      <div class="reel-stats num"><span>${fmtN(r.views)} views</span><span>${fmtN(r.likes)} likes</span><span>${fmtN(r.comments)} comm.</span></div>
      ${r.audio ? `<div class="small muted" title="Audio">♪ ${esc(r.audio)}</div>` : ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap">${r.discovered ? `<span class="chip inbound" title="Found outside your sources">Discovered${r.foundVia ? " · " + esc(r.foundVia) : ""}</span>` : ""}${r.style ? `<span class="chip">${esc(r.style)}</span>` : ""}${r.status !== "New" ? `<span class="chip ${r.status === "Used" ? "ok" : ""}">${esc(r.status)}${r.usedBy ? " · " + esc(r.usedBy) : ""}</span>` : ""}</div>
    </div>
    <div class="reel-actions">
      ${safeUrl(r.url) ? `<a class="btn sm gold" href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer">Open reel</a>` : ""}
      <button class="btn sm ${r.status === "Saved" ? "on" : ""}" data-reel-status="${esc(r.id)}|Saved">Save</button>
      <button class="btn sm ${r.status === "Used" ? "on" : ""}" data-reel-status="${esc(r.id)}|Used">Used</button>
      <button class="btn sm ${r.status === "Skip" ? "on" : ""}" data-reel-status="${esc(r.id)}|Skip">Skip</button>
    </div></div>`;
}
function drawSources(body) {
  const wl = [...S.data.watchlist].filter((w) => w.state !== "pending" && w.state !== "rejected").sort((a, b) => (a.state !== "active") - (b.state !== "active") || a.handle.localeCompare(b.handle));
  const styles = S.data.config.styles;
  body.innerHTML = `
    <div class="card card-pad" style="margin-bottom:14px"><h2>Add seed accounts</h2>
      <form data-seed class="grid" style="grid-template-columns:1fr auto auto;align-items:end">
        <label class="field">Handles (one per line or comma-separated)<textarea class="input" name="handles" rows="2" placeholder="@creator_one, @creator_two"></textarea></label>
        <label class="field">Style<select class="input" name="style"><option value="">—</option>${styles.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
        <button class="btn primary">Add</button></form>
      <div class="small muted" style="margin-top:8px">${S.data.watchlist.filter((w) => w.state === "active").length} active sources. The scan also finds new ones through related accounts and sends unclear ones to Review.</div></div>
    ${wl.length ? `<div class="card table-wrap"><table><thead><tr><th class="nosort">Account</th><th class="nosort">Style</th><th class="nosort">Source</th><th class="nosort">Followers</th><th class="nosort">Median eng.</th><th class="nosort">Last reel</th><th class="nosort">Signals</th><th class="nosort">State</th></tr></thead><tbody>
      ${wl.map((w) => `<tr><td>${handleLink(w.handle)}</td>
        <td><select class="input" data-wstyle="${esc(w.handle)}"><option value="">—</option>${styles.map((s) => `<option ${s === w.style ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></td>
        <td><span class="chip">${esc(w.source)}</span></td><td class="num">${fmtN(w.followers)}</td><td class="num">${fmtN(w.medianEng)}</td><td>${fmtDate(w.lastReelAt)}</td>
        <td class="small muted">${w.classScore != null ? w.classScore : "—"}</td>
        <td><select class="input" data-wstate="${esc(w.handle)}">${["active", "inactive"].map((s) => `<option ${w.state === s ? "selected" : ""}>${s}</option>`).join("")}<option value="remove">remove…</option></select></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="card empty">No sources yet. Add 10–20 seed accounts above.</div>`}`;
  $("[data-seed]", body).addEventListener("submit", async (e) => {
    e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target));
    const handles = fd.handles.split(/[\s,]+/).filter(Boolean); if (!handles.length) return;
    const r = await act(() => api("POST", "/watchlist", { handles, style: fd.style }));
    toast(r.added.length ? `Added ${r.added.length} source${r.added.length === 1 ? "" : "s"}` : "Already on the list"); await load();
  });
  $$("[data-wstate]", body).forEach((s) => s.addEventListener("change", async () => {
    const h = s.dataset.wstate;
    if (s.value === "remove") { if (!confirm(`Remove @${h}?`)) { s.value = "active"; return; } await act(() => api("DELETE", "/watchlist/" + h), "Removed"); }
    else await act(() => api("PATCH", "/watchlist/" + h, { state: s.value }), "Updated");
    await load();
  }));
  $$("[data-wstyle]", body).forEach((s) => s.addEventListener("change", async () => { await act(() => api("PATCH", "/watchlist/" + s.dataset.wstyle, { style: s.value }), "Style saved"); const w = S.data.watchlist.find((x) => x.handle === s.dataset.wstyle); if (w) w.style = s.value; }));
}
function drawReview(body) {
  const rows = S.data.watchlist.filter((w) => w.state === "pending").sort((a, b) => (b.classScore || 0) - (a.classScore || 0));
  body.innerHTML = rows.length ? `<div class="small muted" style="margin-bottom:10px">Accounts the scan found that might be OF creators. Add the ones worth watching. Reject anyone who may be under 18.</div>
    <div class="grid">${rows.map((w) => `<div class="card card-pad" style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
      <div style="min-width:0"><div><span class="who">${handleLink(w.handle)}</span> <span class="chip">score ${w.classScore ?? "—"}</span> <span class="small muted">${fmtN(w.followers)} followers · ${esc(w.foundVia || "discovered")}</span></div>
        ${w.bio ? `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(w.bio)}</div>` : ""}
        <div class="small muted" style="margin-top:4px">${(w.signals || []).map(esc).join(" · ")}${w.linkDest ? ` · link → ${esc(w.linkDest)}` : ""}</div></div>
      <div style="display:flex;gap:6px"><button class="btn sm primary" data-rev="${esc(w.handle)}|active">Add</button><button class="btn sm" data-rev="${esc(w.handle)}|rejected">Reject</button></div></div>`).join("")}</div>`
    : `<div class="card empty">Review queue is clear.</div>`;
  $$("[data-rev]", body).forEach((b) => b.addEventListener("click", async () => {
    const [h, state] = b.dataset.rev.split("|");
    await act(() => api("PATCH", "/watchlist/" + h, { state }), state === "active" ? `@${h} added` : "Rejected");
    const w = S.data.watchlist.find((x) => x.handle === h); if (w) w.state = state; render();
  }));
}

// ---------- settings ----------
function renderSettings(v) {
  const c = S.data.config; const origin = location.origin;
  const num = (k, label, hint = "") => `<label class="field">${label}<input class="input num" type="number" step="any" min="0" name="${k}" value="${esc(c[k])}">${hint ? `<span class="small muted">${hint}</span>` : ""}</label>`;
  const list = (k, label) => `<label class="field">${label}<textarea class="input" name="${k}" rows="3">${esc((c[k] || []).join(", "))}</textarea></label>`;
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Workspace</div><h1>Settings</h1><p>Scan thresholds, website connection and run history.</p></div></div>
    <div class="grid two" style="margin-bottom:16px">
      <div class="card card-pad"><h2>Website form</h2>
        <p class="small">${S.data.inboundConfigured ? '<span class="chip ok">Connected</span> Enquiries from your site land in Leads automatically.' : '<span class="chip warn">Not set</span> Add an INBOUND_TOKEN environment variable in Netlify first.'}</p>
        <p class="small muted">In Netlify, open your <b>website</b> site → Forms → Form notifications → Add notification → Outgoing webhook, and paste:</p>
        <code class="code">${esc(origin)}/api/inbound?token=YOUR_INBOUND_TOKEN</code></div>
      <div class="card card-pad"><h2>Scanner</h2>
        <p class="small">${S.data.scannerConfigured ? '<span class="chip ok">Token set</span>' : '<span class="chip warn">Not set</span> Add a SCANNER_TOKEN environment variable in Netlify.'}</p>
        <p class="small muted">GitHub Actions calls this workspace at:</p><code class="code">${esc(origin)}/api/scanner</code>
        <p class="small muted" style="margin-bottom:0">Runs on the 1st and 15th. Trigger one any time from GitHub → Actions → Medici scan → Run workflow.</p></div>
    </div>
    <form class="card card-pad" data-config style="margin-bottom:16px"><h2>Scan settings</h2>
      <div class="section-title">Reel bank</div>
      <div class="settings-grid">${num("outperformMin", "Outperformance minimum (×)")}${num("minViews", "Minimum views")}${num("minLikes", "Minimum likes (if no views)")}${num("reelWindowDays", "Reel window (days)")}${num("reelArchiveDays", "Archive after (days)")}</div>
      <div class="section-title settings-block">Finding creators</div>
      <div class="settings-grid">${num("autoAddScore", "Auto-add score", "60+ added automatically")}${num("reviewScore", "Review score", "Below this is ignored")}${num("discoveryCap", "Discovery cap per run")}${num("firstRunDiscoveryCap", "First-run discovery cap")}${num("inactiveAfterDays", "Inactive after (days)")}</div>
      <div class="section-title settings-block">Discovery beyond your sources</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:14px">${list("bioSearchPhrases", "Bio phrases to hunt for (blank = your bio keywords)")}${list("hashtags", "Niche hashtags (without #, rotated each run)")}${list("searchKeywords", "Account search terms (e.g. fitness model)")}</div>
      <div class="settings-grid">${num("bioQueriesPerRun", "Bio searches per run")}${num("autoHashtags", "Auto hashtags per run", "Picked from your sources' captions")}${num("postsPerHashtag", "Reels per hashtag")}${num("reachMin", "Discovered reel minimum (× followers)")}${num("discoveryShare", "Budget share for discovery (0–1)")}
        <label class="field">Hashtag scraper (Apify id)<input class="input" name="hashtagActor" value="${esc(c.hashtagActor)}"></label>
        <label class="field">Search scraper (Apify id)<input class="input" name="searchActor" value="${esc(c.searchActor)}"></label>
        <label class="field">Google scraper (Apify id)<input class="input" name="googleActor" value="${esc(c.googleActor)}"></label></div>
      <div class="section-title settings-block">Struggling-creator prospects</div>
      <div class="settings-grid">${num("prospectMinFollowers", "Min followers")}${num("prospectMaxFollowers", "Max followers")}${num("declineThreshold", "Decline threshold (%)", "Views down at least this much")}${num("minPostsPerWeek", "Min posts per week")}</div>
      <div class="section-title settings-block">Budget and scrapers</div>
      <div class="settings-grid">${num("maxResultsPerRun", "Max results per run")}${num("costPer1000", "Cost per 1,000 results ($)")}
        <label class="field">Profile scraper (Apify id)<input class="input" name="profileActor" value="${esc(c.profileActor)}"></label>
        <label class="field">Reel scraper (Apify id)<input class="input" name="reelActor" value="${esc(c.reelActor)}"></label></div>
      <div class="grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:16px">${list("bioKeywords", "Bio keywords")}${list("highlightKeywords", "Highlight keywords")}${list("styles", "Styles")}</div>
      <div style="margin-top:14px"><button class="btn primary">Save settings</button></div></form>
    <div class="card card-pad"><h2>Run history</h2>${S.data.runs.length ? `<div class="table-wrap"><table><thead><tr><th class="nosort">When</th><th class="nosort">Mode</th><th class="nosort">Results</th><th class="nosort">Est. cost</th><th class="nosort">Reels +</th><th class="nosort">Sources +</th><th class="nosort">Prospects +</th><th class="nosort">Notes</th></tr></thead><tbody>
      ${S.data.runs.map((r) => `<tr><td>${new Date(r.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td><td>${esc(r.mode)}</td><td class="num">${r.results ?? "—"}</td><td class="num">${r.estCost != null ? "$" + Number(r.estCost).toFixed(2) : "—"}</td><td class="num">${r.summary?.reelsAdded ?? 0}</td><td class="num">${r.summary?.candidatesAdded ?? 0}</td><td class="num">${r.summary?.prospectsNew ?? 0}</td><td class="small muted">${esc(r.notes)}</td></tr>`).join("")}
      </tbody></table></div><div class="small muted" style="margin-top:8px">This month: $${monthSpend().toFixed(2)} estimated of the $5 free Apify credit.</div>` : `<div class="empty">No runs yet.</div>`}</div>`;
  $("[data-config]", v).addEventListener("submit", async (e) => {
    e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target));
    for (const k of ["bioKeywords", "highlightKeywords", "styles", "hashtags", "searchKeywords", "bioSearchPhrases"]) fd[k] = fd[k].split(",").map((s) => s.trim()).filter(Boolean);
    S.data.config = await act(() => api("PUT", "/config", fd), "Settings saved");
  });
}
function monthSpend() { const m = new Date().toISOString().slice(0, 7); return S.data.runs.filter((r) => r.at.startsWith(m)).reduce((s, r) => s + (Number(r.estCost) || 0), 0); }
