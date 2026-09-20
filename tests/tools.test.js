import test from "node:test";
import assert from "node:assert/strict";
import {
  createLogbook, evaluateReading, normalizeUnit, TOOL_DEFINITIONS, LIMITS,
} from "../public/js/tools.js";

function makeBook(extra = {}) {
  const timers = [];
  const done = [];
  const clock = { t: new Date("2026-09-20T10:00:00Z").getTime() };
  const book = createLogbook({
    now: () => new Date(clock.t),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
    onTimerDone: (t) => done.push(t),
    ...extra,
  });
  return { book, timers, done, clock };
}

test("tool definitions are valid function tools with JSON-schema parameters", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "tool names are unique");
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, "function");
    assert.match(tool.name, /^[a-z_]+$/);
    assert.ok(tool.description.length > 20, `${tool.name} has a real description`);
    assert.equal(tool.parameters.type, "object");
    for (const required of tool.parameters.required ?? []) {
      assert.ok(tool.parameters.properties[required], `${tool.name}.${required} is declared`);
    }
  }
});

test("unit normalisation understands spoken units", () => {
  assert.equal(normalizeUnit("degrees Celsius"), "c");
  assert.equal(normalizeUnit("°F"), "f");
  assert.equal(normalizeUnit("Fahrenheit"), "f");
  assert.equal(normalizeUnit("millimeters per second"), "mm/s");
  assert.equal(normalizeUnit("pounds per square inch"), "psi");
  assert.equal(normalizeUnit("kilopascals"), "kpa");
});

test("limit checks: normal, watch, critical and unit conversion", () => {
  assert.equal(evaluateReading("temperature", 70, "C").flag, "normal");
  assert.equal(evaluateReading("temperature", 82, "C").flag, "watch");
  assert.equal(evaluateReading("temperature", 96, "C").flag, "critical");
  // 200 F = 93.3 C -> watch (not critical)
  const f = evaluateReading("temperature", 200, "degrees Fahrenheit");
  assert.equal(f.flag, "watch");
  assert.equal(f.standardValue, 93.3);
  assert.equal(evaluateReading("pressure", 10, "bar").standardValue, 145);
  assert.equal(evaluateReading("pressure", 10, "bar").flag, "watch");
});

test("vibration in in/s converts to mm/s before comparing", () => {
  // 0.3 in/s = 7.62 mm/s >= 7.1 -> critical
  assert.equal(evaluateReading("vibration", 0.3, "in/s").flag, "critical");
  assert.equal(evaluateReading("vibration", 0.1, "in/s").flag, "normal");
});

test("unknown parameter or unit is 'unchecked', never a false alarm", () => {
  assert.equal(evaluateReading("voltage", 230, "V").flag, "unchecked");
  assert.equal(evaluateReading("temperature", 50, "widgets").flag, "unchecked");
});

test("log_reading stores a flagged reading and reports it", () => {
  const { book } = makeBook();
  const out = book.handleToolCall("log_reading", {
    asset_id: "p-204", parameter: "temperature", value: 82, unit: "C",
  });
  assert.equal(out.is_error, false);
  assert.equal(out.result.flag, "watch");
  assert.equal(out.result.asset_id, "P-204");
  assert.match(out.result.limits, /watch above 80 C/);
  assert.equal(book.snapshot().readings.length, 1);
});

test("log_reading accepts numeric strings and rejects missing pieces", () => {
  const { book } = makeBook();
  assert.equal(book.handleToolCall("log_reading",
    { asset_id: "V-3", parameter: "pressure", value: "1,200", unit: "psi" }).result.flag, "critical");
  const noUnit = book.handleToolCall("log_reading", { asset_id: "V-3", parameter: "pressure", value: 5 });
  assert.equal(noUnit.is_error, true);
  assert.match(noUnit.result.error, /unit/i);
  assert.equal(book.handleToolCall("log_reading", { asset_id: "", parameter: "flow", value: 1, unit: "l/s" }).is_error, true);
  assert.equal(book.handleToolCall("log_reading", { asset_id: "A", parameter: "flow", value: "abc", unit: "l/s" }).is_error, true);
  assert.equal(book.snapshot().readings.length, 1, "bad calls store nothing");
});

test("unknown parameter falls back to 'other'; unknown severity to 'info'", () => {
  const { book } = makeBook();
  assert.equal(book.handleToolCall("log_reading",
    { asset_id: "A", parameter: "humidity", value: 40, unit: "%" }).result.parameter, "other");
  assert.equal(book.handleToolCall("add_finding",
    { asset_id: "A", description: "small leak", severity: "whatever" }).result.severity, "info");
});

