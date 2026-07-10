import type { Plugin } from "@opencode-ai/plugin";
import { createMainframe } from "../src/mainframe.ts";

export const ComputerNoisesPlugin: Plugin = async () => {
	const mf = createMainframe();
	mf.warm();
	mf.start(); // hum from the very start, stays on until process exit
	return {
		event: async ({ event }) => {
			const e = event as {
				type: string;
				properties?: { info?: { role?: string } };
			};
			if (
				e.type === "message.updated" &&
				e.properties?.info?.role === "assistant"
			) {
				mf.poke();
			}
		},
	};
};

export default ComputerNoisesPlugin;
