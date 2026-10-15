import type { GitHubClient } from "../github/client";
import type { NewTreeEntry } from "../github/types";

// Subject plus the ADR-005 trailer, which is frozen once released.
export function commitMessage(deviceName: string, login: string): string {
	const device = deviceName.replace(/\s+/g, " ").trim();
	return `Sync from ${device}\n\nUnivault-Device: ${login}/${device}`;
}

export async function createSyncCommit(
	client: GitHubClient,
	repository: string,
	head: { commitSha: string; treeSha: string },
	entries: NewTreeEntry[],
	message: string,
): Promise<{ commitSha: string; treeSha: string }> {
	const treeSha = await client.createTree(repository, head.treeSha, entries);
	const commitSha = await client.createCommit(repository, { message, tree: treeSha, parents: [head.commitSha] });
	return { commitSha, treeSha };
}
