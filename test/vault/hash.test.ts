import { expect, it } from "vitest";
import { gitBlobSha } from "../../src/vault/hash";

it("matches git hash-object", async () => {
	expect(await gitBlobSha(new TextEncoder().encode("hello"))).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
	expect(await gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});
