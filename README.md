# agent-ambience (popcorn-popper)

Two interchangeable ambience extensions for **pi** and **opencode**, sharing the
same streaming-audio engine:

- **popcorn-popper** — a **microwave running** drone with randomized **popcorn
  pops** while the agent thinks, and a **microwave ding** when it finishes.
- **computer-noises** — a retro **mainframe hum** with **data blips** streaming
  while the agent thinks (70s/80s sci-fi console), fading to silence when done.

Enable whichever you like (or both, if you enjoy microwaved mainframes).

## How it sounds / works

- All sound is synthesized in pure TypeScript (no numpy, no bundled clips except
  popcorn's ding). Popcorn pops use Poisson timing that starts sparse and
  accelerates each turn; computer-noises blips are a near-uniform telemetry stream.
- Each extension mixes everything into ONE continuous PCM stream fed to a single
  long-lived raw player (`pacat` / `pw-cat` / `ffplay` / `play`) on a dedicated
  worker thread, so timing stays sample-accurate even under WSLg's batching RDP
  sink and never stutters when the host's event loop is busy. Popcorn's ding
  (`assets/microwave-finished.wav`) is decoded and mixed into that same stream.
- **One shared instance per user**: any number of pi/opencode agents elect a
  single audio owner (Unix socket + `O_EXCL` lock file) and refcount active turns
  — sound plays while ANY agent is working and stops (popcorn: dings) when the
  LAST one finishes. No overlapping audio. Each extension uses its own socket, so
  they coordinate independently.

## Install on pi

```bash
# Local checkout:
pi install /path/to/popcorn-popper

# From GitHub (after pushing):
pi install git:github.com/<you>/popcorn-popper
```

pi loads every extension in `extensions/` — `popcorn-sound.ts` (`agent_start` →
pop, `agent_end` → stop + ding) and `computer-noises.ts` (`agent_start` → hum,
`message_update` → blips, `agent_end` → stop). Enable/disable either with
`pi config`. Remove the package with `pi remove /path/to/popcorn-popper`.

## Install on opencode

opencode's `plugin` array accepts local file paths (`~` is expanded). Point it at
the plugin you want — `plugin/popcorn.ts` and/or `plugin/computer-noises.ts`:

```bash
cd ~/.config/opencode
jq '.plugin += ["~/path/to/popcorn-popper/plugin/popcorn.ts"]' opencode.json > opencode.json.tmp && mv opencode.json.tmp opencode.json
```

Or edit `opencode.json` by hand:

```json
{ "plugin": ["~/path/to/popcorn-popper/plugin/computer-noises.ts"] }
```

From npm instead (after `npm publish`), reference the subpath exports:

```json
{ "plugin": ["popcorn-popper", "popcorn-popper/computer-noises"] }
```

Both plugins map assistant `message.updated` → start (popcorn pops / hum + blips)
and `session.idle` → stop (+ popcorn ding).

## Requirements

- A raw-PCM player: `pipewire` (`pw-cat`), `pulseaudio-utils` (`pacat`),
  `ffmpeg` (`ffplay`), or `sox` (`play`).
- On Debian/Ubuntu WSL: `sudo apt install pulseaudio-utils` (ships `pacat`).
- **OS support**: WSL and native Linux work out of the box. macOS/Windows-native
  only if `ffmpeg` or `sox` is installed. No raw player found → silently no-ops.

## Tuning

- **popcorn** (`src/popper.ts`): `START_MEAN`/`FLOOR_MEAN` (pop spacing), `TAU_MS`
  (accel speed), `MICRO_LEVEL` (drone loudness), `synthPop` constants (timbre).
- **computer-noises** (`src/mainframe.ts`): `SCALE` (blip pitches), `GAP_BASE`/
  `GAP_JITTER` (blip spacing), `HUM_LEVEL` (hum loudness), `WINDOW_MS` (how long
  blips linger after the last update).

Each engine runs standalone for auditioning:
`bun src/popper.ts --audition 8` / `bun src/mainframe.ts --audition 8`.
