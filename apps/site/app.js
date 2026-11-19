// WIRECOPY Front-Page Teletype, Live Step Streamer, Morgue, Graph, Copy Chief & Merkle Proof Verifier
export const SITE_CONFIG = {
  apiBase: "",
  tokenCa: "",
  tapeRegistry: "",
  xUrl: "https://x.com/wirecopyapp",
};

const state = {
  view: "wire",
  selectedDesk: "",
  missionFilter: "all",
  missions: [],
  activeMissionId: null,
  activeSteps: [],
  pollTimer: null,
  wallet: localStorage.getItem("wirecopy_readonly_wallet") || "",
  chatHistory: [],
  seals: [],
  activeLeaf: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function ago(ts) {
  if (!ts) return "now";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.wallet) headers["x-wallet-address"] = state.wallet;
  if (opts.body && typeof opts.body === "object") {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${SITE_CONFIG.apiBase}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ==================== NAVIGATION ====================
function setView(view) {
  state.view = view;
  document.querySelectorAll(".keycap").forEach((b) => b.classList.toggle("active", b.dataset.nav === view));
  document.querySelectorAll(".section-view").forEach((s) => s.classList.toggle("active", s.id === `view-${view}`));
  if (view === "morgue") loadMorgue();
  if (view === "graph") loadGraph();
  if (view === "seals") loadSeals();
}

document.querySelectorAll("[data-nav]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const v = el.dataset.nav;
    history.replaceState(null, "", `#${v}`);
    setView(v);
  });
});

// ==================== STATS, CA & TICKER TAPE ====================
async function refreshStats() {
  try {
    const s = await api("/v1/stats");
    $("statDispatches").textContent = s.missions ?? 0;
    $("statWired").textContent = s.verified ?? 0;
    $("statMatchRate").textContent = `${s.match_rate_pct ?? 100}%`;
    $("statSeals").textContent = s.seals ?? 0;
    $("navMorgueCount").textContent = s.findings ?? 0;
    $("aiEngineLabel").textContent = s.ai_live
      ? `AI WIRE LIVE (${s.model}) · CHAIN 4663`
      : "WIRE DESK LIVE · CHAIN 4663";

    const ca = s.token || SITE_CONFIG.tokenCa;
    if (ca) {
      SITE_CONFIG.tokenCa = ca;
      $("caDisplay").textContent = `$WIRECOPY: ${ca.slice(0, 6)}…${ca.slice(-4)}`;
    }
    if (s.registry) {
      SITE_CONFIG.tapeRegistry = s.registry;
      $("sealRegistryAddrDisplay").textContent = `Registry: ${s.registry}`;
    }
    if (s.caller) {
      $("callerTierBadge").textContent = (s.caller.label || "Public Reader").toUpperCase();
      const left = Math.max(0, (s.caller.limits?.ask || 3) - (s.caller.used?.ask || 0));
      $("quotaReadout").textContent = `${(s.caller.label || "Public").toUpperCase()} · ${left}/${s.caller.limits?.ask || 3} DISPATCHES LEFT TODAY`;
    }
  } catch (e) {
    console.warn("stats refresh failed:", e);
  }
}

async function refreshRightRailAndRibbon() {
  try {
    const [wired, spiked] = await Promise.all([
      api("/v1/memory?status=verified&limit=6"),
      api("/v1/memory?status=unverified&limit=4"),
    ]);

    const wList = wired.findings || [];
    if (wList.length) {
      $("latestWiredStack").innerHTML = wList
        .slice(0, 5)
        .map(
          (f) => `<div class="clip-card">
            <div class="clip-claim">${esc(f.claim)}</div>
            <div class="clip-foot">
              <span>#${f.mission} · [${esc(f.desk_code)}]</span>
              <span>${(f.entities || [])
                .slice(0, 3)
                .map((ent) => `<button type="button" class="ent-tag" data-ent="${esc(ent)}">${esc(ent)}</button>`)
                .join(" ")}</span>
            </div>
          </div>`
        )
        .join("");

      // Populate top yellow moving ticker ribbon with real verified findings!
      const itemsHtml = wList
        .map(
          (f) =>
            `<button type="button" class="ticker-item-btn" data-open-mission="${f.mission}">● [${esc(f.desk_code)} #${f.mission}] ${esc(f.claim)}</button>`
        )
        .join("");
      $("tickerTrack").innerHTML = itemsHtml + itemsHtml;
    }

    const sList = spiked.findings || [];
    if (sList.length) {
      $("latestSpikedStack").innerHTML = sList
        .map(
          (f) => `<div class="clip-card spiked-clip">
            <div class="clip-claim">${esc(f.claim)}</div>
            <div class="clip-foot">
              <span>SPIKED IN #${f.mission}</span>
              <code>Quote missing: ${esc(String(f.evidence || "").slice(0, 28))}</code>
            </div>
          </div>`
        )
        .join("");
    }
  } catch {}
}

