// session.js - the Voice Agent API connection, with no DOM and no audio hardware.
//
// Protocol notes (AssemblyAI Voice Agent API docs, "Message sequence" and
// "Events reference"):
//   * The browser never sees the API key. Our server mints a one-time token
//     and we connect to  wss://agents.assemblyai.com/v1/ws?token=...
//   * First message must be session.update; input.audio is only accepted after
//     session.ready (audio sent earlier is discarded).
//   * tool.call -> reply.done -> we answer with tool.result.
//   * reply.done with status "interrupted" means the user barged in: flush audio
//     and drop any tool results from that reply.
//   * Always send session.end before closing, otherwise a 30 s billable grace
//     window remains.

export const DEFAULT_WS_URL = "wss://agents.assemblyai.com/v1/ws";
const OPEN = 1; // WebSocket.OPEN

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are FieldLog, a hands-free voice logbook for technicians doing equipment inspections. The technician's hands are busy: they talk, you log.

Style: extremely brief. Confirm each entry in one short sentence, under twelve words. Never read back what they just said at length. Plain conversational English only: no lists, markdown or emojis.

Rules:
- When the user states a measurement (a number with a unit for a piece of equipment), call log_reading. Equipment tags such as P-204 or HX-17 are IDs: keep them exactly as spoken.
- If the equipment, the value or the unit is unclear, ask ONE short question instead of guessing.
- After log_reading, if the result flag is "watch" or "critical", say so in one plain sentence and mention the limit. If it is "normal", just confirm.
- Observations that are not numbers (leaks, noise, corrosion, damage) go to add_finding. Follow-up actions go to create_task. Waiting or cool-down periods go to start_timer.
- "Scratch that", "undo" or "that was wrong" means call undo_last.
- "How are we doing" or "summary" means call get_summary, then answer in at most two short sentences.
- "That's all", "wrap up" or "finish the report" means call finish_report, then tell them the report is ready on screen.
- If told a timer has finished, announce it in one short sentence.
- Never invent readings and never log anything the user did not say.`;

export const GREETING = "FieldLog is ready. Start with a reading whenever you like.";

export const KEY_TERMS = [
  "FieldLog", "psi", "bar", "kPa", "mm/s", "rpm", "bearing", "vibration", "impeller",
  "coupling", "gasket", "seal", "valve", "compressor", "heat exchanger", "torque",
  "cool-down", "corrosion", "P-204", "HX-17",
];

export const VOICES = ["alba", "eve", "jane", "michael", "george"];

export function buildSessionConfig({ tools, voice = "alba", keyterms = KEY_TERMS } = {}) {
  return {
    system_prompt: SYSTEM_PROMPT,
    greeting: GREETING,
    tools,
    input: {
      format: { encoding: "audio/pcm" },
      keyterms,
      turn_detection: { interrupt_response: true },
    },
    output: { voice, format: { encoding: "audio/pcm" }, volume: 100 },
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class VoiceAgentSession {
  /**
   * @param {object} options
   * @param {object} options.sessionConfig  the `session` object for session.update
   * @param {(name:string,args:object,callId:string)=>Promise<{result:object,is_error?:boolean}>|{result:object,is_error?:boolean}} options.toolHandler
   */
  constructor({
    sessionConfig,
    toolHandler,
    tokenUrl = "/api/voice-token",
    tokenHeaders = () => ({}),
    wsUrl = DEFAULT_WS_URL,
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => performance.now(),
    readyTimeoutMs = 15000,
    endTimeoutMs = 2000,
  }) {
    this.sessionConfig = sessionConfig;
    this.toolHandler = toolHandler;
    this.tokenUrl = tokenUrl;
    this.tokenHeaders = tokenHeaders;
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.readyTimeoutMs = readyTimeoutMs;
    this.endTimeoutMs = endTimeoutMs;

    this.status = "idle"; // idle | connecting | ready | ending | ended | error
    this.sessionId = null;
    this.maxSessionSeconds = null;
    this.ws = null;

    this._listeners = new Map();
    this._toolPromises = [];
    this._stoppedAt = null;
    this._awaitFirstAudio = false;
    this._startResolve = null;
    this._startReject = null;
    this._endResolve = null;
  }

  // ---- tiny event emitter -------------------------------------------------
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) {
      try { fn(payload); } catch (error) { console.error(`listener for "${event}" threw`, error); }
    }
  }

  _setStatus(status) {
    this.status = status;
    this._emit("status", status);
  }

  get ready() {
    return this.status === "ready";
  }

  // ---- lifecycle ----------------------------------------------------------
  /** Fetch a token, open the socket, configure the agent. Resolves at session.ready. */
  async start() {
    if (this.status !== "idle") throw new Error(`Cannot start a session that is ${this.status}.`);
    this._setStatus("connecting");

    let token;
    try {
      const response = await this.fetchImpl(this.tokenUrl, { headers: this.tokenHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.message || `Token request failed (${response.status}).`);
        error.code = body.error || `http_${response.status}`;
        throw error;
      }
      token = body.token;
      this.maxSessionSeconds = body.max_session_seconds ?? null;
      if (!token) throw new Error("The server did not return a token.");
    } catch (error) {
      this._fail(error);
      throw error;
    }

    return new Promise((resolve, reject) => {
      this._startResolve = resolve;
      this._startReject = reject;
      this._readyTimer = setTimeout(() => {
        this._failStart(new Error("Timed out waiting for the voice agent to become ready."));
        this._closeSocket();
      }, this.readyTimeoutMs);

      const url = `${this.wsUrl}?token=${encodeURIComponent(token)}`;
      const ws = new this.WebSocketImpl(url);
      this.ws = ws;
      ws.addEventListener("open", () => this._send({ type: "session.update", session: this.sessionConfig }));
      ws.addEventListener("message", (event) => this._onRawMessage(event));
      ws.addEventListener("close", (event) => this._onClose(event));
      ws.addEventListener("error", () => this._emit("log", { dir: "in", type: "socket.error" }));
    });
  }

  /** Graceful end: session.end, wait for session.ended, then close. */
  async end() {
    if (!this.ws || this.status === "idle" || this.status === "ended" || this.status === "error") {
      this._closeSocket();
      return;
    }
    this._setStatus("ending");
    if (this.ws.readyState === OPEN) {
      this._send({ type: "session.end" });
      await new Promise((resolve) => {
        this._endResolve = resolve;
        setTimeout(resolve, this.endTimeoutMs);
      });
    }
    this._closeSocket();
    if (this.status !== "error") this._setStatus("ended");
  }

  /** Synchronous variant for the page `pagehide` event. */
  endSync() {
    if (this.ws && this.ws.readyState === OPEN) this._send({ type: "session.end" });
  }

  /** Stream one base64 PCM16 chunk (24 kHz mono). Dropped until session.ready. */
  sendAudio(base64) {
    if (!this.ready || !this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify({ type: "input.audio", audio: base64 }));
    return true;
  }

  /** Ask the agent to speak now (e.g. timer finished). */
  say(instructions) {
    if (!this.ready) return false;
    this._send({ type: "reply.create", instructions });
    return true;
  }

  // ---- internals ----------------------------------------------------------
  _send(message) {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify(message));
    if (message.type !== "input.audio") this._emit("log", { dir: "out", type: message.type });
  }

  _onRawMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.type !== "reply.audio") this._emit("log", { dir: "in", type: message.type });
    this._route(message);
  }

  _route(message) {
    switch (message.type) {
      case "session.ready":
        clearTimeout(this._readyTimer);
        this.sessionId = message.session_id ?? null;
        this._setStatus("ready");
        this._emit("activity", "listening");
        this._startResolve?.(message);
        this._startResolve = this._startReject = null;
        break;

      case "input.speech.started":
        this._awaitFirstAudio = false;
        this._emit("activity", "user_speaking");
        break;

      case "transcript.user.delta":
        // Docs disagree on the field name (`text` vs `delta`); accept both.
        this._emit("user_partial", message.text ?? message.delta ?? "");
        break;

      case "input.speech.stopped":
        this._stoppedAt = this.now();
        this._awaitFirstAudio = true;
        this._emit("activity", "thinking");
        break;

      case "transcript.user":
        this._emit("user_final", message.text ?? "");
        break;

      case "reply.started":
        this._emit("activity", "speaking");
        break;

      case "reply.audio":
        if (this._awaitFirstAudio && this._stoppedAt != null) {
          this._awaitFirstAudio = false;
          this._emit("latency", Math.round(this.now() - this._stoppedAt));
        }
        this._emit("audio", message.data);
        break;

      case "transcript.agent":
        this._emit("agent_final", { text: message.text ?? "", interrupted: !!message.interrupted });
        break;

      case "tool.call":
        this._onToolCall(message);
        break;

      case "reply.done":
        if (message.status === "interrupted") {
          this._toolPromises = []; // results from an interrupted reply are discarded
          this._emit("interrupted");
        } else {
          this._flushToolResults();
        }
        this._emit("activity", "listening");
        break;

      case "session.error": {
        const code = message.code ?? message.error_code ?? "unknown_error";
        const error = new Error(message.message || code);
        error.code = code;
        if (this._startReject) this._failStart(error); // emits "error" once
        else this._emit("error", error);
        break;
      }

      case "session.ended":
        clearTimeout(this._readyTimer);
        this._emit("ended", message);
        this._endResolve?.();
        this._endResolve = null;
        break;

      default:
        break;
    }
  }

  _onToolCall(message) {
    const { call_id: callId, name, arguments: args } = message;
    this._emit("tool_call", { call_id: callId, name, arguments: args });
    const run = Promise.resolve()
      .then(() => this.toolHandler(name, args ?? {}, callId))
      .then(
        (outcome) => ({
          call_id: callId,
          result: JSON.stringify(outcome?.result ?? outcome ?? {}),
          is_error: !!outcome?.is_error,
        }),
        (error) => ({
          call_id: callId,
          result: JSON.stringify({ error: String(error?.message ?? error) }),
          is_error: true,
        }),
      );
    this._toolPromises.push(run);
  }

  async _flushToolResults() {
    if (this._toolPromises.length === 0) return;
    const pending = this._toolPromises;
    this._toolPromises = [];
    const results = await Promise.all(pending);
    for (const result of results) {
      this._send({ type: "tool.result", ...result });
      this._emit("tool_result", result);
    }
  }

  _onClose(event) {
    clearTimeout(this._readyTimer);
    const code = event?.code;
    if (this._startReject) {
      this._failStart(new Error(
        `The connection closed before the agent was ready (code ${code ?? "unknown"}). ` +
        "This usually means the one-time token was rejected or expired; try again.",
      ));
    } else if (this.status === "ready") {
      this._emit("error", new Error(`The connection was lost (code ${code ?? "unknown"}).`));
      this._setStatus("ended");
    }
    this._endResolve?.();
    this._endResolve = null;
    this._emit("closed", { code });
  }

  _failStart(error) {
    clearTimeout(this._readyTimer);
    const reject = this._startReject;
    this._startResolve = this._startReject = null;
    this._fail(error);
    reject?.(error);
  }

  _fail(error) {
    if (this.status !== "error") {
      this._setStatus("error");
      this._emit("error", error);
    }
  }

  _closeSocket() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
  }
}
