// Old-movie computer "screen blips": short electronic beeps at jumping pitches,
// streamed while the agent works — text/data scrolling across a 70s/80s sci-fi
// CRT (WOPR, Star Trek console), over a low mainframe hum bed.
//
// The spectral balance is tuned for a dense machine texture: energy in
// 400-1600Hz, a 20-400Hz low-mid body, little above ~2.6kHz. `--render` below
// is the harness used to check per-band energies. CN_AUDIO_THEME=classic (or
// `--theme classic` for direct runs) switches back to the original high-beep
// sound.
//
// Host-agnostic engine (only Node built-ins); adapters call createMainframe()
// then warm()/start()/poke()/stop() on their host's events. Same techniques as
// popcorn-popper: one long-lived raw-PCM player fed by a real-time mixer on a
// dedicated worker thread, warm between turns, drop-to-realtime, and ONE audio
// owner per user (Unix socket + O_EXCL lock) so any number of pi
// instances share a single hum that stops when the last turn ends.
//
// Run directly to verify:
//   bun src/mainframe.ts --check       # assert synth/mixer math
//   bun src/mainframe.ts --audition 8  # hear hum + blip bursts
//   bun src/mainframe.ts --audition 8 --theme classic   # the original sound
//   bun src/mainframe.ts --render 8 [--no-blips] > out.raw   # spectral regression
//   bun src/mainframe.ts --coord 0:start,4000:stop,5000:quit   # multi-instance
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SR = 44100;
const VARIANTS = 12;

// ---- audio themes ----------------------------------------------------------
// Two selectable sound worlds. CN_AUDIO_THEME picks one at startup; every pi
// instance should use the same value, since the elected audio owner renders for
// all of them.
//   reference (default) — low-mid machine texture: 392-523Hz beeps with a
//     strong octave, a 20-400Hz hum body, a 140-1400Hz chatter bed, nothing of
//     consequence above ~2.6kHz.
//   classic — the original sound: 1170-1290Hz telemetry beeps (fundamental +
//     3rd + 5th) over a bare 60/120/180Hz mains drone.
const THEMES = {
	reference: {
		// Near-uniform pitch, Nostromo "Mother" telemetry: a fast, relentless
		// stream of nearly-identical beeps. The band sits low, so the beeps'
		// harmonics land in the 800-1600Hz body instead of on top of it.
		scale: [392, 415, 440, 466, 494, 523],
		blipAmp: 0.075,
		// Strong octave, weaker 3rd, fast rolloff: energy in 400-1600Hz.
		partialAmps: [1, 0.75, 0.44, 0.18, 0.12, 0.06],
		partialCutoff: 2600, // Hz; nothing above this is summed
		// Sparse ambient server-room beeps: low-mid only, so they never poke
		// above the ~2.6kHz ceiling.
		ambientScale: [262, 311, 349, 392, 466, 587],
		// 60Hz mains stack + low-mid partials that carry the 100-400Hz mass, so
		// the hum has a body instead of a bare 60/120/180 drone.
		humPartials: [
			[46, 0.3],
			[60, 0.45],
			[69, 0.34],
			[93, 0.26],
			[120, 0.34],
			[139, 0.32],
			[180, 0.19],
			[208, 0.22],
			[240, 0.1],
			[262, 0.34],
			[294, 0.24],
			[370, 0.11],
		],
		toneGain: 0.45,
		bodyCutoff: 220, // machine body lowpass: 12dB/oct fill for 20-400Hz
		bodyPoles: 2,
		bodyLevel: 1.0,
		chatterLevel: 1.5, // 140-1400Hz data-chatter bed inside the hum
		humLevel: 0.042,
	},
	classic: {
		scale: [1170, 1200, 1230, 1260, 1290],
		blipAmp: 0.066,
		partialAmps: [1, 0, 0.3, 0, 0.12], // fundamental + 3rd + 5th
		partialCutoff: 24000, // no band limit: the 5th harmonic is intended
		ambientScale: [523, 784, 1046, 1568, 2093, 2637],
		humPartials: [
			[60, 0.6],
			[120, 0.3],
			[180, 0.15],
		],
		toneGain: 0.5,
		bodyCutoff: 140, // fan rumble: 6dB/oct
		bodyPoles: 1,
		bodyLevel: 1.6,
		chatterLevel: 0, // no chatter bed
		humLevel: 0.055,
	},
};