document.addEventListener("click", (e) => {
  const entBtn = e.target.closest("[data-ent]");
  if (entBtn) {
    $("morgueSearchInput").value = entBtn.dataset.ent;
    setView("morgue");
    return;
  }
  const mBtn = e.target.closest("[data-open-mission]");
  if (mBtn) {
    setView("wire");
    selectMission(Number(mBtn.dataset.openMission));
  }
});

// ==================== LIVE DISPATCH LIST & TRACTOR-FEED STREAM ====================
async function refreshMissions(autoSelectFirst = false) {
  try {
    const r = await api("/v1/missions?limit=35");
    state.missions = r.missions || [];
    renderMissionList();
    if (autoSelectFirst && !state.activeMissionId && state.missions.length) {
      selectMission(state.missions[0].id);
    }
  } catch (e) {
    $("dispatchList").innerHTML = `<div class="deck-loading">Wire offline: ${esc(e.message)}</div>`;
  }
}

function renderMissionList() {
  const filtered = state.missions.filter((m) => {
    if (state.missionFilter === "public") return m.source === "public";
    if (state.missionFilter === "house") return m.source === "house";
    return true;
  });

  if (!filtered.length) {
    $("dispatchList").innerHTML = `<div class="deck-loading">No dispatches in this filter yet.</div>`;
    return;
  }

  $("dispatchList").innerHTML = filtered
    .map(
      (m) => `<button type="button" class="deck-item ${m.id === state.activeMissionId ? "active" : ""}" data-mid="${m.id}">
        <div class="deck-meta">
          <span>#${m.id}</span>
          <span class="desk-badge">${esc(m.desk_code)}</span>
          <span class="status-dot ${esc(m.status)}">${m.status === "running" ? "● LIVE" : esc(m.status.toUpperCase())}</span>
          <span>${ago(m.created)}</span>
        </div>
        <div class="deck-headline">${esc(m.question)}</div>
        <div class="deck-counts">${m.verified}/${m.findings} ON THE WIRE${m.boost ? ` · ⚡ ${esc(m.boost.toUpperCase())}` : ""}</div>
      </button>`
    )
    .join("");
}

$("dispatchList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mid]");
  if (btn) selectMission(Number(btn.dataset.mid));
});

document.querySelectorAll("[data-mfilter]").forEach((b) => {
  b.addEventListener("click", () => {
    state.missionFilter = b.dataset.mfilter;
    document.querySelectorAll("[data-mfilter]").forEach((x) => x.classList.toggle("active", x === b));
    renderMissionList();
  });
});

async function selectMission(id) {
  state.activeMissionId = id;
  state.activeSteps = [];
  if (state.pollTimer) clearInterval(state.pollTimer);
  renderMissionList();
  await pollActiveMission(true);
}

async function pollActiveMission(initial = false) {
  const id = state.activeMissionId;
  if (!id) return;
  const after = initial ? 0 : state.activeSteps.at(-1)?.n || 0;
  try {
    const r = await api(`/v1/missions/${id}?after=${after}`);
    if (r.steps?.length) {
      state.activeSteps.push(...r.steps);
    }
    renderTractorPaper(r.mission, state.activeSteps);

    if (r.mission.status === "queued" || r.mission.status === "running") {
      if (!state.pollTimer) {
        state.pollTimer = setInterval(() => pollActiveMission(false), 1800);
      }
    } else if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      refreshStats();
      refreshMissions(false);
      refreshRightRailAndRibbon();
    }
  } catch (e) {
    $("paperBody").innerHTML = `<div class="paper-empty">Could not read dispatch #${id}: ${esc(e.message)}</div>`;
  }
}

