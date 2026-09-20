// DOM wiring tests. They run the real app.js against the real index.html inside
// jsdom, with a fake voice session and fake audio (no microphone, no network).
// Skipped automatically if jsdom is not installed (run `npm install` first).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

let JSDOM = null;
try { ({ JSDOM } = await import("jsdom")); } catch { /* skip below */ }
const skip = JSDOM ? false : "jsdom not installed (npm install)";

const { initApp } = await import("../public/js/app.js");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSession {
  static instances = [];
  static nextStartError = null;
  constructor(options) {
    this.options = options; this.handlers = {}; this.said = []; this.audioSent = [];
    this.maxSessionSeconds = 300; this.ended = false; this.endedSync = false;
    FakeSession.instances.push(this);
  }
  on(event, fn) { (this.handlers[event] ||= []).push(fn); }
  emit(event, payload) { (this.handlers[event] || []).forEach((fn) => fn(payload)); }
  async start() {
    if (FakeSession.nextStartError) { const e = FakeSession.nextStartError; FakeSession.nextStartError = null; throw e; }
  }
  async end() { this.ended = true; }
  endSync() { this.endedSync = true; }
  say(text) { this.said.push(text); return true; }
  sendAudio(chunk) { this.audioSent.push(chunk); return true; }
  get last() { return FakeSession.instances.at(-1); }
}

function setup({ promptAnswer = null } = {}) {
  FakeSession.instances = [];
  FakeSession.nextStartError = null;
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom;
  window.prompt = () => promptAnswer;
  window.print = () => { window.__printed = true; };
  const audio = { played: [], flushes: 0, started: false, stopped: false, onChunk: null,
    async start() { this.started = true; }, play(b) { this.played.push(b); }, flush() { this.flushes += 1; },
    async stop() { this.stopped = true; } };
  const audios = [];
  const app = initApp({
    document: window.document, window,
    createAudio: (options) => { audio.onChunk = options.onChunk; audios.push(audio); return audio; },
    SessionClass: FakeSession,
    setIntervalFn: () => 1, clearIntervalFn: () => {},
  });
  const $ = (id) => window.document.getElementById(id);
  return { window, app, audio, $, session: () => FakeSession.instances.at(-1) };
}

async function started(ctx) {
  ctx.$("start-btn").click();
  await tick(5);
  return ctx.session();
}

test("initial page state", { skip }, () => {
  const { $ } = setup();
  assert.equal($("status-pill").textContent, "Not connected");
  assert.equal($("start-btn").textContent, "Start inspection");
  assert.ok($("voice-select").options.length >= 3);
  assert.equal($("count-readings").textContent, "0");
  assert.equal($("orb").dataset.state, "idle");
});

test("start: mic first, then a session configured with every tool and the chosen voice", { skip }, async () => {
  const ctx = setup();
  ctx.$("voice-select").value = "eve";
  const session = await started(ctx);
  assert.ok(ctx.audio.started);
  const config = session.options.sessionConfig;
  assert.equal(config.output.voice, "eve");
  assert.equal(config.tools.length, 8);
  assert.equal(ctx.$("start-btn").textContent, "End inspection");
  assert.equal(ctx.$("voice-select").disabled, true);
  assert.match(ctx.$("limit").textContent, /Demo limit 5:00/);
  assert.equal(ctx.$("limit").hidden, false);
});

test("microphone chunks are forwarded to the session", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  ctx.audio.onChunk("QUJD");
  assert.deepEqual(session.audioSent, ["QUJD"]);
});

test("tool calls update the live logbook, counts and badges", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  const out = session.options.toolHandler("log_reading",
    { asset_id: "p-204", parameter: "temperature", value: 82, unit: "C" });
  assert.equal(out.result.flag, "watch");
  const rows = ctx.$("readings-body").querySelectorAll("tr");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /P-204/);
  assert.match(rows[0].textContent, /82 C/);
  assert.equal(rows[0].querySelector(".badge.watch").textContent, "watch");
  assert.equal(ctx.$("count-readings").textContent, "1");
  session.options.toolHandler("add_finding", { asset_id: "P-204", description: "Seal weeping", severity: "major" });
  session.options.toolHandler("create_task", { asset_id: "P-204", action: "Replace seal", due: "next week", priority: "high" });
  assert.equal(ctx.$("count-findings").textContent, "1");
  assert.equal(ctx.$("count-tasks").textContent, "1");
  session.options.toolHandler("start_inspection", { site: "Pump House 2", inspector: "Asha" });
  assert.match(ctx.$("site-meta").textContent, /Pump House 2 . Asha/);
});