type Theme = (typeof THEMES)[keyof typeof THEMES];
type ThemeName = keyof typeof THEMES;

// Alias -> canonical theme name. `default` is the user-facing spelling of
// `reference`, since that is the name shown in `/computer-noises theme`.
const THEME_ALIASES: Record<string, ThemeName> = {
	reference: "reference",
	default: "reference",
	classic: "classic",
	legacy: "classic",
	old: "classic",
};

/** Canonical theme names, in menu order. */
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/** Resolve a theme name or alias; undefined when it names no known theme. */
export function themeName(raw: string | undefined): ThemeName | undefined {
	return THEME_ALIASES[(raw ?? "").trim().toLowerCase()];
}

function resolveTheme(raw: string | undefined): Theme {
	const name = themeName(raw);
	if (name) return THEMES[name];
	if (!raw || !raw.trim()) return THEMES.reference;
	console.error(
		`[computer-noises] unknown CN_AUDIO_THEME "${raw}" — using "reference" (valid: ${THEME_NAMES.join(", ")})`,
	);
	return THEMES.reference;
}

let THEME = resolveTheme(process.env.CN_AUDIO_THEME);
let THEME_NAME: ThemeName = themeName(process.env.CN_AUDIO_THEME) ?? "reference";

// ---- synthesis (pure TS) ---------------------------------------------------
// A short electronic beep built additively from a fundamental plus the theme's
// harmonic ladder, band-limited at the theme's cutoff (no aliasing). Fast attack
// + short release fade keep the stream crisp and click-free. Shared by data
// blips and the faint ambient server-room beeps.
function normalize(out: Float64Array, amp: number): Int16Array {
	let peak = 1e-9;
	for (const v of out) if (Math.abs(v) > peak) peak = Math.abs(v);
	const g = (amp / peak) * 32767;
	const pcm = new Int16Array(out.length);
	for (let i = 0; i < out.length; i++) {
		const v = Math.round(out[i] * g);
		pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
	}
	return pcm;
}

function synthTone(
	theme: Theme,
	f: number,
	dur: number,
	amp: number,
): Int16Array {
	const n = Math.floor(SR * dur);
	const atk = Math.floor(SR * 0.002); // 2ms attack, no click
	const fadeStart = n - Math.floor(SR * 0.004); // 4ms release fade
	const out = new Float64Array(n);
	const w: number[] = [];
	const a: number[] = [];
	const amps = theme.partialAmps;
	for (let h = 1; h <= amps.length && f * h <= theme.partialCutoff; h++) {
		if (amps[h - 1] === 0) continue;
		w.push((2 * Math.PI * f * h) / SR);
		a.push(amps[h - 1]);
	}
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let p = 0; p < w.length; p++) s += a[p] * Math.sin(w[p] * i);
		const attack = i < atk ? i / atk : 1;
		const fade = i > fadeStart ? (n - i) / (n - fadeStart) : 1;
		out[i] = attack * fade * s;
	}
	return normalize(out, amp);
}

// Data blips: near-uniform pitch (theme.scale), the streaming "processing" sound.
function synthBlip(theme: Theme, rand: () => number): Int16Array {
	return synthTone(
		theme,
		theme.scale[Math.floor(rand() * theme.scale.length)],
		0.026 + rand() * 0.01,
		theme.blipAmp + rand() * 0.01,
	);
}

function synthAmbient(theme: Theme, rand: () => number): Int16Array {
	return synthTone(
		theme,
		theme.ambientScale[Math.floor(rand() * theme.ambientScale.length)],
		0.05 + rand() * 0.06,
		0.014 + rand() * 0.01,
	);
}

// ---- timing: a stream of blips with occasional pauses ----------------------
const GAP_BASE = 66; // ms between blips — a touch slower
const GAP_JITTER = 12; // +/- spread

