// Host-agnostic popcorn engine. No pi/opencode imports — just Node built-ins.
// Adapters call createPopper() then start()/stop() on their own events.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MICROWAVE = join(HERE, "..", "assets", "microwave-finished.wav");
const CACHE = join(tmpdir(), "pi-popcorn"); // generated pops (writable anywhere)
const SR = 44100;
const VARIANTS = 8;

// Poisson bursts: mean gap decays from START_MEAN to FLOOR_MEAN, but each
// gap is exponentially random -> clustered, uneven pops, not a metronome.
const FLOOR_MEAN = 55;
const START_MEAN = 420;
const TAU_MS = 5000;
const MIN_GAP = 25; // clamp so we don't spawn a process storm

// ---- pop synthesis (pure TS, no python/numpy) ------------------------------
// A real pop is a short broadband burst, NOT a decaying pure tone. A sustained
// sine = struck metal / bell. Instead: two band-passed noise layers - a low
// hollow "pock" body + a short mid "snap" - with a lowpass to kill hiss.

function bandpass(f0: number, q: number) {
	const w0 = (2 * Math.PI * f0) / SR;
	const alpha = Math.sin(w0) / (2 * q);
	const a0 = 1 + alpha;
	return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}

function synthPop(rand: () => number): Int16Array {
	const n = Math.floor(SR * 0.06); // 60ms buffer; tail decays to silence
	const bodyF = 300 + rand() * 220; // 300-520Hz hollow "pock" body (dominant)
	const bodyQ = 2.0 + rand() * 1.2;
	const bodyTau = 0.014 + rand() * 0.008; // 14-22ms
	const snapF = 1000 + rand() * 700; // 1000-1700Hz short snap = the crack
	const snapQ = 1.2 + rand() * 0.6;
	const snapTau = 0.003 + rand() * 0.003; // 3-6ms
	const atk = 0.0004; // 0.4ms attack softens a hard DC click
	const amp = 0.6 + rand() * 0.4; // per-kernel loudness variation
	const bp = bandpass(bodyF, bodyQ);
	const sp = bandpass(snapF, snapQ);
	const lpA = 1 - Math.exp((-2 * Math.PI * 2400) / SR); // lowpass ~2.4kHz kills hiss

	const out = new Float64Array(n);
	let bx2 = 0;
	let by1 = 0;
	let by2 = 0;
	let sx2 = 0;
	let sy1 = 0;
	let sy2 = 0;
	let lp = 0;
	let peak = 1e-9;
	const fadeStart = n - Math.floor(SR * 0.002); // 2ms tail fade, no truncation click
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const wb = rand() * 2 - 1;
		const ws = rand() * 2 - 1;
		const yb = bp.b0 * wb + bp.b2 * bx2 - bp.a1 * by1 - bp.a2 * by2;
		bx2 = wb;
		by2 = by1;
		by1 = yb;
		const ys = sp.b0 * ws + sp.b2 * sx2 - sp.a1 * sy1 - sp.a2 * sy2;
		sx2 = ws;
		sy2 = sy1;
		sy1 = ys;
		const attack = t < atk ? t / atk : 1;
		const fade = i > fadeStart ? (n - i) / (n - fadeStart) : 1;
		const raw = yb * Math.exp(-t / bodyTau) + 0.3 * ys * Math.exp(-t / snapTau);
		lp += lpA * (raw - lp);
		const s = attack * fade * lp;
		out[i] = s;
		if (Math.abs(s) > peak) peak = Math.abs(s);
	}

	const pcm = new Int16Array(n);
	const g = (amp / peak) * 32767;
	for (let i = 0; i < n; i++) {
		const v = Math.round(out[i] * g);
		pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
	}
	return pcm;
}

function writeWav(path: string, samples: Int16Array): void {
	const dataLen = samples.length * 2;
	const buf = Buffer.alloc(44 + dataLen);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + dataLen, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16); // PCM fmt chunk size
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(SR, 24);
	buf.writeUInt32LE(SR * 2, 28); // byte rate = SR * channels * bytesPerSample
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits per sample
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataLen, 40);
	for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
	// money-path self-check: header math must be exact or players choke.
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.readUInt32LE(40) !== dataLen)
		throw new Error("bad WAV header");
	writeFileSync(path, buf);
}

// Regenerate fresh variants each load (fast; new random batch per session).
// Files (for the per-pop path) go to a tmp cache; samples kept for the mixer.
function ensurePopcorns(): { files: string[]; pops: Int16Array[] } {
	const pops: Int16Array[] = [];
	try {
		mkdirSync(CACHE, { recursive: true });
		const files = Array.from({ length: VARIANTS }, (_, i) => {
			const p = join(CACHE, `popcorn-${i}.wav`);
			const samples = synthPop(Math.random);
			pops.push(samples);
			writeWav(p, samples);
			return p;
		});
		return { files, pops };
	} catch {
		try {
			const files = readdirSync(CACHE)
				.filter((f) => /^popcorn-.*\.wav$/.test(f))
				.map((f) => join(CACHE, f));
			return { files, pops };
		} catch {
			return { files: [], pops };
		}
	}
}

function nextGapMs(streamMs: number): number {
	const mean = FLOOR_MEAN + (START_MEAN - FLOOR_MEAN) * Math.exp(-streamMs / TAU_MS);
	return Math.max(MIN_GAP, -mean * Math.log(1 - Math.random()));
}

// ---- WSL detection + real-time mixer ---------------------------------------
// WSLg pipes PulseAudio to Windows over RDP; one short-lived player per pop
// gets batched by the RDP sink, so spaced/overlapping pops clump. Under WSL we
// mix all pops into ONE continuous PCM stream fed to a single long-lived
// player, so timing is sample-accurate regardless of the sink.

