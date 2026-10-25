// Characters some platform's filesystem refuses, or that break Obsidian links, plus controls and
// invisible format characters (bidi overrides, zero-width) that could disguise the name.
const UNSAFE = /[\\/:*?"<>|#^[\]\p{Cc}\p{Cf}]/gu;
// Filesystems cap a name at 255 bytes, and a download first writes it with a temporary suffix.
const MAX_DEVICE_BYTES = 64;
const MAX_NAME_BYTES = 200;
const encoder = new TextEncoder();

// ADR-003: `<name> (conflict from <device> <yyyy-mm-dd hh.mm>).<ext>`, in the resolving device's
// local time. `n` > 1 numbers a second conflict copy of the same minute. A name without an
// extension, or a dotfile, takes the suffix at its end. The device comes from a commit trailer.
export function siblingPath(path: string, device: string, when: Date, n = 1): string {
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	const cleaned = device.normalize("NFC").replace(/\s+/g, " ").replace(UNSAFE, "-");
	const who = clip(cleaned, MAX_DEVICE_BYTES).trim().replace(/^\.+/, "") || "another device";
	const pad = (value: number) => String(value).padStart(2, "0");
	const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
	const time = `${pad(when.getHours())}.${pad(when.getMinutes())}`;
	const suffix = ` (conflict from ${who} ${day} ${time}${n > 1 ? ` ${n}` : ""})${ext}`;
	const room = Math.max(0, MAX_NAME_BYTES - encoder.encode(suffix).length);
	return `${path.slice(0, slash + 1)}${clip(stem, room)}${suffix}`.normalize("NFC");
}

// The longest prefix of whole code points that fits in `maxBytes` of UTF-8.
function clip(text: string, maxBytes: number): string {
	let out = "";
	let size = 0;
	for (const char of text) {
		size += encoder.encode(char).length;
		if (size > maxBytes) break;
		out += char;
	}
	return out;
}
