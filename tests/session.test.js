import test from "node:test";
import assert from "node:assert/strict";
import { VoiceAgentSession, buildSessionConfig, DEFAULT_WS_URL } from "../public/js/session.js";
import { TOOL_DEFINITIONS } from "../public/js/tools.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.fire("open", {}); });
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { if (this.closed) return; this.closed = true; this.readyState = 3; this.fire("close", { code }); }
  fire(type, event) { (this.listeners[type] ||= []).forEach((fn) => fn(event)); }
  serverSend(obj) { this.fire("message", { data: JSON.stringify(obj) }); }
  types() { return this.sent.map((m) => m.type); }
}

function okFetch(body = { token: "tok-123", max_session_seconds: 300 }) {
  const calls = [];
  const fn = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => body }; };
  fn.calls = calls;
  return fn;
}

function make(overrides = {}) {
  FakeWebSocket.instances = [];
  const clock = { t: 1000 };
  const session = new VoiceAgentSession({
    sessionConfig: buildSessionConfig({ tools: TOOL_DEFINITIONS }),
    toolHandler: async (name, args) => ({ result: { echoed: name, args } }),
    WebSocketImpl: FakeWebSocket,
    fetchImpl: okFetch(),
    now: () => clock.t,
    ...overrides,
  });
  return { session, clock };
}

async function startReady(session) {
  const promise = session.start();
  await tick(); await tick();
  const ws = FakeWebSocket.instances.at(-1);
  ws.serverSend({ type: "session.ready", session_id: "sess-1" });
  await promise;
  return ws;
}

test("start: fetches a token, connects with ?token=, sends session.update first", async () => {
  const fetchImpl = okFetch();
  const { session } = make({ fetchImpl });
  const ws = await startReady(session);
  assert.equal(fetchImpl.calls[0].url, "/api/voice-token");
  assert.equal(ws.url, `${DEFAULT_WS_URL}?token=tok-123`);
  assert.equal(ws.sent[0].type, "session.update");
  assert.equal(ws.sent[0].session.tools.length, TOOL_DEFINITIONS.length);
  assert.equal(ws.sent[0].session.output.voice, "alba");
  assert.ok(ws.sent[0].session.input.keyterms.length > 0);
  assert.equal(session.status, "ready");
  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.maxSessionSeconds, 300);
});

test("session config never contains an API key and stays inline (no agent_id)", () => {
  const config = buildSessionConfig({ tools: TOOL_DEFINITIONS });
  const text = JSON.stringify(config);
  assert.ok(!("agent_id" in config));
  assert.doesNotMatch(text, /api[_-]?key|bearer/i);
});

test("audio is dropped before session.ready and sent after", async () => {
  const { session } = make();
  assert.equal(session.sendAudio("AAAA"), false);
  const promise = session.start();
  await tick(); await tick();
  const ws = FakeWebSocket.instances.at(-1);
  assert.equal(session.sendAudio("AAAA"), false, "still not ready");
  ws.serverSend({ type: "session.ready", session_id: "s" });
  await promise;
  assert.equal(session.sendAudio("QUJD"), true);
  assert.deepEqual(ws.sent.at(-1), { type: "input.audio", audio: "QUJD" });
  assert.equal(ws.types().filter((t) => t === "input.audio").length, 1);
});

test("tool.call: result is sent only after reply.done, with the same call_id and a JSON string", async () => {
  const { session } = make();
  const ws = await startReady(session);
  ws.serverSend({ type: "tool.call", call_id: "c1", name: "log_reading", arguments: { asset_id: "P-204" } });
  await tick();
  assert.ok(!ws.types().includes("tool.result"), "not before reply.done");
  ws.serverSend({ type: "reply.done", reply_id: "r1", status: "completed" });
  await tick();
  const result = ws.sent.find((m) => m.type === "tool.result");
  assert.equal(result.call_id, "c1");
  assert.equal(result.is_error, false);
  assert.equal(typeof result.result, "string");
  assert.deepEqual(JSON.parse(result.result), { echoed: "log_reading", args: { asset_id: "P-204" } });
});

test("several tool calls in one reply are answered in order", async () => {
  const { session } = make();
  const ws = await startReady(session);
  ws.serverSend({ type: "tool.call", call_id: "a", name: "add_finding", arguments: {} });
  ws.serverSend({ type: "tool.call", call_id: "b", name: "create_task", arguments: {} });
  ws.serverSend({ type: "reply.done", status: "completed" });
  await tick();
  assert.deepEqual(ws.sent.filter((m) => m.type === "tool.result").map((m) => m.call_id), ["a", "b"]);
});