function renderTractorPaper(m, steps) {
  const stepResults = new Map();
  for (const s of steps) {
    if (s.kind === "result") stepResults.set(s.n, s.body);
  }

  const stepsHtml = steps
    .filter((s) => s.kind !== "report")
    .map((s) => {
      if (s.kind === "call") {
        const why = s.body?.why || "";
        const args = s.body?.input ? JSON.stringify(s.body.input) : "";
        return `<div class="tape-step">
          <div class="step-num">#${String(s.n).padStart(2, "0")}</div>
          <div>
            <div class="step-head"><span>CALL</span> <span class="step-tool">${esc(s.tool)}</span></div>
            ${why ? `<div class="step-why">${esc(why)}</div>` : ""}
            ${args && args !== "{}" ? `<div class="f-evidence">args: ${esc(args)}</div>` : ""}
          </div>
        </div>`;
      }
      if (s.kind === "result") {
        const pretty = typeof s.body === "object" ? JSON.stringify(s.body, null, 2) : String(s.body);
        const src = s.body?.source || "Robinhood Chain live feed";
        return `<div class="tape-step">
          <div class="step-num">#${String(s.n).padStart(2, "0")}</div>
          <div class="step-raw">
            <div class="step-head"><span>RAW SOURCE PAYLOAD</span> <span class="step-tool">${esc(s.tool)}</span></div>
            <details>
              <summary>Inspect verbatim JSON from ${esc(String(src).slice(0, 68))} (${pretty.length.toLocaleString()} chars)</summary>
              <pre>${esc(pretty)}</pre>
            </details>
          </div>
        </div>`;
      }
      if (s.kind === "finding") {
        const f = s.body || {};
        const isWired = f.status === "verified";
        return `<div class="tape-step">
          <div class="step-num">#${String(s.n).padStart(2, "0")}</div>
          <div>
            <div class="step-head">
              <span class="stamp-pill ${isWired ? "stamp-wired" : "stamp-spiked"}">${isWired ? "ON THE WIRE · MATCHED" : "SPIKED · NO MATCH"}</span>
              ${f.cites ? `<span>cites step #${f.cites}</span>` : ""}
            </div>
            <div class="finding-card-inline ${isWired ? "" : "spiked"}">
              <div class="f-claim">${esc(f.claim)}</div>
              <div class="f-evidence">Verbatim quote checked: <code>${esc(f.evidence)}</code> — ${esc(f.check || "")}</div>
            </div>
          </div>
        </div>`;
      }
      if (s.kind === "note") {
        return `<div class="tape-step">
          <div class="step-num">#${String(s.n).padStart(2, "0")}</div>
          <div class="step-why"><em>Reporter note:</em> ${esc(s.body)}</div>
        </div>`;
      }
      if (s.kind === "error") {
        return `<div class="tape-step">
          <div class="step-num">#${String(s.n).padStart(2, "0")}</div>
          <div class="step-why" style="color:#b91c1c;">Source error (${esc(s.tool || "wire")}): ${esc(s.body)}</div>
        </div>`;
      }
      return "";
    })
    .join("");

  const statusLine =
    m.status === "running"
      ? "● TELETYPE CLACKING LIVE — STREAMING AGENT STEPS…"
      : m.status === "queued"
        ? `QUEUED AT POSITION #${m.position || 1} — STARTING MOMENTARILY…`
        : m.status === "failed"
          ? `WIRE INTERRUPTED: ${m.error || "timeout"}`
          : `FILED ${new Date(m.finished || m.created).toISOString().replace("T", " ").slice(0, 19)} UTC`;

  $("paperBody").innerHTML = `
    <div class="paper-dateline">
      <span>BULLETIN #${String(m.id).padStart(4, "0")} · ${esc(m.desk_name)} [${esc(m.desk_code)}]</span>
      <span>${esc(statusLine)}</span>
    </div>
    <h1 class="paper-headline">${esc(m.question)}</h1>
    ${
      m.report
        ? `<div class="bulletin-box">${esc(m.report)}</div>`
        : `<div class="bulletin-box">${
            m.status === "running" || m.status === "queued"
              ? "Desk reporter is pulling live Robinhood Chain sources and checking figures…"
              : esc(m.error || "No final bulletin filed.")
          }</div>`
    }
    <div class="tape-steps-title">STEP-BY-STEP SOURCE AUDIT LOG (${steps.length} EVENTS · ${m.verified || 0} ON THE WIRE)</div>
    <div>${stepsHtml || '<div class="step-why" style="padding:14px 0;">Waiting for first tool call…</div>'}</div>
  `;
}

// ==================== DISPATCH FORM ====================
document.querySelectorAll(".desk-key").forEach((b) => {
  b.addEventListener("click", () => {
    state.selectedDesk = b.dataset.desk;
    document.querySelectorAll(".desk-key").forEach((x) => x.classList.toggle("active", x === b));
  });
});

document.querySelectorAll(".punch-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $("dispatchInput").value = chip.dataset.q;
    state.selectedDesk = chip.dataset.desk || "";
    document.querySelectorAll(".desk-key").forEach((x) => x.classList.toggle("active", x.dataset.desk === state.selectedDesk));
    $("dispatchInput").focus();
  });
});

