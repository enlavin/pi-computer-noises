// Compiles src/**/*.ts and extensions/**/*.ts to plain .js in dist/, so the
// npm-published package never ships raw TypeScript under node_modules.
// Node refuses to type-strip .ts files whose path contains "node_modules"
// (this is why the npm-registry install of this extension failed to start
// while the git-cloned copy worked fine) — shipping pre-stripped .js sidesteps
// that entirely, for both install methods.
import { stripTypeScriptTypes } from "node:module";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["src", "extensions"];

rmSync(join(ROOT, "dist"), { recursive: true, force: true });

for (const dir of DIRS) {
	for (const file of readdirSync(join(ROOT, dir), { recursive: true })) {
		if (!file.endsWith(".ts")) continue;
		const src = join(ROOT, dir, file);
		const out = join(ROOT, "dist", dir, file.replace(/\.ts$/, ".js"));
		const code = readFileSync(src, "utf8").replace(
			/(from\s+["'][^"']+)\.ts(["'])/g,
			"$1.js$2",
		);
		const js = stripTypeScriptTypes(code, { mode: "strip" });
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, js);
	}
}
console.log("built dist/");
