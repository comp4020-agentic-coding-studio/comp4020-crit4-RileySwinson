# Process overview

## What I built

**Orbit**, a browser instrument on the Mandelbrot and Julia sets. Clicking a
point hands its orbit under _z_ → _z_² + _c_ to an AudioWorklet, which walks the
orbit and reads the real part out as the left channel, the imaginary part as the
right. An orbit that settles into a p-cycle sounds at rate ÷ p — the orbit's
shape is the timbre, its period the pitch. The idea is CodeParade's
[Fractal Sound Explorer](https://codeparade.itch.io/fractal-sound-explorer).

## The moments that mattered

**Choosing ground I didn't already know.** I have built an instrument out of
Conway's Game of Life before, so the obvious move was that shape of problem
again — a grid, a tick, cells mapped to notes. I chose the fractal because I did
not already know how it would sound. That cost me the safety of a known result:
I could not judge in advance whether an orbit would be a tone or noise, so the
contract had to come before the prototype. The published spec became tests
first, red, with nothing behind them ([`154194e`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-RileySwinson/commit/154194e)) —
including the line ruling out playback, which forced live synthesis instead of a
bank of samples.

**Green tests that proved nothing.** `pnpm check` went green while I still had no
evidence the thing made a sound: a test can grep the shipped JavaScript for
`AudioContext`, but it cannot listen. So I drove the built site in real Chrome
and rendered the worklet through an `OfflineAudioContext`. A period-3 orbit at
2400 steps/s measured 800 Hz — exactly rate ÷ 3, as predicted — while interior
fixed points fell silent and escaping points burst and stopped. The same pass
caught what tests could not: both panels were stuck at 40% resolution forever,
because the settle countdown only ticked on frames already marked dirty, and
rendering is what clears that flag ([`bf920b8`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-RileySwinson/commit/bf920b8)).
