import type { GitHubClient } from "../github/client";
import type { NewTreeEntry } from "../github/types";

export interface MergeTrailer {
	path: string;
	base: string;
	ours: string;
	theirs: string;
}

// Subject plus the ADR-005 trailers, which are frozen once released. Readers parse
// Univault-Merge from the right, since the path may contain spaces.
export function commitMessage(deviceName: string, login: string, merges: MergeTrailer[] = []): string {
	const device = deviceName.replace(/\s+/g, " ").trim();
	const trailers = [`Univault-Device: ${login}/${device}`];
	for (const m of merges) trailers.push(`Univault-Merge: ${m.path} ${m.base} ${m.ours} ${m.theirs}`);
	return `Sync from ${device}\n\n${trailers.join("\n")}`;
}

// The Univault-Device trailer read back; null for a commit made outside Univault.
export function deviceTrailer(message: string): { login: string; device: string } | null {
	const match = /^Univault-Device: ([^/\n]+)\/(.+)$/m.exec(message);
	return match?.[1] && match[2] ? { login: match[1], device: match[2].trim() } : null;
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
