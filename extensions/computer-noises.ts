import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMainframe } from "../src/mainframe.ts";

export default function (pi: ExtensionAPI) {
	const mf = createMainframe();
	mf.warm(); // open the stream now so the first turn has no cold-start delay
	pi.on("agent_start", async (_e, ctx) => {
		mf.start();
		ctx.ui.setStatus("blips", "▮ mainframe");
	});
	pi.on("message_update", async () => mf.poke());
	pi.on("agent_end", async (_e, ctx) => {
		mf.stop();
		ctx.ui.setStatus("blips", undefined);
	});
}
