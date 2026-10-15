import { beforeEach, describe, expect, it } from "vitest";
import { UnivaultError } from "../src/errors";
import { SessionStore } from "../src/session";
import { FakeGitHub } from "./fakes/github";
import { App } from "./fakes/obsidian";

const TOKEN = "github_pat_secret123";

describe("SessionStore", () => {
	let app: App;
	let github: FakeGitHub;

	beforeEach(() => {
		app = new App();
		github = new FakeGitHub();
		github.addToken(TOKEN, "octo");
	});

	it("stores token and login in local storage after GET /user", async () => {
		const session = new SessionStore(app, github.fetch);
		expect(await session.signInWithToken(` ${TOKEN}\n`)).toBe("octo");
		expect(app.localStorage.get("univault-session")).toEqual({
			host: "https://api.github.com",
			login: "octo",
			accessToken: TOKEN,
			authKind: "pat",
		});
		expect(github.requests).toEqual([{ method: "GET", path: "/user", status: 200 }]);
		expect(new SessionStore(app, github.fetch).login()).toBe("octo");
	});

	it("leaves no session when GitHub rejects the token", async () => {
		const session = new SessionStore(app, github.fetch);
		const error = await session.signInWithToken("wrong").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UnivaultError);
		expect((error as UnivaultError).code).toBe("auth-expired");
		expect(app.localStorage.has("univault-session")).toBe(false);
		expect(session.client()).toBeNull();
	});

	it("hands out a working client and the login, not the token", async () => {
		const session = new SessionStore(app, github.fetch);
		await session.signInWithToken(TOKEN);
		const handle = session.client();
		expect(Object.keys(handle ?? {})).toEqual(["client", "login"]);
		expect(await handle?.client.getUser()).toEqual({ login: "octo" });
		expect(JSON.stringify(handle)).not.toContain(TOKEN);
	});

	it("keeps the vault id stable across reloads", () => {
		const id = new SessionStore(app, github.fetch).vaultId();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(new SessionStore(app, github.fetch).vaultId()).toBe(id);
		expect(new SessionStore(new App(), github.fetch).vaultId()).not.toBe(id);
	});
});