$("toggleBurnInputBtn").addEventListener("click", () => {
  const d = $("burnDrawer");
  d.hidden = !d.hidden;
});

$("dispatchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("dispatchInput").value.trim();
  if (!q) return;
  const burnTx = $("burnTxInput").value.trim();
  const btn = $("transmitBtn");
  btn.disabled = true;
  $("dispatchFeedback").textContent = "Transmitting assignment to Robinhood Chain bureau…";
  try {
    const r = await api("/v1/missions", {
      method: "POST",
      body: {
        desk: state.selectedDesk || undefined,
        question: q,
        burn_tx: burnTx || undefined,
      },
    });
    $("dispatchInput").value = "";
    $("burnTxInput").value = "";
    $("dispatchFeedback").textContent = `Bulletin #${r.mission.id} assigned to ${r.mission.desk_name} — streaming live on roll below.`;
    await refreshMissions(false);
    await selectMission(r.mission.id);
    refreshStats();
  } catch (err) {
    $("dispatchFeedback").textContent = `Wire rejected: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ==================== MORGUE ====================
async function loadMorgue() {
  const q = $("morgueSearchInput").value.trim();
  const desk = $("morgueDeskSelect").value;
  const st = $("morgueStatusSelect").value;
  const params = new URLSearchParams({ limit: "80" });
  if (q) params.set("q", q);
  if (desk) params.set("desk", desk);
  if (st) params.set("status", st);
  try {
    const r = await api(`/v1/memory?${params}`);
    const list = r.findings || [];
    $("morgueGrid").innerHTML = list.length
      ? list
          .map(
            (f) => `<article class="morgue-card ${f.status === "verified" ? "" : "is-spiked"}">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span class="stamp-pill ${f.status === "verified" ? "stamp-wired" : "stamp-spiked"}">${esc(f.stamp)}</span>
                <button type="button" class="ent-tag" data-open-mission="${f.mission}">Replay #${f.mission} [${esc(f.desk_code)}] →</button>
              </div>
              <div class="mc-claim">${esc(f.claim)}</div>
              <div class="mc-ev">Quoted: ${esc(f.evidence)}</div>
              <div class="mc-meta">
                <span>${f.source ? esc(String(f.source).slice(0, 44)) : "Chain source"}</span>
                <span>${ago(f.created)}</span>
              </div>
            </article>`
          )
          .join("")
      : `<div class="rail-muted">No clippings match that filter.</div>`;
  } catch (e) {
    $("morgueGrid").innerHTML = `<div class="rail-muted">${esc(e.message)}</div>`;
  }
}

["morgueSearchInput", "morgueDeskSelect", "morgueStatusSelect"].forEach((id) => {
  $(id).addEventListener("input", () => loadMorgue());
  $(id).addEventListener("change", () => loadMorgue());
});

// ==================== ENTITY WIRE GRAPH ====================
async function loadGraph() {
  try {
    const g = await api("/v1/graph");
    const svg = $("entityGraphSvg");
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    if (!nodes.length) {
      svg.innerHTML = `<text x="450" y="270" text-anchor="middle" fill="#94a3b8" font-family="IBM Plex Mono" font-size="14">Graph populates automatically as dispatches file verified findings.</text>`;
      return;
    }

    const cx = 450;
    const cy = 270;
    const coords = new Map();
    nodes.slice(0, 28).forEach((n, idx, arr) => {
      const ring = idx === 0 ? 0 : idx < 9 ? 135 : 225;
      const angle = idx === 0 ? 0 : (idx / Math.max(1, arr.length - 1)) * Math.PI * 2;
      coords.set(n.id, {
        ...n,
        x: Math.round(cx + Math.cos(angle) * ring * 1.35),
        y: Math.round(cy + Math.sin(angle) * ring * 0.92),
      });
    });

    const linesSvg = edges
      .filter((e) => coords.has(e.a) && coords.has(e.b))
      .map((e) => {
        const a = coords.get(e.a);
        const b = coords.get(e.b);
        return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#3b82f6" stroke-opacity="${Math.min(0.75, 0.2 + e.w * 0.12)}" stroke-width="${Math.min(3.5, 1 + e.w * 0.5)}" />`;
      })
      .join("");

    const nodesSvg = [...coords.values()]
      .map((n) => {
        const r = Math.min(24, 9 + n.findings * 2.2);
        return `<g class="g-node" data-gnode="${esc(n.id)}" style="cursor:pointer">
          <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="#1d4ed8" stroke="#ffd23f" stroke-width="2"/>
          <text x="${n.x}" y="${n.y + r + 14}" text-anchor="middle" fill="#f8fafc" font-family="IBM Plex Mono" font-size="11" font-weight="600">${esc(n.id)}</text>
        </g>`;
      })
      .join("");

    svg.innerHTML = linesSvg + nodesSvg;
  } catch {}
}

