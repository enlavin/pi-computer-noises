// Microwave popcorn: a synthesized "microwave running" drone bed with random
// popcorn pops layered on top while the agent works, and the microwave-finished
// ding when it stops. Ported from the computer-noises techniques:
//   - one long-lived raw-PCM player fed by a real-time mixer on a dedicated
//     worker thread (immune to the host's event-loop stalls),
//   - warm between turns (silence keeps WSLg's RDP sink primed),
//   - drop-to-realtime so a stall never leaves a burst/tail,
//   - ONE audio owner per user elected via a Unix socket + O_EXCL lock, so any
//     number of pi/opencode instances share a single microwave. Drone+pops play
//     while ANY instance is mid-turn; the ding fires when the LAST turn ends.
//
// Host-agnostic: only Node built-ins. Adapters call createPopper().start/stop().
// Run directly to verify:
//   bun src/popper.ts --check       # assert synth/mixer math
//   bun src/popper.ts --audition 8  # hear drone + pops, then the ding
//   bun src/popper.ts --coord 0:start,4000:stop,5000:quit   # multi-instance
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MICROWAVE = join(HERE, "..", "assets", "microwave-finished.wav");
const SR = 44100;
const VARIANTS = 8;

// Poisson bursts: mean gap decays from START_MEAN to FLOOR_MEAN, but each gap
// is exponentially random -> clustered, uneven pops, not a metronome. The clock
// resets each turn (the microwave reheats sparse -> fast every time).
const FLOOR_MEAN = 55;
const START_MEAN = 420;
const TAU_MS = 5000;
const MIN_GAP = 25; // clamp so overlapping pops stay sane
const MICRO_LEVEL = 0.05; // microwave drone bed level (sits under the pops)

// ---- pop synthesis (pure TS) -----------------------------------------------
// A real pop is a short broadband burst: two band-passed noise layers - a low
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
	let bx2 = 0, by1 = 0, by2 = 0, sx2 = 0, sy1 = 0, sy2 = 0, lp = 0, peak = 1e-9;
	const fadeStart = n - Math.floor(SR * 0.002); // 2ms tail fade, no truncation click
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const wb = rand() * 2 - 1;
		const ws = rand() * 2 - 1;
		const yb = bp.b0 * wb + bp.b2 * bx2 - bp.a1 * by1 - bp.a2 * by2;
		bx2 = wb; by2 = by1; by1 = yb;
		const ys = sp.b0 * ws + sp.b2 * sx2 - sp.a1 * sy1 - sp.a2 * sy2;
		sx2 = ws; sy2 = sy1; sy1 = ys;
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

function nextGapMs(streamMs: number): number {
	const mean = FLOOR_MEAN + (START_MEAN - FLOOR_MEAN) * Math.exp(-streamMs / TAU_MS);
	return Math.max(MIN_GAP, -mean * Math.log(1 - Math.random()));
}

// ---- microwave-finished ding: decode the WAV (s16le/44100/mono) ------------
// The data chunk is NOT at offset 44 (there's a LIST/INFO chunk), so walk the
// RIFF chunks. Returns samples at SR; stereo is downmixed; empty on any failure.
function loadDing(): Int16Array {
	try {
		const buf = readFileSync(MICROWAVE);
		if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
			return new Int16Array(0);
		let off = 12;
		let channels = 1;
		let data: Buffer | undefined;
		while (off + 8 <= buf.length) {
			const id = buf.toString("ascii", off, off + 4);
			const size = buf.readUInt32LE(off + 4);
			const body = off + 8;
			if (id === "fmt ") channels = buf.readUInt16LE(body + 2);
			else if (id === "data") { data = buf.subarray(body, Math.min(body + size, buf.length)); break; }
			off = body + size + (size & 1); // chunks are word-aligned
		}
		if (!data) return new Int16Array(0);
		const total = data.length >> 1;
		if (channels === 2) {
			const n = total >> 1;
			const out = new Int16Array(n);
			for (let i = 0; i < n; i++) out[i] = (data.readInt16LE(i * 4) + data.readInt16LE(i * 4 + 2)) >> 1;
			return out;
		}
		const out = new Int16Array(total);
		for (let i = 0; i < total; i++) out[i] = data.readInt16LE(i * 2);
		return out;
	} catch {
		return new Int16Array(0);
	}
}