// Mixer renders a continuous mainframe hum every chunk, plus data blips only
// while blipsOn() is true. The hum fills the silence gaps (post-request wait,
// between blip windows, tool waits); blips overlay during active streaming.
function createMixer(
	theme: Theme,
	blips: Int16Array[],
	ambients: Int16Array[],
	blipsOn: () => boolean,
): (n: number) => Buffer {
	let pos = 0;
	let nextOnset = 0;
	let active: Array<{ s: Int16Array; start: number }> = [];
	// Hum bed noise state, continuous across chunks: a cascaded lowpass for the
	// machine body rumble and a 140-1400Hz bandpass for the mid-band chatter.
	const body = new Float64Array(theme.bodyPoles);
	const chatOn = theme.chatterLevel > 0;
	let chatHp = 0;
	let chatX = 0;
	let chatLp1 = 0;
	let chatLp2 = 0;
	const bodyA = 1 - Math.exp((-2 * Math.PI * theme.bodyCutoff) / SR);
	const hpA = 1 / (1 + (2 * Math.PI * 140) / SR); // 140Hz one-pole highpass
	const lpA = 1 - Math.exp((-2 * Math.PI * 1400) / SR); // 1400Hz pole, x2
	const humW = theme.humPartials.map(([f]) => (2 * Math.PI * f) / SR);
	const humA = theme.humPartials.map(([, a]) => a);
	const humPh = new Float64Array(humW.length); // per-partial phase accumulator
	const ambientGap = () => ((900 + Math.random() * 3200) / 1000) * SR; // 0.9-4.1s apart
	let nextAmbient = ambientGap();

	const pickNext = (): { s: Int16Array; gap: number } => {
		let ms: number;
		if (Math.random() < 0.03)
			ms = 120 + Math.random() * 120; // rare brief pause
		else ms = GAP_BASE + (Math.random() - 0.5) * 2 * GAP_JITTER; // tight uniform jitter
		return {
			s: blips[Math.floor(Math.random() * blips.length)],
			gap: (ms / 1000) * SR,
		};
	};

	return (n: number): Buffer => {
		const end = pos + n;
		const acc = new Float64Array(n);

		// mainframe hum: partial stack + noise beds under a slow LFO.
		// Phase accumulators persist across chunks, so chunk edges never click.
		for (let i = 0; i < n; i++) {
			const t = (pos + i) / SR;
			let tone = 0;
			for (let p = 0; p < humW.length; p++) {
				tone += humA[p] * Math.sin(humPh[p]);
				humPh[p] += humW[p];
				if (humPh[p] > 2 * Math.PI) humPh[p] -= 2 * Math.PI;
			}
			const white = Math.random() * 2 - 1;
			let bodyOut = white;
			for (let p = 0; p < body.length; p++) {
				body[p] += bodyA * (bodyOut - body[p]);
				bodyOut = body[p];
			}
			let chatter = 0;
			if (chatOn) {
				chatHp = hpA * (chatHp + white - chatX); // 140Hz highpass
				chatX = white;
				chatLp1 += lpA * (chatHp - chatLp1);
				chatLp2 += lpA * (chatLp1 - chatLp2); // 12dB/oct ceiling at 1400Hz
				chatter = chatLp2 * theme.chatterLevel;
			}
			const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.22 * t);
			acc[i] +=
				(tone * theme.toneGain +
					bodyOut * theme.bodyLevel +
					chatter) *
				lfo *
				theme.humLevel *
				32767; // int16-scaled, like the blips
		}

		// data blips only while active; when off, skip ahead so onsets don't backlog
		// into a catch-up burst when activity resumes.
		if (blipsOn()) {
			while (nextOnset < end) {
				const { s, gap } = pickNext();
				active.push({ s, start: Math.round(nextOnset) });
				nextOnset += gap;
			}
		} else {
			nextOnset = end;
		}
		// ambient server-room beeps: sparse + faint, always on with the hum
		while (nextAmbient < end) {
			active.push({
				s: ambients[Math.floor(Math.random() * ambients.length)],
				start: Math.round(nextAmbient),
			});
			nextAmbient += ambientGap();
		}
		for (const p of active) {
			const st = Math.max(pos, p.start);
			const en = Math.min(end, p.start + p.s.length);
			for (let g = st; g < en; g++) acc[g - pos] += p.s[g - p.start];
		}
		active = active.filter((p) => p.start + p.s.length > end);
		pos = end;
		const buf = Buffer.alloc(n * 2);
		for (let i = 0; i < n; i++) {
			const v = Math.round(acc[i] * 0.8);
			buf.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
		}
		return buf;
	};
}