test("a slow tool handler still answers after reply.done", async () => {
  const { session } = make({
    toolHandler: async () => { await new Promise((r) => setTimeout(r, 20)); return { result: { ok: 1 } }; },
  });
  const ws = await startReady(session);
  ws.serverSend({ type: "tool.call", call_id: "slow", name: "get_summary", arguments: {} });
  ws.serverSend({ type: "reply.done", status: "completed" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ws.sent.filter((m) => m.type === "tool.result").length, 1);
});

test("a throwing tool handler produces is_error:true instead of breaking the session", async () => {
  const { session } = make({ toolHandler: () => { throw new Error("boom"); } });
  const ws = await startReady(session);
  ws.serverSend({ type: "tool.call", call_id: "x", name: "log_reading", arguments: {} });
  ws.serverSend({ type: "reply.done", status: "completed" });
  await tick();
  const result = ws.sent.find((m) => m.type === "tool.result");
  assert.equal(result.is_error, true);
  assert.match(result.result, /boom/);
  assert.equal(session.status, "ready");
});

test("tool handler results with is_error are passed through", async () => {
  const { session } = make({ toolHandler: () => ({ is_error: true, result: { error: "unit missing" } }) });
  const ws = await startReady(session);
  ws.serverSend({ type: "tool.call", call_id: "y", name: "log_reading", arguments: {} });
  ws.serverSend({ type: "reply.done", status: "completed" });
  await tick();
  const result = ws.sent.find((m) => m.type === "tool.result");
  assert.equal(result.is_error, true);
  assert.deepEqual(JSON.parse(result.result), { error: "unit missing" });
});

test("interrupted reply: emits 'interrupted' and discards pending tool results", async () => {
  const { session } = make();
  const ws = await startReady(session);
  let interrupted = 0;
  session.on("interrupted", () => { interrupted += 1; });
  ws.serverSend({ type: "tool.call", call_id: "z", name: "log_reading", arguments: {} });
  ws.serverSend({ type: "reply.done", status: "interrupted" });
  await tick();
  assert.equal(interrupted, 1);
  assert.ok(!ws.types().includes("tool.result"));
  // and a later normal reply.done must not resurrect the discarded result
  ws.serverSend({ type: "reply.done", status: "completed" });
  await tick();
  assert.ok(!ws.types().includes("tool.result"));
});

test("latency = input.speech.stopped -> first reply.audio, once per turn", async () => {
  const { session, clock } = make();
  const ws = await startReady(session);
  const values = [];
  session.on("latency", (ms) => values.push(ms));
  ws.serverSend({ type: "input.speech.started" });
  clock.t = 5000;
  ws.serverSend({ type: "input.speech.stopped" });
  clock.t = 5420;
  ws.serverSend({ type: "reply.audio", data: "AA==" });
  clock.t = 5500;
  ws.serverSend({ type: "reply.audio", data: "AA==" });
  assert.deepEqual(values, [420]);
  clock.t = 9000; ws.serverSend({ type: "input.speech.stopped" });
  clock.t = 9300; ws.serverSend({ type: "reply.audio", data: "AA==" });
  assert.deepEqual(values, [420, 300]);
});

test("events: partial (text or delta), final transcripts, agent text, audio, activity", async () => {
  const { session } = make();
  const ws = await startReady(session);
  const seen = { partial: [], user: [], agent: [], audio: [], activity: [] };
  session.on("user_partial", (t) => seen.partial.push(t));
  session.on("user_final", (t) => seen.user.push(t));
  session.on("agent_final", (t) => seen.agent.push(t));
  session.on("audio", (a) => seen.audio.push(a));
  session.on("activity", (a) => seen.activity.push(a));
  ws.serverSend({ type: "input.speech.started" });
  ws.serverSend({ type: "transcript.user.delta", text: "P 204" });
  ws.serverSend({ type: "transcript.user.delta", delta: "P 204 bearing" });
  ws.serverSend({ type: "input.speech.stopped" });
  ws.serverSend({ type: "transcript.user", text: "P-204 bearing is 82 C." });
  ws.serverSend({ type: "reply.started", reply_id: "r" });
  ws.serverSend({ type: "reply.audio", data: "QQ==" });
  ws.serverSend({ type: "transcript.agent", text: "Logged. Watch level.", interrupted: false });
  ws.serverSend({ type: "reply.done", status: "completed" });
  assert.deepEqual(seen.partial, ["P 204", "P 204 bearing"]);
  assert.deepEqual(seen.user, ["P-204 bearing is 82 C."]);
  assert.deepEqual(seen.agent, [{ text: "Logged. Watch level.", interrupted: false }]);
  assert.deepEqual(seen.audio, ["QQ=="]);
  assert.deepEqual(seen.activity, ["user_speaking", "thinking", "speaking", "listening"]);
});

test("session.error before ready rejects start() and emits exactly one error", async () => {
  const { session } = make();
  const errors = [];
  session.on("error", (e) => errors.push(e));
  const promise = session.start();
  await tick(); await tick();
  const ws = FakeWebSocket.instances.at(-1);
  ws.serverSend({ type: "session.error", code: "invalid_value", message: "bad voice" });
  await assert.rejects(promise, /bad voice/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "invalid_value");
  assert.equal(session.status, "error");
});

test("session.error accepts the alternative error_code field", async () => {
  const { session } = make();
  const promise = session.start();
  await tick(); await tick();
  FakeWebSocket.instances.at(-1).serverSend({ type: "session.error", error_code: "immutable_field", message: "nope" });
  await assert.rejects(promise, (error) => error.code === "immutable_field");
});

test("socket closing before ready rejects with a helpful message", async () => {
  const { session } = make();
  const promise = session.start();
  await tick(); await tick();
  FakeWebSocket.instances.at(-1).close(1006);
  await assert.rejects(promise, /closed before the agent was ready \(code 1006\)/);
  assert.equal(session.status, "error");
});

test("token failure surfaces the server's message and code, and opens no socket", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: "passcode_required", message: "A demo passcode is required." }) });
  const { session } = make({ fetchImpl });
  await assert.rejects(session.start(), (error) => error.code === "passcode_required" && /passcode/.test(error.message));
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(session.status, "error");
});

