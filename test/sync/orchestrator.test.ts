import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, REPO } from "./harness";

describe("Orchestrator", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await createHarness();
	});

	it("makes one free 304 request and no commit when nothing changed", async () => {
		await h.inSync({ "a.md": "a", "notes/b.md": "b" });
		const head = h.github.head(REPO, "main");
		const quota = h.github.rateLimitRemaining;

		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });

		expect(h.github.requests).toEqual([{ method: "GET", path: `/repos/${REPO}/git/ref/heads/main`, status: 304 }]);
		expect(h.github.rateLimitRemaining).toBe(quota);
		expect(h.github.head(REPO, "main")).toBe(head);
		expect(h.states).toEqual(["syncing", "idle"]);
		expect(h.orchestrator.lastSyncAt).not.toBeNull();
	});

	it("follows an upload with a no-op sync that is exactly one 304", async () => {
		await h.inSync({ "a.md": "before" });
		h.vault.setFile("a.md", "after");
		expect(await h.orchestrator.sync("manual")).toMatchObject({ kind: "synced", uploaded: 1 });

		h.github.requests.length = 0;
		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(h.github.requests).toEqual([{ method: "GET", path: `/repos/${REPO}/git/ref/heads/main`, status: 304 }]);
	});

	it("keeps no ETag when another device pushes right after our ref update", async () => {
		await h.inSync({ "a.md": "before" });
		h.vault.setFile("a.md", "after");
		let pushed = false;
		h.github.onRequest = (method, path) => {
			if (method === "GET" && path.includes("/git/ref/") && h.github.requests.some((r) => r.method === "PATCH") && !pushed) {
				pushed = true;
				h.github.commitFiles(REPO, "main", { "b.md": "from phone" });
			}
		};
		await h.orchestrator.sync("manual");
		expect((await h.store.getAnchor())?.refEtag).toBeNull();

		h.github.onRequest = null;
		expect(await h.orchestrator.sync("manual")).toMatchObject({ kind: "synced", downloaded: 1 });
		expect(new TextDecoder().decode(h.vault.bytes("b.md"))).toBe("from phone");
	});

	it("stores a fresh ref ETag when the head matches the anchor without one", async () => {
		await h.inSync({ "a.md": "a" });
		const anchor = (await h.store.getAnchor())!;
		await h.store.advance({ ...anchor, refEtag: null }, []);

		await h.orchestrator.sync("manual");
		expect((await h.store.getAnchor())?.refEtag).toMatch(/^W\//);

		h.github.requests.length = 0;
		await h.orchestrator.sync("manual");
		expect(h.github.requests.map((r) => r.status)).toEqual([304]);
	});

	it("coalesces calls during a run into one follow-up", async () => {
		await h.inSync({ "a.md": "a" });
		const first = h.orchestrator.sync("manual");
		const second = h.orchestrator.sync("manual");
		const third = h.orchestrator.sync("manual");

		expect(await first).toEqual(await second);
		expect(await third).toEqual({ kind: "synced", uploaded: 0, downloaded: 0 });
		expect(h.github.requests).toHaveLength(2);
		expect(h.states).toEqual(["syncing", "idle", "syncing", "idle"]);
	});

	it("moves to error on a UnivaultError and back to idle on the next success", async () => {
		await h.inSync({ "a.md": "a" });
		h.github.inject("GET", /git\/ref/, { status: 401 });

		const failed = await h.orchestrator.sync("manual");
		expect(failed.kind === "failed" && failed.error.code).toBe("auth-expired");
		expect(h.orchestrator.state).toBe("error");

		expect((await h.orchestrator.sync("manual")).kind).toBe("synced");
		expect(h.orchestrator.state).toBe("idle");
	});

	it("reports needs-setup without a session or repository and makes no request", async () => {
		h.signedIn = false;
		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "needs-setup" });
		h.signedIn = true;
		h.settings = { ...h.settings, repository: "" };
		expect(await h.orchestrator.sync("manual")).toEqual({ kind: "needs-setup" });
		expect(h.orchestrator.state).toBe("error");
		expect(h.github.requests).toHaveLength(0);
	});

	it("removes temp files left by an interrupted download", async () => {
		await h.inSync({ "a.md": "a" });
		h.vault.setFile("b.md.univault-partial", "par");
		await h.orchestrator.sync("manual");
		expect(h.vault.files.has("b.md.univault-partial")).toBe(false);
	});

	it("ignores a local deletion in phase 0", async () => {
		await h.inSync({ "a.md": "a", "b.md": "b" });
		h.vault.files.delete("b.md");
		expect((await h.orchestrator.sync("manual")).kind).toBe("synced");
		expect(h.github.requests).toHaveLength(1);
	});
});