// ---- real-time mixer -------------------------------------------------------
// Renders the microwave drone (while popping), Poisson-scheduled pops (clock
// reset each time popping turns on), and a one-shot ding when pullDing() fires.
function createMixer(
	pops: Int16Array[],
	ding: Int16Array,
	poppingOn: () => boolean,
	pullDing: () => boolean,
): (n: number) => Buffer {
	let pos = 0;
	let nextOnset = 0;
	let popClock0 = 0; // sample index popping (re)started, for the accel curve
	let wasPopping = false;
	let voices: Array<{ s: Int16Array; start: number }> = [];
	let lpNoise = 0; // fan-rumble lowpass state, continuous across chunks
	let env = 0; // drone on/off envelope (ramped, no click)
	const rumbleA = 1 - Math.exp((-2 * Math.PI * 200) / SR); // ~200Hz lowpass fan
	const envA = 1 - Math.exp((-2 * Math.PI * 30) / SR); // ~5ms drone ramp

	return (n: number): Buffer => {
		const end = pos + n;
		const acc = new Float64Array(n);
		const popping = poppingOn();

		// microwave drone bed: mains hum + lowpassed motor/fan rumble + faint
		// beating magnetron whine + slow turntable amplitude wobble.
		for (let i = 0; i < n; i++) {
			const t = (pos + i) / SR;
			const mains =
				0.5 * Math.sin(2 * Math.PI * 60 * t) +
				0.2 * Math.sin(2 * Math.PI * 120 * t) +
				0.1 * Math.sin(2 * Math.PI * 180 * t);
			lpNoise += rumbleA * (Math.random() * 2 - 1 - lpNoise);
			const whine = 0.06 * (Math.sin(2 * Math.PI * 2550 * t) + Math.sin(2 * Math.PI * 2610 * t));
			const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.18 * t);
			env += envA * ((popping ? 1 : 0) - env);
			acc[i] += (mains * 0.35 + lpNoise * 2.0 + whine) * lfo * env * MICRO_LEVEL * 32767;
		}

		// pops: Poisson schedule while popping, clock reset on the off->on edge.
		if (popping) {
			if (!wasPopping) { popClock0 = pos; nextOnset = pos; wasPopping = true; }
			while (nextOnset < end) {
				voices.push({ s: pops[Math.floor(Math.random() * pops.length)], start: Math.round(nextOnset) });
				nextOnset += (nextGapMs(((nextOnset - popClock0) / SR) * 1000) / 1000) * SR;
			}
		} else {
			wasPopping = false;
			nextOnset = end; // don't backlog a burst when popping resumes
		}
		if (ding.length && pullDing()) voices.push({ s: ding, start: pos });

		for (const p of voices) {
			const st = Math.max(pos, p.start);
			const en = Math.min(end, p.start + p.s.length);
			for (let g = st; g < en; g++) acc[g - pos] += p.s[g - p.start];
		}
		voices = voices.filter((p) => p.start + p.s.length > end);
		pos = end;
		const buf = Buffer.alloc(n * 2);
		for (let i = 0; i < n; i++) {
			const v = Math.round(acc[i] * 0.8); // headroom against overlap clipping
			buf.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
		}
		return buf;
	};
}

