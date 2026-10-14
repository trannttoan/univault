import { type ErrorCode, UnivaultError } from "../errors";
import type { Commit, Compare, CompareFile, NewTreeEntry, RefResult, Tree, TreeEntry } from "./types";

const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";
const MAX_READ_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
// Not yet measured against the live API: GitHub documents 422 for a ref update
// that is not a fast forward.
const NON_FAST_FORWARD_STATUS = 422;

export interface GitHubClientOptions {
	fetch: typeof fetch;
	host: string;
	token: string;
	sleep?: (ms: number) => Promise<void>;
}

interface SendOptions {
	body?: unknown;
	accept?: string;
	etag?: string | null;
	conflictStatus?: number;
}

export class GitHubClient {
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #base: string;

	constructor(options: GitHubClientOptions) {
		let url: URL;
		try {
			url = new URL(options.host);
		} catch {
			throw new UnivaultError("unknown", { cause: new Error("GitHub host is not a valid URL") });
		}
		if (url.protocol !== "https:") {
			throw new UnivaultError("unknown", { cause: new Error(`GitHub host must use HTTPS: ${url.origin}`) });
		}
		this.#base = url.href.replace(/\/+$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async getUser(): Promise<{ login: string }> {
		const json = await this.json<{ login: string }>("GET", "/user");
		return { login: json.login };
	}

	async getRef(repo: string, branch: string, etag?: string | null): Promise<RefResult> {
		const res = await this.send("GET", `${repoPath(repo)}/git/ref/heads/${segments(branch)}`, { etag });
		if (res.status === 304) return { notModified: true };
		const json = (await res.json()) as { object: { sha: string } };
		return { notModified: false, sha: json.object.sha, etag: res.headers.get("etag") };
	}

	async getCommit(repo: string, sha: string): Promise<Commit> {
		const json = await this.json<{ sha: string; tree: { sha: string }; parents: { sha: string }[] }>(
			"GET",
			`${repoPath(repo)}/git/commits/${sha}`,
		);
		return { sha: json.sha, treeSha: json.tree.sha, parents: json.parents.map((p) => p.sha) };
	}

	async getCompare(repo: string, base: string, head: string): Promise<Compare> {
		const json = await this.json<{
			status: Compare["status"];
			files?: { filename: string; status: CompareFile["status"]; sha: string; previous_filename?: string }[];
		}>("GET", `${repoPath(repo)}/compare/${base}...${head}`);
		const files = (json.files ?? []).map((f) => ({
			filename: f.filename,
			status: f.status,
			sha: f.sha,
			...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
		}));
		return { status: json.status, files };
	}

	async getTree(repo: string, sha: string): Promise<Tree> {
		const json = await this.json<{ sha: string; truncated: boolean; tree: TreeEntry[] }>(
			"GET",
			`${repoPath(repo)}/git/trees/${sha}?recursive=1`,
		);
		const entries = json.tree.map(({ path, mode, type, sha, size }) => ({
			path,
			mode,
			type,
			sha,
			...(size === undefined ? {} : { size }),
		}));
		return { sha: json.sha, truncated: json.truncated, entries };
	}

	async getBlobStream(repo: string, sha: string): Promise<ReadableStream<Uint8Array>> {
		const res = await this.send("GET", `${repoPath(repo)}/git/blobs/${sha}`, { accept: RAW_ACCEPT });
		if (!res.body) throw new UnivaultError("unknown", { cause: new Error(`Blob ${sha} has no body`) });
		return res.body;
	}

	async createBlob(repo: string, bytes: Uint8Array): Promise<string> {
		const body = { content: toBase64(bytes), encoding: "base64" };
		return (await this.json<{ sha: string }>("POST", `${repoPath(repo)}/git/blobs`, { body })).sha;
	}