// ---- portable raw-PCM streaming player -------------------------------------
const RAW_PLAYERS: Array<{ cmd: string; args: string[] }> = [
	{
		cmd: "pacat",
		args: [
			"--playback",
			"--rate",
			String(SR),
			"--channels",
			"1",
			"--format",
			"s16le",
			"--latency-msec",
			"40",
		],
	},
	{
		cmd: "pw-cat",
		args: [
			"--playback",
			"--rate",
			String(SR),
			"--channels",
			"1",
			"--format",
			"s16",
			"-",
		],
	},
	{
		cmd: "ffplay",
		args: [
			"-f",
			"s16le",
			"-ar",
			String(SR),
			"-ch_layout",
			"mono",
			"-nodisp",
			"-autoexit",
			"-loglevel",
			"quiet",
			"-i",
			"-",
		],
	},
	{
		cmd: "play",
		args: [
			"-q",
			"-t",
			"raw",
			"-r",
			String(SR),
			"-e",
			"signed",
			"-b",
			"16",
			"-c",
			"1",
			"-",
		],
	},
];

function detectRawPlayer(): { cmd: string; args: string[] } | undefined {
	for (const p of RAW_PLAYERS) {
		try {
			execFileSync("sh", ["-c", `command -v ${p.cmd}`], { stdio: "ignore" });
			return p;
		} catch {
			// try next
		}
	}
	return undefined;
}

interface Mainframe {
	warm(): void;
	start(): void;
	poke(): void;
	stop(): void;
	/** Mute/unmute the shared hum and every instance's blips. */
	muted(next: boolean): void;
	/** Switch the shared sound world (aliases accepted, unknown names ignored). */
	setTheme(name: string): void;
	/** Canonical name of the theme this instance is using. */
	theme(): ThemeName;
	shutdown(): void;
}

const WINDOW_MS = 500; // blips keep going this long after the last update

// Core audio pump: owns the long-lived player + pacing tick + mixer state.
// In production this runs on a dedicated worker thread (below), so the agent's
// main-loop stalls (model streaming, tool output) can't starve or burst it.
interface PumpEngine {
	warm(): void;
	active(on: boolean): void;
	poke(): void;
	/** Mute/unmute the shared hum and every instance's blips. */
	muted(next: boolean): void;
	/** Switch sound world; the player is respawned to rebuild the mixer. */
	setTheme(name: ThemeName): void;
	shutdown(): void;
}

