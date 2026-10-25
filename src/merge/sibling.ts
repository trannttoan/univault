// Characters some platform's filesystem refuses, or that break Obsidian links, plus controls.
const UNSAFE = /[\\/:*?"<>|#^[\]\p{Cc}]/gu;

// ADR-003: `<name> (conflict from <device> <yyyy-mm-dd hh.mm>).<ext>`, in the resolving device's
// local time. `n` > 1 numbers a second conflict copy of the same minute. A name without an
// extension, or a dotfile, takes the suffix at its end.
export function siblingPath(path: string, device: string, when: Date, n = 1): string {
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	const who =
		device
			.replace(/\s+/g, " ")
			.replace(UNSAFE, "-")
			.trim()
			.replace(/^\.+/, "") || "another device";
	const pad = (value: number) => String(value).padStart(2, "0");
	const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
	const time = `${pad(when.getHours())}.${pad(when.getMinutes())}`;
	return `${path.slice(0, slash + 1)}${stem} (conflict from ${who} ${day} ${time}${n > 1 ? ` ${n}` : ""})${ext}`;
}
