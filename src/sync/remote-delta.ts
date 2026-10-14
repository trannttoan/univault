import type { GitHubClient } from "../github/client";
import type { SyncAnchor } from "../store/db";

export type RemoteChange = { kind: "added" | "modified"; sha: string } | { kind: "removed" };

export type HeadCheck = { kind: "unchanged"; etag: string | null } | { kind: "changed"; sha: string; etag: string | null };

// One conditional request; a 304 against the anchor's ETag costs no quota.
export async function checkHead(
	client: GitHubClient,
	repository: string,
	branch: string,
	anchor: SyncAnchor | null,
): Promise<HeadCheck> {
	const ref = await client.getRef(repository, branch, anchor?.refEtag);
	if (ref.notModified) return { kind: "unchanged", etag: anchor?.refEtag ?? null };
	if (anchor && ref.sha === anchor.commitSha) return { kind: "unchanged", etag: ref.etag };
	return { kind: "changed", sha: ref.sha, etag: ref.etag };
}
