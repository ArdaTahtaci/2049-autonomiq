/* MachineProof demo UI. Drives the real backend API (same origin): POST /tasks → /fund → /start,
   then polls GET /tasks/:id while the robot proof is verified and settled. No keys live here. */
"use strict";

const $ = (id) => document.getElementById(id);
const POLL_MS = 600;
const TERMINAL = new Set(["SETTLED", "FAILED"]);
const EXPLORERS = { "1": "https://etherscan.io", "11155111": "https://sepolia.etherscan.io", "84532": "https://sepolia.basescan.org", "421614": "https://sepolia.arbiscan.io" };
const CHAIN_NAMES = { "31337": "Hardhat local", "1": "Ethereum", "11155111": "Sepolia", "84532": "Base Sepolia", "421614": "Arbitrum Sepolia" };
const CHECK_LABELS = {
  submission_schema: "Submission", proof_schema: "Proof schema", task_id_match: "Task ID", robot_id_match: "Robot ID",
  proof_hash: "Proof hash", signature: "Signature", task_geometry: "Task geometry", timestamp: "Timestamp",
  physical_placement: "Physical placement", success_claim: "Success claim",
};

const state = { health: null, task: null, busy: false, phase: null, anim: null, runId: 0 };

/* ── helpers ── */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const short = (hex, a = 6, b = 4) => (typeof hex === "string" && hex.length > a + b + 2 ? `${hex.slice(0, a + 2)}…${hex.slice(-b)}` : hex || "—");
const fmtVec = (v) => (v ? `${n(v.x)}, ${n(v.y)}, ${n(v.z)}` : "—");
const cm = (m) => `${(m * 100).toFixed(1)} cm`;
const n = (x) => (Math.round(x * 1000) / 1000).toString();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
function formatEth(wei) {
  try {
    const w = BigInt(wei), whole = w / 10n ** 18n, frac = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return `${whole}${frac ? "." + frac.slice(0, 6) : ""} ETH`;
  } catch { return "—"; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Backend unreachable. Is the server running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

function copyOnClick(el, value) {
  el.title = value ? "Click to copy" : "";
  el.onclick = value ? () => navigator.clipboard?.writeText(value).then(() => { const o = el.textContent; el.textContent = "Copied"; setTimeout(() => (el.textContent = o), 900); }) : null;
}

const isCre = () => (state.task?.settlement_mode ?? state.health?.settlement_mode) === "cre";
const explorerTx = (hash) => { const base = EXPLORERS[state.health?.chain_id]; return base && hash ? `${base}/tx/${hash}` : null; };

/* ── health / header ── */
async function loadHealth() {
  const net = $("net");
  try {
    const res = await fetch("/health");
    const info = await res.json();
    state.health = info;
    net.replaceChildren(
      h("span", { class: `pill ${info.ok ? "pill-ok" : "pill-bad"}` }, h("span", { class: "dot" }), info.ok ? (CHAIN_NAMES[info.chain_id] ?? `Chain ${info.chain_id}`) : "Chain unreachable"),
      h("span", { class: "pill pill-cre" }, info.settlement_mode === "cre" ? "Chainlink CRE settlement" : "Direct settlement"),
      h("span", { class: "pill pill-muted" }, info.robot_adapter === "mock" ? "Simulated robot" : "External simulator"),
    );
    $("foot-rpc").textContent = info.escrow_address ? `escrow ${short(info.escrow_address)}` : "";
    if (info.robot_adapter !== "mock") {
      document.querySelectorAll(".scenario").forEach((s) => (s.hidden = true));
      $("control-note").textContent = "External simulator: the robot posts its own signed proof.";
    }
  } catch {
    state.health = null;
    net.replaceChildren(h("span", { class: "pill pill-bad" }, h("span", { class: "dot" }), "Backend offline"));
  }
  renderSettlementHeader();
}

/* ── pipeline ── */
const STAGES = [
  { key: "create", name: "Create task" },
  { key: "fund", name: "Funded" },
  { key: "run", name: "Robot running" },
  { key: "proof", name: "Proof received" },
  { key: "verify", name: "Verifying", cre: true },
  { key: "settle", name: "On-chain settled" },
];

function stageStates(task, phase) {
  const s = Array(6).fill("idle");
  const subs = Array(6).fill("");
  const doneUpTo = (i) => { for (let k = 0; k < i; k++) s[k] = "done"; };
  if (!task) {
    if (phase === "create") s[0] = "active";
    return { s, subs };
  }
  subs[0] = task.task_id;
  if (task.transactions.fund) subs[1] = `${formatEth(task.reward_wei)} locked`;
  if (task.proof) subs[3] = short(task.proof.proof_hash, 4, 4);
  switch (task.status) {
    case "CREATED": doneUpTo(1); s[1] = "active"; break;
    case "FUNDED": doneUpTo(2); if (phase === "start") s[2] = "active"; break;
    case "RUNNING": doneUpTo(2); s[2] = "active"; subs[2] = task.robot_id; break;
    case "PROOF_RECEIVED": doneUpTo(4); s[4] = "active"; subs[4] = isCre() ? "workflow running" : "checking"; break;
    case "VERIFIED": doneUpTo(5); s[4] = "ok"; s[5] = "active"; subs[4] = "passed"; break;
    case "SETTLED": doneUpTo(6); s[4] = "ok"; s[5] = "ok"; subs[4] = "passed"; subs[5] = `${formatEth(task.reward_wei)} paid`; break;
    case "FAILED":
      if (task.proof) {
        doneUpTo(4); s[4] = "fail"; s[5] = "fail";
        subs[4] = "rejected";
        subs[5] = task.transactions.refund || task.onchain?.status === "Refunded" ? "refunded" : "not paid";
      } else {
        doneUpTo(2); s[2] = "fail"; subs[2] = "error";
      }
      break;
  }
  if (task.status !== "RUNNING" && (task.proof || TERMINAL.has(task.status))) subs[2] = subs[2] || task.robot_id;
  return { s, subs };
}

function renderPipeline() {
  const { s, subs } = stageStates(state.task, state.phase);
  const ol = $("stages");
  if (!ol.children.length) {
    STAGES.forEach((st, i) => ol.append(h("li", { class: `stage ${st.key}` },
      h("span", { class: "stage-bar" }),
      h("span", { class: "stage-row" }, h("span", { class: "stage-num" }, `0${i + 1}`), h("span", { class: "stage-name" }, st.name)),
      h("span", { class: "stage-sub mono" }))));
  }
  [...ol.children].forEach((li, i) => {
    li.dataset.state = s[i];
    li.querySelector(".stage-sub").textContent = subs[i];
    if (STAGES[i].cre) {
      li.classList.toggle("cre", isCre());
      li.querySelector(".stage-name").textContent = isCre() ? "Verifying" : "Verifier check";
    }
    if (i === 5) li.querySelector(".stage-name").textContent = state.task?.status === "FAILED" && state.task.proof ? "Refunded on-chain" : "On-chain settled";
  });

  const t = state.task;
  $("task-id").textContent = t ? t.task_id : "No task yet";
  const chip = $("status-chip");
  const status = t ? t.status : state.phase ? "STARTING" : "IDLE";
  chip.textContent = status.replace("_", " ");
  chip.dataset.tone = !t ? (state.phase ? "live" : "idle") : t.status === "SETTLED" ? "pos" : t.status === "FAILED" ? "neg" : "live";
}

/* ── robot scene ── */
function sceneBounds(task) {
  const pts = [task.start_position, task.target_position];
  const raw = task.proof?.raw;
  if (raw?.final_object_position) pts.push(raw.final_object_position);
  if (Array.isArray(raw?.trajectory)) pts.push(...raw.trajectory);
  let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  let minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const span = Math.max(maxX - minX, maxY - minY, 0.4);
  const pad = span * 0.22 + task.tolerance;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function drawScene(task, objectPos) {
  const el = $("scene");
  const W = 520, H = 260;
  const t = task ?? { start_position: { x: 0, y: 0, z: 0 }, target_position: { x: 1, y: 0, z: 0 }, tolerance: 0.05 };
  const b = sceneBounds(t);
  const scale = Math.min(W / (b.maxX - b.minX), H / (b.maxY - b.minY));
  const ox = (W - (b.maxX - b.minX) * scale) / 2, oy = (H - (b.maxY - b.minY) * scale) / 2;
  const X = (x) => ox + (x - b.minX) * scale;
  const Y = (y) => H - (oy + (y - b.minY) * scale);
  el.replaceChildren();

  // 10 cm grid
  const step = 0.1 * scale >= 14 ? 0.1 : 0.25;
  for (let gx = Math.ceil(b.minX / step) * step; gx <= b.maxX; gx += step) el.append(svg("line", { class: "grid-line", x1: X(gx), x2: X(gx), y1: 0, y2: H }));
  for (let gy = Math.ceil(b.minY / step) * step; gy <= b.maxY; gy += step) el.append(svg("line", { class: "grid-line", x1: 0, x2: W, y1: Y(gy), y2: Y(gy) }));
  const scaleBar = svg("text", { class: "axis-label", x: 12, y: H - 12 });
  scaleBar.textContent = `grid ${step * 100} cm · top-down`;
  el.append(scaleBar);

  const s = t.start_position, g = t.target_position;
  el.append(svg("line", { class: "path-ghost", x1: X(s.x), y1: Y(s.y), x2: X(g.x), y2: Y(g.y) }));

  const placement = task?.verification?.placement;
  const tolR = Math.max(t.tolerance * scale, 3);
  el.append(svg("circle", { class: `tol${placement && !placement.within_tolerance ? " bad" : ""}`, cx: X(g.x), cy: Y(g.y), r: tolR }));
  el.append(svg("rect", { class: "marker", x: X(s.x) - 6, y: Y(s.y) - 6, width: 12, height: 12, rx: 2 }));
  el.append(svg("path", { class: "marker", d: `M${X(g.x) - 5} ${Y(g.y)}h10M${X(g.x)} ${Y(g.y) - 5}v10` }));
  const la = svg("text", { class: "marker-label", x: X(s.x), y: Y(s.y) + 24, "text-anchor": "middle" }); la.textContent = "A · pick";
  const lb = svg("text", { class: "marker-label", x: X(g.x), y: Y(g.y) - tolR - 10, "text-anchor": "middle" }); lb.textContent = `B · place ±${n(t.tolerance * 100)} cm`;
  el.append(la, lb);

  const raw = task?.proof?.raw;
  if (Array.isArray(raw?.trajectory) && raw.trajectory.length > 1) {
    el.append(svg("polyline", { class: "path", points: raw.trajectory.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ") }));
  }
  if (Array.isArray(raw?.events) && raw.events.some((e) => e.type === "DROP") && raw.final_object_position) {
    el.append(svg("circle", { class: "drop", cx: X(raw.final_object_position.x), cy: Y(raw.final_object_position.y), r: 11 }));
  }
  const pos = objectPos ?? raw?.final_object_position ?? s;
  const tone = placement ? (task.verification.passed ? "pos" : "neg") : "";
  el.append(svg("circle", { class: `object ${tone}`, cx: X(pos.x), cy: Y(pos.y), r: 5.5 }));
}

function animateRobot(task) {
  if (state.anim?.taskId === task.task_id) return;
  stopAnim();
  const anim = { taskId: task.task_id, raf: 0 };
  state.anim = anim;
  const s = task.start_position, g = task.target_position, t0 = performance.now();
  const frame = (now) => {
    const k = ((now - t0) / 1800) % 1;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    drawScene(task, { x: s.x + (g.x - s.x) * e, y: s.y + (g.y - s.y) * e, z: 0 });
    anim.raf = requestAnimationFrame(frame);
  };
  anim.raf = requestAnimationFrame(frame);
}
function stopAnim() { if (state.anim) cancelAnimationFrame(state.anim.raf); state.anim = null; }

function renderRobot() {
  const t = state.task;
  $("robot-id").textContent = t ? t.robot_id : "—";
  if (t?.status === "RUNNING") animateRobot(t); else { stopAnim(); drawScene(t); }
  $("kv-target").textContent = t ? fmtVec(t.target_position) : "—";
  const final = t?.proof?.raw?.final_object_position;
  $("kv-final").textContent = final ? fmtVec(final) : t?.status === "RUNNING" ? "measuring…" : "—";
  const p = t?.verification?.placement, d = $("kv-distance");
  d.className = `mono${p ? (p.within_tolerance ? " pos" : " neg") : ""}`;
  d.textContent = p ? `${cm(p.distance)} / ±${cm(p.tolerance)}` : t ? `— / ±${cm(t.tolerance)}` : "—";
}

/* ── proof ── */
function renderProof() {
  const t = state.task, proof = t?.proof, v = t?.verification;
  const pill = $("proof-pill");
  if (!proof) {
    pill.className = "pill pill-muted";
    pill.textContent = t?.status === "RUNNING" ? "Robot executing…" : "Awaiting proof";
  } else if (v) {
    pill.className = `pill ${v.passed ? "pill-pos" : "pill-neg"}`;
    pill.textContent = v.passed ? "Verified" : "Task failed";
  } else {
    pill.className = "pill pill-cre";
    pill.textContent = "Signature valid";
  }
  $("kv-hash").textContent = proof ? short(proof.proof_hash, 10, 8) : "—";
  copyOnClick($("kv-hash"), proof?.proof_hash);
  $("kv-signer").textContent = proof ? `${short(proof.signer, 6, 4)} · ${t.robot_id}` : "—";
  copyOnClick($("kv-signer"), proof?.signer);

  const list = $("checks");
  const checks = v?.checks ?? [];
  const key = checks.map((c) => `${c.name}${c.ok}`).join("|");
  if (list.dataset.key === key && checks.length) return;
  list.dataset.key = key;
  if (!checks.length) {
    list.replaceChildren(h("li", { class: "empty" }, proof ? "Proof accepted. Verification in progress…" : t?.rejected_proofs ? `${t.rejected_proofs} invalid proof(s) rejected` : "Verification checks appear when the robot reports back."));
    return;
  }
  const order = ["signature", "proof_hash", "task_id_match", "robot_id_match", "physical_placement", "success_claim", "timestamp", "task_geometry", "proof_schema"];
  const sorted = [...checks].filter((c) => c.name !== "submission_schema").sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  list.replaceChildren(...sorted.map((c, i) => {
    const li = h("li", { class: c.ok ? "ok" : "bad", style: `animation-delay:${i * 45}ms` },
      h("span", { class: "ic" }, c.ok ? "✓" : "✕"), h("span", { class: "nm" }, CHECK_LABELS[c.name] ?? c.name), h("span", { class: "dt", title: c.detail }, c.ok ? shortDetail(c) : c.detail));
    return li;
  }));
}

function shortDetail(c) {
  const t = state.task, p = t?.verification?.placement;
  switch (c.name) {
    case "signature": return `robot ${short(t?.proof?.signer)}`;
    case "proof_hash": return "matches canonical proof";
    case "physical_placement": return p ? `${cm(p.distance)} from target` : "within tolerance";
    case "success_claim": return "confirmed by measurement";
    case "task_id_match": return t?.task_id ?? "match";
    case "robot_id_match": return t?.robot_id ?? "match";
    case "timestamp": return "within task window";
    case "task_geometry": return "matches funded spec";
    case "proof_schema": return "valid";
    default: return "ok";
  }
}

/* ── settlement / CRE ── */
function renderSettlementHeader() {
  const cre = isCre();
  $("settle-title").textContent = cre ? "Chainlink CRE" : "Settlement";
  const mp = $("mode-pill");
  mp.className = `pill ${cre ? "pill-cre" : "pill-muted"}`;
  mp.textContent = cre ? "Workflow · DON-signed report" : "Verifier oracle";
}

function renderSettlement() {
  renderSettlementHeader();
  const t = state.task, cre = isCre(), wr = t?.cre?.workflow_result;
  const verdict = $("verdict");
  let tone = "idle", value = "Pending", sub = "Waiting for a verified proof.";
  if (t) {
    const reward = formatEth(t.reward_wei);
    if (t.status === "SETTLED") {
      tone = "pos"; value = `${reward} released`; sub = `Paid to ${short(t.payee)}${cre ? " by the CRE workflow report" : ""}. Settled exactly once.`;
    } else if (t.status === "FAILED") {
      tone = "neg";
      value = t.proof ? "Refunded" : "Failed";
      const reason = t.verification?.reasons?.[0] ?? wr?.reasons?.[0] ?? t.error;
      sub = t.proof ? `${reward} returned to requester${reason ? `: ${reason}` : ""}` : reason ?? "Task failed.";
    } else if (t.status === "PROOF_RECEIVED" || t.status === "VERIFIED") {
      tone = "live"; value = cre ? "CRE verifying" : "Committing";
      sub = cre ? (t.cre?.status === "TRIGGER_FAILED" ? "Workflow trigger failed, retrying" : "Workflow re-verifies the proof independently, then writes a signed report on-chain.") : "Committing the proof hash and settling the escrow.";
    } else if (t.status === "RUNNING") { value = "Escrow locked"; sub = `${reward} held until the proof is verified.`; }
    else if (t.status === "FUNDED") { value = "Escrow locked"; sub = `${reward} held by the contract.`; }
    if (cre && wr && TERMINAL.has(t.status)) sub += ` · Workflow decision: ${wr.decision}`;
  }
  verdict.dataset.tone = tone;
  $("verdict-value").textContent = value;
  $("verdict-sub").textContent = sub;

  $("kv-escrow").textContent = t ? `${formatEth(t.reward_wei)} · ${short(state.health?.escrow_address)}` : short(state.health?.escrow_address);
  const oc = t?.onchain;
  $("kv-onchain").textContent = oc ? (oc.error ? "unavailable" : oc.status) : "—";

  const rows = [];
  if (t?.transactions.fund) rows.push(["Fund", t.transactions.fund]);
  if (t?.transactions.commit) rows.push(["Commit", t.transactions.commit]);
  if (t?.cre?.report_tx) rows.push(["CRE report", t.cre.report_tx]);
  if (t?.transactions.settle) rows.push(["Payout", t.transactions.settle]);
  if (t?.transactions.refund) rows.push(["Refund", t.transactions.refund]);
  const seen = new Set();
  const uniq = rows.filter(([, hsh]) => !seen.has(hsh) && seen.add(hsh));
  const list = $("txs");
  const key = uniq.map((r) => r.join(":")).join("|");
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...(uniq.length ? uniq.map(([k, hash]) => {
    const url = explorerTx(hash);
    const v = url ? h("a", { href: url, target: "_blank", rel: "noopener" }, hash) : h("span", { class: "v copyable" }, hash);
    if (!url) copyOnClick(v, hash);
    return h("li", {}, h("span", { class: "k" }, k), v);
  }) : [h("li", { class: "empty" }, "Transactions appear as they confirm.")]));
}

/* ── events ── */
function renderEvents() {
  const list = $("events"), evs = state.task?.events ?? [];
  if (list.dataset.count === String(evs.length) && list.dataset.task === (state.task?.task_id ?? "")) return;
  list.dataset.count = String(evs.length);
  list.dataset.task = state.task?.task_id ?? "";
  if (!evs.length) { list.replaceChildren(h("li", { class: "empty" }, "Run a task to stream its lifecycle.")); return; }
  const tone = (ty, msg) => (ty === "PROOF_VERIFIED" && /FAIL/i.test(msg) ? "neg" : /SETTLEMENT_RELEASED|PROOF_VERIFIED/.test(ty) ? "pos" : /FAILED|REJECTED|REFUNDED|ERROR/.test(ty) ? "neg" : /^CRE_/.test(ty) ? "cre" : "");
  list.replaceChildren(...evs.map((e) => h("li", {}, h("span", { class: "t" }, fmtTime(e.at)), h("span", { class: `ty ${tone(e.type, e.message)}` }, e.type), h("span", { class: "m" }, e.message))));
  list.scrollTop = list.scrollHeight;
}

function render() {
  renderPipeline();
  renderRobot();
  renderProof();
  renderSettlement();
  renderEvents();
  const btn = $("run");
  btn.disabled = state.busy || !state.health?.ok;
  btn.querySelector(".btn-label").textContent = state.busy ? "Running…" : state.task && TERMINAL.has(state.task.status) ? "Run another task" : "Run task";
  $("control").classList.toggle("busy", state.busy);
  document.querySelectorAll("#control input").forEach((i) => (i.disabled = state.busy));
  if (state.task) $("reward-pill").textContent = `${formatEth(state.task.reward_wei)} reward`;
  if (!state.health?.ok && !state.busy) $("control-note").textContent = state.health ? "Chain unreachable. Check the RPC / local node." : "Backend offline. Start it with npm run dev.";
}

/* ── flow ── */
async function runTask(outcome) {
  const runId = ++state.runId;
  state.busy = true; state.task = null; state.phase = "create";
  $("control-note").textContent = "Creating task…";
  render();
  try {
    state.task = await api("POST", "/tasks", {});
    render();
    $("control-note").textContent = "Locking reward in escrow…";
    state.task = await api("POST", `/tasks/${encodeURIComponent(state.task.task_id)}/fund`);
    state.phase = "start";
    render();
    $("control-note").textContent = "Dispatching robot…";
    const body = state.health?.robot_adapter === "mock" ? { mock_outcome: outcome } : {};
    state.task = await api("POST", `/tasks/${encodeURIComponent(state.task.task_id)}/start`, body);
    render();
    $("control-note").textContent = state.health?.robot_adapter === "mock" ? "Robot executing pick-and-place…" : "Waiting for the robot simulator's proof…";
    await poll(state.task.task_id, runId);
  } catch (err) {
    toast(err.message);
    $("control-note").textContent = err.message;
    if (state.task) await refresh(state.task.task_id).catch(() => {});
  } finally {
    if (runId === state.runId) { state.busy = false; state.phase = null; render(); }
  }
}

async function refresh(taskId) {
  state.task = await api("GET", `/tasks/${encodeURIComponent(taskId)}`);
  render();
}

async function poll(taskId, runId) {
  const deadline = Date.now() + (isCre() ? 240_000 : 180_000);
  let failures = 0;
  while (runId === state.runId && Date.now() < deadline) {
    try {
      await refresh(taskId);
      failures = 0;
      const s = state.task.status;
      if (s === "PROOF_RECEIVED") $("control-note").textContent = isCre() ? "Chainlink CRE workflow verifying…" : "Verifying proof…";
      if (s === "VERIFIED") $("control-note").textContent = "Settling on-chain…";
      if (TERMINAL.has(s)) {
        $("control-note").textContent = s === "SETTLED" ? "Payment released on-chain." : state.task.proof ? "Proof failed verification. Escrow refunded." : (state.task.error ?? "Task failed.");
        return;
      }
    } catch (err) {
      if (++failures >= 5) throw err;
    }
    await sleep(POLL_MS);
  }
  if (runId === state.runId) throw new Error("Timed out waiting for settlement. The task keeps running on the backend.");
}

async function restoreLatest() {
  try {
    const tasks = await api("GET", "/tasks");
    if (!Array.isArray(tasks) || !tasks.length) return;
    const latest = tasks.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    await refresh(latest.task_id);
    if (!TERMINAL.has(state.task.status) && state.task.status !== "CREATED") {
      state.busy = true; const runId = ++state.runId; render();
      await poll(latest.task_id, runId).catch((e) => toast(e.message));
      state.busy = false; render();
    }
  } catch { /* first load with no tasks */ }
}

$("control").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) return;
  const outcome = new FormData(e.currentTarget).get("outcome") ?? "success";
  runTask(String(outcome));
});

(async () => {
  render();
  await loadHealth();
  render();
  await restoreLatest();
  setInterval(() => { if (!state.busy) loadHealth().then(render); }, 15_000);
})();
