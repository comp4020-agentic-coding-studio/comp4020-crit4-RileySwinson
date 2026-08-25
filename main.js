// Orbit — the Mandelbrot and Julia sets as an instrument.
//
// Both halves of the page draw the same iteration, z -> z^2 + c, from opposite
// ends: the Mandelbrot varies c and starts z at 0, the Julia fixes c and varies
// the starting z. Clicking either one hands its orbit to the audio worklet,
// which walks that orbit and reads it out as a stereo waveform.

const DEFAULTS = {
  mandelbrot: { cx: -0.6, cy: 0, span: 3.2 },
  julia: { cx: 0, cy: 0, span: 3.2 },
};

const ORBIT_POINTS = 900;
const ESCAPE_SQ = 16;
const MAX_RENDER = 700;
const SETTLE_MS = 200; // quiet time before the full-resolution redraw

const state = {
  julia: { re: -0.1226, im: 0.7449 },
  linkJulia: true,
  rate: 2400,
  volume: 0.35,
  maxIter: 220,
  point: { panel: "mandelbrot", re: -0.1226, im: 0.7449 },
};

// ---------------------------------------------------------------- palette

// A repeating gradient rather than one stretched over maxIter, so the banding
// stays put when you change the detail slider or zoom in.
const STOPS = [
  [0.0, 8, 12, 34],
  [0.14, 26, 74, 140],
  [0.32, 84, 176, 210],
  [0.48, 226, 244, 248],
  [0.64, 250, 186, 84],
  [0.82, 158, 54, 46],
  [1.0, 8, 12, 34],
];

const PALETTE = (() => {
  const size = 1024;
  const table = new Uint8ClampedArray(size * 3);
  for (let i = 0; i < size; i++) {
    const t = i / size;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, r0, g0, b0] = STOPS[k];
    const [t1, r1, g1, b1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    table[i * 3] = r0 + (r1 - r0) * f;
    table[i * 3 + 1] = g0 + (g1 - g0) * f;
    table[i * 3 + 2] = b0 + (b1 - b0) * f;
  }
  return table;
})();

// ---------------------------------------------------------------- fractals

// Cheap containment tests for the two largest interior regions. Interior points
// cost the full iteration budget, and these two are most of the black on
// screen, so skipping them is the difference between a snappy pan and a stutter.
function inMainBody(cr, ci) {
  const q = (cr - 0.25) * (cr - 0.25) + ci * ci;
  if (q * (q + (cr - 0.25)) <= 0.25 * ci * ci) return true;
  return (cr + 1) * (cr + 1) + ci * ci <= 0.0625;
}

// Escape time with the fractional part filled in, so the bands are smooth
// rather than stepped. Returns -1 for a point that never escaped.
function escapeTime(zr, zi, cr, ci, maxIter) {
  let r2 = zr * zr;
  let i2 = zi * zi;
  let n = 0;
  while (n < maxIter && r2 + i2 <= 256) {
    zi = 2 * zr * zi + ci;
    zr = r2 - i2 + cr;
    r2 = zr * zr;
    i2 = zi * zi;
    n++;
  }
  if (n >= maxIter) return -1;
  return n + 1 - Math.log(Math.log(Math.sqrt(r2 + i2))) / Math.LN2;
}