function isWSL(): boolean {
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

const RAW_PLAYERS: Array<{ cmd: string; args: string[] }> = [
	{
		cmd: "pacat",
		args: ["--playback", "--rate", String(SR), "--channels", "1", "--format", "s16le", "--latency-msec", "50"],
	},
	{ cmd: "pw-cat", args: ["--playback", "--rate", String(SR), "--channels", "1", "--format", "s16", "-"] },
	{
		cmd: "ffplay",
		args: ["-f", "s16le", "-ar", String(SR), "-ch_layout", "mono", "-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "-"],
	},
];

function detectRawPlayer(): { cmd: string; args: string[] } | undefined {
	for (const p of RAW_PLAYERS) {
		try {
			execFileSync("sh", ["-c", `command -v ${p.cmd}`], { stdio: "ignore" });
			return p;
		} catch {
			// not installed, try next
		}
	}
	return undefined;
}

function createMixer(pops: Int16Array[]): (n: number) => Buffer {
	let pos = 0; // samples rendered so far
	let nextOnset = 0; // sample index of the next pop
	let active: Array<{ s: Int16Array; start: number }> = [];
	return (n: number): Buffer => {
		const end = pos + n;
		const acc = new Float64Array(n);
		while (nextOnset < end) {
			active.push({ s: pops[Math.floor(Math.random() * pops.length)], start: Math.round(nextOnset) });
			nextOnset += (nextGapMs((nextOnset / SR) * 1000) / 1000) * SR;
		}
		for (const p of active) {
			const st = Math.max(pos, p.start);
			const en = Math.min(end, p.start + p.s.length);
			for (let g = st; g < en; g++) acc[g - pos] += p.s[g - p.start];
		}
		active = active.filter((p) => p.start + p.s.length > end);
		pos = end;
		const out = Buffer.alloc(n * 2);
		for (let i = 0; i < n; i++) {
			const v = Math.round(acc[i] * 0.7); // headroom so overlapping pops rarely hard-clip
			out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
		}
		return out;
	};
}

// ---- file player detection (portable) --------------------------------------
// First working player wins. All get WAV, so even ALSA-only aplay works.
// Covers PulseAudio (Debian/Ubuntu, WSLg), PipeWire (Arch), ALSA, ffmpeg, sox.
const PLAYERS: Array<{ cmd: string; args: (f: string) => string[] }> = [
	{ cmd: "pw-play", args: (f) => [f] },
	{ cmd: "paplay", args: (f) => [f] },
	{ cmd: "aplay", args: (f) => ["-q", f] },
	{ cmd: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] },
	{ cmd: "play", args: (f) => ["-q", f] },
];

function detectPlayer(): { cmd: string; args: (f: string) => string[] } | undefined {
	for (const p of PLAYERS) {
		try {
			execFileSync("sh", ["-c", `command -v ${p.cmd}`], { stdio: "ignore" });
			return p;
		} catch {
			// not installed, try next
		}
	}
	return undefined;
}

export interface Popper {
	start(): void;
	stop(): void;
}

// Build the popcorn engine once (detects players, generates pops). start() is
// idempotent (safe to call repeatedly while responding); stop() ends popping
// and plays the ding.
export function createPopper(): Popper {
	const player = detectPlayer(); // file player, for the ding + non-WSL pops
	const rawPlayer = isWSL() ? detectRawPlayer() : undefined; // streaming player under WSL
	const { files, pops } = ensurePopcorns();

	const play = (file: string): ChildProcess | undefined => {
		if (!player) return undefined;
		return execFile(player.cmd, player.args(file), () => {});
	};

	// non-WSL: one short-lived player process per pop
	let timer: NodeJS.Timeout | undefined;
	let startedAt = 0;
	const kernels = new Set<ChildProcess>();
	const scheduleNext = () => {
		const delay = nextGapMs(Date.now() - startedAt);
		timer = setTimeout(() => {
			const p = play(files[Math.floor(Math.random() * files.length)]);
			if (p) {
				kernels.add(p);
				p.on("exit", () => kernels.delete(p));
			}
			scheduleNext();
		}, delay);
	};

	// WSL: one long-lived player fed a continuous mixed PCM stream
	let stream: ChildProcess | undefined;
	let ticker: NodeJS.Timeout | undefined;
	const startStream = () => {
		if (!rawPlayer) return;
		const proc = spawn(rawPlayer.cmd, rawPlayer.args, { stdio: ["pipe", "ignore", "ignore"] });
		proc.on("error", () => {
			stream = undefined;
		});
		proc.stdin.on("error", () => {}); // ignore EPIPE if the player dies
		stream = proc;
		const mix = createMixer(pops);
		const lead = Math.floor(SR * 0.06); // keep ~60ms buffered ahead to absorb jitter
		const t0 = Date.now();
		let emitted = 0;
		ticker = setInterval(() => {
			const sin = stream?.stdin;
			if (!sin?.writable) return;
			const target = Math.floor(((Date.now() - t0) / 1000) * SR) + lead;
			const n = target - emitted;
			if (n <= 0) return;
			sin.write(mix(n));
			emitted = target;
		}, 20);
	};
	const stopStream = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (stream) {
			try {
				stream.stdin?.end();
			} catch {
				// already gone
			}
			stream = undefined;
		}
	};

	return {
		start() {
			if (rawPlayer && pops.length > 0) {
				if (!stream) startStream();
			} else if (player && files.length > 0) {
				if (!timer) {
					startedAt = Date.now();
					scheduleNext();
				}
			}
		},
		stop() {
			stopStream();
			if (timer) clearTimeout(timer);
			timer = undefined;
			for (const p of kernels) p.kill();
			kernels.clear();
			play(MICROWAVE);
		},
	};
}