test("SECURITY: spoken/model text can never inject markup", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  session.options.toolHandler("add_finding", { asset_id: "<b>X</b>", description: evil, severity: "minor" });
  session.emit("user_final", evil);
  session.emit("agent_final", { text: evil });
  session.emit("tool_call", { call_id: "c", name: "add_finding", arguments: { d: evil } });
  session.emit("user_partial", evil);
  const doc = ctx.window.document;
  assert.equal(doc.querySelectorAll("#findings-body img, #findings-body script, #findings-body b").length, 0);
  assert.equal(doc.querySelectorAll("#transcript img, #transcript script, #partial img, #partial script").length, 0);
  assert.equal(ctx.window.__pwned, undefined);
  assert.ok(doc.querySelector("#findings-body td:nth-child(2)").textContent.includes("<img"));
  ctx.app.openReport();
  assert.equal(doc.querySelectorAll("#report-content img, #report-content script").length, 0);
});

test("conversation: partial -> final, agent text, audio playback, barge-in flush", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  session.emit("user_partial", "P 204 bear");
  assert.equal(ctx.$("partial").textContent, "P 204 bear");
  session.emit("user_final", "P-204 bearing is 82 C.");
  assert.equal(ctx.$("partial").textContent, "");
  assert.equal(ctx.$("transcript").querySelector(".msg.user .said").textContent, "P-204 bearing is 82 C.");
  session.emit("agent_final", { text: "Logged. Watch level.", interrupted: false });
  assert.equal(ctx.$("transcript").querySelector(".msg.agent .said").textContent, "Logged. Watch level.");
  session.emit("audio", "AAAA");
  assert.deepEqual(ctx.audio.played, ["AAAA"]);
  session.emit("interrupted");
  assert.equal(ctx.audio.flushes, 1);
});

test("activity drives the orb and the caption", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  for (const name of ["listening", "user_speaking", "thinking", "speaking"]) {
    session.emit("activity", name);
    assert.equal(ctx.$("orb").dataset.state, name);
    assert.ok(ctx.$("activity").textContent.length > 3);
  }
});

test("response-time badges show the last and the median latency", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  [900, 400, 700].forEach((ms) => session.emit("latency", ms));
  assert.equal(ctx.$("latency-last").textContent, "700 ms");
  assert.equal(ctx.$("latency-median").textContent, "700 ms");
  session.emit("latency", 300);
  assert.equal(ctx.$("latency-median").textContent, "550 ms"); // median of 300,400,700,900
});

test("tool chip is shown and gets a status badge from the result", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  session.emit("tool_call", { call_id: "c1", name: "log_reading", arguments: { asset_id: "P-204", value: 96, unit: "C" } });
  const chip = ctx.$("transcript").querySelector(".msg.tool");
  assert.match(chip.textContent, /log_reading/);
  assert.match(chip.textContent, /P-204/);
  session.emit("tool_result", { call_id: "c1", is_error: false, result: JSON.stringify({ flag: "critical" }) });
  assert.equal(chip.querySelector(".badge.critical").textContent, "critical");
  session.emit("tool_call", { call_id: "c2", name: "log_reading", arguments: {} });
  session.emit("tool_result", { call_id: "c2", is_error: true, result: JSON.stringify({ error: "x" }) });
  assert.ok(ctx.$("transcript").querySelector('[data-call="c2"] .badge.error'));
});

test("finish_report opens the report once the agent has finished speaking", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  session.options.toolHandler("log_reading", { asset_id: "P-204", parameter: "temperature", value: 96, unit: "C" });
  session.options.toolHandler("finish_report", {});
  const dialog = ctx.$("report-dialog");
  assert.equal(dialog.hasAttribute("open"), false, "not while the agent is still talking");
  session.emit("activity", "speaking");
  assert.equal(dialog.hasAttribute("open"), false);
  session.emit("activity", "listening");
  assert.equal(dialog.hasAttribute("open"), true);
  assert.match(ctx.$("report-content").textContent, /1 readings, 0 findings, 0 tasks/);
  assert.match(ctx.$("report-content").textContent, /1 reading\(s\) need attention/);
  ctx.$("close-report").click();
  assert.equal(dialog.hasAttribute("open"), false);
});

test("Report button works any time; print button calls window.print", { skip }, async () => {
  const ctx = setup();
  ctx.$("report-btn").click();
  assert.equal(ctx.$("report-dialog").hasAttribute("open"), true);
  ctx.$("print-report").click();
  assert.equal(ctx.window.__printed, true);
});