function createPumpEngine(): PumpEngine {
	const rawPlayer = detectRawPlayer();
	let blips = Array.from({ length: VARIANTS }, () => synthBlip(THEME, Math.random));
	let ambients = Array.from({ length: THEME.ambientScale.length }, () =>
		synthAmbient(THEME, Math.random),
	);

	let stream: ChildProcess | undefined;
	let running = false; // tick loop alive → RDP stream stays open (warm)
	let on = false; // this turn is live → render hum+blips, else silence
	let silent = false; // master mute: render silence even while a turn is live
	let timer: ReturnType<typeof setTimeout> | undefined;
	let blipsUntil = 0; // wall-clock ms; blips render while Date.now() < this
	let mix: ((n: number) => Buffer) | undefined; // rebuilt per player spawn

	// Keep ONE player alive for the whole session, feeding silence between turns.
	// WSLg's RDPSink re-incurs a ~1-2s startup buffer every time a stream opens,
	// so spawning/killing per turn made every turn's audio late. A warm stream
	// pays that cost once; turns then start within the LEAD buffer.
	const spawnPlayer = () => {
		if (!rawPlayer || stream) return;
		const proc = spawn(rawPlayer.cmd, rawPlayer.args, {
			stdio: ["pipe", "ignore", "ignore"],
		});
		const gone = () => {
			if (stream === proc) {
				stream = undefined;
				running = false;
			}
		};
		proc.on("error", gone);
		proc.on("exit", gone);
		proc.stdin.on("error", () => {}); // ignore EPIPE if the player dies
		stream = proc;
		running = true;
		mix = createMixer(THEME, blips, ambients, () => Date.now() < blipsUntil);
		// Small LEAD ahead of real time, topped up every 10ms. On a dedicated worker
		// loop this stays glitch-free low; LEAD is the onset floor and the variance.
		const LEAD = Math.floor(SR * 0.1);
		const STEP = Math.floor(SR * 0.02); // <=20ms per write
		let t0 = Date.now(); // wall-clock baseline; rebased after sink backpressure
		let written = 0;
		let draining = false; // sink couldn't keep up -> pace from sink, not wall clock
		const rebase = () => {
			t0 = Date.now() - (written / SR) * 1000;
		}; // realign target to where the sink is
		const tick = () => {
			if (!running) return;
			const sin = stream?.stdin;
			if (sin?.writable && !draining) {
				const target = Math.floor(((Date.now() - t0) / 1000) * SR) + LEAD;
				// Drop-to-realtime: only on a true pump stall (lag WITHOUT backpressure).
				// Sink-slow lag is handled by the drain handler rebasing t0, not by skipping.
				if (target - written > 2 * LEAD) written = target - LEAD;
				while (running && written < target) {
					const n = Math.min(STEP, target - written);
					const live = on && !silent && mix !== undefined;
					const ok = sin.write(live ? mix!(n) : Buffer.alloc(n * 2)); // silence keeps stream warm
					written += n; // data is queued even when ok=false (over highWaterMark)
					if (!ok) {
						draining = true;
						sin.once("drain", () => {
							draining = false;
							rebase();
						});
						break;
					}
				}
			}
			timer = setTimeout(tick, 10);
		};
		tick();
	};

	return {
		warm() {
			spawnPlayer(); // idempotent; opens the RDP stream ahead of the first turn
		},
		active(next: boolean) {
			spawnPlayer(); // respawn if the player died mid-session
			on = next;
			if (!next) blipsUntil = 0; // go silent but keep the stream warm
		},
		poke() {
			blipsUntil = Date.now() + WINDOW_MS;
		},
		muted(next: boolean) {
			silent = next;
			if (next) blipsUntil = 0;
		},
		setTheme(name: ThemeName) {
			if (name !== THEME_NAME) {
				THEME_NAME = name;
				THEME = THEMES[name];
				blips = Array.from({ length: VARIANTS }, () => synthBlip(THEME, Math.random));
				ambients = Array.from({ length: THEME.ambientScale.length }, () =>
					synthAmbient(THEME, Math.random),
				);
			}
			// The mixer closes over the old theme's variants and filters, so respawn
			// the player: a brief gap is cheaper than live-swapping mixer state.
			if (stream) {
				running = false;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				const old = stream;
				stream = undefined;
				try {
					old.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
			mix = undefined;
			spawnPlayer();
		},
		shutdown() {
			running = false;
			on = false;
			blipsUntil = 0;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (stream) {
				try {
					stream.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				stream = undefined;
			}
			mix = undefined;
		},
	};
}

// Worker-thread entry: the pump lives here, isolated from the agent's event
// loop, driven by one-word messages. A busy main loop can no longer stall the
// tick — which was causing both >1s hum dropouts and the post-turn beep tail.
if (!isMainThread && parentPort) {
	const engine = createPumpEngine();
	process.once("exit", () => engine.shutdown());
	parentPort.on("message", (m: string) => {
		if (m === "warm") engine.warm();
		else if (m === "start") engine.active(true);
		else if (m === "poke") engine.poke();
		else if (m === "stop") engine.active(false);
		else if (m === "mute") engine.muted(true);
		else if (m === "unmute") engine.muted(false);
		else if (m.startsWith("theme:")) {
			const name = themeName(m.slice(6));
			if (name) engine.setTheme(name);
		} else if (m === "shutdown") {
			engine.shutdown();
			process.exit(0);
		}
	});
}

// The local pump drives audio for one process; the theme getter lives on the
// Mainframe wrapper, which tracks the user's choice across elections.
type LocalPump = Omit<Mainframe, "theme">;

function createLocalPump(): LocalPump {
	// Prefer a dedicated worker thread for the pump; fall back to in-process
	// pacing if this runtime can't spawn one (audio then shares the main loop).
	let worker: Worker | undefined;
	try {
		worker = new Worker(new URL(import.meta.url));
		worker.on("error", () => {
			worker = undefined;
		});
	} catch {
		worker = undefined;
	}
	if (worker) {
		const w = worker;
		const post = (m: string) => {
			try {
				w.postMessage(m);
			} catch {
				/* worker gone */
			}
		};
		// No terminate() on exit: that stops the thread without reaping its pacat
		// child (orphan). Normal process teardown closes the stdin pipe → pacat EOFs.
		return {
			warm: () => post("warm"),
			start: () => post("start"),
			poke: () => post("poke"),
			stop: () => post("stop"),
			muted: (next) => post(next ? "mute" : "unmute"),
			setTheme: (name) => post(`theme:${name}`),
			shutdown: () => post("shutdown"),
		};
	}
	const engine = createPumpEngine();
	process.once("exit", () => engine.shutdown());
	return {
		warm: () => engine.warm(),
		start: () => engine.active(true),
		poke: () => engine.poke(),
		stop: () => engine.active(false),
		muted: (next) => engine.muted(next),
		setTheme: (name) => {
			const canonical = themeName(name);
			if (canonical) engine.setTheme(canonical);
		},
		shutdown: () => engine.shutdown(),
	};
}

// ---- cross-process coordination --------------------------------------------
// Several instances would each spawn their own hum. Instead elect ONE audio
// owner per user via a Unix socket + O_EXCL lock (bun's listen() silently
// rebinds an occupied unix path, so it can't be the lock). The owner runs the
// (worker) pump; every other instance is a silent client that streams its turn
// activity over the socket. The owner refcounts active turns across all
// instances — hum plays while ANY instance is mid-turn and stops when the last
// turn ends. Own socket name (not the standalone extension's) so a repo install
// and a globally-installed original never clash.
const SOCK_PATH = join(
	process.env.XDG_RUNTIME_DIR || tmpdir(),
	"computer-noises.sock",
);
const LOCK_PATH = SOCK_PATH + ".lock";

export function createMainframe(): Mainframe {
	let selfActive = false; // is THIS instance mid-turn (source of truth across roles)
	let disposed = false;
	// Local mirror of the shared settings, replayed to whichever pump this
	// instance ends up driving (owner, client, or private fallback).
	let mutedNow = false;
	let themeNow: ThemeName | undefined;
	let role: {
		start(): void;
		poke(): void;
		stop(): void;
		muted(next: boolean): void;
		theme(name: ThemeName): void;
	} = {
		start() {},
		poke() {},
		stop() {},
		muted() {},
		theme() {},
	};
	let teardown = () => {};

	const becomeOwner = (server: Server) => {
		const pump = createLocalPump();
		let activeCount = 0;
		let selfCounted = false;
		const apply = () => (activeCount > 0 ? pump.start() : pump.stop());
		if (themeNow) pump.setTheme(themeNow);
		// On election the pump adopts this instance's last known settings. The
		// caller seeds them from the config file before start(), so a fresh owner
		// never resets the shared mute/theme to its own defaults.
		pump.muted(mutedNow);
		if (process.env.CN_DEBUG)
			console.error(`[owner] elected pid=${process.pid}`);
		const conns = new Set<Socket>();
		server.on("connection", (sock: Socket) => {
			conns.add(sock);
			let cactive = false;
			let buf = "";
			sock.setEncoding("utf8");
			sock.on("data", (d: string) => {
				buf += d;
				let i: number;
				while ((i = buf.indexOf("\n")) >= 0) {
					const m = buf.slice(0, i);
					buf = buf.slice(i + 1);
					if (m === "start") {
						if (!cactive) {
							cactive = true;
							activeCount++;
							apply();
							if (process.env.CN_DEBUG)
								console.error(`[owner] active=${activeCount}`);
						}
					} else if (m === "stop") {
						if (cactive) {
							cactive = false;
							activeCount--;
							apply();
							if (process.env.CN_DEBUG)
								console.error(`[owner] active=${activeCount}`);
						}
					} else if (m === "poke") pump.poke();
					else if (m.startsWith("theme:")) {
						const name = themeName(m.slice(6));
						if (name) {
							themeNow = name;
							pump.setTheme(name);
						}
					} else if (m === "mute" || m === "unmute") {
						mutedNow = m === "mute";
						pump.muted(mutedNow);
					}
				}
			});
			const drop = () => {
				if (!conns.delete(sock)) return;
				if (cactive) {
					cactive = false;
					activeCount--;
					apply();
					if (process.env.CN_DEBUG)
						console.error(`[owner] active=${activeCount}`);
				}
			};
			sock.on("close", drop);
			sock.on("error", () => {}); // 'close' follows
		});
		server.on("error", () => {}); // runtime errors after listen: keep the pump
		if (selfActive) {
			selfCounted = true;
			activeCount++;
		}
		pump.warm();
		apply();
		if (process.env.CN_DEBUG) console.error(`[owner] active=${activeCount}`);
		role = {
			start: () => {
				if (!selfCounted) {
					selfCounted = true;
					activeCount++;
					apply();
					if (process.env.CN_DEBUG)
						console.error(`[owner] active=${activeCount}`);
				}
			},
			stop: () => {
				if (selfCounted) {
					selfCounted = false;
					activeCount--;
					apply();
					if (process.env.CN_DEBUG)
						console.error(`[owner] active=${activeCount}`);
				}
			},
			poke: () => pump.poke(),
			muted: (next) => {
				mutedNow = next;
				pump.muted(next);
			},
			theme: (name) => {
				themeNow = name;
				pump.setTheme(name);
			},
		};
		teardown = () => {
			try {
				server.close();
			} catch {
				/* not listening */
			}
			for (const s of conns) {
				try {
					s.destroy();
				} catch {
					/* gone */
				}
			}
			try {
				unlinkSync(SOCK_PATH);
			} catch {
				/* already gone */
			}
			try {
				unlinkSync(LOCK_PATH);
			} catch {
				/* already gone */
			}
			pump.shutdown();
		};
	};

	const becomeClient = (sock: Socket) => {
		const send = (m: string) => {
			try {
				sock.write(m + "\n");
			} catch {
				/* broken pipe */
			}
		};
		if (process.env.CN_DEBUG)
			console.error(`[client] connected pid=${process.pid}`);
		if (selfActive) send("start"); // announce current state to the (new) owner
		role = {
			start: () => send("start"),
			stop: () => send("stop"),
			poke: () => send("poke"),
			muted: (next) => send(next ? "mute" : "unmute"),
			theme: (name) => send(`theme:${name}`),
		};
		// Re-assert this instance's settings so a stale owner catches up. Send the
		// state explicitly either way: an election may have happened in between and
		// the new owner must not inherit a stale mute.
		send(mutedNow ? "mute" : "unmute");
		if (themeNow) send(`theme:${themeNow}`);
		teardown = () => {
			try {
				sock.destroy();
			} catch {
				/* gone */
			}
		};
		const reElect = () => {
			if (disposed) return;
			role = {
				start() {},
				poke() {},
				stop() {},
				muted() {},
				theme() {},
			}; // silent until re-elected
			setTimeout(elect, 40 + Math.random() * 80); // jitter to avoid a thundering herd
		};
		sock.on("close", reElect);
		sock.on("error", () => {}); // 'close' follows
	};

	// Non-EADDRINUSE listen failure (perms, bad path): degrade to a private pump
	// (per-instance hum) rather than going silent.
	const becomeOwnerLocalOnly = () => {
		const pump = createLocalPump();
		if (themeNow) pump.setTheme(themeNow);
		pump.muted(mutedNow);
		pump.warm();
		if (selfActive) pump.start();
		role = {
			start: () => pump.start(),
			stop: () => pump.stop(),
			poke: () => pump.poke(),
			muted: (next) => {
				mutedNow = next;
				pump.muted(next);
			},
			theme: (name) => {
				themeNow = name;
				pump.setTheme(name);
			},
		};
		teardown = () => pump.shutdown();
	};

	const isAlive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as { code?: string }).code === "EPERM";
		}
	};

	const tryOwn = () => {
		if (disposed) return;
		try {
			writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" }); // atomic: EEXIST if held
		} catch (e) {
			if ((e as { code?: string }).code !== "EEXIST") {
				becomeOwnerLocalOnly();
				return;
			}
			// lock held: live owner (up or starting) → retry-connect soon; dead pid →
			// break the stale lock. The atomic wx create still serializes the winner.
			const pid = Number(readFileSync(LOCK_PATH, "utf8")) || 0;
			if (!pid || !isAlive(pid)) {
				try {
					unlinkSync(LOCK_PATH);
				} catch {
					/* raced */
				}
			}
			setTimeout(elect, 40 + Math.random() * 80);
			return;
		}
		try {
			unlinkSync(SOCK_PATH);
		} catch {
			/* no stale socket */
		} // bun won't clear it for us
		const server = createServer();
		server.once("error", () => {
			try {
				unlinkSync(LOCK_PATH);
			} catch {
				/* gone */
			}
			becomeOwnerLocalOnly();
		});
		server.listen(SOCK_PATH, () => becomeOwner(server));
	};

	const elect = () => {
		if (disposed) return;
		// Connect-first: a live owner answers → be a client; nobody answers → race
		// for the O_EXCL lock file, and the winner listens.
		const probe = connect(SOCK_PATH);
		const onErr = () => tryOwn();
		probe.once("connect", () => {
			probe.removeListener("error", onErr);
			becomeClient(probe);
		});
		probe.once("error", onErr);
	};

	elect();
	process.once("exit", () => {
		disposed = true;
		teardown();
	});

	return {
		warm: () => {}, // owner auto-warms on election; clients need no warming
		start: () => {
			selfActive = true;
			role.start();
		},
		poke: () => role.poke(),
		stop: () => {
			selfActive = false;
			role.stop();
		},
		muted: (next) => {
			mutedNow = next;
			role.muted(next);
		},
		setTheme: (name) => {
			const canonical = themeName(name);
			if (!canonical) return;
			themeNow = canonical;
			THEME_NAME = canonical;
			THEME = THEMES[canonical];
			role.theme(canonical);
		},
		theme: () => themeNow ?? THEME_NAME,
		shutdown: () => {
			if (!disposed) {
				disposed = true;
				teardown();
			}
		},
	};
}

