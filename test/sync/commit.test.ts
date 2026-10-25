import { describe, expect, it } from "vitest";
import { commitMessage, deviceTrailer } from "../../src/sync/commit";

describe("commit trailers", () => {
	it("reads back the device trailer it writes, with the merge trailers after it", () => {
		const sha = "a".repeat(40);
		const message = commitMessage("My  Phone/2", "octo", [{ path: "a b.md", base: sha, ours: sha, theirs: sha }]);
		expect(deviceTrailer(message)).toEqual({ login: "octo", device: "My Phone/2" });
	});

	it("returns null for a commit made outside Univault", () => {
		expect(deviceTrailer("Update notes\n\nSigned-off-by: someone")).toBeNull();
	});
});
