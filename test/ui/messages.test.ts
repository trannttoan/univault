import { describe, expect, it } from "vitest";
import { UnivaultError } from "../../src/errors";
import { outcomeMessage, signInFailure } from "../../src/ui/messages";

describe("signInFailure", () => {
	it("surfaces the cause for an offline failure and says the old session is kept", () => {
		const error = new UnivaultError("offline", { cause: new Error("GET /user failed: TypeError: Failed to fetch") });
		expect(signInFailure(error, "octocat")).toBe(
			"You're offline. (GET /user failed: TypeError: Failed to fetch) Still signed in as octocat.",
		);
	});

	it("omits the cause for a rejected token", () => {
		const error = new UnivaultError("auth-expired", { cause: new Error("GET /user returned 401: Bad credentials") });
		expect(signInFailure(error, null)).toBe("GitHub rejected the token. Enter a new one in settings.");
	});

	it("treats anything else as unknown with its message", () => {
		expect(signInFailure(new TypeError("boom"), "octocat")).toBe("Sync failed unexpectedly. Still signed in as octocat.");
	});
});

describe("outcomeMessage", () => {
	it("counts merges and conflicts left to resolve", () => {
		expect(outcomeMessage({ kind: "synced", uploaded: 1, downloaded: 2, merged: ["a.md", "b.md"] })).toBe(
			"Univault: synced, 1 uploaded, 2 downloaded, 2 merged.",
		);
		expect(outcomeMessage({ kind: "synced", uploaded: 1, downloaded: 0, conflicts: ["a.md"] })).toBe(
			"Univault: synced, 1 uploaded, 0 downloaded. 1 conflict to resolve.",
		);
		expect(outcomeMessage({ kind: "synced", uploaded: 0, downloaded: 0, conflicts: ["a.md", "b.md"] })).toBe(
			"Univault: already in sync. 2 conflicts to resolve.",
		);
		expect(outcomeMessage({ kind: "synced", uploaded: 0, downloaded: 0 })).toBe("Univault: already in sync.");
	});

	it("tells a first sync's differing files apart from a repository that kept changing", () => {
		const first = outcomeMessage({ kind: "first-sync-differs", paths: ["a.md", "c.md"] });
		expect(first).toContain("can't combine them yet");
		expect(first).toContain("Files: a.md, c.md");
		const raced = outcomeMessage({ kind: "failed", error: new UnivaultError("conflict-retry") });
		expect(raced).toBe("Univault: The repository kept changing during sync. Try again.");
	});
});
