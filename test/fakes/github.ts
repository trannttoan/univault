import { createHash } from "node:crypto";

// In-memory GitHub REST fake, called through the same fetch signature the
// client uses. Blob SHAs are real git ids; tree and commit SHAs are
// deterministic stand-ins. Status codes follow the TRD's measured responses.

type FileMap = Map<string, { mode: string; sha: string }>;

interface FakeCommit {
	tree: string;
	parents: string[];
	message: string;
	author: { name: string; date: string };
}

interface FakeRepo {
	blobs: Map<string, Uint8Array>;
	trees: Map<string, FileMap>;
	commits: Map<string, FakeCommit>;
	refs: Map<string, string>;
}

export interface RequestRecord {
	method: string;
	path: string;
	status: number;
}

type Injected =
	| { status: number; headers?: Record<string, string>; body?: unknown }
	// A 200 whose body sends these chunks, then errors, like a connection dropped mid-transfer.
	| { brokenStream: Uint8Array[] }
	| "network";

// Handlers read only the groups their own pattern captures.
type Groups = [string, string, string, string, string];

interface Route {
	method: string;
	pattern: RegExp;
	handle: (repo: FakeRepo | undefined, match: Groups, req: FakeRequest) => Response;
}

interface FakeRequest {
	headers: Headers;
	body: unknown;
	url: URL;
}

export class FakeGitHub {
	readonly requests: RequestRecord[] = [];
	readonly cacheModes: (RequestCache | undefined)[] = [];
	readonly tokens = new Map<string, string>();
	rateLimitRemaining = 5000;
	blobChunkSize = 4;
	// Runs before each request is handled, e.g. to let "another device" push mid-sync.
	onRequest: ((method: string, path: string) => void) | null = null;
	// Author date of new commits; GitHub sets it to the time of the request.
	now: () => Date = () => new Date();
	private readonly repos = new Map<string, FakeRepo>();
	private readonly injected: { method: string; pattern: RegExp; response: Injected }[] = [];
	private commitCounter = 0;

	addToken(token: string, login: string): void {
		this.tokens.set(token, login);
	}

	createRepo(name: string): void {
		this.repos.set(name, { blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map() });
	}

	// Seeds the remote as another device would: one commit on top of the branch head.
	commitFiles(
		name: string,
		branch: string,
		files: Record<string, string | Uint8Array>,
		message = "seed",
		author = "octo",
	): string {
		const repo = this.repo(name);
		const head = repo.refs.get(branch);
		const base = head ? repo.trees.get(repo.commits.get(head)!.tree)! : new Map();
		const tree: FileMap = new Map(base);
		for (const [path, content] of Object.entries(files)) {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			tree.set(path, { mode: "100644", sha: this.storeBlob(repo, bytes) });
		}
		const commit = { tree: this.storeTree(repo, tree), parents: head ? [head] : [], message, author: this.author(author) };
		const sha = this.storeCommit(repo, commit);
		repo.refs.set(branch, sha);
		return sha;
	}

	// Drops every ref, so the repository answers as empty, like one recreated on GitHub.
	empty(name: string): void {
		this.repo(name).refs.clear();
	}

	head(name: string, branch: string): string | undefined {
		return this.repo(name).refs.get(branch);
	}

	commit(name: string, sha: string): FakeCommit | undefined {
		return this.repo(name).commits.get(sha);
	}

	file(name: string, branch: string, path: string): Uint8Array | undefined {
		const repo = this.repo(name);
		const head = repo.refs.get(branch);
		const entry = head ? repo.trees.get(repo.commits.get(head)!.tree)!.get(path) : undefined;
		return entry ? repo.blobs.get(entry.sha) : undefined;
	}

