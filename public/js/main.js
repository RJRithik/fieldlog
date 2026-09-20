import { initApp } from "./app.js";
import { AudioIO } from "./audio.js";

initApp({ document, window, createAudio: (options) => new AudioIO(options) });
