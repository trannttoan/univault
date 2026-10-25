import type { GitHubClient } from "../github/client";
import type { VaultAdapter, VaultStat } from "../vault/adapter";

// Streams the raw blob into the vault chunk by chunk; the file is replaced only once complete.
export async function download(
	client: GitHubClient,
	repository: string,
	vault: VaultAdapter,
	path: string,
	sha: string,
	expected: VaultStat | null,
): Promise<void> {
	await vault.writeChunked(path, await client.getBlobStream(repository, sha), expected);
}

// Whole blob on the heap, for the merge engine.
export async function readBlob(client: GitHubClient, repository: string, sha: string): Promise<Uint8Array> {
	return new Uint8Array(await new Response(await client.getBlobStream(repository, sha)).arrayBuffer());
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