test("findings and tasks are stored with defaults", () => {
  const { book } = makeBook();
  book.handleToolCall("add_finding", { asset_id: "p-204", description: "Seal weeping", severity: "major" });
  const task = book.handleToolCall("create_task", { asset_id: "p-204", action: "Replace seal" });
  assert.equal(task.result.priority, "normal");
  assert.equal(task.result.due, "unspecified");
  const snap = book.snapshot();
  assert.equal(snap.findings[0].severity, "major");
  assert.equal(snap.tasks[0].action, "Replace seal");
});

test("undo_last removes the most recent entry across kinds, in order", () => {
  const { book } = makeBook();
  book.handleToolCall("log_reading", { asset_id: "A", parameter: "flow", value: 1, unit: "l/s" });
  book.handleToolCall("add_finding", { asset_id: "A", description: "noise", severity: "minor" });
  const first = book.handleToolCall("undo_last");
  assert.equal(first.result.kind, "finding");
  const second = book.handleToolCall("undo_last");
  assert.equal(second.result.kind, "reading");
  const third = book.handleToolCall("undo_last");
  assert.equal(third.is_error, true);
  assert.equal(book.snapshot().readings.length, 0);
});

test("timers schedule, fire once, and notify", () => {
  const { book, timers, done } = makeBook();
  const out = book.handleToolCall("start_timer", { minutes: 10, label: "cool-down" });
  assert.equal(out.is_error, false);
  assert.equal(timers[0].ms, 600000);
  timers[0].fn();
  timers[0].fn(); // a duplicate fire must not notify twice
  assert.equal(done.length, 1);
  assert.equal(done[0].label, "cool-down");
  assert.equal(book.snapshot().timers[0].done, true);
});

test("timer validation", () => {
  const { book } = makeBook();
  assert.equal(book.handleToolCall("start_timer", { minutes: 0 }).is_error, true);
  assert.equal(book.handleToolCall("start_timer", { minutes: "soon" }).is_error, true);
  assert.equal(book.handleToolCall("start_timer", { minutes: 999 }).is_error, true);
  assert.equal(book.handleToolCall("start_timer", { minutes: 0.5 }).is_error, false);
});

test("summary lists flagged readings; finish_report marks the report ready", () => {
  const { book } = makeBook();
  book.handleToolCall("start_inspection", { site: "Pump House 2", inspector: "Asha" });
  book.handleToolCall("log_reading", { asset_id: "P-204", parameter: "temperature", value: 96, unit: "C" });
  book.handleToolCall("log_reading", { asset_id: "P-204", parameter: "vibration", value: 2, unit: "mm/s" });
  const summary = book.handleToolCall("get_summary").result;
  assert.equal(summary.readings, 2);
  assert.equal(summary.flagged_readings.length, 1);
  assert.equal(summary.flagged_readings[0].flag, "critical");
  assert.equal(summary.site, "Pump House 2");
  const finished = book.handleToolCall("finish_report");
  assert.equal(finished.result.report_ready, true);
  assert.equal(book.snapshot().finished, true);
});

test("unknown tools and thrown handlers return errors instead of crashing", () => {
  const { book } = makeBook();
  assert.equal(book.handleToolCall("launch_rocket", {}).is_error, true);
  assert.equal(book.handleToolCall("log_reading", null).is_error, true);
});

test("CSV export escapes commas and quotes (newlines are collapsed to spaces on input)", () => {
  const { book } = makeBook();
  book.handleToolCall("add_finding", { asset_id: "A-1", description: 'Bolt "M8", loose\nnear flange', severity: "minor" });
  const csv = book.toCSV();
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "type,id,time,asset_id,parameter,value,unit,flag_or_severity,detail");
  assert.match(csv, /"Bolt ""M8"", loose near flange"/);
});

test("subscribers are notified on every change and can unsubscribe", () => {
  const { book } = makeBook();
  let calls = 0;
  const off = book.subscribe(() => { calls += 1; });
  book.handleToolCall("get_summary");
  book.handleToolCall("get_summary");
  off();
  book.handleToolCall("get_summary");
  assert.equal(calls, 2);
});

test("reset clears everything", () => {
  const { book } = makeBook();
  book.handleToolCall("log_reading", { asset_id: "A", parameter: "flow", value: 1, unit: "l/s" });
  book.reset();
  assert.equal(book.snapshot().readings.length, 0);
  assert.equal(book.handleToolCall("log_reading", { asset_id: "A", parameter: "flow", value: 1, unit: "l/s" }).result.id, "R1");
});

test("LIMITS stay in sync with the converters used for them", () => {
  for (const key of Object.keys(LIMITS)) {
    assert.notEqual(evaluateReading(key, 1, LIMITS[key].unit).flag, "unchecked", key);
  }
});
