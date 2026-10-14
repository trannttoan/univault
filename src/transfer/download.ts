import type { GitHubClient } from "../github/client";
import type { VaultAdapter } from "../vault/adapter";

// Streams the raw blob into the vault chunk by chunk; the file is replaced only once complete.
export async function download(
	client: GitHubClient,
	repository: string,
	vault: VaultAdapter,
	path: string,
	sha: string,
): Promise<void> {
	await vault.writeChunked(path, await client.getBlobStream(repository, sha));
}