$("entityGraphSvg").addEventListener("click", async (e) => {
  const g = e.target.closest("[data-gnode]");
  if (!g) return;
  const ent = g.dataset.gnode;
  $("graphSelectedNode").textContent = ent.toUpperCase();
  const r = await api(`/v1/memory?q=${encodeURIComponent(ent)}&limit=10`);
  $("graphNodeFindings").innerHTML = (r.findings || [])
    .map(
      (f) => `<div class="clip-card">
        <div class="clip-claim">${esc(f.claim)}</div>
        <div class="clip-foot"><span>#${f.mission} · ${esc(f.stamp)}</span></div>
      </div>`
    )
    .join("");
});

// ==================== COPY CHIEF CHAT ====================
function appendChatBubble(role, text, looked = []) {
  const div = document.createElement("div");
  div.className = `chief-msg ${role === "user" ? "chief-user" : "chief-bot"}`;
  const lookedHtml =
    looked?.length
      ? `<div class="chief-looked">Sources checked: ${looked.map((l) => `[${esc(l.tool)}]`).join(" ")}</div>`
      : "";
  div.innerHTML = `
    <div class="chief-role">${role === "user" ? "READER" : "COPY CHIEF"}</div>
    <div class="chief-bubble">${esc(text)}</div>
    ${lookedHtml}
  `;
  $("chiefMessages").appendChild(div);
  $("chiefMessages").scrollTop = $("chiefMessages").scrollHeight;
}

$("chiefForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("chiefInput").value.trim();
  if (!content) return;
  $("chiefInput").value = "";
  state.chatHistory.push({ role: "user", content });
  appendChatBubble("user", content);

  const btn = $("chiefSendBtn");
  btn.disabled = true;
  try {
    const r = await api("/v1/chat", {
      method: "POST",
      body: { messages: state.chatHistory },
    });
    state.chatHistory.push({ role: "chief", content: r.reply });
    appendChatBubble("chief", r.reply, r.looked || []);
  } catch (err) {
    appendChatBubble("chief", `WIRE BUSY — ${err.message}\n--30--`);
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll(".chief-try").forEach((b) => {
  b.addEventListener("click", () => {
    $("chiefInput").value = b.dataset.q;
    $("chiefForm").requestSubmit();
  });
});

$("clearChatBtn").addEventListener("click", () => {
  state.chatHistory = [];
  $("chiefMessages").innerHTML = "";
  appendChatBubble("chief", "Fresh roll loaded. Ask about any Robinhood Chain stock token, Pons curve, protocol, or wallet.\n--30--");
});

// ==================== MERKLE TAPE SEALS & TAMPER PLAYGROUND ====================
async function loadSeals() {
  try {
    const r = await api("/v1/seals");
    state.seals = r.seals || [];
    if (!state.seals.length) {
      $("sealsListWrap").innerHTML = `<div class="rail-muted">First Merkle tape seal builds automatically once verified findings enter the Morgue.</div>`;
      return;
    }
    $("sealsListWrap").innerHTML = state.seals
      .map(
        (s, idx) => `<button type="button" class="seal-row-btn ${idx === 0 ? "active" : ""}" data-sidx="${idx}">
          <span>EPOCH ${s.epochHour} · ${s.wiredCount} ON WIRE</span>
          <code>${s.merkleRoot.slice(0, 12)}…${s.merkleRoot.slice(-6)}</code>
        </button>`
      )
      .join("");
    selectSeal(0);
  } catch {}
}

function selectSeal(idx) {
  const s = state.seals[idx];
  if (!s || !s.leaves?.length) return;
  const leaf = s.leaves[0];
  state.activeLeaf = { seal: s, leaf, originalClaim: leaf.record.claim };
  $("proofPlayground").hidden = false;
  $("pfEpoch").textContent = String(s.epochHour);
  $("pfRoot").textContent = s.merkleRoot;
  $("pfClaimEdit").value = leaf.record.claim;
  runLeafProofCheck();
}

$("sealsListWrap").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sidx]");
  if (b) {
    document.querySelectorAll(".seal-row-btn").forEach((x) => x.classList.toggle("active", x === b));
    selectSeal(Number(b.dataset.sidx));
  }
});