	async createTree(repo: string, baseTree: string | null, entries: NewTreeEntry[]): Promise<string> {
		const body = baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries };
		return (await this.json<{ sha: string }>("POST", `${repoPath(repo)}/git/trees`, { body })).sha;
	}

	async createCommit(repo: string, commit: { message: string; tree: string; parents: string[] }): Promise<string> {
		return (await this.json<{ sha: string }>("POST", `${repoPath(repo)}/git/commits`, { body: commit })).sha;
	}

	async updateRef(repo: string, branch: string, sha: string): Promise<void> {
		const res = await this.send("PATCH", `${repoPath(repo)}/git/refs/heads/${segments(branch)}`, {
			body: { sha, force: false },
			conflictStatus: NON_FAST_FORWARD_STATUS,
		});
		await res.body?.cancel();
	}

	async putContents(
		repo: string,
		path: string,
		file: { branch: string; message: string; bytes: Uint8Array },
	): Promise<{ commitSha: string; treeSha: string }> {
		const body = { message: file.message, content: toBase64(file.bytes), branch: file.branch };
		const json = await this.json<{ commit: { sha: string; tree: { sha: string } } }>(
			"PUT",
			`${repoPath(repo)}/contents/${segments(path)}`,
			{ body },
		);
		return { commitSha: json.commit.sha, treeSha: json.commit.tree.sha };
	}

	private async json<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
		return (await (await this.send(method, path, options)).json()) as T;
	}

	private async send(method: string, path: string, options: SendOptions): Promise<Response> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.#token}`,
			Accept: options.accept ?? JSON_ACCEPT,
			"X-GitHub-Api-Version": API_VERSION,
		};
		if (options.etag) headers["If-None-Match"] = options.etag;
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		const init: RequestInit = { method, headers };
		if (options.body !== undefined) init.body = JSON.stringify(options.body);
		const isRead = method === "GET";

		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				res = await this.#fetch(this.#base + path, init);
			} catch (error) {
				if (isRead && attempt < MAX_READ_RETRIES) {
					await this.#sleep(1000 * 2 ** attempt);
					continue;
				}
				const detail = error instanceof Error ? `${error.name}: ${error.message}` : "network failure";
				throw new UnivaultError("offline", { cause: new Error(this.redact(`${method} ${path} failed: ${detail}`)) });
			}
			if (res.ok || res.status === 304) return res;

			const wait = isRead && attempt < MAX_READ_RETRIES ? retryDelay(res, attempt) : null;
			if (wait === null) throw await this.toError(method, path, res, options.conflictStatus);
			await res.body?.cancel();
			await this.#sleep(wait);
		}
	}

	private async toError(method: string, path: string, res: Response, conflictStatus?: number): Promise<UnivaultError> {
		let message = "";
		try {
			message = String(((await res.json()) as { message?: unknown }).message ?? "");
		} catch {
			// Body is not JSON; the status alone is enough.
		}
		const cause = new Error(this.redact(`${method} ${path} returned ${res.status}${message ? `: ${message}` : ""}`));
		return new UnivaultError(statusCode(res, conflictStatus), { cause });
	}

	private redact(text: string): string {
		return this.#token ? text.split(this.#token).join("[redacted]") : text;
	}
}

function statusCode(res: Response, conflictStatus?: number): ErrorCode {
	if (res.status === conflictStatus) return "conflict-retry";
	if (res.status === 401) return "auth-expired";
	if (isRateLimited(res)) return "rate-limited";
	if (res.status === 403) return "forbidden";
	if (res.status === 404) return "not-found";
	return "unknown";
}

function isRateLimited(res: Response): boolean {
	if (res.status === 429) return true;
	return res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
}

// Reads retry on 5xx with backoff, and on rate limits that name a short Retry-After.
function retryDelay(res: Response, attempt: number): number | null {
	const retryAfter = Number(res.headers.get("retry-after"));
	if (isRateLimited(res)) {
		return res.headers.has("retry-after") && retryAfter >= 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS
			? retryAfter * 1000
			: null;
	}
	if (res.status >= 500) return 1000 * 2 ** attempt;
	return null;
}

function repoPath(repo: string): string {
	return `/repos/${segments(repo)}`;
}

function segments(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
