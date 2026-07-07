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
pi install git:github.com/<you>/popcorn-popper      # or: pi install /path/to/popcorn-popper
```

That's it — pi loads `extensions/popcorn-sound.ts`, which binds `agent_start`
→ pop, `agent_end` → stop + ding.

## Install on opencode

Add to `opencode.json`:

```json
{ "plugin": ["popcorn-popper"] }
```

or drop the repo in `~/.config/opencode/plugins/` (global) or
`.opencode/plugins/` (project). The plugin maps assistant `message.updated`
→ start popping and `session.idle` → stop + ding.

## Requirements

- One of: `pipewire` (`pw-play`/`pw-cat`), `pulseaudio-utils` (`paplay`/`pacat`),
  `alsa-utils` (`aplay`), `ffmpeg` (`ffplay`), or `sox` (`play`).
- On Debian/Ubuntu WSL: `sudo apt install pulseaudio-utils` (ships `pacat`).

## Tuning

Knobs live at the top of `src/popper.ts`: `START_MEAN`/`FLOOR_MEAN` (pop
spacing), `TAU_MS` (ramp speed), and the `synthPop` constants (pitch, decay,
lowpass) for the pop timbre.