// ---- direct-run: audition or self-check ------------------------------------
if (import.meta.main && isMainThread) {
	const mode = process.argv[2] ?? "--audition";
	// `--theme classic` / `--theme reference` for direct runs; the extension
	// itself reads CN_AUDIO_THEME instead.
	const themeArg = process.argv.indexOf("--theme");
	if (themeArg > 0 && process.argv[themeArg + 1]) {
		THEME = resolveTheme(process.argv[themeArg + 1]);
		THEME_NAME = themeName(process.argv[themeArg + 1]) ?? "reference";
	}
	if (mode === "--check") {
		const b = synthBlip(THEME, Math.random);
		console.assert(
			b.length > 0 && b.length <= Math.floor(SR * 0.07),
			"blip length",
		);
		console.assert(
			b.some((v) => v !== 0),
			"blip not silent",
		);
		console.assert(
			b.every((v) => v >= -32768 && v <= 32767),
			"blip in int16 range",
		);
		const humOnly = createMixer(THEME, [b], [synthAmbient(THEME, Math.random)], () => false);
		const chunk = humOnly(4410);
		console.assert(chunk.length === 8820, "mixer emits 2 bytes/sample");
		console.assert(
			chunk.some((_, i) => i % 2 === 0 && chunk.readInt16LE(i) !== 0),
			"hum not silent when blips off",
		);
		if (!detectRawPlayer())
			console.warn("no raw player found (pacat/pw-cat/ffplay/play)");
		console.log("ok");
	} else if (mode === "--render") {
		// Spectral regression harness: raw s16le mono to stdout, no player process.
		// `bun src/mainframe.ts --render 8 [--no-blips] > out.raw`
		const secs = Number(process.argv[3] ?? 8);
		const on = process.argv[4] !== "--no-blips";
		const bs = Array.from({ length: VARIANTS }, () => synthBlip(THEME, Math.random));
		const as = Array.from({ length: THEME.ambientScale.length }, () =>
			synthAmbient(THEME, Math.random),
		);
		const mix = createMixer(THEME, bs, as, () => on);
		const step = Math.floor(SR * 0.05);
		for (let s = 0; s < secs * SR; s += step)
			process.stdout.write(mix(step));
	} else if (mode === "--coord") {
		// Multi-instance harness: `--coord 0:start,2000:stop,3000:quit`. Launch a few
		// with CN_DEBUG=1 and watch that only one owner exists and active= tracks the
		// union of every instance's turns.
		const mf = createMainframe();
		mf.warm();
		for (const step of (process.argv[3] ?? "").split(",").filter(Boolean)) {
			const [ms, cmd] = step.split(":");
			setTimeout(() => {
				if (cmd === "start") mf.start();
				else if (cmd === "poke") mf.poke();
				else if (cmd === "stop") mf.stop();
				else if (cmd === "quit") process.exit(0);
			}, Number(ms));
		}
		setInterval(() => {}, 1 << 30); // keep alive until a quit step
	} else {
		const mf = createLocalPump();
		mf.start();
		const secs = Number(process.argv[3] ?? 8);
		// Simulate updates: poke in bursts with a silent gap so you hear hum-only.
		const poker = setInterval(() => {
			if ((Date.now() / 1000) % 4 < 2) mf.poke(); // 2s blips, 2s hum-only, repeat
		}, 80);
		console.log(
			`auditioning ~${secs}s: mainframe hum + blip bursts (gaps = hum only)...`,
		);
		setTimeout(() => {
			clearInterval(poker);
			mf.stop();
			process.exit(0);
		}, secs * 1000);
	}
}
