// The synth. Nothing here is a sample or a table lookup: every output sample
// comes from iterating z -> z^2 + c one more time.
//
// The orbit of a point is a sequence of complex numbers. Read the real part as
// the left channel and the imaginary part as the right, step through it at
// `rate` steps per second, and an orbit that settles into a p-cycle repeats
// every p steps -- so it sounds a tone at rate/p. A short cycle is a high note,
// a long one is a low note, a chaotic orbit is noise, and an orbit that escapes
// to infinity is a burst that stops. The fractal is doing the synthesis; we are
// only listening to it.

// The same seven families as main.js, in the same order. A worklet runs in its
// own global scope and cannot import the module the page uses, so this list is
// duplicated on purpose -- spec/crit-4.test.ts compares the two and fails if a
// family is ever added to one and not the other.
const FAMILY_IDS = [
  "mandelbrot",
  "burning-ship",
  "tricorn",
  "celtic",
  "perpendicular",
  "multibrot-3",
  "multibrot-4",
];

const ESCAPE_SQ = 16; // |z| > 4 and the orbit is gone for good
const SETTLED = 1e-9; // an orbit this still has converged to a point: silence
const SETTLE_STEPS = 96;

class Voice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.id = -1;
    this.playing = false;
    this.age = 0;
    this.reset();
  }

  reset() {
    this.family = 0;
    this.zr = this.zi = 0;
    this.cr = this.ci = 0;
    this.prevR = this.prevI = 0;
    this.nextR = this.nextI = 0;
    this.phase = 0;
    this.step = 0;
    this.level = 0;
    this.releasing = false;
    this.still = 0;
    // One DC blocker per channel. An orbit circling a fixed point is a large
    // constant offset with a small wiggle on top; without this you hear the
    // offset as a thump and the wiggle not at all.
    this.dc = [0, 0, 0, 0]; // x1L, y1L, x1R, y1R
  }

  start(msg) {
    this.reset();
    this.id = msg.id;
    this.playing = true;
    this.seed(msg);
  }

  // Re-seed the orbit without retriggering the envelope. Dragging across the
  // set calls this every pointermove, which is what makes a drag a glissando
  // rather than a machine-gun of separate notes.
  seed(msg) {
    const family = FAMILY_IDS.indexOf(msg.family);
    this.family = family < 0 ? 0 : family;
    this.cr = msg.cr;
    this.ci = msg.ci;
    this.prevR = this.nextR = msg.zr;
    this.prevI = this.nextI = msg.zi;
    this.phase = 0;
    this.still = 0;
    this.releasing = false;
    this.setRate(msg.rate);
  }

  setRate(rate) {
    this.step = Math.max(1e-6, rate) / this.sampleRate;
  }

  release() {
    this.releasing = true;
  }

  // One step of the selected family. Resolved to an integer once at noteOn, so
  // the per-sample cost is a switch and not a string compare.
  //
  // Not called `step`: that name is already the phase increment this voice
  // advances by each sample, and an instance field shadows a class method, so
  // the call would throw on the audio thread where nothing on the page can see
  // it -- the page keeps running and the note is simply silent.
  applyFamily(x, y) {
    switch (this.family) {
      case 1: {
        const ax = Math.abs(x);
        const ay = Math.abs(y);
        return [ax * ax - ay * ay, 2 * ax * ay];
      }
      case 2:
        return [x * x - y * y, -2 * x * y];
      case 3:
        return [Math.abs(x * x - y * y), 2 * x * y];
      case 4: {
        const ay = Math.abs(y);
        return [x * x - ay * ay, -2 * x * ay];
      }
      case 5: {
        const x2 = x * x;
        const y2 = y * y;
        return [x * (x2 - 3 * y2), y * (3 * x2 - y2)];
      }
      case 6: {
        const r = x * x - y * y;
        const i = 2 * x * y;
        return [r * r - i * i, 2 * r * i];
      }
      default:
        return [x * x - y * y, 2 * x * y];
    }
  }

  advance() {
    this.prevR = this.nextR;
    this.prevI = this.nextI;
    const [fr, fi] = this.applyFamily(this.nextR, this.nextI);
    const r = fr + this.cr;
    const i = fi + this.ci;
    if (!Number.isFinite(r) || !Number.isFinite(i) || r * r + i * i > ESCAPE_SQ) {
      // Escaped. Freeze the orbit and let the envelope close: the sound of a
      // point outside the set is the chaos just before it left, then nothing.
      this.releasing = true;
      return;
    }
    const dr = r - this.prevR;
    const di = i - this.prevI;
    this.still = dr * dr + di * di < SETTLED ? this.still + 1 : 0;
    if (this.still > SETTLE_STEPS) this.releasing = true;
    this.nextR = r;
    this.nextI = i;
  }

  // One DC-blocked sample per channel: y = x - x1 + 0.999 * y1.
  block(x, k) {
    const y = x - this.dc[k] + 0.999 * this.dc[k + 1];
    this.dc[k] = x;
    this.dc[k + 1] = y;
    return y;
  }

  render(left, right, attack, releaseCoef) {
    for (let n = 0; n < left.length; n++) {
      this.phase += this.step;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.advance();
      }

      // Linear interpolation between orbit points. Below about 40 steps per
      // second the steps would be audible as clicks; above the sample rate the
      // orbit runs faster than we can hear and turns to noise. Both are fair
      // sounds for this instrument to be able to make.
      const t = this.phase;
      const l = this.prevR + (this.nextR - this.prevR) * t;
      const r = this.prevI + (this.nextI - this.prevI) * t;

      this.level = this.releasing
        ? this.level * releaseCoef
        : this.level + (1 - this.level) * attack;

      // Orbits that stay bounded live inside |z| <= 2; tanh catches the ones
      // on their way out without a hard clip.
      left[n] += Math.tanh(this.block(l, 0) * 0.6) * this.level;
      right[n] += Math.tanh(this.block(r, 2) * 0.6) * this.level;
    }

    if (this.releasing && this.level < 1e-4) {
      this.playing = false;
      this.id = -1;
    }
  }
}

class FractalProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const voices = options.processorOptions?.voices ?? 8;
    this.voices = Array.from({ length: voices }, () => new Voice(sampleRate));
    this.clock = 0;
    this.gain = 0.35;
    // ~8 ms attack, ~140 ms release, as one-pole coefficients.
    this.attack = 1 - Math.exp(-1 / (0.008 * sampleRate));
    this.releaseCoef = Math.exp(-1 / (0.14 * sampleRate));
    this.port.onmessage = (event) => this.handle(event.data);
  }

  find(id) {
    return this.voices.find((v) => v.playing && v.id === id) ?? null;
  }

  handle(msg) {
    switch (msg.type) {
      case "noteOn": {
        const voice =
          this.find(msg.id) ??
          this.voices.find((v) => !v.playing) ??
          // Steal the oldest sounding voice. Clicking faster than the release
          // should thin the texture, never refuse to make a sound.
          this.voices.reduce((a, b) => (a.age <= b.age ? a : b));
        voice.age = ++this.clock;
        voice.start(msg);
        break;
      }
      case "update": {
        const voice = this.find(msg.id);
        if (voice) voice.seed(msg);
        break;
      }
      case "noteRate": {
        this.find(msg.id)?.setRate(msg.rate);
        break;
      }
      case "rate": {
        for (const voice of this.voices) {
          if (voice.playing) voice.setRate(msg.rate);
        }
        break;
      }
      case "noteOff": {
        this.find(msg.id)?.release();
        break;
      }
      case "allOff": {
        for (const voice of this.voices) voice.release();
        break;
      }
      case "gain": {
        this.gain = msg.value;
        break;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] ?? out[0];
    left.fill(0);
    if (right !== left) right.fill(0);

    for (const voice of this.voices) {
      if (voice.playing) voice.render(left, right, this.attack, this.releaseCoef);
    }

    for (let n = 0; n < left.length; n++) {
      left[n] *= this.gain;
      if (right !== left) right[n] *= this.gain;
    }
    return true;
  }
}

registerProcessor("fractal-processor", FractalProcessor);
