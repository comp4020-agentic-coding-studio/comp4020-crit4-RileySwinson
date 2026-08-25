import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Crit 4 — "An instrument". The mechanically checkable lines of the published
// spec:
// https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/04-instrument/
//
// These assert the CONTRACT — what the page must do — not how it's built, so
// they survive a change of approach. The lines a person judges (is it
// expressive? do two players sound different? is there no way to play it
// wrong?) are not here: the pod judges those at the crit, cold, by playing it.
//
// Like the invariants, these run against the BUILT site, so they check what
// actually ships. `pnpm check` builds first.
const DIST = resolve("dist");

function files(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const shipped = files().map((path) => relative(DIST, path).split(sep).join("/"));

// Every script the site ships, as one blob. Bundlers rename and hash, so the
// only honest way to ask "does the page synthesise sound?" is to read what
// went out.
const scripts = shipped
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(DIST, name), "utf8"))
  .join("\n");

// A real URL, not the default opaque origin: jsdom throws on storage access
// from an opaque origin, and a diff over a DOM node can reach for it.
const home = new JSDOM(readFileSync(join(DIST, "index.html"), "utf8"), {
  url: "https://example.org/",
}).window.document;

describe("the browser is the instrument", () => {
  it("synthesises sound in the page with Web Audio", () => {
    expect(
      /AudioContext/.test(scripts),
      "no AudioContext in the shipped JavaScript — the sound has to be made live in the page",
    ).toBe(true);
  });

  it("routes what it makes through the graph, rather than just starting a context", () => {
    // Any node that generates samples counts: an oscillator, a buffer source,
    // or a worklet doing the arithmetic itself. What the spec rules out is a
    // page that opens a context and then plays something it was handed.
    expect(
      /OscillatorNode|createOscillator|AudioBufferSourceNode|createBufferSource|AudioWorkletNode/.test(
        scripts,
      ),
      "no node making samples in the shipped JavaScript — something has to actually make the sound",
    ).toBe(true);
  });

  it("ships no recorded audio to play back", () => {
    const media = shipped.filter((name) =>
      /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba|webm)$/i.test(name),
    );
    expect(
      media,
      "the spec rules out playback: the player makes the sound, the page doesn't replay it",
    ).toEqual([]);
    expect(
      home.querySelector("audio, video") !== null,
      "an <audio> or <video> element is playback, not an instrument",
    ).toBe(false);
  });
});

// The quote classes below allow a backtick: the bundler rewrites string
// literals as template literals, so `"keydown"` ships as `` `keydown` ``.
describe("playable with whatever is at hand", () => {
  it("listens for pointer or mouse or touch", () => {
    expect(
      /["'`](pointer(down|move|up)|mouse(down|move|up)|touch(start|move|end))["'`]/.test(
        scripts,
      ),
      "no pointer, mouse or touch listener in the shipped JavaScript",
    ).toBe(true);
  });

  it("listens for the keyboard", () => {
    expect(
      /["'`](keydown|keyup|keypress)["'`]/.test(scripts),
      "no keyboard listener in the shipped JavaScript — a keyboard is what some players have at hand",
    ).toBe(true);
  });

  it("offers something a keyboard can reach", () => {
    const focusable = home.querySelectorAll(
      "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    expect(
      focusable.length,
      "nothing on the page can take focus, so a keyboard player has nowhere to start",
    ).toBeGreaterThan(0);
  });
});

describe("a stranger can play it uninstructed", () => {
  it("invites the first sound on the opening screen", () => {
    const main = home.querySelector("main")?.textContent ?? "";
    expect(
      /\b(play|press|tap|click|touch|drag|move|hold|start|strum|strike)\b/i.test(
        main,
      ),
      "the opening screen names no action — a stranger needs to know what to do first, without being told",
    ).toBe(true);
  });

  it("has replaced the starter page", () => {
    expect(
      home.querySelector('[data-testid="intro"]') !== null,
      "the starter's intro is still on the page — this is still the template, not an instrument",
    ).toBe(false);
  });
});
