import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { createMainframe, THEME_NAMES, themeName } from "../src/mainframe.ts";

interface Config {
	sound: boolean;
	theme: string;
}

const DEFAULTS: Config = { sound: true, theme: "space" };

// Status-bar icon per theme; shell/command lines stay plain names.
const THEME_ICONS: Record<string, string> = {
	space: "🚀",
	robot: "🤖",
};
const DEFAULT_THEME = DEFAULTS.theme;

function configPath(): string {
	return join(getAgentDir(), "computer-noises.json");
}

function loadConfig(): Config {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULTS };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
		return {
			sound: typeof raw.sound === "boolean" ? raw.sound : DEFAULTS.sound,
			theme: themeName(raw.theme) ?? DEFAULTS.theme,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(config: Config): void {
	const path = configPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
	} catch {
		/* read-only agent dir: settings stay per-session */
	}
}

type Fg = (token: never, text: string) => string;

const selectTheme = (theme: { fg: Fg }) => ({
	selectedPrefix: (t: string) => theme.fg("accent" as never, t),
	selectedText: (t: string) => theme.fg("accent" as never, t),
	description: (t: string) => theme.fg("muted" as never, t),
	scrollInfo: (t: string) => theme.fg("dim" as never, t),
	noMatch: (t: string) => theme.fg("warning" as never, t),
});

/** Canonical theme name, or a human-readable complaint. */
function parseTheme(raw: string): { name: string } | { error: string } {
	const name = themeName(raw);
	if (name) return { name };
	return {
		error: `Unknown theme "${raw}". Available: ${THEME_NAMES.join(", ")}`,
	};
}

function describe(config: Config): string {
	return `sound ${config.sound ? "on" : "off"} · theme ${config.theme}`;
}

function usage(): string {
	return [
		"Usage: /computer-noises [sound on|off|toggle] | [theme <name>] | status",
		`Themes: ${THEME_NAMES.join(", ")}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	// An explicit CN_AUDIO_THEME wins over the persisted choice for this process.
	const envTheme = themeName(process.env.CN_AUDIO_THEME);
	if (envTheme) config.theme = envTheme;
	const mf = createMainframe();

	// Settings are shared across processes through the config file, so this
	// instance's `config` can be stale: another pi may have muted or switched
	// theme since we loaded it. Re-read before acting on it, and never write a
	// stale value back over a newer one.
	const refresh = (): Config => {
		const disk = loadConfig();
		config.sound = disk.sound;
		config.theme = envTheme ?? disk.theme;
		return config;
	};

	// Apply settings before any audio plays.
	if (config.theme !== DEFAULT_THEME) mf.setTheme(config.theme);
	mf.muted(!config.sound);
	mf.warm();
	mf.start(); // hum from the very start, stays on until shutdown

	const apply = (next: Config, ctx: ExtensionCommandContext) => {
		mf.setTheme(next.theme);
		mf.muted(!next.sound);
		config.theme = next.theme;
		config.sound = next.sound;
		saveConfig(config);
		updateStatus(ctx);
	};

	// Last UI context seen, so the shared-state listener can redraw the status of
	// this instance when ANOTHER pi changes the theme or mutes the sound.
	let activeCtx: { ui: ExtensionContext["ui"] } | undefined;
	let rendered = "";

	const renderStatus = (ctx: { ui: ExtensionCommandContext["ui"] } | undefined) => {
		if (!ctx?.ui) return;
		const line = config.sound
			? `${THEME_ICONS[config.theme] ?? "♪"} ${config.theme}`
			: "🔇 off";
		if (line === rendered) return;
		rendered = line;
		ctx.ui.setStatus("noises", line);
	};

	const updateStatus = (ctx: { ui: ExtensionContext["ui"] } | undefined) => {
		activeCtx = ctx ?? activeCtx;
		renderStatus(activeCtx);
	};

	// The audio owner broadcasts shared settings to every instance; adopt them so
	// this process's status line (and its poke gating) stays in sync.
	mf.onSettingsChange((shared) => {
		config.sound = !shared.muted;
		config.theme = shared.theme;
		updateStatus(activeCtx);
	});

	const themeItems = (): SelectItem[] =>
		THEME_NAMES.map((name) => ({
			value: name,
			label: name === refresh().theme ? `${name} (active)` : name,
			description:
				name === "space"
					? "Low-mid mainframe texture (default)"
					: "Original high telemetry beeps",
		}));

	const pickTheme = async (ctx: ExtensionCommandContext): Promise<void> => {
		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Computer noises: theme"))));
			const list = new SelectList(themeItems(), THEME_NAMES.length, selectTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!result) return;
		apply({ ...refresh(), theme: result }, ctx);
		ctx.ui.notify(`Theme: ${result}`, "info");
	};

	const showMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
		const current = refresh();
		const items: SelectItem[] = [
			{
				value: "toggle-sound",
				label: `Sound: ${current.sound ? "on" : "off"}`,
				description: current.sound ? "Mute the hum and all blips" : "Unmute",
			},
			{
				value: "theme",
				label: `Theme: ${current.theme}`,
				description: "Choose the sound world",
			},
		];
		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Computer noises"))));
			const list = new SelectList(items, items.length, selectTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (result === "toggle-sound") {
			const next = refresh();
			apply({ ...next, sound: !next.sound }, ctx);
			ctx.ui.notify(`Sound ${config.sound ? "on" : "off"}`, "info");
		} else if (result === "theme") {
			await pickTheme(ctx);
		}
	};

	pi.registerCommand("computer-noises", {
		description: "Mainframe sound: on/off and theme",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest[0]?.toLowerCase();

			if (!sub) {
				if (ctx.mode === "tui") await showMenu(ctx);
				else ctx.ui.notify(describe(config), "info");
				return;
			}

			if (sub === "sound" || sub === "volume" || sub === "mute") {
				const current = refresh();
				if (!value || value === "toggle") {
					apply({ ...current, sound: !current.sound }, ctx);
				} else if (["on", "true", "1", "enable"].includes(value)) {
					apply({ ...current, sound: true }, ctx);
				} else if (["off", "false", "0", "disable", "mute"].includes(value)) {
					apply({ ...current, sound: false }, ctx);
				} else {
					ctx.ui.notify(`Expected on or off, got "${rest[0]}".`, "error");
					return;
				}
				ctx.ui.notify(`Sound ${config.sound ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "theme") {
				if (!value) {
					if (ctx.mode === "tui") await pickTheme(ctx);
					else ctx.ui.notify(describe(config), "info");
					return;
				}
				const parsed = parseTheme(value);
				if ("error" in parsed) {
					ctx.ui.notify(parsed.error, "error");
					return;
				}
				apply({ ...refresh(), theme: parsed.name }, ctx);
				ctx.ui.notify(`Theme: ${parsed.name}`, "info");
				return;
			}

			if (sub === "status") {
				ctx.ui.notify(describe(config), "info");
				return;
			}

			ctx.ui.notify(usage(), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("agent_start", async (_event, ctx) => {
		refresh();
		updateStatus(ctx);
	});
	pi.on("session_shutdown", async () => mf.shutdown());
	pi.on("agent_start", async () => {
		if (refresh().sound) mf.poke();
	});
	pi.on("message_update", async () => {
		if (refresh().sound) mf.poke();
	});
}
