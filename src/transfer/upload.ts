import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { VaultAdapter } from "../vault/adapter";
import { gitBlobSha } from "../vault/hash";

// Git blob uploads are whole base64 bodies on the heap, so they are capped per platform.
export async function uploadBlob(
	client: GitHubClient,
	repository: string,
	vault: VaultAdapter,
	file: { path: string; vaultPath: string; size: number },
	capBytes: number,
): Promise<{ sha: string; size: number }> {
	if (file.size > capBytes) {
		throw new UnivaultError("unknown", {
			cause: new Error(`File is over the ${capBytes}-byte upload cap`),
			paths: [file.path],
		});
	}
	const bytes = await vault.read(file.vaultPath);
	const [sha, local] = await Promise.all([client.createBlob(repository, bytes), gitBlobSha(bytes)]);
	if (sha !== local) {
		throw new UnivaultError("unknown", { cause: new Error(`Blob id mismatch: ${local} vs ${sha}`), paths: [file.path] });
	}
	return { sha, size: bytes.byteLength };
}
