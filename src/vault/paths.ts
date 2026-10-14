import { UnivaultError } from "../errors";

export function normalizeVaultPath(path: string): string {
	return path.normalize("NFC");
}

// Repository paths are untrusted; anything that could escape the vault or
// reach the config directory is refused before it touches the disk.
export function canonicalizeRepoPath(raw: string, configDir: string, pluginDir: string): string {
	const path = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/").normalize("NFC");
	const segments = path.split("/");
	const lower = path.toLowerCase();
	const unsafe =
		path.startsWith("/") ||
		/^[a-z]:/i.test(path) ||
		path.includes("\0") ||
		segments.some((s) => s === "" || s === "." || s === "..") ||
		isWithin(lower, configDir.toLowerCase()) ||
		isWithin(lower, pluginDir.toLowerCase());
	if (unsafe) throw new UnivaultError("path-unsafe", { cause: new Error(`Unsafe repository path: ${raw}`) });
	return path;
}

function isWithin(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}
