import { describe, expect, it } from "vitest";
import { statusText } from "../../src/ui/status-bar";

describe("statusText", () => {
	it("names each state, counting pending conflicts", () => {
		expect(statusText("syncing", null)).toBe("Univault: syncing…");
		expect(statusText("error", null)).toBe("Univault: error");
		expect(statusText("idle", null)).toBe("Univault: idle");
		expect(statusText("conflicts-pending", new Date(), 1)).toBe("Univault: 1 conflict");
		expect(statusText("conflicts-pending", new Date(), 3)).toBe("Univault: 3 conflicts");
	});
});
