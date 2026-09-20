# FieldLog - talk, and it's logged

**A hands-free voice logbook for people whose hands are busy.** A technician walks
an inspection, speaks readings, findings and follow-ups, and FieldLog turns the
conversation into a structured, exportable report - live, on screen, while they talk.

Built for the **AssemblyAI Voice Agent Hackathon** on the
[AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents).

> Demo URL: _add your deployed URL here_  |  Video: _add link_  |  Slides: _add link_

## The problem

Inspections, maintenance rounds and lab work all end the same way: someone
re-types notes from a clipboard, a phone or memory into a form, hours later, with
transcription errors ("P-204" becomes "P204", "82" becomes "28") and no
timestamps. Gloves, grease and noise make typing impractical on the job. Voice is
the natural input - but a plain dictation app just produces a blob of text.

## What FieldLog does

You say:

> "P-204 bearing temperature is 82 degrees Celsius."

FieldLog:

1. hears it (AssemblyAI speech-to-text tuned for numbers and equipment tags),
2. decides it is a *measurement* and calls the `log_reading` tool,
3. converts units (°F, bar, in/s ...) and checks the value against limits,
4. answers out loud in one short sentence: "Logged. Watch level - limit is 80."
5. shows a new row in the live logbook, ready to export.

Other things you can say: findings ("small oil leak at the P-204 seal, major"),
follow-up tasks ("replace the seal next week, high priority"), timers
("start a 10 minute cool-down" - it tells you when it ends), corrections
("scratch that"), status ("how are we doing?") and "finish the report", which opens
a printable report and a CSV download.

## How it uses the AssemblyAI Voice Agent API

| Capability | How FieldLog uses it |
| --- | --- |
| Single WebSocket voice agent | One connection carries speech in, speech out, transcripts and events. No separate STT / LLM / TTS wiring. |
| JSON-Schema tool calling | Eight client-side tools (`log_reading`, `add_finding`, `create_task`, `start_timer`, `undo_last`, `get_summary`, `start_inspection`, `finish_report`) turn speech into structured data. Enums and examples in the schemas sharpen accuracy on units and tags. |
| Key-term boosting | `input.keyterms` biases transcription toward inspection vocabulary. |
| Turn detection + barge-in | The agent can be interrupted mid-sentence; the client flushes playback instantly and discards tool results from the interrupted reply. |
| Tool results feed the reply | The `flag` returned by `log_reading` is what makes the agent say "watch level" or "critical". |
| `reply.create` | When a timer finishes, the app asks the agent to announce it. |
| Clean shutdown | `session.end` is always sent (including on tab close) so no billable grace window is left open. |

The page also measures **response time** (end of your speech to first agent audio)
and shows the last and median values, so the speed is visible, not claimed.

## Architecture

```
Browser (public/)                                  Server (api/)          AssemblyAI
+---------------------------------------+   GET   +---------------+
| audio.js   mic -> 24 kHz PCM16 chunks  |-------->| voice-token.js|--key-->  /v1/token
| session.js Voice Agent protocol        |<--token-|  (holds the   |<-token-
| tools.js   logbook, limits, units      |         |   API key)    |
| app.js     page wiring                 |         +---------------+
+-------------------|-------------------+
                    | wss://agents.assemblyai.com/v1/ws?token=<one-time>
                    v
           AssemblyAI Voice Agent API (STT + LLM + voice)
```

* The **API key never reaches the browser.** The server mints a one-time token
  (`GET /v1/token`) and the browser connects with that.
* The **tools run in the browser**, next to the UI: the agent decides *when* to
  call a tool, the tool decides *what happens* (validation, unit conversion,
  limits, state).
* No database. Nothing is stored by this app; the log lives in the page until you
  export it.

## Run it locally

Needs [Node.js](https://nodejs.org) 18+ and an AssemblyAI API key.

```bash
git clone <this repo>
cd fieldlog
cp .env.example .env        # then put your key in .env
npm start                   # http://localhost:3000
```

Use headphones or laptop speakers - browsers cancel the echo. The microphone works
on `localhost` and on HTTPS only.

## Deploy (Vercel)

1. Push this repo to GitHub.
2. In Vercel: **Add New -> Project**, import the repo, framework preset **Other**.
3. Add environment variable `ASSEMBLYAI_API_KEY`.
4. Optional: `MAX_SESSION_SECONDS` (default 300) and `DEMO_PASSCODE`.
5. Deploy and open the URL.

## Protecting a public demo

A public page that starts paid voice sessions must limit abuse:

* every session is capped (`MAX_SESSION_SECONDS`, default 5 minutes);
* tokens are single-use and expire in 2 minutes;
* per-IP rate limit (12 sessions / 10 minutes; best effort, per server instance);
* optional `DEMO_PASSCODE` that visitors must enter;
* the API key exists only in server environment variables.

## Tests

```bash
npm install     # installs jsdom, used only by the DOM tests
npm test
```

70 automated tests cover the tool logic and unit conversion, the exact message
sequence of the Voice Agent protocol (against a fake server), the token endpoint
(including "the key never appears in any response"), and the page wiring in a
simulated browser - including a test that speech text can never inject markup.
The audio resampler is checked against a synthetic 440 Hz tone.

## Honest limits

* Alarm limits (80 C / 120 psi / 4.5 mm/s ...) are **demo values** in
  `public/js/tools.js`; a real deployment would load them per asset.
* Speech recognition, like any, can mishear a tag; the agent is instructed to ask
  one short question when unsure rather than guess, and "scratch that" undoes the
  last entry.
* The log is in-page only (export to CSV or print to PDF). Persisting to a
  maintenance system (CMMS) is the obvious next step and is not implemented.
* Verified against the AssemblyAI documentation and a simulated server; behaviour
  on the live service depends on your account and network.

## Project layout

```
api/voice-token.js     token endpoint (server)
public/index.html      page
public/style.css
public/js/session.js   Voice Agent protocol client
public/js/tools.js     tool schemas + logbook logic
public/js/audio.js     microphone + playback
public/js/pcm-processor.js   AudioWorklet (resample to 24 kHz PCM16)
public/js/app.js       page wiring
server.js              local dev server
tests/                 node --test suites
```

## License

MIT - see [LICENSE](LICENSE).
