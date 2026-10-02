/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// What to Watch: pick a mood and it suggests shows from your list, in
// sections: almost done, keep watching, start something new and movie
// night. Everything comes from your AniList list in one request; the picks
// are worked out on the page, so changing the mood is instant.

function init() {
  // Seanime runs the UI handler in its own runtime, from its source text, so
  // it can't see anything declared at the top level of this file. Everything
  // it needs comes from the shared module compiled from createWhatToWatch().
  $shared.define("what-to-watch", createWhatToWatch)

  $ui.register((ctx) => {
    const W = $shared.use("what-to-watch")

    const page = ctx.newWebview({
      slot: "screen",
      fullWidth: true,
      // A screen-tall frame that scrolls itself, rather than one sized to fit
      // its content: in a frame with nothing to scroll, Chrome's middle-click
      // autoscroll gets stuck and the wheel stops working until the next click.
      height: "100vh",
      sidebar: { label: "What to Watch", icon: W.ICON },
    })

    const payload = ctx.state<any>(null)
    page.channel.sync("data", payload)
    page.setContent(() => W.PAGE_HTML)

    let loading = false
    async function load(force: boolean) {
      if (loading) return
      loading = true
      try {
        // Last time's list shows up at once; the fresh one replaces it.
        const cached = force ? null : W.cachedPayload()
        if (cached) payload.set(Object.assign(cached, { loading: !cached.fresh }))
        else payload.set(Object.assign({}, payload.get() || {}, { loading: true }))
        if (!cached || !cached.fresh) payload.set(W.load(force))
      } finally {
        loading = false
      }
    }

    page.channel.on("refresh", () => { load(true) })
    page.channel.on("open", (p: any) => {
      const id = p && Number(p.id)
      if (id) ctx.screen.navigateTo("/entry", { id: String(id) })
    })
    page.channel.on("set-prefs", (p: any) => {
      payload.set(Object.assign({}, payload.get() || {}, { prefs: W.savePrefs(p) }))
    })

    load(false)
    page.onMount(() => load(false))
  })
}

