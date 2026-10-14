import type { VaultAdapter, VaultFile } from "./adapter";

export const TEMP_SUFFIX = ".univault-partial";

// The slice of Obsidian's Vault this adapter uses; Vault satisfies it structurally.
export interface VaultLike {
	getFiles(): { path: string; stat: { mtime: number; size: number } }[];
	adapter: {
		exists(path: string): Promise<boolean>;
		readBinary(path: string): Promise<ArrayBuffer>;
		writeBinary(path: string, data: ArrayBuffer): Promise<void>;
		appendBinary(path: string, data: ArrayBuffer): Promise<void>;
		remove(path: string): Promise<void>;
		rename(path: string, newPath: string): Promise<void>;
		mkdir(path: string): Promise<void>;
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

	async writeChunked(path: string, chunks: ReadableStream<Uint8Array>): Promise<void> {
		const { adapter } = this.vault;
		const temp = path + TEMP_SUFFIX;
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.ensureFolder(path.slice(0, slash));

		await adapter.writeBinary(temp, new ArrayBuffer(0));
		const reader = chunks.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await adapter.appendBinary(temp, toArrayBuffer(value));
		}

		// No atomic rename-over-existing in Obsidian's adapter: remove, then rename.
		if (await adapter.exists(path)) await adapter.remove(path);
		await adapter.rename(temp, path);
	}

	exists(path: string): Promise<boolean> {
		return this.vault.adapter.exists(path);
	}

	async ensureFolder(path: string): Promise<void> {
		if (!(await this.vault.adapter.exists(path))) await this.vault.adapter.mkdir(path);
	}

	async removeTempFiles(): Promise<void> {
		for (const file of this.vault.getFiles()) {
			if (file.path.endsWith(TEMP_SUFFIX)) await this.vault.adapter.remove(file.path);
		}
	}
}

function toArrayBuffer(chunk: Uint8Array): ArrayBuffer {
	if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer) {
		return chunk.buffer;
	}
	return chunk.slice().buffer;
}
