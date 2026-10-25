import type { IndexEntry } from "../store/db";
import type { VaultAdapter, VaultFile } from "../vault/adapter";
import { gitBlobSha } from "../vault/hash";
import { normalizeVaultPath } from "../vault/paths";

export type LocalChange =
	| { kind: "added" | "modified"; vaultPath: string; blobSha: string; mtime: number; size: number }
	| { kind: "deleted" };

export interface LocalScan {
	changes: Map<string, LocalChange>;
	// Every listed file as the scan saw it, for checking a target before it is replaced.
	files: Map<string, VaultFile>;
	// Changed files over the upload cap, never read: phase 0 cannot send them.
	oversized: string[];
}

// Keys are NFC paths. Only files whose mtime or size moved are read and hashed.
export async function localDelta(
	vault: VaultAdapter,
	index: Map<string, IndexEntry>,
	capBytes: number,
	hash: (bytes: Uint8Array) => Promise<string> = gitBlobSha,
): Promise<LocalScan> {
	const delta = new Map<string, LocalChange>();
	const seen = new Map<string, VaultFile>();
	const oversized: string[] = [];

	for (const file of await vault.list()) {
		const path = normalizeVaultPath(file.path);
		// The repository refuses such a path, and a commit trailer naming it would break.
		if (/[\r\n]/.test(path)) continue;
		seen.set(path, file);
		const entry = index.get(path);
		if (entry && entry.mtime === file.mtime && entry.size === file.size) continue;
		if (file.size > capBytes) {
			oversized.push(path);
			continue;
		}

		const blobSha = await hash(await vault.read(file.path));
		if (entry && entry.blobSha === blobSha) continue;
		delta.set(path, { kind: entry ? "modified" : "added", vaultPath: file.path, blobSha, mtime: file.mtime, size: file.size });
	}

	for (const path of index.keys()) {
		if (!seen.has(path)) delta.set(path, { kind: "deleted" });
	}
	return { changes: delta, files: seen, oversized: oversized.sort() };
}
