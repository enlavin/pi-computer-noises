import type { Plugin } from "@opencode-ai/plugin";
import { createMainframe } from "../src/mainframe.ts";

// opencode has no "agent_start"; assistant message.updated fires while
// responding (start is idempotent, poke opens a blip window), session.idle
// fires when finished.
export const ComputerNoisesPlugin: Plugin = async () => {
	const mf = createMainframe();
	return {
		event: async ({ event }) => {
			const e = event as { type: string; properties?: { info?: { role?: string } } };
			if (e.type === "message.updated" && e.properties?.info?.role === "assistant") {
				mf.start();
				mf.poke();
			} else if (e.type === "session.idle") {
				mf.stop();
			}
		},
	};
};

export default ComputerNoisesPlugin;