async function runLeafProofCheck() {
  if (!state.activeLeaf) return;
  const { seal, leaf } = state.activeLeaf;
  const candidate = { ...leaf.record, claim: $("pfClaimEdit").value };
  const r = await api("/v1/verify-leaf", {
    method: "POST",
    body: {
      record: candidate,
      proof: leaf.proof,
      expectedRoot: seal.merkleRoot,
    },
  });
  const box = $("proofResultBox");
  box.className = `proof-result ${r.valid ? "ok" : "bad"}`;
  box.textContent = r.valid
    ? `✓ MERKLE PROOF VALID — Computed root ${r.computedRoot.slice(0, 14)}… matches sealed root byte-for-byte.`
    : `✕ TAMPER DETECTED — Computed root ${r.computedRoot.slice(0, 14)}… DOES NOT MATCH sealed root ${r.expectedRoot.slice(0, 14)}…!`;
}

$("verifyLeafBtn").addEventListener("click", runLeafProofCheck);
$("tamperLeafBtn").addEventListener("click", () => {
  if (!state.activeLeaf) return;
  const cur = $("pfClaimEdit").value;
  $("pfClaimEdit").value = cur.replace(/\d/, (d) => String((Number(d) + 1) % 10)) + (/\d/.test(cur) ? "" : " [EDITED]");
  runLeafProofCheck();
});
$("restoreLeafBtn").addEventListener("click", () => {
  if (!state.activeLeaf) return;
  $("pfClaimEdit").value = state.activeLeaf.originalClaim;
  runLeafProofCheck();
});

// ==================== 0-WALLET PRESS MODAL, CA COPY & MCP KEY ====================
$("openPressModalBtn").addEventListener("click", () => {
  $("pressWalletInput").value = state.wallet;
  $("pressModal").hidden = false;
});
$("closePressModalBtn").addEventListener("click", () => {
  $("pressModal").hidden = true;
});
$("pressWalletForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const w = $("pressWalletInput").value.trim();
  if (w && !/^0x[0-9a-fA-F]{40}$/.test(w)) {
    alert("Enter a valid 0x Robinhood Chain public address.");
    return;
  }
  state.wallet = w.toLowerCase();
  localStorage.setItem("wirecopy_readonly_wallet", state.wallet);
  $("pressModal").hidden = true;
  await refreshStats();
});
$("clearPressWalletBtn").addEventListener("click", async () => {
  state.wallet = "";
  localStorage.removeItem("wirecopy_readonly_wallet");
  $("pressWalletInput").value = "";
  $("pressModal").hidden = true;
  await refreshStats();
});

$("caStampBox").addEventListener("click", () => {
  if (!SITE_CONFIG.tokenCa) return;
  navigator.clipboard?.writeText(SITE_CONFIG.tokenCa);
  $("caDisplay").textContent = "COPIED TO CLIPBOARD ✓";
  setTimeout(() => refreshStats(), 1400);
});

$("copyCliQuickBtn").addEventListener("click", () => {
  navigator.clipboard?.writeText("npx wirecopy-mcp init");
  $("copyCliQuickBtn").textContent = "COPIED ✓";
  setTimeout(() => ($("copyCliQuickBtn").textContent = "COPY"), 1400);
});

$("mcpKeyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/v1/keys", {
      method: "POST",
      body: {
        wallet: $("mcpWalletInput").value.trim(),
        name: $("mcpNameInput").value.trim(),
      },
    });
    const out = $("mcpKeyOutput");
    out.hidden = false;
    out.textContent = `MCP KEY (${r.label} · ${r.daily_api_limit.toLocaleString()}/day): ${r.key}`;
  } catch (err) {
    alert(err.message);
  }
});

// ==================== BOOT ====================
const initialHash = location.hash.replace(/^#\/?/, "");
if (["wire", "morgue", "graph", "chief", "seals"].includes(initialHash)) {
  setView(initialHash);
}
refreshStats();
refreshMissions(true);
refreshRightRailAndRibbon();
setInterval(() => {
  refreshMissions(false);
  refreshRightRailAndRibbon();
}, 15000);
