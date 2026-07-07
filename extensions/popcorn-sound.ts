import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPopper } from "../src/popper.ts";

export default function (pi: ExtensionAPI) {
	const popper = createPopper();
	pi.on("agent_start", async () => popper.start());
	pi.on("agent_end", async () => popper.stop());
}
