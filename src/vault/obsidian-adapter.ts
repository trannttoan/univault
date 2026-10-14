import { UnivaultError } from "../errors";
import type { VaultAdapter, VaultFile, VaultStat } from "./adapter";
import { TEMP_SUFFIX } from "./paths";

// The slice of Obsidian's Vault this adapter uses; Vault satisfies it structurally.
export interface VaultLike {
	configDir: string;
	getFiles(): { path: string; stat: { mtime: number; size: number } }[];
	adapter: {
		exists(path: string): Promise<boolean>;
		readBinary(path: string): Promise<ArrayBuffer>;
		stat(path: string): Promise<{ type: "file" | "folder"; mtime: number; size: number } | null>;
		writeBinary(path: string, data: ArrayBuffer): Promise<void>;
		appendBinary(path: string, data: ArrayBuffer): Promise<void>;
		remove(path: string): Promise<void>;
		rename(path: string, newPath: string): Promise<void>;
		mkdir(path: string): Promise<void>;
		list(path: string): Promise<{ files: string[]; folders: string[] }>;
	};
}

export class ObsidianVaultAdapter implements VaultAdapter {
	constructor(private readonly vault: VaultLike) {}

	async list(): Promise<VaultFile[]> {
		return this.vault
			.getFiles()
			.filter((file) => !file.path.endsWith(TEMP_SUFFIX))
			.map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size }));
	}

	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.vault.adapter.readBinary(path));
	}

	async stat(path: string): Promise<VaultStat | null> {
		const stat = await this.vault.adapter.stat(path);
		return stat?.type === "file" ? { mtime: stat.mtime, size: stat.size } : null;
	}

	async writeChunked(path: string, chunks: ReadableStream<Uint8Array>, expected: VaultStat | null): Promise<void> {
		const { adapter } = this.vault;
		const temp = path + TEMP_SUFFIX;
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.ensureFolder(path.slice(0, slash));

		await adapter.writeBinary(temp, new ArrayBuffer(0));
		const reader = chunks.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			try {
				await adapter.appendBinary(temp, toArrayBuffer(value));
			} catch (error) {
				await reader.cancel().catch(() => {});
				throw error;
			}
		}

		// The user may have edited the target while it streamed; never overwrite that.
		const current = await this.stat(path);
		const unchanged = expected
			? current?.mtime === expected.mtime && current.size === expected.size
			: current === null && !(await adapter.exists(path));
		if (!unchanged) {
			await adapter.remove(temp);
			throw new UnivaultError("conflict-retry", { cause: new Error("Changed during download"), paths: [path] });
		}

		// No atomic rename-over-existing in Obsidian's adapter: remove, then rename.
		if (current) await adapter.remove(path);
		await adapter.rename(temp, path);
	}

	exists(path: string): Promise<boolean> {
		return this.vault.adapter.exists(path);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const folder = parts.slice(0, i).join("/");
			if (!(await this.vault.adapter.exists(folder))) await this.vault.adapter.mkdir(folder);
		}
	}

	// Walks the disk, not the vault index, which misses temp files in dot-prefixed folders.
	// Repository paths with the temp suffix are refused, so every match is ours. Skips the
	// config directory and any .git folder, which no git tree can contain.
	async removeTempFiles(): Promise<void> {
		const { adapter, configDir } = this.vault;
		const visited = new Set<string>();
		const pending = ["/"];
		for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
			if (visited.has(folder)) continue;
			visited.add(folder);
			let listing: { files: string[]; folders: string[] };
			try {
				listing = await adapter.list(folder);
			} catch {
				continue; // Removed while we walked.
			}
			for (const file of listing.files) {
				if (file.endsWith(TEMP_SUFFIX)) await adapter.remove(file.replace(/^\/+/, ""));
			}
			for (const child of listing.folders) {
				const path = child.replace(/^\/+/, "");
				const name = path.slice(path.lastIndexOf("/") + 1);
				if (name === ".git" || path === configDir || path.startsWith(`${configDir}/`)) continue;
				pending.push(path);
			}
		}
	}
}

function toArrayBuffer(chunk: Uint8Array): ArrayBuffer {
	if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer) {
		return chunk.buffer;
	}
	return chunk.slice().buffer;
}