// ---- portable raw-PCM streaming player -------------------------------------
const RAW_PLAYERS: Array<{ cmd: string; args: string[] }> = [
	{ cmd: "pacat", args: ["--playback", "--rate", String(SR), "--channels", "1", "--format", "s16le", "--latency-msec", "40"] },
	{ cmd: "pw-cat", args: ["--playback", "--rate", String(SR), "--channels", "1", "--format", "s16", "-"] },
	{ cmd: "ffplay", args: ["-f", "s16le", "-ar", String(SR), "-ch_layout", "mono", "-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "-"] },
	{ cmd: "play", args: ["-q", "-t", "raw", "-r", String(SR), "-e", "signed", "-b", "16", "-c", "1", "-"] },
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

// ---- pump engine (runs on the worker thread) -------------------------------
interface Pump {
	warm(): void;
	active(on: boolean): void;
	ding(): void;
	shutdown(): void;
}

function createPumpEngine(): Pump {
	const rawPlayer = detectRawPlayer();
	const pops = Array.from({ length: VARIANTS }, () => synthPop(Math.random));
	const ding = loadDing();

	let stream: ChildProcess | undefined;
	let running = false;
	let on = false; // active turn -> drone + pops
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dingUntil = 0; // wall-clock ms; keep rendering (for the ding tail) until then
	let pendingDing = false;

	const spawnPlayer = () => {
		if (!rawPlayer || stream) return;
		const proc = spawn(rawPlayer.cmd, rawPlayer.args, { stdio: ["pipe", "ignore", "ignore"] });
		const gone = () => { if (stream === proc) { stream = undefined; running = false; } };
		proc.on("error", gone);
		proc.on("exit", gone);
		proc.stdin.on("error", () => {}); // ignore EPIPE if the player dies
		stream = proc;
		running = true;
		const mix = createMixer(pops, ding, () => on, () => {
			if (pendingDing) { pendingDing = false; return true; }
			return false;
		});
		const LEAD = Math.floor(SR * 0.1);
		const STEP = Math.floor(SR * 0.02);
		const t0 = Date.now();
		let written = 0;
		const tick = () => {
			if (!running) return;
			const sin = stream?.stdin;
			if (sin?.writable) {
				const target = Math.floor(((Date.now() - t0) / 1000) * SR) + LEAD;
				if (target - written > 2 * LEAD) written = target - LEAD; // drop-to-realtime
				const render = on || Date.now() < dingUntil;
				while (running && written < target) {
					const n = Math.min(STEP, target - written);
					sin.write(render ? mix(n) : Buffer.alloc(n * 2)); // silence keeps stream warm
					written += n;
				}
			}
			timer = setTimeout(tick, 10);
		};
		tick();
	};

	return {
		warm() { spawnPlayer(); },
		active(next: boolean) { spawnPlayer(); on = next; },
		ding() {
			if (!ding.length) return;
			pendingDing = true;
			dingUntil = Date.now() + (ding.length / SR) * 1000 + 300;
		},
		shutdown() {
			running = false;
			on = false;
			dingUntil = 0;
			pendingDing = false;
			if (timer) { clearTimeout(timer); timer = undefined; }
			if (stream) {
				try { stream.kill("SIGKILL"); } catch { /* already gone */ }
				stream = undefined;
			}
		},
	};
}

// Worker-thread entry: the pump lives here, isolated from the host's event loop.
if (!isMainThread && parentPort) {
	const engine = createPumpEngine();
	process.once("exit", () => engine.shutdown());
	parentPort.on("message", (m: string) => {
		if (m === "warm") engine.warm();
		else if (m === "on") engine.active(true);
		else if (m === "off") engine.active(false);
		else if (m === "ding") engine.ding();
		else if (m === "shutdown") { engine.shutdown(); process.exit(0); }
	});
}

function createLocalPump(): Pump {
	let worker: Worker | undefined;
	try {
		worker = new Worker(new URL(import.meta.url));
		worker.on("error", () => { worker = undefined; });
	} catch {
		worker = undefined;
	}
	if (worker) {
		const w = worker;
		const post = (m: string) => { try { w.postMessage(m); } catch { /* worker gone */ } };
		// No terminate() on exit: it orphans the pacat child. Process teardown
		// closes the stdin pipe -> pacat EOFs on its own.
		return {
			warm: () => post("warm"),
			active: (o: boolean) => post(o ? "on" : "off"),
			ding: () => post("ding"),
			shutdown: () => post("shutdown"),
		};
	}
	const engine = createPumpEngine();
	process.once("exit", () => engine.shutdown());
	return engine;
}

// ---- cross-process coordination --------------------------------------------
// One microwave per user shared across ALL pi + opencode instances. Elect an
// owner via connect-first probe + an O_EXCL lock file (bun's listen() silently
// rebinds an occupied unix path, so it can't be the lock). The owner runs the
// pump; other instances are silent clients streaming start/stop. Refcount active
// turns: drone+pops while ANY instance is mid-turn, ding when the LAST ends.
const SOCK_PATH = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "popcorn-popper.sock");
const LOCK_PATH = SOCK_PATH + ".lock";

export interface Popper {
	start(): void;
	stop(): void;
}

export function createPopper(): Popper {
	let selfActive = false; // is THIS instance mid-turn (source of truth across roles)
	let disposed = false;
	let role: { start(): void; stop(): void } = { start() {}, stop() {} };
	let teardown = () => {};

	const becomeOwner = (server: Server) => {
		const pump = createLocalPump();
		let activeCount = 0;
		let selfCounted = false;
		let wasActive = false;
		if (process.env.POP_DEBUG) console.error(`[owner] elected pid=${process.pid}`);
		const apply = () => {
			const nowActive = activeCount > 0;
			if (nowActive && !wasActive) pump.active(true);
			else if (!nowActive && wasActive) { pump.active(false); pump.ding(); } // ding on the last stop
			wasActive = nowActive;
			if (process.env.POP_DEBUG) console.error(`[owner] active=${activeCount}`);
		};
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
					if (m === "start") { if (!cactive) { cactive = true; activeCount++; apply(); } }
					else if (m === "stop") { if (cactive) { cactive = false; activeCount--; apply(); } }
				}
			});
			const drop = () => {
				if (!conns.delete(sock)) return;
				if (cactive) { cactive = false; activeCount--; apply(); }
			};
			sock.on("close", drop);
			sock.on("error", () => {});
		});
		server.on("error", () => {});
		pump.warm();
		if (selfActive) { selfCounted = true; activeCount++; }
		apply();
		role = {
			start: () => { if (!selfCounted) { selfCounted = true; activeCount++; apply(); } },
			stop: () => { if (selfCounted) { selfCounted = false; activeCount--; apply(); } },
		};
		teardown = () => {
			try { server.close(); } catch { /* not listening */ }
			for (const s of conns) { try { s.destroy(); } catch { /* gone */ } }
			try { unlinkSync(SOCK_PATH); } catch { /* already gone */ }
			try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
			pump.shutdown();
		};
	};

	const becomeClient = (sock: Socket) => {
		const send = (m: string) => { try { sock.write(m + "\n"); } catch { /* broken pipe */ } };
		if (process.env.POP_DEBUG) console.error(`[client] connected pid=${process.pid}`);
		if (selfActive) send("start"); // announce current state to the (new) owner
		role = { start: () => send("start"), stop: () => send("stop") };
		teardown = () => { try { sock.destroy(); } catch { /* gone */ } };
		const reElect = () => {
			if (disposed) return;
			role = { start() {}, stop() {} }; // silent until re-elected
			setTimeout(elect, 40 + Math.random() * 80);
		};
		sock.on("close", reElect);
		sock.on("error", () => {});
	};

	const becomeOwnerLocalOnly = () => {
		// socket dir unusable -> private microwave (per-instance), never silent.
		const pump = createLocalPump();
		let wasActive = false;
		pump.warm();
		const apply = () => {
			if (selfActive && !wasActive) pump.active(true);
			else if (!selfActive && wasActive) { pump.active(false); pump.ding(); }
			wasActive = selfActive;
		};
		if (selfActive) apply();
		role = { start: () => apply(), stop: () => apply() };
		teardown = () => pump.shutdown();
	};

	const isAlive = (pid: number) => {
		try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
	};

	const tryOwn = () => {
		if (disposed) return;
		try {
			writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" }); // atomic: EEXIST if held
		} catch (e) {
			if ((e as { code?: string }).code !== "EEXIST") { becomeOwnerLocalOnly(); return; }
			const pid = Number(readFileSync(LOCK_PATH, "utf8")) || 0;
			if (!pid || !isAlive(pid)) { try { unlinkSync(LOCK_PATH); } catch { /* raced */ } }
			setTimeout(elect, 40 + Math.random() * 80);
			return;
		}
		try { unlinkSync(SOCK_PATH); } catch { /* no stale socket */ }
		const server = createServer();
		server.once("error", () => { try { unlinkSync(LOCK_PATH); } catch { /* gone */ } becomeOwnerLocalOnly(); });
		server.listen(SOCK_PATH, () => becomeOwner(server));
	};

	const elect = () => {
		if (disposed) return;
		// Connect-first: a live owner answers -> be a client; nobody answers ->
		// race for the O_EXCL lock, and the winner listens.
		const probe = connect(SOCK_PATH);
		const onErr = () => tryOwn();
		probe.once("connect", () => { probe.removeListener("error", onErr); becomeClient(probe); });
		probe.once("error", onErr);
	};

	elect();
	process.once("exit", () => { disposed = true; teardown(); });

	return {
		start: () => { selfActive = true; role.start(); },
		stop: () => { selfActive = false; role.stop(); },
	};
}

