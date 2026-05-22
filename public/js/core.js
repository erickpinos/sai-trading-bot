/**
 * Dashboard core — the only file every component depends on.
 *
 * Provides:
 *   - state polling (GET /api/state every 5s) + market polling (every 60s)
 *   - a tiny pub/sub so components can react to state/market updates without
 *     coupling to each other
 *   - shared utilities: fmt, escapeHtml, auth(), setCode/setCodeAction/wireCopy
 *   - theme management (light/dark with view-transitions)
 *   - cached webhook secret in sessionStorage
 *
 * Components MUST NOT poll the server directly for state — they subscribe via
 * `onState` and let core handle the request lifecycle. Components MAY call API
 * endpoints (kill, dry-run, tunnel, etc.) through `auth()` and then call
 * `refreshState()` to pull the latest snapshot.
 */

// ---------- formatting ----------

export const fmt = {
  time: (ts) => {
    if (!ts) return "—"
    const d = new Date(ts)
    const p = (n) => String(n).padStart(2, "0")
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
  },
  addr: (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"),
  num: (n, d = 4) => (typeof n === "number" ? n.toFixed(d) : "—"),
  rel: (ts) => {
    if (!ts) return "never"
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return s + "s ago"
    if (s < 3600) return Math.floor(s / 60) + "m ago"
    if (s < 86400) return Math.floor(s / 3600) + "h ago"
    return Math.floor(s / 86400) + "d ago"
  },
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]),
  )
}

// ---------- secret + auth ----------

const SECRET_KEY = "saitb_secret_v1"
export function getSecret() { return sessionStorage.getItem(SECRET_KEY) || "" }
export function setSecret(s) { sessionStorage.setItem(SECRET_KEY, s) }
export function forgetSecret() { sessionStorage.removeItem(SECRET_KEY) }

export function ensureSecret() {
  let s = getSecret()
  if (s) return s
  s = prompt("Enter your WEBHOOK_SECRET (cached for this tab only):")
  if (!s) return null
  setSecret(s)
  return s
}

export async function auth(path, body) {
  const s = ensureSecret()
  if (!s) return { error: "no_secret" }
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-secret": s },
    body: JSON.stringify(body || {}),
  })
  const json = await r.json().catch(() => ({}))
  if (r.status === 403) {
    forgetSecret()
    alert("Bad secret — please re-enter.")
  }
  return { ok: r.ok, status: r.status, json }
}

// ---------- theme ----------

const THEME_KEY = "saitb_theme_v1"
function applyTheme(theme) { document.documentElement.dataset.theme = theme }
applyTheme(localStorage.getItem(THEME_KEY) || "dark")

export function toggleTheme() {
  const cur = document.documentElement.dataset.theme || "dark"
  const next = cur === "dark" ? "light" : "dark"
  const swap = () => {
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
  }
  if (document.startViewTransition) document.startViewTransition(swap)
  else swap()
}

// ---------- pub/sub ----------

let state = null
let markets = []
const stateListeners = []
const marketListeners = []

export function getState() { return state }
export function getMarkets() { return markets }

export function onState(fn) {
  stateListeners.push(fn)
  if (state) {
    try { fn(state) } catch (e) { console.error("[onState init]", e) }
  }
}

export function onMarkets(fn) {
  marketListeners.push(fn)
  if (markets.length) {
    try { fn(markets) } catch (e) { console.error("[onMarkets init]", e) }
  }
}

function publishState(s) {
  state = s
  for (const fn of stateListeners) {
    try { fn(s) } catch (e) { console.error("[state listener]", e) }
  }
}

function publishMarkets(ms) {
  markets = ms
  for (const fn of marketListeners) {
    try { fn(ms) } catch (e) { console.error("[markets listener]", e) }
  }
}

// ---------- polling ----------

export async function refreshState() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" })
    if (!r.ok) throw new Error("HTTP " + r.status)
    const s = await r.json()
    publishState(s)
    const f = document.getElementById("footer")
    if (f) f.textContent = "updated " + fmt.time(Date.now()) + " · polling every 5s"
  } catch (e) {
    const f = document.getElementById("footer")
    if (f) f.textContent = "fetch error: " + e.message
  }
}

export async function refreshMarkets() {
  try {
    const r = await fetch("/api/markets", { cache: "no-store" })
    const j = await r.json()
    publishMarkets(j.markets || [])
  } catch {
    publishMarkets([])
  }
}

// ---------- copy-able code blocks ----------

export function setCode(id, text) {
  const el = typeof id === "string" ? document.getElementById(id) : id
  if (!el) return
  el.innerHTML = ""
  el.appendChild(document.createTextNode(text))
  wireCopy(el, text)
}

