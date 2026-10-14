export interface VaultFile {
	path: string;
	mtime: number;
	size: number;
}

export interface VaultAdapter {
	list(): Promise<VaultFile[]>;
	read(path: string): Promise<Uint8Array>;
	// Streams into a temporary file beside the target, then replaces the target.
	writeChunked(path: string, chunks: ReadableStream<Uint8Array>): Promise<void>;
	exists(path: string): Promise<boolean>;
	ensureFolder(path: string): Promise<void>;
	// Removes temporary files left behind by an interrupted writeChunked.
	removeTempFiles(): Promise<void>;
}
