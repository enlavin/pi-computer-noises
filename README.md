# popcorn-popper

Plays a randomized **popcorn crackle** while the agent is thinking, and a
**microwave ding** when it finishes.

- Pops are synthesized in pure TypeScript (no assets, no numpy) — band-passed
  noise bursts with Poisson timing that starts sparse and accelerates, so it
  sounds like real microwave popcorn, not a metronome.
- Portable audio: auto-detects `pw-play` / `paplay` / `aplay` / `ffplay` /
  `play`. Only the ding ships as a file (`assets/microwave-finished.wav`).
- **WSL-aware**: under WSL, WSLg's RDP audio sink batches per-process playback,
  so it instead mixes one continuous PCM stream into a single long-lived
  `pacat`/`pw-cat`/`ffplay` process for clean, sample-accurate timing.

## Install on pi

```bash
# Local checkout:
pi install /path/to/popcorn-popper

# From GitHub (after pushing):
pi install git:github.com/<you>/popcorn-popper
```

Remove with `pi remove /path/to/popcorn-popper`. pi loads
`extensions/popcorn-sound.ts`, which binds `agent_start` → pop, `agent_end`
→ stop + ding.

## Install on opencode

opencode's `plugin` array accepts a local file path (`~` is expanded). Point it
at the plugin entry from a local checkout:

```bash
cd ~/.config/opencode
jq '.plugin += ["~/path/to/popcorn-popper/plugin/popcorn.ts"]' opencode.json > opencode.json.tmp && mv opencode.json.tmp opencode.json
```

Or edit `opencode.json` by hand:

```json
{ "plugin": ["~/path/to/popcorn-popper/plugin/popcorn.ts"] }
```

From npm instead (after `npm publish`):

```json
{ "plugin": ["popcorn-popper"] }
```

Restart opencode to load it. The plugin maps assistant `message.updated`
→ start popping and `session.idle` → stop + ding.

## Requirements

- One of: `pipewire` (`pw-play`/`pw-cat`), `pulseaudio-utils` (`paplay`/`pacat`),
  `alsa-utils` (`aplay`), `ffmpeg` (`ffplay`), or `sox` (`play`).
- On Debian/Ubuntu WSL: `sudo apt install pulseaudio-utils` (ships `pacat`).
- **OS support**: WSL and native Linux work out of the box. macOS/Windows-native
  only if `ffmpeg` or `sox` is installed (default `afplay` is not detected). No
  player found → the extension silently no-ops.

## Tuning

Knobs live at the top of `src/popper.ts`: `START_MEAN`/`FLOOR_MEAN` (pop
spacing), `TAU_MS` (ramp speed), and the `synthPop` constants (pitch, decay,
lowpass) for the pop timbre.
