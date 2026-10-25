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

// Whole blob on the heap, for the merge engine; null as soon as it passes `capBytes`.
export async function readBlob(
	client: GitHubClient,
	repository: string,
	sha: string,
	capBytes: number,
): Promise<Uint8Array | null> {
	const reader = (await client.getBlobStream(repository, sha)).getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > capBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
