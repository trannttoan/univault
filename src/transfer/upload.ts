import { UnivaultError } from "../errors";
import type { GitHubClient } from "../github/client";
import type { VaultAdapter } from "../vault/adapter";
import { gitBlobSha } from "../vault/hash";

export interface UploadFile {
	path: string;
	vaultPath: string;
	size: number;
}

// Git blob uploads are whole base64 bodies on the heap, so they are capped per platform.
async function readCapped(vault: VaultAdapter, file: UploadFile, capBytes: number): Promise<Uint8Array> {
	if (file.size > capBytes) {
		throw new UnivaultError("unknown", {
			cause: new Error(`File is over the ${capBytes}-byte upload cap`),
			paths: [file.path],
		});
	}
	return vault.read(file.vaultPath);
}

export async function uploadBlob(
	client: GitHubClient,
	repository: string,
	vault: VaultAdapter,
	file: UploadFile,
	capBytes: number,
): Promise<{ sha: string; size: number }> {
	const bytes = await readCapped(vault, file, capBytes);
	const [sha, local] = await Promise.all([client.createBlob(repository, bytes), gitBlobSha(bytes)]);
	if (sha !== local) {
		throw new UnivaultError("unknown", { cause: new Error(`Blob id mismatch: ${local} vs ${sha}`), paths: [file.path] });
	}
	return { sha, size: bytes.byteLength };
}

export async function bootstrapBranch(
	client: GitHubClient,
	repository: string,
	branch: string,
	vault: VaultAdapter,
	file: UploadFile,
	capBytes: number,
	message: string,
): Promise<void> {
	const bytes = await readCapped(vault, file, capBytes);
	await client.putContents(repository, file.path, { branch, message, bytes });
}