function renderFractal(panel, size) {
  const { canvas, view, kind } = panel;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const image = context.createImageData(size, size);
  const data = image.data;
  const { maxIter } = state;
  const step = view.span / size;
  const left = view.cx - view.span / 2;
  const top = view.cy + view.span / 2;
  const isMandelbrot = kind === "mandelbrot";
  const jr = state.julia.re;
  const ji = state.julia.im;

  for (let y = 0; y < size; y++) {
    const im = top - (y + 0.5) * step;
    for (let x = 0; x < size; x++) {
      const re = left + (x + 0.5) * step;
      let value;
      if (isMandelbrot) {
        value = inMainBody(re, im) ? -1 : escapeTime(0, 0, re, im, maxIter);
      } else {
        value = escapeTime(re, im, jr, ji, maxIter);
      }

      const o = (y * size + x) * 4;
      if (value < 0) {
        data[o] = 10;
        data[o + 1] = 10;
        data[o + 2] = 18;
      } else {
        const t = (value * 0.035) % 1;
        const p = (((t * 1024) | 0) % 1024) * 3;
        data[o] = PALETTE[p];
        data[o + 1] = PALETTE[p + 1];
        data[o + 2] = PALETTE[p + 2];
      }
      data[o + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------- orbits

function orbitSeed(kind, point) {
  return kind === "mandelbrot"
    ? { cr: point.re, ci: point.im, zr: 0, zi: 0 }
    : { cr: state.julia.re, ci: state.julia.im, zr: point.re, zi: point.im };
}

// The same walk the worklet does, run once for the drawing. Stopping at the
// escape radius is why a point outside the set draws a short tail and a point
// inside draws a closed loop.
function computeOrbit(kind, point) {
  const seed = orbitSeed(kind, point);
  let zr = seed.zr;
  let zi = seed.zi;
  const path = [zr, zi];
  for (let n = 1; n < ORBIT_POINTS; n++) {
    const r = zr * zr - zi * zi + seed.cr;
    const i = 2 * zr * zi + seed.ci;
    if (!Number.isFinite(r) || !Number.isFinite(i) || r * r + i * i > ESCAPE_SQ) {
      break;
    }
    zr = r;
    zi = i;
    path.push(zr, zi);
  }
  return path;
}

// ---------------------------------------------------------------- audio

let audio = null;
let audioFailed = false;

async function setupAudio() {
  if (audio || audioFailed) return audio;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const context = new Ctor();
    await context.audioWorklet.addModule(
      new URL("fractal-processor.js", document.baseURI),
    );
    const node = new AudioWorkletNode(context, "fractal-processor", {
      outputChannelCount: [2],
      processorOptions: { voices: 10 },
    });
    node.connect(context.destination);
    node.port.postMessage({ type: "gain", value: state.volume });
    audio = { context, node };
    return audio;
  } catch (error) {
    audioFailed = true;
    setStatus(
      "This browser wouldn't start Web Audio, so there's no sound — the fractals and orbits still draw.",
    );
    console.error(error);
    return null;
  }
}

function send(message) {
  audio?.node.port.postMessage(message);
}

// The first click is both the first note and the gesture that unlocks audio.
async function wake() {
  const ready = await setupAudio();
  if (ready && ready.context.state !== "running") {
    await ready.context.resume();
    setStatus("Sound is on. Drag to bend a note.");
  }
  return ready;
}

// ---------------------------------------------------------------- notes

const notes = new Map();
let nextNoteId = 1;

function noteOn(key, kind, point, semitones = 0) {
  const panel = panels[kind];
  const id = nextNoteId++;
  const rate = state.rate * Math.pow(2, semitones / 12);
  notes.set(key, { id, kind, semitones });
  state.point = { panel: kind, re: point.re, im: point.im };
  send({ type: "noteOn", id, ...orbitSeed(kind, point), rate });
  showOrbit(panel, point, rate);
  return id;
}

function noteMove(key, point) {
  const note = notes.get(key);
  if (!note) return;
  const rate = state.rate * Math.pow(2, note.semitones / 12);
  state.point = { panel: note.kind, re: point.re, im: point.im };
  send({ type: "update", id: note.id, ...orbitSeed(note.kind, point), rate });
  showOrbit(panels[note.kind], point, rate);
}

function noteOff(key) {
  const note = notes.get(key);
  if (!note) return;
  notes.delete(key);
  send({ type: "noteOff", id: note.id });
  const stillSounding = [...notes.values()].some((n) => n.kind === note.kind);
  if (!stillSounding) panels[note.kind].sounding = false;
}

function retuneAll() {
  for (const note of notes.values()) {
    send({
      type: "noteRate",
      id: note.id,
      rate: state.rate * Math.pow(2, note.semitones / 12),
    });
  }
  for (const panel of Object.values(panels)) {
    if (panel.sounding) panel.orbitRate = state.rate;
  }
}

// ---------------------------------------------------------------- panels

const panels = {};

function makePanel(kind) {
  const plot = document.querySelector(`.plot[data-view="${kind}"]`);
  const panel = {
    kind,
    plot,
    canvas: plot.querySelector(".fractal"),
    overlay: plot.querySelector(".overlay"),
    view: { ...DEFAULTS[kind] },
    orbit: null,
    orbitRate: 0,
    playhead: 0,
    sounding: false,
    dirty: true,
    interacting: false,
    settleAt: 0,
  };
  panels[kind] = panel;
  return panel;
}

function toComplex(panel, event) {
  const rect = panel.overlay.getBoundingClientRect();
  const u = (event.clientX - rect.left) / rect.width - 0.5;
  const v = (event.clientY - rect.top) / rect.height - 0.5;
  return {
    re: panel.view.cx + u * panel.view.span,
    im: panel.view.cy - v * panel.view.span,
  };
}

function toPixels(panel, re, im, size) {
  return [
    ((re - panel.view.cx) / panel.view.span + 0.5) * size,
    (0.5 - (im - panel.view.cy) / panel.view.span) * size,
  ];
}

function showOrbit(panel, point, rate) {
  panel.orbit = computeOrbit(panel.kind, point);
  panel.orbitRate = rate;
  panel.playhead = 0;
  panel.sounding = true;
  if (panel.kind === "mandelbrot" && state.linkJulia) setJulia(point, true);
}

function drawOverlay(panel) {
  const overlay = panel.overlay;
  const size = Math.max(1, Math.round(panel.plot.clientWidth));
  if (overlay.width !== size) {
    overlay.width = size;
    overlay.height = size;
  }
  const context = overlay.getContext("2d");
  context.clearRect(0, 0, size, size);

  // Where c sits, so the two panels read as one picture.
  if (panel.kind === "mandelbrot") {
    const [x, y] = toPixels(panel, state.julia.re, state.julia.im, size);
    context.strokeStyle = "rgba(255,255,255,0.85)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.stroke();
  }

  const path = panel.orbit;
  if (!path || path.length < 4) return;

  const count = path.length / 2;
  context.lineWidth = 1.25;
  context.lineJoin = "round";

  // Drawn as segments rather than one stroke so the tail can fade: the early
  // steps are the loud ones, and a settled cycle ends up drawn over itself.
  for (let n = 1; n < count; n++) {
    const [x0, y0] = toPixels(panel, path[(n - 1) * 2], path[(n - 1) * 2 + 1], size);
    const [x1, y1] = toPixels(panel, path[n * 2], path[n * 2 + 1], size);
    const fade = 0.16 + 0.74 * (1 - n / count);
    context.strokeStyle = `rgba(255, 236, 190, ${fade.toFixed(3)})`;
    context.beginPath();
    context.moveTo(x0, y0);
    context.lineTo(x1, y1);
    context.stroke();
  }

  for (let n = 0; n < Math.min(count, 64); n++) {
    const [x, y] = toPixels(panel, path[n * 2], path[n * 2 + 1], size);
    context.fillStyle = `rgba(255,255,255,${(0.5 * (1 - n / 64)).toFixed(3)})`;
    context.beginPath();
    context.arc(x, y, 1.8, 0, Math.PI * 2);
    context.fill();
  }

  if (panel.sounding) {
    const at = Math.floor(panel.playhead) % count;
    const [x, y] = toPixels(panel, path[at * 2], path[at * 2 + 1], size);
    context.fillStyle = "rgba(120, 240, 255, 0.95)";
    context.beginPath();
    context.arc(x, y, 4.5, 0, Math.PI * 2);
    context.fill();
  }
}

// Two resolutions: a quick one while the view is moving, the full one once it
// stops. The deadline has to live on the clock rather than a frame counter,
// because rendering is what clears `dirty` — a counter that only ticks on dirty
// frames never reaches the end, and the panel stays soft forever.
function requestRender(panel, interacting) {
  panel.dirty = true;
  if (interacting) {
    panel.interacting = true;
    panel.settleAt = performance.now() + SETTLE_MS;
  } else {
    panel.interacting = false;
  }
}

// ---------------------------------------------------------------- view

function zoomAt(panel, event, factor) {
  const before = toComplex(panel, event);
  panel.view.span = Math.min(6, Math.max(1e-13, panel.view.span * factor));
  const after = toComplex(panel, event);
  panel.view.cx += before.re - after.re;
  panel.view.cy += before.im - after.im;
  requestRender(panel, true);
}

function setJulia(point, quiet) {
  state.julia = { re: point.re, im: point.im };
  cRe.value = point.re.toFixed(4);
  cIm.value = point.im.toFixed(4);
  requestRender(panels.julia, Boolean(quiet));
}

// ---------------------------------------------------------------- input

function bindPanel(panel) {
  const target = panel.overlay;

  target.addEventListener("pointerdown", async (event) => {
    target.setPointerCapture(event.pointerId);
    target.focus({ preventScroll: true });
    if (event.shiftKey) {
      panel.pan = { x: event.clientX, y: event.clientY, ...panel.view };
      return;
    }
    event.preventDefault();
    await wake();
    noteOn(`p${event.pointerId}`, panel.kind, toComplex(panel, event));
  });

  target.addEventListener("pointermove", (event) => {
    if (panel.pan) {
      const rect = target.getBoundingClientRect();
      const scale = panel.view.span / rect.width;
      panel.view.cx = panel.pan.cx - (event.clientX - panel.pan.x) * scale;
      panel.view.cy = panel.pan.cy + (event.clientY - panel.pan.y) * scale;
      requestRender(panel, true);
      return;
    }
    if (notes.has(`p${event.pointerId}`)) {
      noteMove(`p${event.pointerId}`, toComplex(panel, event));
    }
  });

  const end = (event) => {
    panel.pan = null;
    noteOff(`p${event.pointerId}`);
  };
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);

  target.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoomAt(panel, event, Math.exp(event.deltaY * 0.0012));
    },
    { passive: false },
  );

  // Touch: stop the browser treating a drag across the plot as a scroll.
  target.style.touchAction = "none";
}

