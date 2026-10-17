# pi-computer-noises

**Retro mainframe ambience** for pi: a 60Hz mainframe hum with data blips
while the agent thinks (70s/80s sci-fi console — WOPR, Star Trek). Fades to
silence when the last turn ends.

<img src="assets/certified-non-human-transparent-256px.png" width="256" alt="Certified Non-Human">

## How it sounds / works

- All sound is synthesized in pure TypeScript. Blips are a near-uniform
  telemetry stream of short electronic beeps at tightly-clustered pitches
  (392-523Hz) with a strong octave on top, so the stream's energy sits in
  400-1600Hz. The hum bed is a 60Hz mains stack plus the low-mid partials
  (46/69/139/262/294/370Hz) and two filtered-noise beds that give it a dense
  20-400Hz body. Sparse ambient server-room beeps play over the hum even
  between turns.
- The spectral balance is tuned for a dense 70s/80s console texture:
  per-octave weight sits in 400-1600Hz, the hum carries a 20-400Hz body, and
  there is little of consequence above ~2.6kHz. 13dB crest factor.
- Everything is mixed into ONE continuous PCM stream fed to a single long-lived
  raw player (`pacat` / `pw-cat` / `ffplay` / `play`) on a dedicated worker
  thread, so timing stays sample-accurate and never stutters when the host's
  event loop is busy.
- **One shared instance per user**: any number of pi agents elect a single
  audio owner (Unix socket + `O_EXCL` lock file) and refcount active turns —
  hum + blips play while ANY agent is working and stop when the LAST one
  finishes.

## Audio themes

The default is `reference` (the sound above). `classic` restores the original
original sound: 1170-1290Hz telemetry beeps (fundamental + 3rd + 5th) over a
bare 60/120/180Hz mains drone.

```bash
CN_AUDIO_THEME=classic pi      # old sound
CN_AUDIO_THEME=reference pi    # default
```

The theme is read at startup and is per-process: the elected audio owner renders
for all pi instances, so export it in the environment that launches pi rather
than per shell command. An unknown value logs a warning and falls back to
`reference`. Direct runs take `--theme classic|reference` instead:

```bash
bun src/mainframe.ts --audition 8 --theme classic
```

[![Watch the video](assets/muthur6000.png)](https://www.youtube.com/watch?v=TtGsqGcajjg)

## Install on pi

```bash
pi install git:github.com/enlavin/pi-computer-noises
# or local checkout:
pi install /path/to/pi-computer-noises
```

Enable/disable with `pi config`. Remove with `pi remove /path/to/pi-computer-noises`.

## Requirements

- A raw-PCM player: `pipewire` (`pw-cat`), `pulseaudio-utils` (`pacat`),
  `ffmpeg` (`ffplay`), or `sox` (`play`).
- On Debian/Ubuntu WSL: `sudo apt install pulseaudio-utils`.
- **OS support**: WSL and native Linux. macOS/Windows-native only if `ffmpeg`
  or `sox` is installed. No raw player found → silently no-ops.

## Tuning

Edit `src/mainframe.ts`:

- Both themes live in the `THEMES` table: per theme `scale` (blip pitches),
  `blipAmp`, `partialAmps` / `partialCutoff` (blip harmonic ladder),
  `ambientScale`, `humPartials` (hum tone stack), `toneGain`, `bodyCutoff` /
  `bodyPoles` / `bodyLevel` (low noise bed), `chatterLevel` (mid noise bed),
  `humLevel` (hum loudness).
- Shared timing: `GAP_BASE` / `GAP_JITTER` (blip spacing), `WINDOW_MS` (how long
  blips linger after the last update).

Spectral regression harness (raw s16le mono at 44.1kHz on stdout):

```bash
bun src/mainframe.ts --render 12 > /tmp/on.raw              # hum + blips
bun src/mainframe.ts --render 12 --no-blips > /tmp/hum.raw  # hum only
```

[Sample audio clip](https://github.com/enlavin/pi-computer-noises/raw/refs/heads/main/assets/audition.mp3)

Audition standalone: `bun src/mainframe.ts --audition 8`
