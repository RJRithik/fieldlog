// app.js - wires the voice session, the microphone/speaker, the logbook and the page.
//
// Everything that comes from speech or from the model (asset tags, findings,
// transcripts) is inserted with textContent, never innerHTML: what a person says
// must never be able to inject markup into the page.

import { createLogbook, TOOL_DEFINITIONS } from "./tools.js";
import { VoiceAgentSession, buildSessionConfig, VOICES } from "./session.js";

const PASSCODE_KEY = "fieldlog_passcode";

function el(document, tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

const isNode = (value) => value != null && typeof value === "object" && typeof value.nodeType === "number";

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const ACTIVITY_TEXT = {
  idle: "Press start, allow the microphone, and begin talking.",
  connecting: "Connecting...",
  listening: "Listening. Say a reading, a finding or a task.",
  user_speaking: "Hearing you...",
  thinking: "Logging...",
  speaking: "FieldLog is speaking. You can interrupt at any time.",
  ended: "Session ended. Press start for a new one.",
  error: "Something went wrong. See the message above.",
};

export function initApp({
  document,
  window,
  createAudio,
  SessionClass = VoiceAgentSession,
  setIntervalFn = (fn, ms) => window.setInterval(fn, ms),
  clearIntervalFn = (id) => window.clearInterval(id),
}) {
  const $ = (id) => document.getElementById(id);
  const ui = {
    start: $("start-btn"), report: $("report-btn"), reset: $("reset-btn"),
    status: $("status-pill"), activity: $("activity"), orb: $("orb"), voice: $("voice-select"),
    transcript: $("transcript"), partial: $("partial"), banner: $("error-banner"),
    latencyLast: $("latency-last"), latencyMedian: $("latency-median"), limit: $("limit"),
    readings: $("readings-body"), findings: $("findings-body"), tasks: $("tasks-body"),
    timers: $("timers"), siteMeta: $("site-meta"),
    countReadings: $("count-readings"), countFindings: $("count-findings"), countTasks: $("count-tasks"),
    dialog: $("report-dialog"), reportContent: $("report-content"),
    downloadCsv: $("download-csv"), printReport: $("print-report"), closeReport: $("close-report"),
  };

  const state = {
    session: null, audio: null, busy: false, latencies: [],
    seenRows: new Set(), pendingReport: false, limitTimer: null, timerTicker: null, sessionEndsAt: null,
  };

  const logbook = createLogbook({
    onTimerDone: (timer) => {
      state.session?.say(`The ${timer.label} timer has just finished. Tell the user in one short sentence.`);
    },
  });

  // ---- small UI helpers ----------------------------------------------------
  function setActivity(name) {
    ui.orb.dataset.state = name;
    ui.activity.textContent = ACTIVITY_TEXT[name] ?? "";
  }

  function setStatus(text, tone = "") {
    ui.status.textContent = text;
    ui.status.className = `pill ${tone}`.trim();
  }

  function showError(message) {
    ui.banner.textContent = message;
    ui.banner.hidden = !message;
  }

  function addMessage(role, text) {
    if (!text) return;
    const label = role === "user" ? "You" : "FieldLog";
    ui.transcript.append(el(document, "div", { class: `msg ${role}` }, [
      el(document, "span", { class: "who", text: label }),
      el(document, "span", { class: "said", text }),
    ]));
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  function compactArgs(args) {
    return Object.entries(args ?? {})
      .filter(([, v]) => v !== "" && v != null)
      .map(([, v]) => String(v))
      .join(" \u00b7 ")
      .slice(0, 120);
  }

  function addToolChip(callId, name, args) {
    const chip = el(document, "div", { class: "msg tool", "data-call": callId }, [
      el(document, "span", { class: "who", text: "Tool" }),
      el(document, "span", { class: "said", text: `${name}  ${compactArgs(args)}` }),
    ]);
    ui.transcript.append(chip);
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  function markToolResult(result) {
    const chip = [...ui.transcript.querySelectorAll(".msg.tool")]
      .reverse().find((node) => node.getAttribute("data-call") === result.call_id);
    if (!chip) return;
    let parsed = {};
    try { parsed = JSON.parse(result.result); } catch { /* keep empty */ }
    const flag = result.is_error ? "error" : parsed.flag;
    if (flag) chip.append(el(document, "span", { class: `badge ${flag}`, text: flag }));
  }

  // ---- logbook rendering ---------------------------------------------------
  function row(id, cells) {
    const tr = el(document, "tr", { class: state.seenRows.has(id) ? "" : "new" });
    state.seenRows.add(id);
    for (const cell of cells) {
      tr.append(isNode(cell) ? el(document, "td", {}, [cell]) : el(document, "td", { text: String(cell) }));
    }
    return tr;
  }

  const badge = (value) => el(document, "span", { class: `badge ${value}`, text: value });

  function renderLogbook(snapshot) {
    ui.readings.replaceChildren(...snapshot.readings.map((r) => row(r.id, [
      r.id, r.asset_id, r.parameter, `${r.value} ${r.unit}`, badge(r.flag),
    ])));
    ui.findings.replaceChildren(...snapshot.findings.map((f) => row(f.id, [
      f.asset_id, f.description, badge(f.severity),
    ])));
    ui.tasks.replaceChildren(...snapshot.tasks.map((t) => row(t.id, [
      t.asset_id, t.action, t.due, badge(t.priority),
    ])));
    ui.countReadings.textContent = String(snapshot.readings.length);
    ui.countFindings.textContent = String(snapshot.findings.length);
    ui.countTasks.textContent = String(snapshot.tasks.length);

    const meta = [snapshot.meta.site, snapshot.meta.inspector].filter(Boolean).join(" \u00b7 ");
    ui.siteMeta.textContent = meta ? `- ${meta}` : "";
    renderTimers(snapshot.timers);
    if (snapshot.finished && !state.reportShown) state.pendingReport = true;
  }

  function renderTimers(timers = logbook.snapshot().timers) {
    const nowMs = Date.now();
    ui.timers.replaceChildren(...timers.map((t) => {
      const left = (new Date(t.ends_at).getTime() - nowMs) / 1000;
      const text = t.done ? `${t.label}: done` : `${t.label}: ${formatClock(left)}`;
      return el(document, "span", { class: `chip timer ${t.done ? "done" : ""}`.trim(), text });
    }));
  }

  logbook.subscribe(renderLogbook);

  // ---- report --------------------------------------------------------------
  function buildReport(snapshot) {
    const wrap = el(document, "div");
    const meta = [snapshot.meta.site && `Site: ${snapshot.meta.site}`, snapshot.meta.inspector && `Inspector: ${snapshot.meta.inspector}`,
      `Started: ${new Date(snapshot.meta.started_at).toLocaleString()}`].filter(Boolean);
    wrap.append(el(document, "p", { class: "muted", text: meta.join("  |  ") }));

    const flagged = snapshot.readings.filter((r) => r.flag === "watch" || r.flag === "critical");
    const major = snapshot.findings.filter((f) => f.severity === "major" || f.severity === "critical");
    wrap.append(el(document, "p", { class: "headline", text:
      `${snapshot.readings.length} readings, ${snapshot.findings.length} findings, ${snapshot.tasks.length} tasks. ` +
      `${flagged.length} reading(s) need attention, ${major.length} major finding(s).` }));

    const section = (title, headers, rows) => {
      wrap.append(el(document, "h3", { text: title }));
      if (!rows.length) { wrap.append(el(document, "p", { class: "muted", text: "None." })); return; }
      const thead = el(document, "tr", {}, headers.map((h) => el(document, "th", { text: h })));
      const body = rows.map((cells) => el(document, "tr", {}, cells.map((c) =>
        isNode(c) ? el(document, "td", {}, [c]) : el(document, "td", { text: String(c) }))));
      wrap.append(el(document, "table", {}, [el(document, "thead", {}, [thead]), el(document, "tbody", {}, body)]));
    };
    section("Readings", ["ID", "Asset", "Parameter", "Value", "Status"],
      snapshot.readings.map((r) => [r.id, r.asset_id, r.parameter, `${r.value} ${r.unit}`, badge(r.flag)]));
    section("Findings", ["Asset", "Observation", "Severity"],
      snapshot.findings.map((f) => [f.asset_id, f.description, badge(f.severity)]));
    section("Follow-up tasks", ["Asset", "Action", "Due", "Priority"],
      snapshot.tasks.map((t) => [t.asset_id, t.action, t.due, badge(t.priority)]));
    return wrap;
  }

  function openReport() {
    ui.reportContent.replaceChildren(buildReport(logbook.snapshot()));
    state.reportShown = true;
    state.pendingReport = false;
    if (typeof ui.dialog.showModal === "function" && !ui.dialog.open) ui.dialog.showModal();
    else ui.dialog.setAttribute("open", "");
  }

  function closeReport() {
    state.reportShown = false;
    if (typeof ui.dialog.close === "function") ui.dialog.close();
    else ui.dialog.removeAttribute("open");
  }

  function downloadCsv() {
    const blob = new window.Blob([logbook.toCSV()], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = el(document, "a", { href: url, download: "fieldlog-report.csv" });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }

  // ---- session lifecycle ---------------------------------------------------
  function latencyUpdate(ms) {
    state.latencies.push(ms);
    ui.latencyLast.textContent = `${ms} ms`;
    ui.latencyMedian.textContent = `${median(state.latencies)} ms`;
  }

  function startLimitCountdown(seconds) {
    stopLimitCountdown();
    if (!seconds) return;
    state.sessionEndsAt = Date.now() + seconds * 1000;
    ui.limit.hidden = false;
    const tick = () => {
      const left = (state.sessionEndsAt - Date.now()) / 1000;
      ui.limit.textContent = `Demo limit ${formatClock(left)}`;
    };
    tick();
    state.limitTimer = setIntervalFn(tick, 1000);
  }

  function stopLimitCountdown() {
    if (state.limitTimer != null) clearIntervalFn(state.limitTimer);
    state.limitTimer = null;
    ui.limit.hidden = true;
  }

  function wireSession(session) {
    session.on("status", (status) => {
      const map = { connecting: ["Connecting", "warn"], ready: ["Live", "ok"], ending: ["Ending", "warn"],
        ended: ["Ended", ""], error: ["Error", "bad"] };
      const [text, tone] = map[status] ?? [status, ""];
      setStatus(text, tone);
      if (status === "connecting") setActivity("connecting");
      if (status === "ended") setActivity("ended");
      if (status === "error") setActivity("error");
    });
    session.on("activity", (name) => {
      setActivity(name);
      if (name === "listening" && state.pendingReport) openReport();
    });
    session.on("user_partial", (text) => { ui.partial.textContent = text; });
    session.on("user_final", (text) => { ui.partial.textContent = ""; addMessage("user", text); });
    session.on("agent_final", ({ text }) => addMessage("agent", text));
    session.on("audio", (data) => state.audio?.play(data));
    session.on("interrupted", () => state.audio?.flush());
    session.on("latency", latencyUpdate);
    session.on("tool_call", ({ call_id, name, arguments: args }) => addToolChip(call_id, name, args));
    session.on("tool_result", markToolResult);
    session.on("error", (error) => showError(error.message));
    session.on("closed", () => {
      // Server-initiated end (time limit) or a dropped connection, not a user click.
      if (state.session !== session || state.busy) return;
      if (ui.banner.hidden) {
        showError("The session ended (time limit reached or connection lost). Press start to begin again.");
      }
      end();
    });
  }

  async function begin({ retried = false } = {}) {
    if (state.busy) return;
    state.busy = true;
    showError("");
    ui.start.disabled = true;
    ui.start.textContent = "Connecting...";
    ui.voice.disabled = true;
    ui.partial.textContent = "";

    try {
      state.audio = createAudio({ onChunk: (chunk) => state.session?.sendAudio(chunk) });
      await state.audio.start(); // inside the click gesture: asks for the microphone

      const session = new SessionClass({
        sessionConfig: buildSessionConfig({ tools: TOOL_DEFINITIONS, voice: ui.voice.value }),
        toolHandler: (name, args) => logbook.handleToolCall(name, args),
        tokenHeaders: () => {
          const code = window.sessionStorage?.getItem(PASSCODE_KEY);
          return code ? { "x-demo-passcode": code } : {};
        },
      });
      state.session = session;
      wireSession(session);
      await session.start();
      startLimitCountdown(session.maxSessionSeconds);
      ui.start.textContent = "End inspection";
      ui.start.disabled = false;
    } catch (error) {
      await teardown();
      if (error?.code === "passcode_required" && !retried) {
        const code = window.prompt("This demo needs a passcode:");
        if (code) {
          window.sessionStorage?.setItem(PASSCODE_KEY, code);
          state.busy = false;
          await begin({ retried: true });
          return;
        }
      }
      showError(friendlyError(error));
      setStatus("Error", "bad");
      setActivity("error");
      resetStartButton();
    } finally {
      state.busy = false;
    }
  }

  function friendlyError(error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      return "Microphone access was blocked. Allow the microphone for this site and try again.";
    }
    if (error?.name === "NotFoundError") return "No microphone was found on this device.";
    return error?.message || "Could not start the session.";
  }

  function resetStartButton() {
    ui.start.textContent = "Start inspection";
    ui.start.disabled = false;
    ui.voice.disabled = false;
  }

  async function teardown() {
    stopLimitCountdown();
    const { session, audio } = state;
    state.session = null;
    state.audio = null;
    try { await session?.end(); } catch { /* ignore */ }
    try { await audio?.stop(); } catch { /* ignore */ }
  }

  async function end() {
    if (state.busy) return;
    state.busy = true;
    ui.start.disabled = true;
    await teardown();
    setStatus("Ended", "");
    setActivity("ended");
    resetStartButton();
    state.busy = false;
  }

  // ---- events --------------------------------------------------------------
  for (const voice of VOICES) ui.voice.append(el(document, "option", { value: voice, text: voice }));

  ui.start.addEventListener("click", () => (state.session ? end() : begin()));
  ui.report.addEventListener("click", openReport);
  ui.closeReport.addEventListener("click", closeReport);
  ui.dialog.addEventListener("close", () => { state.reportShown = false; });
  ui.downloadCsv.addEventListener("click", downloadCsv);
  ui.printReport.addEventListener("click", () => window.print());
  ui.reset.addEventListener("click", () => {
    logbook.reset();
    state.seenRows.clear();
    state.latencies = [];
    ui.transcript.replaceChildren();
    ui.latencyLast.textContent = "-";
    ui.latencyMedian.textContent = "-";
    renderLogbook(logbook.snapshot());
  });
  window.addEventListener("pagehide", () => state.session?.endSync());
  state.timerTicker = setIntervalFn(() => renderTimers(), 1000);

  setActivity("idle");
  setStatus("Not connected");
  renderLogbook(logbook.snapshot());

  return { logbook, begin, end, openReport, getState: () => state };
}