test("token headers (passcode) are sent to the token endpoint", async () => {
  const fetchImpl = okFetch();
  const { session } = make({ fetchImpl, tokenHeaders: () => ({ "x-demo-passcode": "letmein" }) });
  await startReady(session);
  assert.equal(fetchImpl.calls[0].options.headers["x-demo-passcode"], "letmein");
});

test("ready timeout: rejects and closes the socket", async () => {
  const { session } = make({ readyTimeoutMs: 20 });
  const promise = session.start();
  await assert.rejects(promise, /Timed out/);
  assert.equal(FakeWebSocket.instances.at(-1).closed, true);
});

test("end(): sends session.end, waits for session.ended, then closes", async () => {
  const { session } = make();
  const ws = await startReady(session);
  let ended = 0;
  session.on("ended", () => { ended += 1; });
  const done = session.end();
  await tick();
  assert.equal(ws.sent.at(-1).type, "session.end");
  assert.equal(ws.closed, false, "not closed until the server says so");
  ws.serverSend({ type: "session.ended", session_duration_seconds: 5 });
  await done;
  assert.equal(ended, 1);
  assert.equal(ws.closed, true);
  assert.equal(session.status, "ended");
});

test("end(): if the server never answers, it still closes after the timeout", async () => {
  const { session } = make({ endTimeoutMs: 20 });
  const ws = await startReady(session);
  await session.end();
  assert.equal(ws.closed, true);
});

test("endSync(): sends session.end synchronously (page unload)", async () => {
  const { session } = make();
  const ws = await startReady(session);
  session.endSync();
  assert.equal(ws.sent.at(-1).type, "session.end");
});

test("say(): sends reply.create with instructions only when ready", async () => {
  const { session } = make();
  assert.equal(session.say("hello"), false);
  const ws = await startReady(session);
  assert.equal(session.say("Tell the user the timer finished."), true);
  assert.deepEqual(ws.sent.at(-1), { type: "reply.create", instructions: "Tell the user the timer finished." });
});

test("unexpected close while ready surfaces an error and ends the session", async () => {
  const { session } = make();
  const ws = await startReady(session);
  const errors = [];
  session.on("error", (e) => errors.push(e));
  ws.close(1011);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /connection was lost \(code 1011\)/);
  assert.equal(session.status, "ended");
});

test("start() cannot be called twice", async () => {
  const { session } = make();
  await startReady(session);
  await assert.rejects(session.start(), /Cannot start/);
});
