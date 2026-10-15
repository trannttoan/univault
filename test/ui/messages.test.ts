import { describe, expect, it } from "vitest";
import { UnivaultError } from "../../src/errors";
import { signInFailure } from "../../src/ui/messages";

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
