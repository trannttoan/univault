import type { VaultLike } from "../../src/vault/obsidian-adapter";

interface StoredFile {
	bytes: Uint8Array;
	mtime: number;
}

// In-memory stand-in for Obsidian's Vault and its DataAdapter.
export class FakeVault implements VaultLike {
	readonly files = new Map<string, StoredFile>();
	readonly configDir = ".obsidian";
	readonly folders = new Set<string>([""]);
	readonly appendCalls: string[] = [];
	private clock = 1_000;

	setFile(path: string, content: string | Uint8Array): void {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		this.addParents(path);
		this.files.set(path, { bytes, mtime: ++this.clock });
	}

	bytes(path: string): Uint8Array | undefined {
		return this.files.get(path)?.bytes;
	}

	// Like Obsidian's index, skips any path with a dot-prefixed segment.
	getFiles() {
		return [...this.files]
			.filter(([path]) => !path.split("/").some((segment) => segment.startsWith(".")))
			.map(([path, file]) => ({ path, stat: { mtime: file.mtime, size: file.bytes.byteLength } }));
	}

	readonly adapter: VaultLike["adapter"] = {
		exists: async (path) => this.files.has(path) || this.folders.has(path),
		readBinary: async (path) => this.require(path).bytes.slice().buffer,
		stat: async (path) => {
			const file = this.files.get(path);
			if (file) return { type: "file", mtime: file.mtime, size: file.bytes.byteLength };
			return this.folders.has(path) ? { type: "folder", mtime: 0, size: 0 } : null;
		},
		writeBinary: async (path, data) => {
			this.requireParent(path);
			this.files.set(path, { bytes: new Uint8Array(data.slice(0)), mtime: ++this.clock });
		},
		appendBinary: async (path, data) => {
			this.appendCalls.push(path);
			const file = this.require(path);
			const bytes = new Uint8Array(file.bytes.byteLength + data.byteLength);
			bytes.set(file.bytes);
			bytes.set(new Uint8Array(data), file.bytes.byteLength);
			this.files.set(path, { bytes, mtime: ++this.clock });
		},
		remove: async (path) => {
			this.require(path);
			this.files.delete(path);
		},
		rename: async (path, newPath) => {
			if (this.files.has(newPath)) throw new Error("Destination file already exists!");
			this.requireParent(newPath);
			this.files.set(newPath, this.require(path));
			this.files.delete(path);
		},
		list: async (path) => {
			const folder = path === "/" ? "" : path;
			const inFolder = (p: string) => p !== "" && p.slice(0, Math.max(p.lastIndexOf("/"), 0)) === folder;
			return { files: [...this.files.keys()].filter(inFolder), folders: [...this.folders].filter(inFolder) };
		},
		mkdir: async (path) => {
			this.requireParent(path);
			this.folders.add(path);
		},
	};

	private require(path: string): StoredFile {
		const file = this.files.get(path);
		if (!file) throw new Error(`ENOENT: ${path}`);
		return file;
	}

	private requireParent(path: string): void {
		const parent = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
		if (!this.folders.has(parent)) throw new Error(`ENOENT: ${parent}`);
	}

	private addParents(path: string): void {
		const parts = path.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
	}
}