// ---- direct-run: self-check / audition / multi-instance harness ------------
if (import.meta.main && isMainThread) {
	const mode = process.argv[2] ?? "--audition";
	if (mode === "--check") {
		const p = synthPop(Math.random);
		console.assert(p.length === Math.floor(SR * 0.06), "pop length");
		console.assert(p.some((v) => v !== 0), "pop not silent");
		console.assert(p.every((v) => v >= -32768 && v <= 32767), "pop in int16 range");
		const ding = loadDing();
		console.assert(ding.length > 0, "ding decoded");
		let popping = true;
		const mix = createMixer([p], ding, () => popping, () => false);
		const chunk = mix(4410);
		console.assert(chunk.length === 8820, "mixer emits 2 bytes/sample");
		console.assert(chunk.some((_, i) => i % 2 === 0 && chunk.readInt16LE(i) !== 0), "drone/pops audible while popping");
		popping = false;
		let g = 0; const gaps: number[] = [];
		for (let i = 0; i < 200; i++) gaps.push(nextGapMs(g));
		console.assert(gaps.every((x) => x >= MIN_GAP), "gaps respect MIN_GAP");
		if (!detectRawPlayer()) console.warn("no raw player found (pacat/pw-cat/ffplay/play)");
		console.log("ok");
	} else if (mode === "--coord") {
		const pop = createPopper();
		for (const step of (process.argv[3] ?? "").split(",").filter(Boolean)) {
			const [ms, cmd] = step.split(":");
			setTimeout(() => {
				if (cmd === "start") pop.start();
				else if (cmd === "stop") pop.stop();
				else if (cmd === "quit") process.exit(0);
			}, Number(ms));
		}
		setInterval(() => {}, 1 << 30);
	} else {
		const pump = createLocalPump();
		pump.warm();
		pump.active(true);
		const secs = Number(process.argv[3] ?? 8);
		console.log(`auditioning ~${secs}s: microwave drone + accelerating pops, then the ding...`);
		setTimeout(() => { pump.active(false); pump.ding(); }, secs * 1000);
		setTimeout(() => { pump.shutdown(); process.exit(0); }, (secs + 5) * 1000);
	}
}
