import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../api/voice-token.js";

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b; };
  res.json = () => JSON.parse(res.body);
  return res;
}
const fakeReq = (over = {}) => ({ method: "GET", headers: {}, socket: { remoteAddress: "9.9.9.9" }, ...over });

function upstream(body = { token: "one-time-token" }, ok = true, status = 200) {
  const calls = [];
  const fn = async (url, options) => { calls.push({ url: String(url), options }); return { ok, status, json: async () => body }; };
  fn.calls = calls;
  return fn;
}
const ENV = { ASSEMBLYAI_API_KEY: "secret-key-value" };

test("returns a token, caps the session, forbids caching", async () => {
  const fetchImpl = upstream();
  const res = fakeRes();
  await createHandler({ fetchImpl, env: ENV })(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { token: "one-time-token", max_session_seconds: 300 });
  assert.equal(res.headers["cache-control"], "no-store");
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://agents.assemblyai.com/v1/token");
  assert.equal(url.searchParams.get("expires_in_seconds"), "120");
  assert.equal(url.searchParams.get("max_session_duration_seconds"), "300");
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, "Bearer secret-key-value");
});

test("the API key never appears in any response", async () => {
  for (const [fetchImpl, env] of [
    [upstream(), ENV],
    [upstream({ detail: "secret-key-value" }, false, 401), ENV],
    [async () => { throw new Error("secret-key-value exploded"); }, ENV],
  ]) {
    const res = fakeRes();
    await createHandler({ fetchImpl, env })(fakeReq(), res);
    assert.doesNotMatch(res.body, /secret-key-value/);
  }
});

test("MAX_SESSION_SECONDS is clamped to 60..10800 and defaults to 300", async () => {
  for (const [value, expected] of [["10", 60], ["999999", 10800], ["abc", 300], [undefined, 300], ["120", 120]]) {
    const fetchImpl = upstream();
    const res = fakeRes();
    await createHandler({ fetchImpl, env: { ...ENV, MAX_SESSION_SECONDS: value } })(fakeReq(), res);
    assert.equal(res.json().max_session_seconds, expected, String(value));
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get("max_session_duration_seconds"), String(expected));
  }
});

test("missing API key -> 500 with a setup hint, upstream never called", async () => {
  const fetchImpl = upstream();
  const res = fakeRes();
  await createHandler({ fetchImpl, env: {} })(fakeReq(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "server_not_configured");
  assert.equal(fetchImpl.calls.length, 0);
});

test("only GET is allowed", async () => {
  const res = fakeRes();
  await createHandler({ fetchImpl: upstream(), env: ENV })(fakeReq({ method: "POST" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET");
});

test("upstream failure, bad body and timeouts all become a generic 502", async () => {
  for (const fetchImpl of [
    upstream({}, false, 500),
    upstream({ nope: 1 }),
    async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
  ]) {
    const res = fakeRes();
    await createHandler({ fetchImpl, env: ENV })(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "upstream_error");
  }
});

test("optional passcode: required when configured, accepted when correct", async () => {
  const env = { ...ENV, DEMO_PASSCODE: "open-sesame" };
  const handler = createHandler({ fetchImpl: upstream(), env });
  let res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "passcode_required");
  res = fakeRes();
  await handler(fakeReq({ headers: { "x-demo-passcode": "wrong" } }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await handler(fakeReq({ headers: { "x-demo-passcode": "open-sesame" } }), res);
  assert.equal(res.statusCode, 200);
});

test("per-IP rate limit: 12 per 10 minutes, other IPs unaffected, window expires", async () => {
  let t = 1_000_000;
  const fetchImpl = upstream();
  const handler = createHandler({ fetchImpl, env: ENV, now: () => t });
  for (let i = 0; i < 12; i += 1) {
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.statusCode, 200, `request ${i + 1}`);
  }
  let res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, "rate_limited");
  res = fakeRes();
  await handler(fakeReq({ socket: { remoteAddress: "8.8.8.8" } }), res);
  assert.equal(res.statusCode, 200);
  t += 10 * 60 * 1000 + 1;
  res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 200);
});

test("uses the first x-forwarded-for address as the client IP", async () => {
  const handler = createHandler({ fetchImpl: upstream(), env: ENV });
  for (let i = 0; i < 12; i += 1) await handler(fakeReq({ headers: { "x-forwarded-for": "5.5.5.5, 10.0.0.1" } }), fakeRes());
  const res = fakeRes();
  await handler(fakeReq({ headers: { "x-forwarded-for": "5.5.5.5, 10.0.0.2" } }), res);
  assert.equal(res.statusCode, 429);
});