// Everything the plugin does. Self-contained: compiled from its own source
// by $shared, so it may only use globals ($anilist, $storage, ...). Keep it
// free of anything esbuild compiles into top-level helpers (tagged templates
// like String.raw, for one): those would be outside this function.
function createWhatToWatch() {
  const PREFS_KEY = "ww-prefs"
  const LIST_KEY = "ww-list-v1"
  // Your list changes as you watch.
  const LIST_TTL = 10 * 60000
  const IN_PROGRESS: { [s: string]: boolean } = { CURRENT: true, PAUSED: true, REPEATING: true }

  const ICON = `<span style="display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;color:currentColor"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="m10 8 5 3-5 3z"/><path d="M8 21h8"/></svg></span>`

  const LIST_QUERY = `query ($u: Int) {
    MediaListCollection(userId: $u, type: ANIME) {
      lists { entries {
        status progress updatedAt score(format: POINT_100)
        media {
          id format episodes duration status isAdult
          title { userPreferred }
          coverImage { large color }
          bannerImage
          genres averageScore
          studios(isMain: true) { nodes { name } }
          tags { name rank }
          nextAiringEpisode { episode }
        }
      } }
    }
  }`

  // ---------------------------------------------------------------------------
  // AniList
  // ---------------------------------------------------------------------------

  // An AniList error (rate limit, outage) throws: treating it as empty data
  // would overwrite good cached data with nothing.
  function query(token: string, q: string, variables: any): any {
    const res: any = $anilist.customQuery({ query: q, variables }, token)
    if (!res || (res.errors && !res.data)) {
      throw new Error("AniList didn't answer" + (res && res.errors ? ": " + JSON.stringify(res.errors).slice(0, 120) : ""))
    }
    // customQuery may or may not unwrap "data".
    return res.data ? res.data : res
  }

  function viewerId(token: string): number {
    const cached = $storage.get("ww-viewer")
    if (cached) return cached
    const d = query(token, "query { Viewer { id } }", {})
    const id = d && d.Viewer && d.Viewer.id
    if (!id) throw new Error("could not get the AniList user")
    $storage.set("ww-viewer", id)
    return id
  }

  // ---------------------------------------------------------------------------
  // Taste (as in Season Guide and Backlog)
  // ---------------------------------------------------------------------------

  // How much you like each genre, studio and tag: scored shows count by how
  // far their score is from your average, unscored ones by their status
  // (dropped counts against). Pulled towards zero for features you've seen
  // only a couple of times.
  function tasteOf(raw: any[]): { [f: string]: number } {
    const scores = raw.filter((e) => e.score > 0).map((e) => e.score)
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 70
    const sd = scores.length > 1
      ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length)
      : 10
    const byStatus: { [s: string]: number } = { COMPLETED: 0.4, REPEATING: 0.6, CURRENT: 0.25, PAUSED: 0, DROPPED: -1, PLANNING: 0.15 }
    const sum: { [f: string]: number } = {}
    const weight: { [f: string]: number } = {}
    for (const e of raw) {
      const w = e.score > 0
        ? Math.max(-2, Math.min(2, (e.score - mean) / Math.max(sd, 5)))
        : (byStatus[e.status] || 0)
      const add = (f: string, fw: number) => {
        sum[f] = (sum[f] || 0) + w * fw
        weight[f] = (weight[f] || 0) + fw
      }
      for (const g of (e.media.genres || [])) add("g:" + g, 1)
      for (const s of ((e.media.studios && e.media.studios.nodes) || [])) add("s:" + s.name, 0.8)
      for (const t of (e.media.tags || [])) if (t && t.rank >= 60) add("t:" + t.name, (t.rank / 100) * 0.6)
    }
    const affinity: { [f: string]: number } = {}
    for (const f in sum) affinity[f] = sum[f] / (weight[f] + 2)
    return affinity
  }

  // 0-100: how well a show's genres, studio and tags fit your taste, and
  // which of them pushed it up and down the most.
  function matchOf(genres: string[], studios: string[], tags: string[], affinity: { [f: string]: number }): any {
    let total = 0
    let weights = 0
    const parts: { name: string, v: number }[] = []
    const add = (f: string, name: string, fw: number) => {
      const a = affinity[f] || 0
      total += a * fw
      weights += fw
      if (Math.abs(a) >= 0.08) parts.push({ name, v: a * fw })
    }
    for (const g of genres) add("g:" + g, g, 1)
    for (const s of studios) add("s:" + s, s, 0.8)
    for (const t of tags) add("t:" + t, t, 0.5)
    // The extra weight pulls shows we know little about towards 50%.
    const raw = total / (weights + 1.5)
    return {
      match: Math.round(100 / (1 + Math.exp(-raw * 7))),
      why: {
        p: parts.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4).map((x) => x.name),
        n: parts.filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.name),
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Candidates
  // ---------------------------------------------------------------------------

  // Shows in progress with episodes left to watch, and planned shows that
  // have started airing.
  function candidatesOf(raw: any[], affinity: { [f: string]: number }): any[] {
    const out: any[] = []
    for (const e of raw) {
      const m = e.media
      if (!m || m.isAdult) continue
      const planned = e.status === "PLANNING"
      if (!planned && !IN_PROGRESS[e.status]) continue
      if (m.status === "NOT_YET_RELEASED" || m.status === "CANCELLED") continue
      const next = m.nextAiringEpisode && m.nextAiringEpisode.episode
      const aired = next ? next - 1 : (m.episodes || 0)
      const progress = planned ? 0 : (e.progress || 0)
      if (aired <= progress) continue
      const tags: string[] = []
      for (const t of (m.tags || [])) if (t && t.rank >= 60 && tags.length < 8) tags.push(t.name)
      const studios = ((m.studios && m.studios.nodes) || []).map((s: any) => s.name)
      const taste = matchOf(m.genres || [], studios, tags, affinity)
      out.push({
        id: m.id,
        title: (m.title && m.title.userPreferred) || "?",
        cover: (m.coverImage && m.coverImage.large) || "",
        banner: m.bannerImage || "",
        color: (m.coverImage && m.coverImage.color) || "",
        format: m.format || "",
        episodes: m.episodes || 0,
        aired,
        progress,
        duration: m.duration || 24,
        airing: m.status === "RELEASING",
        listStatus: e.status,
        updatedAt: e.updatedAt || 0,
        genres: m.genres || [],
        tags,
        score: m.averageScore || 0,
        match: taste.match,
        why: taste.why,
      })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  function cleanPrefs(p: any): any {
    p = p || {}
    const moods = ["any", "light", "action", "feels", "mind", "dark"]
    return { mood: moods.indexOf(p.mood) >= 0 ? p.mood : "any" }
  }

  function readPrefs(): any {
    try { return cleanPrefs($storage.get(PREFS_KEY)) } catch (e) { return cleanPrefs(null) }
  }

  function savePrefs(p: any): any {
    const prefs = cleanPrefs(Object.assign({}, readPrefs(), p || {}))
    $storage.set(PREFS_KEY, prefs)
    return prefs
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  function load(force: boolean): any {
    const prefs = readPrefs()
    try {
      const token = $database.anilist.getToken()
      if (!token) return { error: "Not logged in to AniList: log in in Seanime.", prefs }
      const d = query(token, LIST_QUERY, { u: viewerId(token) })
      if (!d || !d.MediaListCollection) throw new Error("AniList returned no list")
      const raw: any[] = []
      for (const l of (d.MediaListCollection.lists || [])) for (const e of (l.entries || [])) if (e && e.media) raw.push(e)
      const items = candidatesOf(raw, tasteOf(raw))
      $storage.set(LIST_KEY, { at: Date.now(), items })
      return { items, prefs, updatedAt: Date.now() }
    } catch (e) {
      console.error("What to Watch: " + e)
      const stale = cachedPayload()
      if (stale) return Object.assign(stale, { loading: false, warning: "Couldn't refresh: " + e })
      return { error: "Couldn't load your list: " + e, prefs }
    }
  }

  // What the page shows, from the cached list (any age); null before the
  // first load. `fresh` says whether it still needs a refresh.
  function cachedPayload(): any {
    const cached = $storage.get(LIST_KEY)
    if (!cached || !Array.isArray(cached.items)) return null
    return { items: cached.items, prefs: readPrefs(), updatedAt: cached.at, fresh: Date.now() - cached.at < LIST_TTL }
  }

  // ---------------------------------------------------------------------------
  // Page (runs inside the webview iframe). A plain template literal: no
  // backslashes and no interpolation inside, so nothing to escape.
  // ---------------------------------------------------------------------------

  const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: #0b0b0d; --paper: #131317; --paper2: #1a1a20; --line: #26262e;
    --text: #ececf1; --muted: #8a8a96; --brand: #7c6cf2; --on-brand: #fff;
    --yellow: #e6b422; --green: #3fbf6a; --blue: #5b8def; --red: #ff8a8a;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); color-scheme: dark; scrollbar-width: thin; scrollbar-color: #3a3a46 transparent; }
  html, body { margin: 0; color: var(--text); font: 14px/1.4 Inter, "Segoe UI", system-ui, sans-serif; }
  body { position: relative; overflow-x: hidden; }
  .hero { position: absolute; top: 0; left: 0; right: 0; height: 440px; pointer-events: none;
    background-size: cover; background-position: center 30%; opacity: .5;
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%); }
  .hero.cover { filter: blur(28px) saturate(1.4); transform: scale(1.15); opacity: .6; }
  .wrap { position: relative; padding: 8px 4px 32px; max-width: 1600px; margin: 0 auto; }
  h1 { margin: 0; font-weight: 700; letter-spacing: -.01em; }
  h2 { font-size: 17px; margin: 0; font-weight: 650; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button { font: inherit; color: var(--text); background: var(--paper2); border: 1px solid var(--line);
    border-radius: 10px; padding: 7px 13px; cursor: pointer; }
  button:hover { border-color: #3a3a46; background: #202028; }
  .seg { display: inline-flex; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; flex-wrap: wrap; }
  .seg button { border: 0; background: transparent; padding: 6px 13px; border-radius: 8px; color: var(--muted); }
  .seg button.on { background: var(--brand); color: var(--on-brand); font-weight: 600; }
  section { background: rgba(19,19,23,.86); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin-top: 16px; }
  .head { min-height: 150px; align-items: flex-end; padding-bottom: 6px; }
  .head h1 { font-size: 34px; text-shadow: 0 2px 12px rgba(0,0,0,.6); }
  .head .sub { font-size: 13px; color: #d4d4dc; text-shadow: 0 1px 6px rgba(0,0,0,.8); margin-top: 2px; }
  .label { width: 110px; flex: none; color: var(--muted); font-size: 13px; }
  .controls .row + .row { margin-top: 10px; }

  /* Picks */
  .picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
  .pick { background: var(--paper2); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; cursor: pointer;
    display: flex; flex-direction: column; }
  .pick:hover { border-color: var(--brand); }
  .pick .art { height: 130px; background-size: cover; background-position: center 30%; position: relative; }
  .pick .art::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 30%, var(--paper2)); }
  .pick .art.cover { filter: saturate(1.1); background-position: center 20%; }
  .pick .body { display: flex; gap: 14px; padding: 0 14px 14px; margin-top: -54px; position: relative; z-index: 1; flex: 1; }
  .pick img { width: 96px; height: 138px; object-fit: cover; border-radius: 9px; flex: none; box-shadow: 0 6px 18px rgba(0,0,0,.5); background: #222; }
  .pick .info { display: flex; flex-direction: column; gap: 5px; min-width: 0; padding-top: 58px; flex: 1; }
  .t { font-weight: 650; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .pick .t { font-size: 16px; }
  .plan { font-size: 13px; }
  .plan b { font-weight: 650; }
  .meta { font-size: 12px; color: var(--muted); }
  .pills { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: auto; padding-top: 4px; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: #23232b; color: #c4c4cc; }
  .pill.match { background: color-mix(in srgb, var(--brand) 22%, transparent); color: var(--text); cursor: help; }
  .score { font-size: 12px; font-weight: 650; }
  .open { margin-left: auto; padding: 4px 12px; font-size: 13px; border-radius: 8px; background: var(--brand); color: var(--on-brand); border: 0; font-weight: 600; }
  .open:hover { background: var(--brand); filter: brightness(1.1); }
  .sec-head { margin-bottom: 12px; }
  .sec-head h2 .dot { display: inline-block; width: 10px; height: 10px; border-radius: 99px; margin-right: 8px; }


  #tip { position: absolute; display: none; z-index: 50; max-width: 320px; pointer-events: none;
    background: #1f1f27; border: 1px solid #34343f; border-radius: 10px; padding: 10px 12px; font-size: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  #tip b { font-size: 13px; display: block; margin-bottom: 6px; }
  #tip div { margin-top: 3px; }
  .tip-row { display: flex; gap: 8px; }
  .tip-label { flex: none; width: 96px; color: var(--muted); }
  .tip-label.good { color: var(--green); }
  .tip-label.bad { color: var(--red); }
  .tip-foot { color: var(--muted); font-size: 11px; margin-top: 8px !important; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .error { color: var(--red); }
  .note { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="hero" id="hero"></div>
<div class="wrap" id="root"><div class="empty">Loading your list…</div></div>
<div id="tip"></div>
<script>
var DATA = null;
var PREFS = { mood: "any" };
// Where each section's "Other picks" has got to.
var OFFSET = {};
var PER_SECTION = 4;
var MOODS = [["any", "Anything"], ["light", "Light & fun"], ["action", "Action"], ["feels", "Feels"], ["mind", "Mind-bending"], ["dark", "Dark"]];
// What each mood looks for in genres and tags, and what goes against it.
var MOOD_RULES = {
  light: { g: ["Comedy", "Slice of Life", "Romance", "Sports", "Music"], t: ["Iyashikei", "Cute Girls Doing Cute Things", "School Club", "Parody"], avoid: ["Horror", "Psychological", "Thriller", "Tragedy", "Gore"] },
  action: { g: ["Action", "Adventure", "Mecha", "Sports"], t: ["Super Power", "Martial Arts", "Battle Royale", "Swordplay"], avoid: ["Slice of Life", "Iyashikei"] },
  feels: { g: ["Drama", "Romance"], t: ["Tragedy", "Coming of Age", "Found Family", "Love Triangle"], avoid: ["Ecchi", "Parody"] },
  mind: { g: ["Mystery", "Psychological", "Thriller", "Sci-Fi"], t: ["Time Manipulation", "Philosophy", "Detective", "Conspiracy", "Survival"], avoid: ["Ecchi", "Iyashikei"] },
  dark: { g: ["Horror", "Thriller", "Psychological"], t: ["Gore", "Tragedy", "Survival", "Death Game"], avoid: ["Comedy", "Slice of Life", "Iyashikei"] }
};
var SECTIONS = [
  ["finish", "Almost done", "A few episodes left: finish them off.", "var(--green)"],
  ["keep", "Keep watching", "Pick up where you left off.", "var(--yellow)"],
  ["new", "Start something new", "From your Planning list.", "var(--blue)"],
  ["movie", "Movie night", "Films from your Planning list.", "#c77dff"]
];
var FORMAT_NAME = { TV: "TV", TV_SHORT: "TV Short", ONA: "ONA", MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special", MUSIC: "Music" };

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function send(ev, p) { window.webview.send(ev, p || {}); }
function find(id) {
  var items = (DATA && DATA.items) || [];
  for (var k = 0; k < items.length; k++) if (items[k].id === id) return items[k];
  return null;
}
function hexToRgb(h) {
  if (!h || h.charAt(0) !== "#" || h.length !== 7) return null;
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
// Banner and accent colour of the first pick on the page.
function applyTheme(top) {
  var hero = document.getElementById("hero");
  var img = top && (top.banner || top.cover);
  hero.style.backgroundImage = img ? 'url("' + String(img).replace(/"/g, "%22") + '")' : "none";
  hero.className = "hero" + (top && !top.banner ? " cover" : "");
  var css = document.documentElement.style;
  var rgb = top && hexToRgb(top.color);
  var brand = "#7c6cf2", onBrand = "#fff";
  if (rgb) {
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    var spread = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    if (lum > 0.22 && lum < 0.85 && spread > 40) { brand = top.color; onBrand = lum > 0.6 ? "#111" : "#fff"; }
  }
  css.setProperty("--brand", brand);
  css.setProperty("--on-brand", onBrand);
}
// "45 min", "1 h 30 min"; longer stretches rounded to the hour. No-break
// spaces keep a number and its unit on one line.
function minutesText(min) {
  if (min < 60) return min + " min";
  if (min >= 180) return "~" + Math.round(min / 60) + " h";
  var h = Math.floor(min / 60), m = min % 60;
  return h + " h" + (m ? " " + m + " min" : "");
}
function ago(sec) {
  if (!sec) return "";
  var days = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return days + " days ago";
  if (days < 365) { var m = Math.round(days / 30); return m + (m === 1 ? " month ago" : " months ago"); }
  var y = Math.round(days / 365); return y + (y === 1 ? " year ago" : " years ago");
}

// ---------- picking ----------
// 0-1: how well a show fits the mood. Two matching genres is a full fit,
// a matching tag counts half, and every opposing genre or tag takes half off.
function moodFit(i, mood) {
  var r = MOOD_RULES[mood];
  if (!r) return 1;
  var hits = 0, against = 0;
  i.genres.forEach(function (g) { if (r.g.indexOf(g) >= 0) hits += 1; if (r.avoid.indexOf(g) >= 0) against += 1; });
  i.tags.forEach(function (t) { if (r.t.indexOf(t) >= 0) hits += 0.5; if (r.avoid.indexOf(t) >= 0) against += 1; });
  return Math.max(0, Math.min(1, hits / 2) - 0.5 * against);
}
function leftOf(i) { return i.aired - i.progress; }
// Almost done: a finished show with at most 3 episodes left, or up to 6
// if that's the last quarter of it.
function sectionOf(i) {
  if (i.listStatus === "PLANNING") return i.format === "MOVIE" ? "movie" : "new";
  var left = leftOf(i);
  if (!i.airing && (left <= 3 || (i.episodes && left <= 6 && left / i.episodes <= 0.25))) return "finish";
  return "keep";
}
// Score 0-1: mood 35%, AniList score 30%, your taste 30%, and 5% for having
// watched it recently (easier to pick up while you still remember it).
// Almost done also favours the shows closest to the end.
function rate(i, section, mood) {
  var q = i.score ? Math.max(0, Math.min(1, (i.score - 60) / 25)) : 0.35;
  var days = i.updatedAt ? (Date.now() / 1000 - i.updatedAt) / 86400 : 9999;
  var fresh = section === "new" || section === "movie" ? 0.5 : days < 14 ? 1 : days < 90 ? 0.6 : 0.3;
  var v = 0.35 * moodFit(i, mood) + 0.3 * q + 0.3 * (i.match / 100) + 0.05 * fresh;
  if (section === "finish") v += 0.1 * (1 - Math.min(leftOf(i), 6) / 7);
  return v;
}
// Every show that fits the mood, by section, best first.
function bySection() {
  var out = { finish: [], keep: [], new: [], movie: [] };
  (DATA.items || []).forEach(function (i) {
    if (PREFS.mood !== "any" && moodFit(i, PREFS.mood) <= 0) return;
    var s = sectionOf(i);
    out[s].push({ i: i, value: rate(i, s, PREFS.mood) });
  });
  for (var s in out) out[s].sort(function (a, b) { return b.value - a.value; });
  return out;
}

// ---------- match tooltip ----------
function tipRow(label, c, text) { return '<div class="tip-row"><span class="tip-label ' + c + '">' + label + '</span><span>' + text + '</span></div>'; }
function showTip(el) {
  var i = find(Number(el.getAttribute("data-id")));
  if (!i) return;
  var w = i.why || { p: [], n: [] };
  var html = '<b>' + i.match + '% match</b>';
  if (w.p.length) html += tipRow("You like", "good", esc(w.p.join(", ")));
  if (w.n.length) html += tipRow("Not your thing", "bad", esc(w.n.join(", ")));
  if (!w.p.length && !w.n.length) html += '<div class="muted">Not enough in common with your list to tell — neutral.</div>';
  html += '<div class="tip-foot">From genres, studios and tags of what you scored and watched on AniList.</div>';
  var tip = document.getElementById("tip");
  tip.innerHTML = html;
  tip.style.display = "block";
  var r = el.getBoundingClientRect();
  var left = Math.min(r.left + window.scrollX, document.documentElement.clientWidth - tip.offsetWidth - 8);
  var top = r.top + window.scrollY - tip.offsetHeight - 8;
  if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = top + "px";
}
function hideTip() { var tip = document.getElementById("tip"); if (tip) tip.style.display = "none"; }
document.addEventListener("mouseover", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-tip]") : null;
  if (el) showTip(el); else hideTip();
});
document.addEventListener("scroll", hideTip, true);

// ---------- rendering ----------
// What's ahead: what's left to watch and how long it takes.
function planText(i, section) {
  var left = leftOf(i), d = i.duration;
  if (section === "finish") return left === 1 ? "<b>Last episode</b> · " + minutesText(d) : "<b>" + left + " episodes left</b> · " + minutesText(left * d);
  if (section === "keep") return "<b>Next: ep " + (i.progress + 1) + "</b>" + (i.episodes ? ' <span class="muted">of ' + i.episodes + "</span>" : "") +
    " · " + (i.airing ? left + " out now" : left + " left, " + minutesText(left * d));
  if (section === "movie") return "<b>Movie</b> · " + minutesText(d);
  var n = i.airing ? i.aired : i.episodes;
  return "<b>" + esc(FORMAT_NAME[i.format] || i.format) + "</b>" + (n ? " · " + n + (n === 1 ? " ep" : " eps") + (i.airing ? " out" : "") + ", " + minutesText(n * d) : "");
}
function whyText(i, section) {
  if (section === "finish" || section === "keep") return "You stopped at ep " + i.progress + (i.updatedAt ? ", " + ago(i.updatedAt) : "") + ".";
  return i.airing ? "Airing now." : "";
}
function pickCard(x, section) {
  var i = x.i;
  var art = i.banner || i.cover;
  var why = whyText(i, section);
  return '<div class="pick" data-open="' + i.id + '"><div class="art' + (i.banner ? "" : " cover") + '" style="background-image:url(&quot;' + esc(art) + '&quot;)"></div>' +
    '<div class="body"><img src="' + esc(i.cover) + '" loading="lazy"><div class="info">' +
    '<div class="t">' + esc(i.title) + '</div>' +
    '<div class="plan">' + planText(i, section) + '</div>' +
    (why ? '<div class="meta">' + esc(why) + '</div>' : '') +
    '<div class="pills"><span class="score">' + (i.score ? "★ " + (i.score / 10).toFixed(1) : "★ —") + '</span>' +
    '<span class="pill match" data-tip="match" data-id="' + i.id + '">' + i.match + '% match</span>' +
    i.genres.slice(0, 2).map(function (g) { return '<span class="pill">' + esc(g) + '</span>'; }).join("") +
    '<button class="open" data-open="' + i.id + '">Open</button></div>' +
    '</div></div></div>';
}
// The shows a section shows now: PER_SECTION from where "Other picks" got to.
function shownOf(list, key) {
  if (list.length <= PER_SECTION) return list;
  var at = (OFFSET[key] || 0) % list.length;
  var out = list.slice(at, at + PER_SECTION);
  if (out.length < PER_SECTION) out = out.concat(list.slice(0, PER_SECTION - out.length));
  return out;
}
function render() {
  var root = document.getElementById("root");
  if (!DATA) { root.innerHTML = '<div class="empty">Loading your list…</div>'; return; }
  var items = DATA.items || [];
  var inProgress = items.filter(function (i) { return i.listStatus !== "PLANNING"; }).length;
  var sub = DATA.items ? inProgress + " in progress · " + (items.length - inProgress) + " planned" : "";
  var head = '<div class="row head"><div><h1>What to Watch</h1><div class="sub">' + esc(sub) +
    (DATA.loading ? (sub ? " · " : "") + "loading…" : "") +
    (DATA.warning ? ' · <span class="error">' + esc(DATA.warning) + '</span>' : '') + '</div></div><span class="spacer"></span>' +
    '<button data-act="refresh" title="Fetch your list again from AniList">Refresh</button></div>';
  var controls = '<section class="controls"><div class="row"><span class="label">In the mood for</span><span class="seg">' + MOODS.map(function (o) {
    return '<button data-act="mood" data-v="' + o[0] + '" class="' + (PREFS.mood === o[0] ? "on" : "") + '">' + o[1] + '</button>';
  }).join("") + '</span></div></section>';
  if (DATA.error) { applyTheme(null); root.innerHTML = head + '<section><div class="empty error">' + esc(DATA.error) + '</div></section>'; return; }
  if (!DATA.items) { applyTheme(null); root.innerHTML = head + controls + '<section><div class="empty">Loading your list…</div></section>'; return; }

  var lists = bySection();
  var top = null;
  var body = SECTIONS.map(function (s) {
    var list = lists[s[0]];
    if (!list.length) return "";
    var shown = shownOf(list, s[0]);
    if (!top) top = shown[0].i;
    return '<section><div class="row sec-head"><h2><span class="dot" style="background:' + s[3] + '"></span>' + s[1] +
      ' <span class="muted">· ' + list.length + '</span></h2><span class="note">' + s[2] + '</span><span class="spacer"></span>' +
      (list.length > PER_SECTION ? '<button data-act="other" data-v="' + s[0] + '">Other picks</button>' : '') + '</div>' +
      '<div class="picks">' + shown.map(function (x) { return pickCard(x, s[0]); }).join("") + '</div></section>';
  }).join("");
  applyTheme(top);
  if (!body) body = '<section><div class="empty">Nothing in your list fits this mood. Try another one.</div></section>';
  root.innerHTML = head + controls + body;
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act],[data-open]") : null;
  if (!el || !DATA) return;
  var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
  var open = el.getAttribute("data-open");
  if (open) { send("open", { id: Number(open) }); return; }
  if (act === "mood") { PREFS.mood = v; OFFSET = {}; send("set-prefs", { mood: v }); render(); }
  else if (act === "other") { OFFSET[v] = (OFFSET[v] || 0) + PER_SECTION; render(); }
  else if (act === "refresh") { DATA.loading = true; render(); send("refresh"); }
});

window.webview.on("data", function (d) {
  DATA = d;
  if (d && d.prefs) PREFS = d.prefs;
  render();
});
render();
</script>
</body>
</html>`

  return { ICON, PAGE_HTML, load, cachedPayload, savePrefs }
}
