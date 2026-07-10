import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMainframe } from "../src/mainframe.ts";

export default function (pi: ExtensionAPI) {
	const mf = createMainframe();
	mf.warm();
	mf.start(); // hum from the very start, stays on until shutdown
	pi.on("session_shutdown", async () => mf.shutdown());
	pi.on("agent_start", async () => mf.poke());
	pi.on("message_update", async () => mf.poke());
}
