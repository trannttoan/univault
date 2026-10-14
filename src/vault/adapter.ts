export interface VaultStat {
	mtime: number;
	size: number;
}

export interface VaultFile {
	path: string;
	mtime: number;
	size: number;
}

export interface VaultAdapter {
	list(): Promise<VaultFile[]>;
	read(path: string): Promise<Uint8Array>;
	// Reads the disk, so it also sees paths the vault index skips (dot-prefixed ones).
	stat(path: string): Promise<VaultStat | null>;
	// Streams into a temporary file beside the target, then replaces the target, but only
	// if the target still matches `expected` (null: it did not exist).
	writeChunked(path: string, chunks: ReadableStream<Uint8Array>, expected: VaultStat | null): Promise<void>;
	exists(path: string): Promise<boolean>;
	// Removes temporary files left behind by an interrupted writeChunked.
	removeTempFiles(): Promise<void>;
}
