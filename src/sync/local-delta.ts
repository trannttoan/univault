import type { IndexEntry } from "../store/db";
import type { VaultAdapter } from "../vault/adapter";
import { gitBlobSha } from "../vault/hash";
import { normalizeVaultPath } from "../vault/paths";

export type LocalChange =
	| { kind: "added" | "modified"; vaultPath: string; blobSha: string; mtime: number; size: number }
	| { kind: "deleted" };

// Keys are NFC paths. Only files whose mtime or size moved are read and hashed.
export async function localDelta(
	vault: VaultAdapter,
	index: Map<string, IndexEntry>,
	hash: (bytes: Uint8Array) => Promise<string> = gitBlobSha,
): Promise<Map<string, LocalChange>> {
	const delta = new Map<string, LocalChange>();
	const seen = new Set<string>();

	for (const file of await vault.list()) {
		const path = normalizeVaultPath(file.path);
		seen.add(path);
		const entry = index.get(path);
		if (entry && entry.mtime === file.mtime && entry.size === file.size) continue;

		const blobSha = await hash(await vault.read(file.path));
		if (entry && entry.blobSha === blobSha) continue;
		delta.set(path, { kind: entry ? "modified" : "added", vaultPath: file.path, blobSha, mtime: file.mtime, size: file.size });
	}

	for (const path of index.keys()) {
		if (!seen.has(path)) delta.set(path, { kind: "deleted" });
	}
	return delta;
}
