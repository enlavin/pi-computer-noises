import type { Plugin } from "@opencode-ai/plugin";
import { createPopper } from "../src/popper.ts";

// opencode has no "agent_start"; assistant message.updated fires while
// responding (start() is idempotent), session.idle fires when finished.
export const PopcornPlugin: Plugin = async () => {
	const popper = createPopper();
	return {
		event: async ({ event }) => {
			const e = event as { type: string; properties?: { info?: { role?: string } } };
			if (e.type === "message.updated" && e.properties?.info?.role === "assistant") {
				popper.start();
			} else if (e.type === "session.idle") {
				popper.stop();
			}
		},
	};
};

export default PopcornPlugin;
