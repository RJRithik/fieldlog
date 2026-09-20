// tools.js - the FieldLog "brain that lives in the browser".
//
// The Voice Agent API decides WHEN to call a tool (from what the technician
// says). The functions here decide WHAT happens: validate the values, convert
// units, check limits and keep the structured log. Pure JavaScript with no DOM,
// so it runs in the browser and under `node --test`.

// ---------------------------------------------------------------------------
// Tool schemas (sent to the Voice Agent API in session.update -> session.tools)
// ---------------------------------------------------------------------------

const PARAMETERS = [
  "temperature", "pressure", "vibration", "voltage", "current",
  "level", "flow", "speed", "other",
];
const SEVERITIES = ["info", "minor", "major", "critical"];
const PRIORITIES = ["low", "normal", "high"];

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "start_inspection",
    description:
      "Record the site and the inspector's name when the user mentions them. " +
      "Call once, only if the user actually says a site or a name.",
    parameters: {
      type: "object",
      properties: {
        site: { type: "string", description: "Plant, site or area name, e.g. 'Pump House 2'." },
        inspector: { type: "string", description: "Name of the person doing the inspection." },
      },
    },
  },
  {
    type: "function",
    name: "log_reading",
    description:
      "Log a measurement the user states, such as 'P-204 bearing temperature is 82 degrees Celsius'. " +
      "Use this whenever a number with a unit is given for a piece of equipment. " +
      "The result says whether the value is normal, watch or critical; tell the user if it is not normal.",
    parameters: {
      type: "object",
      properties: {
        asset_id: {
          type: "string",
          description: "Equipment tag exactly as spoken, e.g. P-204, HX-17, V-3.",
          examples: ["P-204", "HX-17"],
        },
        parameter: { type: "string", enum: PARAMETERS, description: "What was measured." },
        value: { type: "number", description: "The numeric value." },
        unit: { type: "string", description: "Unit as spoken, e.g. C, F, psi, bar, mm/s." },
        notes: { type: "string", description: "Optional extra detail the user gave." },
      },
      required: ["asset_id", "parameter", "value", "unit"],
    },
  },
  {
    type: "function",
    name: "add_finding",
    description:
      "Log an observation that is not a number: a leak, noise, corrosion, damage, a missing guard. " +
      "Choose the severity from what the user says.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "Equipment tag, e.g. P-204." },
        description: { type: "string", description: "What was observed, in the user's words." },
        severity: { type: "string", enum: SEVERITIES },
      },
      required: ["asset_id", "description", "severity"],
    },
  },
  {
    type: "function",
    name: "create_task",
    description: "Create a follow-up action, e.g. 'replace the seal next week'.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "Equipment tag the task relates to." },
        action: { type: "string", description: "What needs to be done." },
        due: { type: "string", description: "When, as spoken: 'tomorrow', 'next week', 'Friday'." },
        priority: { type: "string", enum: PRIORITIES },
      },
      required: ["asset_id", "action"],
    },
  },
  {
    type: "function",
    name: "start_timer",
    description: "Start a countdown timer, e.g. a cool-down or wait period. Minutes may be fractional.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "Length in minutes, e.g. 10 or 0.5." },
        label: { type: "string", description: "What the timer is for, e.g. 'cool-down'." },
      },
      required: ["minutes"],
    },
  },
  {
    type: "function",
    name: "undo_last",
    description:
      "Remove the most recent reading, finding or task. Use when the user says 'scratch that', " +
      "'undo', 'that was wrong' or 'delete the last one'.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_summary",
    description:
      "Get counts and any flagged readings so far. Use when the user asks how it is going or for a summary.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "finish_report",
    description:
      "Close the inspection and show the finished report on screen. Use when the user says they are " +
      "done, wraps up, or asks for the report.",
    parameters: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Limits and unit conversion (demo values; a real deployment loads these per asset)
// ---------------------------------------------------------------------------

export const LIMITS = {
  temperature: { unit: "C", watch: 80, critical: 95 },
  pressure: { unit: "psi", watch: 120, critical: 150 },
  vibration: { unit: "mm/s", watch: 4.5, critical: 7.1 },
};

const CONVERTERS = {
  temperature: {
    c: (v) => v,
    f: (v) => ((v - 32) * 5) / 9,
    k: (v) => v - 273.15,
  },
  pressure: {
    psi: (v) => v,
    bar: (v) => v * 14.5038,
    kpa: (v) => v * 0.145038,
    mpa: (v) => v * 145.038,
  },
  vibration: {
    "mm/s": (v) => v,
    "in/s": (v) => v * 25.4,
  },
};

export function normalizeUnit(raw) {
  let u = String(raw ?? "").toLowerCase().trim();
  u = u.replace(/[°º]/g, "").replace(/\bdegrees?\b/g, "").replace(/\bdeg\b/g, "");
  u = u.replace(/millimet(?:er|re)s?\s*(?:per|\/)\s*(?:second|sec|s)\b/g, "mm/s");
  u = u.replace(/inch(?:es)?\s*(?:per|\/)\s*(?:second|sec|s)\b/g, "in/s");
  u = u.replace(/pounds?\s*(?:per|\/)\s*square\s*inch/g, "psi");
  u = u.replace(/kilopascals?/g, "kpa").replace(/megapascals?/g, "mpa");
  u = u.replace(/\s+/g, "");
  const aliases = {
    celsius: "c", centigrade: "c", fahrenheit: "f", kelvin: "k",
    mms: "mm/s", ips: "in/s", pascals: "pa",
  };
  return aliases[u] ?? u;
}

export function evaluateReading(parameter, value, unit) {
  const limit = LIMITS[parameter];
  if (!limit) return { flag: "unchecked", standardValue: value, standardUnit: unit, limitText: "" };
  const convert = CONVERTERS[parameter]?.[normalizeUnit(unit)];
  if (!convert) {
    return { flag: "unchecked", standardValue: value, standardUnit: unit, limitText: "unit not recognised" };
  }
  const standardValue = Math.round(convert(value) * 10) / 10;
  const limitText = `watch above ${limit.watch} ${limit.unit}, critical above ${limit.critical} ${limit.unit}`;
  let flag = "normal";
  if (standardValue >= limit.critical) flag = "critical";
  else if (standardValue >= limit.watch) flag = "watch";
  return { flag, standardValue, standardUnit: limit.unit, limitText };
}

// ---------------------------------------------------------------------------
// Logbook state + tool handlers
// ---------------------------------------------------------------------------

const MAX_TIMER_MINUTES = 240;

function cleanText(value, max = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeAssetId(raw) {
  return cleanText(raw, 40).toUpperCase();
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value.replace(/,/g, ""));
  return NaN;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createLogbook({
  now = () => new Date(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (id) => clearTimeout(id),
  onTimerDone = () => {},
} = {}) {
  let state;
  let counters;
  const history = [];
  const timerHandles = new Map();
  const listeners = new Set();

  function fresh() {
    state = {
      meta: { site: "", inspector: "", started_at: now().toISOString() },
      readings: [], findings: [], tasks: [], timers: [],
      finished: false,
    };
    counters = { R: 0, F: 0, T: 0, TM: 0 };
    history.length = 0;
  }
  fresh();

  const emit = () => listeners.forEach((fn) => fn(snapshot()));
  const stamp = () => now().toISOString();
  const nextId = (prefix) => `${prefix}${++counters[prefix]}`;

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function summary() {
    const flagged = state.readings
      .filter((r) => r.flag === "watch" || r.flag === "critical")
      .map((r) => ({ id: r.id, asset_id: r.asset_id, parameter: r.parameter, value: r.value, unit: r.unit, flag: r.flag }));
    return {
      site: state.meta.site || null,
      readings: state.readings.length,
      findings: state.findings.length,
      tasks: state.tasks.length,
      flagged_readings: flagged,
      major_findings: state.findings.filter((f) => f.severity === "major" || f.severity === "critical").length,
      active_timers: state.timers.filter((t) => !t.done).length,
    };
  }

  const fail = (message) => ({ is_error: true, result: { error: message } });
  const ok = (result) => ({ is_error: false, result });

  const handlers = {
    start_inspection(args) {
      const site = cleanText(args.site, 80);
      const inspector = cleanText(args.inspector, 80);
      if (!site && !inspector) return fail("Provide a site or an inspector name.");
      if (site) state.meta.site = site;
      if (inspector) state.meta.inspector = inspector;
      return ok({ recorded: true, site: state.meta.site, inspector: state.meta.inspector });
    },

    log_reading(args) {
      const asset = normalizeAssetId(args.asset_id);
      if (!asset) return fail("The equipment tag is missing. Ask the user which equipment this is.");
      const value = toNumber(args.value);
      if (!Number.isFinite(value)) return fail("The value is not a number. Ask the user to repeat it.");
      const unit = cleanText(args.unit, 20);
      if (!unit) return fail("The unit is missing. Ask the user for the unit.");
      const parameter = PARAMETERS.includes(String(args.parameter).toLowerCase())
        ? String(args.parameter).toLowerCase() : "other";

      const verdict = evaluateReading(parameter, value, unit);
      const reading = {
        id: nextId("R"), at: stamp(), asset_id: asset, parameter, value, unit,
        flag: verdict.flag, standard_value: verdict.standardValue, standard_unit: verdict.standardUnit,
        notes: cleanText(args.notes),
      };
      state.readings.push(reading);
      history.push({ kind: "readings", id: reading.id });
      return ok({
        recorded: true, id: reading.id, asset_id: asset, parameter, value, unit,
        flag: verdict.flag,
        value_in_standard_unit: `${verdict.standardValue} ${verdict.standardUnit}`,
        limits: verdict.limitText,
      });
    },

    add_finding(args) {
      const asset = normalizeAssetId(args.asset_id);
      const description = cleanText(args.description);
      if (!asset || !description) return fail("Need the equipment tag and what was observed.");
      const severity = SEVERITIES.includes(String(args.severity).toLowerCase())
        ? String(args.severity).toLowerCase() : "info";
      const finding = { id: nextId("F"), at: stamp(), asset_id: asset, description, severity };
      state.findings.push(finding);
      history.push({ kind: "findings", id: finding.id });
      return ok({ recorded: true, id: finding.id, asset_id: asset, severity });
    },

    create_task(args) {
      const asset = normalizeAssetId(args.asset_id);
      const action = cleanText(args.action);
      if (!asset || !action) return fail("Need the equipment tag and the action.");
      const priority = PRIORITIES.includes(String(args.priority).toLowerCase())
        ? String(args.priority).toLowerCase() : "normal";
      const task = {
        id: nextId("T"), at: stamp(), asset_id: asset, action,
        due: cleanText(args.due, 60) || "unspecified", priority,
      };
      state.tasks.push(task);
      history.push({ kind: "tasks", id: task.id });
      return ok({ recorded: true, id: task.id, asset_id: asset, due: task.due, priority });
    },

    start_timer(args) {
      const minutes = toNumber(args.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return fail("The timer length is not valid. Ask for minutes.");
      if (minutes > MAX_TIMER_MINUTES) return fail(`Timers are limited to ${MAX_TIMER_MINUTES} minutes.`);
      const timer = {
        id: nextId("TM"), label: cleanText(args.label, 40) || "timer", minutes,
        started_at: stamp(),
        ends_at: new Date(now().getTime() + minutes * 60000).toISOString(),
        done: false,
      };
      state.timers.push(timer);
      timerHandles.set(timer.id, setTimeoutFn(() => {
        timerHandles.delete(timer.id);
        const t = state.timers.find((x) => x.id === timer.id);
        if (!t || t.done) return;
        t.done = true;
        emit();
        onTimerDone({ ...t });
      }, minutes * 60000));
      return ok({ started: true, id: timer.id, label: timer.label, minutes });
    },

    undo_last() {
      const last = history.pop();
      if (!last) return fail("There is nothing to undo.");
      const list = state[last.kind];
      const index = list.findIndex((item) => item.id === last.id);
      const [removed] = index >= 0 ? list.splice(index, 1) : [null];
      return ok({ removed: true, kind: last.kind.slice(0, -1), item: removed });
    },

    get_summary() {
      return ok(summary());
    },

    finish_report() {
      state.finished = true;
      return ok({ report_ready: true, ...summary() });
    },
  };

  function handleToolCall(name, args = {}) {
    const handler = handlers[name];
    if (!handler) return fail(`Unknown tool: ${name}`);
    let outcome;
    try {
      outcome = handler(args && typeof args === "object" ? args : {});
    } catch (error) {
      outcome = fail(`Tool failed: ${error.message}`);
    }
    emit();
    return outcome;
  }

  function toCSV() {
    const header = ["type", "id", "time", "asset_id", "parameter", "value", "unit", "flag_or_severity", "detail"];
    const rows = [header];
    for (const r of state.readings) {
      rows.push(["reading", r.id, r.at, r.asset_id, r.parameter, r.value, r.unit, r.flag, r.notes]);
    }
    for (const f of state.findings) {
      rows.push(["finding", f.id, f.at, f.asset_id, "", "", "", f.severity, f.description]);
    }
    for (const t of state.tasks) {
      rows.push(["task", t.id, t.at, t.asset_id, "", "", "", t.priority, `${t.action} (due: ${t.due})`]);
    }
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  return {
    handleToolCall,
    snapshot,
    summary,
    toCSV,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() {
      timerHandles.forEach((handle) => clearTimeoutFn(handle));
      timerHandles.clear();
      fresh();
      emit();
    },
    dispose() {
      timerHandles.forEach((handle) => clearTimeoutFn(handle));
      timerHandles.clear();
      listeners.clear();
    },
  };
}