	// The next request matching method and path gets this response instead.
	inject(method: string, pattern: RegExp, response: Injected): void {
		this.injected.push({ method, pattern, response });
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const path = url.pathname + url.search;
		this.onRequest?.(method, path);
		this.cacheModes.push(init?.cache);
		const injectedAt = this.injected.findIndex((i) => i.method === method && i.pattern.test(path));
		if (injectedAt >= 0) {
			const response = this.injected.splice(injectedAt, 1)[0]!.response;
			if (response === "network") throw new TypeError("fetch failed");
			if ("brokenStream" in response) {
				const chunks = [...response.brokenStream];
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						const chunk = chunks.shift();
						if (chunk) controller.enqueue(chunk);
						else controller.error(new TypeError("network error"));
					},
				});
				return this.record(method, path, new Response(body, { status: 200 }));
			}
			return this.respond(method, path, response.status, response.body ?? { message: "injected" }, response.headers);
		}

		const headers = new Headers(init?.headers);
		const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		if (!this.tokens.has(token)) return this.respond(method, path, 401, { message: "Bad credentials" });
		if (this.rateLimitRemaining <= 0) {
			return this.respond(method, path, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
		}

		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const req: FakeRequest = { headers, body, url };
		if (method === "GET" && url.pathname === "/user") {
			return this.respond(method, path, 200, { login: this.tokens.get(token) });
		}
		for (const route of this.routes) {
			const exec = route.pattern.exec(url.pathname);
			if (route.method !== method || !exec) continue;
			const match = exec as unknown as Groups;
			const repo = this.repos.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`);
			const res = repo ? route.handle(repo, match, req) : json(404, { message: "Not Found" });
			return this.record(method, path, res);
		}
		return this.respond(method, path, 404, { message: "Not Found" });
	};

	private readonly routes: Route[] = [
		{
			method: "GET",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/,
			handle: (repo, m, req) => {
				if (isEmpty(repo!)) return emptyRepo();
				const sha = repo!.refs.get(decodeSegments(m[3]));
				if (!sha) return json(404, { message: "Not Found" });
				const etag = `"${sha}"`;
				const ifNoneMatch = req.headers.get("if-none-match")?.replace(/^W\//, "");
				if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
				return json(200, { ref: `refs/heads/${decodeSegments(m[3])}`, object: { sha, type: "commit" } }, { etag: `W/${etag}` });
			},
		},
		{
			method: "GET",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([0-9a-f]{40})$/,
			handle: (repo, m) => {
				const commit = repo!.commits.get(m[3]);
				if (!commit) return json(404, { message: "Not Found" });
				return json(200, {
					sha: m[3],
					message: commit.message,
					author: { ...commit.author, email: `${commit.author.name}@example.com` },
					tree: { sha: commit.tree },
					parents: commit.parents.map((sha) => ({ sha })),
				});
			},
		},
		{
			method: "GET",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([0-9a-f]{40})$/,
			handle: (repo, m) => {
				if (isEmpty(repo!)) return emptyRepo();
				const tree = repo!.trees.get(m[3]);
				if (!tree) return json(404, { message: "Not Found" });
				return json(200, { sha: m[3], truncated: false, tree: listTree(repo!, tree) });
			},
		},
		{
			method: "GET",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([0-9a-f]{40})$/,
			handle: (repo, m, req) => {
				if (isEmpty(repo!)) return emptyRepo();
				const bytes = repo!.blobs.get(m[3]);
				if (!bytes) return json(404, { message: "Not Found" });
				if (req.headers.get("accept") !== "application/vnd.github.raw+json") {
					return json(200, { sha: m[3], size: bytes.byteLength, content: Buffer.from(bytes).toString("base64"), encoding: "base64" });
				}
				return new Response(chunked(bytes, this.blobChunkSize), { status: 200 });
			},
		},
		{
			method: "GET",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/,
			handle: (repo, m) => {
				const base = repo!.commits.get(m[3]);
				const head = repo!.commits.get(m[4]);
				if (!base || !head) return json(404, { message: "Not Found" });
				const files = diffTrees(repo!, base.tree, head.tree).slice(0, 300);
				return json(200, { status: compareStatus(repo!, m[3], m[4]), files });
			},
		},
		{
			method: "POST",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/,
			handle: (repo, _m, req) => {
				if (isEmpty(repo!)) return emptyRepo();
				const { content, encoding } = req.body as { content: string; encoding: string };
				const bytes = encoding === "base64" ? new Uint8Array(Buffer.from(content, "base64")) : new TextEncoder().encode(content);
				const sha = this.storeBlob(repo!, bytes);
				return json(201, { sha, url: "" });
			},
		},
		{
			method: "POST",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/,
			handle: (repo, _m, req) => {
				if (isEmpty(repo!)) return emptyRepo();
				const { base_tree, tree: entries } = req.body as {
					base_tree?: string;
					tree: { path: string; mode: string; sha: string | null }[];
				};
				const base = base_tree ? repo!.trees.get(base_tree) : new Map();
				if (!base) return json(422, { message: "base_tree is not a valid tree" });
				const tree: FileMap = new Map(base);
				for (const entry of entries) {
					if (entry.sha === null) tree.delete(entry.path);
					else if (!repo!.blobs.has(entry.sha)) return json(422, { message: "Invalid sha" });
					else tree.set(entry.path, { mode: entry.mode, sha: entry.sha });
				}
				return json(201, { sha: this.storeTree(repo!, tree) });
			},
		},
		{
			method: "POST",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/,
			handle: (repo, _m, req) => {
				if (isEmpty(repo!)) return emptyRepo();
				const { message, tree, parents } = req.body as FakeCommit;
				if (!repo!.trees.has(tree) || parents.some((p) => !repo!.commits.has(p))) {
					return json(422, { message: "Invalid tree or parent" });
				}
				const author = this.author(this.login(req));
				return json(201, { sha: this.storeCommit(repo!, { message, tree, parents, author }) });
			},
		},
		{
			method: "PATCH",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/,
			handle: (repo, m, req) => {
				const branch = decodeSegments(m[3]);
				const current = repo!.refs.get(branch);
				const { sha, force } = req.body as { sha: string; force?: boolean };
				if (!current) return json(422, { message: "Reference does not exist" });
				if (!repo!.commits.has(sha)) return json(422, { message: "Object does not exist" });
				if (!force && !isAncestor(repo!, current, sha)) return json(422, { message: "Update is not a fast forward" });
				repo!.refs.set(branch, sha);
				return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
			},
		},
		{
			method: "PUT",
			pattern: /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
			handle: (repo, m, req) => {
				const { message, content, branch } = req.body as { message: string; content: string; branch: string };
				const path = decodeSegments(m[3]);
				const head = repo!.refs.get(branch);
				if (!head && !isEmpty(repo!)) return json(404, { message: `Branch ${branch} not found` });
				const tree: FileMap = new Map(head ? repo!.trees.get(repo!.commits.get(head)!.tree)! : new Map());
				if (tree.has(path)) return json(422, { message: '"sha" wasn\'t supplied.' });
				tree.set(path, { mode: "100644", sha: this.storeBlob(repo!, new Uint8Array(Buffer.from(content, "base64"))) });
				const treeSha = this.storeTree(repo!, tree);
				const author = this.author(this.login(req));
				const sha = this.storeCommit(repo!, { message, tree: treeSha, parents: head ? [head] : [], author });
				repo!.refs.set(branch, sha);
				return json(201, { content: { path }, commit: { sha, tree: { sha: treeSha } } });
			},
		},
	];

	private respond(method: string, path: string, status: number, body: unknown, headers?: Record<string, string>): Response {
		return this.record(method, path, json(status, body, headers));
	}

	private record(method: string, path: string, res: Response): Response {
		if (res.status !== 304 && this.rateLimitRemaining > 0) this.rateLimitRemaining--;
		res.headers.set("x-ratelimit-remaining", String(this.rateLimitRemaining));
		this.requests.push({ method, path, status: res.status });
		return res;
	}

	private author(name: string): FakeCommit["author"] {
		return { name, date: this.now().toISOString().replace(/\.\d{3}Z$/, "Z") };
	}

	private login(req: FakeRequest): string {
		return this.tokens.get(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "") ?? "unknown";
	}

	private repo(name: string): FakeRepo {
		const repo = this.repos.get(name);
		if (!repo) throw new Error(`No fake repository ${name}`);
		return repo;
	}

	private storeBlob(repo: FakeRepo, bytes: Uint8Array): string {
		const sha = sha1(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]));
		repo.blobs.set(sha, bytes);
		return sha;
	}

	private storeTree(repo: FakeRepo, tree: FileMap): string {
		const lines = [...tree].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => `${e.mode} ${e.sha} ${p}`);
		const sha = sha1(`tree\n${lines.join("\n")}`);
		repo.trees.set(sha, tree);
		return sha;
	}

	private storeCommit(repo: FakeRepo, commit: FakeCommit): string {
		const sha = sha1(`commit ${++this.commitCounter}\n${JSON.stringify(commit)}`);
		repo.commits.set(sha, commit);
		return sha;
	}
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function emptyRepo(): Response {
	return json(409, { message: "Git Repository is empty." });
}

function isEmpty(repo: FakeRepo): boolean {
	return repo.refs.size === 0;
}

function sha1(data: string | Uint8Array): string {
	return createHash("sha1").update(data).digest("hex");
}

function decodeSegments(path: string): string {
	return path.split("/").map(decodeURIComponent).join("/");
}

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.byteLength) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

function listTree(repo: FakeRepo, tree: FileMap) {
	const folders = new Set<string>();
	const entries: { path: string; mode: string; type: string; sha: string; size?: number }[] = [];
	for (const [path, entry] of tree) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
		entries.push({ path, mode: entry.mode, type: "blob", sha: entry.sha, size: repo.blobs.get(entry.sha)!.byteLength });
	}
	for (const folder of folders) entries.push({ path: folder, mode: "040000", type: "tree", sha: sha1(`folder ${folder}`) });
	return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function diffTrees(repo: FakeRepo, baseSha: string, headSha: string) {
	const base = repo.trees.get(baseSha)!;
	const head = repo.trees.get(headSha)!;
	const files: { filename: string; status: string; sha: string }[] = [];
	for (const [path, entry] of head) {
		const before = base.get(path);
		if (!before) files.push({ filename: path, status: "added", sha: entry.sha });
		else if (before.sha !== entry.sha) files.push({ filename: path, status: "modified", sha: entry.sha });
	}
	for (const [path, entry] of base) {
		if (!head.has(path)) files.push({ filename: path, status: "removed", sha: entry.sha });
	}
	return files;
}

function isAncestor(repo: FakeRepo, ancestor: string, sha: string): boolean {
	const queue = [sha];
	const seen = new Set<string>();
	while (queue.length) {
		const current = queue.shift()!;
		if (current === ancestor) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		queue.push(...(repo.commits.get(current)?.parents ?? []));
	}
	return false;
}

function compareStatus(repo: FakeRepo, base: string, head: string): string {
	if (base === head) return "identical";
	if (isAncestor(repo, base, head)) return "ahead";
	if (isAncestor(repo, head, base)) return "behind";
	return "diverged";
}