export function setCodeAction(id, label, onClick, opts = {}) {
  const el = typeof id === "string" ? document.getElementById(id) : id
  if (!el) return
  el.innerHTML = ""
  el.appendChild(document.createTextNode(opts.text != null ? opts.text : " "))
  const btn = document.createElement("button")
  btn.className = "copy-btn"
  btn.textContent = label
  if (opts.disabled) btn.disabled = true
  if (onClick) btn.addEventListener("click", onClick)
  el.appendChild(btn)
}

export function wireCopy(el, text) {
  const btn = document.createElement("button")
  btn.className = "copy-btn"
  btn.textContent = "copy"
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text)
      btn.textContent = "copied"
      btn.classList.add("ok")
      setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("ok") }, 1200)
    } catch {
      btn.textContent = "fail"
    }
  })
  el.appendChild(btn)
}

// ---------- HTML include loader ----------
// The shell uses <div data-include="/components/foo/foo.html"></div>
// placeholders. We fetch each one and inline the markup so component JS can
// run normal querySelector against it.

async function loadIncludes() {
  const nodes = document.querySelectorAll("[data-include]")
  await Promise.all(
    [...nodes].map(async (host) => {
      const url = host.getAttribute("data-include")
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error("HTTP " + r.status)
        host.innerHTML = await r.text()
      } catch (e) {
        host.innerHTML = `<div class="warn">failed to load ${url}: ${e.message}</div>`
      }
    }),
  )
}

// ---------- collapsible panels ----------
// Any <section class="panel" data-collapsible id="..."> gets a chevron toggle
// prepended to its .panel-head and a persisted collapse state.

const COLLAPSE_KEY_PREFIX = "saitb_collapsed_"

function wireCollapsibles(root = document) {
  const panels = root.querySelectorAll(".panel[data-collapsible]")
  for (const panel of panels) {
    if (panel.dataset.collapseWired) continue
    panel.dataset.collapseWired = "1"
    const head = panel.querySelector(".panel-head")
    if (!head) continue

    // Restore persisted state.
    const id = panel.id || ""
    const key = COLLAPSE_KEY_PREFIX + id
    if (id && localStorage.getItem(key) === "1") panel.classList.add("collapsed")

    // Prepend chevron button.
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "collapse-toggle"
    btn.setAttribute("aria-label", "toggle section")
    btn.innerHTML = '<span class="chev"></span>'
    head.insertBefore(btn, head.firstChild)

    // Toggle on click anywhere on the head (button or whitespace).
    head.addEventListener("click", (e) => {
      // Don't collapse when the user clicks an interactive element inside the head.
      if (e.target.closest("select, input, textarea")) return
      if (e.target.closest("button") && e.target.closest("button") !== btn) return
      panel.classList.toggle("collapsed")
      if (id) {
        localStorage.setItem(key, panel.classList.contains("collapsed") ? "1" : "0")
      }
    })
  }
}

// ---------- header wiring ----------

function wireHeader() {
  const themeBtn = document.getElementById("themeBtn")
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme)
}

function renderHeader(s) {
  const dot = document.getElementById("modeDot")
  if (!dot) return
  dot.classList.remove("live", "dry", "killed")
  const mode = s.killSwitch ? "killed" : s.dryRun ? "dry" : "live"
  dot.classList.add(mode)
  const modeLabel = s.killSwitch ? "KILLED" : s.dryRun ? "DRY-RUN" : "LIVE"
  const metaEl = document.getElementById("meta")
  if (metaEl) {
    metaEl.innerHTML =
      "<b>" + s.chain + "</b> · " + modeLabel + " · wallet <b>" + fmt.addr(s.wallet) + "</b>"
  }
}

// ---------- boot ----------

const COMPONENT_MODULES = [
  "/components/strategy-engine/strategy-engine.js",
  "/components/alert-builder/alert-builder.js",
  "/components/pipeline-state/pipeline-state.js",
  "/components/controls/controls.js",
  "/components/activity-log/activity-log.js",
  "/components/balance/balance.js",
  "/components/positions/positions.js",
  "/components/tx-history/tx-history.js",
]

async function boot() {
  await loadIncludes()
  wireHeader()
  wireCollapsibles()
  onState(renderHeader)

  // Load each component after its markup is mounted. Use dynamic import so a
  // broken component doesn't take the whole dashboard down.
  await Promise.all(
    COMPONENT_MODULES.map(async (path) => {
      try {
        const mod = await import(path)
        if (mod.init) await mod.init()
      } catch (e) {
        console.error(`[component ${path}]`, e)
      }
    }),
  )

  refreshState()
  refreshMarkets()
  setInterval(refreshState, 5000)
  setInterval(refreshMarkets, 60000)
}

boot()
