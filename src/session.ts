import { UnivaultError } from "./errors";
import { GitHubClient } from "./github/client";

export const GITHUB_HOST = "https://api.github.com";
const SESSION_KEY = "univault-session";
const VAULT_ID_KEY = "univault-vault-id";

export interface Session {
	host: string;
	login: string;
	accessToken: string;
	authKind: "pat";
}

// Obsidian's App satisfies this: per-vault localStorage, outside the vault folder.
export interface LocalStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

// The only module besides the GitHub client that sees a token.
export class SessionStore {
	constructor(
		private readonly storage: LocalStorage,
		private readonly fetch: typeof globalThis.fetch,
	) {}

	vaultId(): string {
		const existing = this.storage.loadLocalStorage(VAULT_ID_KEY);
		if (typeof existing === "string" && existing) return existing;
		const id = crypto.randomUUID();
		this.storage.saveLocalStorage(VAULT_ID_KEY, id);
		return id;
	}

	login(): string | null {
		return this.load()?.login ?? null;
	}

	async signInWithToken(token: string): Promise<string> {
		const accessToken = token.trim();
		if (!accessToken) throw new UnivaultError("auth-expired");
		const { login } = await this.clientFor(accessToken).getUser();
		const session: Session = { host: GITHUB_HOST, login, accessToken, authKind: "pat" };
		this.storage.saveLocalStorage(SESSION_KEY, session);
		return login;
	}

	signOut(): void {
		this.storage.saveLocalStorage(SESSION_KEY, null);
	}

	// Hands out a ready client so callers never receive the token itself.
	client(): { client: GitHubClient; login: string } | null {
		const session = this.load();
		return session ? { client: this.clientFor(session.accessToken, session.host), login: session.login } : null;
	}

	private clientFor(token: string, host = GITHUB_HOST): GitHubClient {
		return new GitHubClient({ fetch: this.fetch, host, token });
	}

	private load(): Session | null {
		const value = this.storage.loadLocalStorage(SESSION_KEY) as Partial<Session> | null;
		if (!value || typeof value.accessToken !== "string" || typeof value.login !== "string") return null;
		return { host: value.host ?? GITHUB_HOST, login: value.login, accessToken: value.accessToken, authKind: "pat" };
	}
}
