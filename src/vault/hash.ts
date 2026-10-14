// Git blob id: SHA-1 over "blob <byte length>\0" followed by the bytes.
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const data = new Uint8Array(header.byteLength + bytes.byteLength);
	data.set(header);
	data.set(bytes, header.byteLength);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