const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];
const LOWER = "KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash".split(" ");
const UPPER = "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP".split(" ");

function semitonesFor(code) {
  const low = LOWER.indexOf(code);
  if (low >= 0) return SCALE[low];
  const high = UPPER.indexOf(code);
  if (high >= 0) return SCALE[high] + 12;
  return null;
}

function typingInAControl(event) {
  const tag = event.target?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

function currentPoint() {
  return { re: state.point.re, im: state.point.im };
}

function bindKeyboard() {
  window.addEventListener("keydown", async (event) => {
    if (typingInAControl(event) || event.metaKey || event.ctrlKey) return;

    if (event.code === "Space") {
      event.preventDefault();
      await wake();
      randomPoint();
      return;
    }

    if (event.code.startsWith("Arrow")) {
      event.preventDefault();
      const panel = panels[state.point.panel];
      const nudge = panel.view.span * (event.shiftKey ? 0.002 : 0.02);
      const point = currentPoint();
      if (event.code === "ArrowLeft") point.re -= nudge;
      if (event.code === "ArrowRight") point.re += nudge;
      if (event.code === "ArrowUp") point.im += nudge;
      if (event.code === "ArrowDown") point.im -= nudge;
      state.point = { panel: panel.kind, ...point };
      for (const [key, note] of notes) {
        if (note.kind === panel.kind) noteMove(key, point);
      }
      if (!notes.size) showOrbit(panel, point, state.rate);
      return;
    }

    const semitones = semitonesFor(event.code);
    if (semitones === null || event.repeat || notes.has(event.code)) return;
    event.preventDefault();
    await wake();
    noteOn(event.code, state.point.panel, currentPoint(), semitones);
  });

  window.addEventListener("keyup", (event) => noteOff(event.code));
  window.addEventListener("blur", panic);
}

// ---------------------------------------------------------------- actions

// Boundary points are the ones worth hearing: deep inside is a fixed point and
// silence, far outside escapes before it can sound. So keep drawing until we
// land on something that took a while to make up its mind.
function randomPoint() {
  const panel = panels.mandelbrot;
  const { view } = panel;
  let best = null;
  for (let tries = 0; tries < 500; tries++) {
    const re = view.cx + (Math.random() - 0.5) * view.span * 0.9;
    const im = view.cy + (Math.random() - 0.5) * view.span * 0.9;
    const value = inMainBody(re, im) ? -1 : escapeTime(0, 0, re, im, state.maxIter);
    const score = value < 0 ? 0 : value;
    if (!best || score > best.score) best = { re, im, score };
    if (score > state.maxIter * 0.35) break;
  }
  const point = { re: best.re, im: best.im };
  noteOn("random", "mandelbrot", point);
  window.setTimeout(() => noteOff("random"), 900);
}

function panic() {
  for (const key of [...notes.keys()]) noteOff(key);
  send({ type: "allOff" });
}

// ---------------------------------------------------------------- controls

const $ = (id) => document.getElementById(id);
const rateInput = $("rate");
const volumeInput = $("volume");
const detailInput = $("detail");
const cRe = $("c-re");
const cIm = $("c-im");
const statusLine = $("status");

function setStatus(text) {
  statusLine.textContent = text;
}

function bindControls() {
  rateInput.addEventListener("input", () => {
    state.rate = Math.round(Math.pow(2, Number(rateInput.value)));
    $("rate-out").textContent = `${state.rate} steps/s`;
    retuneAll();
  });

  volumeInput.addEventListener("input", () => {
    state.volume = Number(volumeInput.value);
    $("volume-out").textContent = `${Math.round(state.volume * 100)}%`;
    send({ type: "gain", value: state.volume });
  });

  detailInput.addEventListener("input", () => {
    state.maxIter = Number(detailInput.value);
    $("detail-out").textContent = `${state.maxIter} iterations`;
    for (const panel of Object.values(panels)) requestRender(panel, true);
  });

  const readC = () => {
    const re = Number(cRe.value);
    const im = Number(cIm.value);
    if (!Number.isFinite(re) || !Number.isFinite(im)) return;
    state.julia = { re, im };
    requestRender(panels.julia, false);
  };
  cRe.addEventListener("input", readC);
  cIm.addEventListener("input", readC);

  $("link-julia").addEventListener("change", (event) => {
    state.linkJulia = event.target.checked;
  });

  $("random").addEventListener("click", async () => {
    await wake();
    randomPoint();
  });

  $("reset-view").addEventListener("click", () => {
    for (const panel of Object.values(panels)) {
      panel.view = { ...DEFAULTS[panel.kind] };
      requestRender(panel, false);
    }
  });

  $("panic").addEventListener("click", panic);
}

// ---------------------------------------------------------------- loop

let lastFrame = 0;

function frame(now) {
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;

  for (const panel of Object.values(panels)) {
    if (panel.interacting && now >= panel.settleAt) {
      panel.interacting = false;
      panel.dirty = true;
    }
    if (panel.dirty) {
      panel.dirty = false;
      const css = Math.max(1, panel.plot.clientWidth);
      const full = Math.min(MAX_RENDER, Math.round(css * (window.devicePixelRatio || 1)));
      renderFractal(panel, panel.interacting ? Math.max(96, Math.round(full * 0.4)) : full);
    }
    if (panel.sounding) panel.playhead += panel.orbitRate * dt;
    drawOverlay(panel);
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start

function start() {
  makePanel("mandelbrot");
  makePanel("julia");
  for (const panel of Object.values(panels)) bindPanel(panel);
  bindKeyboard();
  bindControls();

  state.rate = Math.round(Math.pow(2, Number(rateInput.value)));
  $("rate-out").textContent = `${state.rate} steps/s`;
  showOrbit(panels.mandelbrot, currentPoint(), state.rate);
  panels.mandelbrot.sounding = false;

  const resize = new ResizeObserver(() => {
    for (const panel of Object.values(panels)) requestRender(panel, true);
  });
  for (const panel of Object.values(panels)) resize.observe(panel.plot);

  requestAnimationFrame(frame);
  // Built suspended: the context exists and the worklet is compiled before the
  // first click, so the first note isn't the one that pays for the setup.
  setupAudio();
}

start();