test("End: session ended, mic released, button restored", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  ctx.$("start-btn").click();
  await tick(5);
  assert.equal(session.ended, true);
  assert.equal(ctx.audio.stopped, true);
  assert.equal(ctx.$("start-btn").textContent, "Start inspection");
  assert.equal(ctx.$("start-btn").disabled, false);
  assert.equal(ctx.$("voice-select").disabled, false);
  assert.equal(ctx.$("limit").hidden, true);
});

test("start failure: banner explains it, mic released, can retry", { skip }, async () => {
  const ctx = setup();
  FakeSession.nextStartError = Object.assign(new Error("Could not start a voice session right now."), { code: "upstream_error" });
  ctx.$("start-btn").click();
  await tick(10);
  assert.equal(ctx.$("error-banner").hidden, false);
  assert.match(ctx.$("error-banner").textContent, /Could not start a voice session/);
  assert.equal(ctx.audio.stopped, true);
  assert.equal(ctx.$("start-btn").textContent, "Start inspection");
  assert.equal(ctx.$("start-btn").disabled, false);
  ctx.$("start-btn").click();
  await tick(10);
  assert.equal(ctx.$("error-banner").hidden, true, "a retry clears the old error");
  assert.equal(ctx.$("start-btn").textContent, "End inspection");
});

test("microphone permission denied gives a plain-language message", { skip }, async () => {
  const ctx = setup();
  ctx.audio.start = async () => { throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }); };
  ctx.$("start-btn").click();
  await tick(10);
  assert.match(ctx.$("error-banner").textContent, /Microphone access was blocked/);
  assert.equal(FakeSession.instances.length, 0, "no session is opened without a microphone");
});

test("passcode flow: prompt once, remember it, retry with the header", { skip }, async () => {
  const ctx = setup({ promptAnswer: "open-sesame" });
  FakeSession.nextStartError = Object.assign(new Error("A demo passcode is required."), { code: "passcode_required" });
  ctx.$("start-btn").click();
  await tick(20);
  assert.equal(ctx.window.sessionStorage.getItem("fieldlog_passcode"), "open-sesame");
  const retry = FakeSession.instances.at(-1);
  assert.deepEqual(retry.options.tokenHeaders(), { "x-demo-passcode": "open-sesame" });
  assert.equal(ctx.$("start-btn").textContent, "End inspection");
  assert.equal(ctx.$("error-banner").hidden, true);
});

test("passcode prompt cancelled: shows the server's message", { skip }, async () => {
  const ctx = setup({ promptAnswer: null });
  FakeSession.nextStartError = Object.assign(new Error("A demo passcode is required."), { code: "passcode_required" });
  ctx.$("start-btn").click();
  await tick(10);
  assert.match(ctx.$("error-banner").textContent, /passcode/);
  assert.equal(ctx.$("start-btn").textContent, "Start inspection");
});

test("server-side end (time limit / dropped connection) resets the page with a message", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  session.emit("closed", { code: 1000 });
  await tick(10);
  assert.match(ctx.$("error-banner").textContent, /session ended/i);
  assert.equal(ctx.$("start-btn").textContent, "Start inspection");
  assert.equal(ctx.audio.stopped, true);
});

test("a finished timer asks the agent to announce it", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  session.options.toolHandler("start_timer", { minutes: 0.004, label: "cool-down" }); // ~240 ms
  assert.match(ctx.$("timers").textContent, /cool-down/);
  await tick(400);
  assert.equal(session.said.length, 1);
  assert.match(session.said[0], /cool-down timer has just finished/);
  assert.match(ctx.$("timers").textContent, /cool-down: done/);
});

test("New inspection clears the log, transcript and metrics", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  session.options.toolHandler("log_reading", { asset_id: "A", parameter: "flow", value: 1, unit: "l/s" });
  session.emit("user_final", "hello");
  session.emit("latency", 500);
  ctx.$("reset-btn").click();
  assert.equal(ctx.$("readings-body").children.length, 0);
  assert.equal(ctx.$("transcript").children.length, 0);
  assert.equal(ctx.$("latency-last").textContent, "-");
});

test("closing the tab sends session.end (pagehide)", { skip }, async () => {
  const ctx = setup();
  const session = await started(ctx);
  ctx.window.dispatchEvent(new ctx.window.Event("pagehide"));
  assert.equal(session.endedSync, true);
});
