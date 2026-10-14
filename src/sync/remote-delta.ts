import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { IndexEntry, SyncAnchor } from "../store/db";

export type RemoteChange = { kind: "added" | "modified"; sha: string } | { kind: "removed" };

export type HeadCheck =
	| { kind: "unchanged"; etag: string | null }
	| { kind: "changed"; sha: string; etag: string | null }
	| { kind: "empty" };

// The compare endpoint lists at most 300 files; a full page may be truncated.
const COMPARE_FILE_LIMIT = 300;

// One conditional request; a 304 against the anchor's ETag costs no quota.
export async function checkHead(
	client: GitHubClient,
	repository: string,
	branch: string,
	anchor: SyncAnchor | null,
): Promise<HeadCheck> {
	const ref = await client.getRef(repository, branch, anchor?.refEtag);
	if (ref.kind === "empty") return { kind: "empty" };
	if (ref.kind === "not-modified") return { kind: "unchanged", etag: anchor?.refEtag ?? null };
	if (anchor && ref.sha === anchor.commitSha) return { kind: "unchanged", etag: ref.etag };
	return { kind: "changed", sha: ref.sha, etag: ref.etag };
}

// Added and modified paths between the anchor and the head, keyed by canonical
// path. Removals are dropped in phase 0. `canonical` throws on unsafe paths.
export async function remoteDelta(
	client: GitHubClient,
	repository: string,
	anchor: SyncAnchor | null,
	head: { commitSha: string; treeSha: string },
	index: Map<string, IndexEntry>,
	canonical: (path: string) => string,
): Promise<Map<string, RemoteChange>> {
	const delta = new Map<string, RemoteChange>();
	// An anchor commit that no longer exists (history rewritten) reads as not-found: use the tree.
	const compare = anchor
		? await client.getCompare(repository, anchor.commitSha, head.commitSha).catch(notFoundAsNull)
		: null;
	if (compare) {
		if (compare.status === "ahead" && compare.files.length < COMPARE_FILE_LIMIT) {
			// renamed, copied and changed all leave content at `filename`.
			for (const file of compare.files) {
				if (file.status === "removed") continue;
				const path = canonical(file.filename);
				delta.set(path, { kind: index.has(path) ? "modified" : "added", sha: file.sha });
			}
			return delta;
		}
	}

	const tree = await client.getTree(repository, head.treeSha);
	if (tree.truncated) throw new UnivaultError("tree-too-large");
	for (const entry of tree.entries) {
		if (entry.type !== "blob") continue;
		const path = canonical(entry.path);
		const known = index.get(path);
		if (known?.blobSha !== entry.sha) delta.set(path, { kind: known ? "modified" : "added", sha: entry.sha });
	}
	return delta;
}

function notFoundAsNull(error: unknown): null {
	if (error instanceof UnivaultError && error.code === "not-found") return null;
	throw error;
}
