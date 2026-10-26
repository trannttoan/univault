# ADR-003: Line-level three-way merge with a paragraph-aware overlap rule; sibling conflict copies

Status: Accepted · 2026-09-25

## Context

Most same-note edits from two devices touch different parts of the note and should merge without a prompt. Some touch the same passage and must not be merged silently. A merge can be clean line by line and still read wrongly when both sides rewrote different sentences of one paragraph. When the user keeps both versions of a conflict, the losing version must remain visible and attributable.

## Decision

- Text files are merged with a standard line-level three-way merge over base, ours, and theirs.
- Two changes are treated as overlapping, and therefore a conflict, when they touch the same line or lines within the same paragraph (a paragraph being a run of non-blank lines). The exact rule is tuned by spike S8.
- Binary files with changes on both sides are always a conflict.
- Every automatic merge records a pre-merge snapshot of this device's version (ADR-004) and a `Univault-Merge` commit trailer (ADR-005), so the merge is visible and reversible from file history.
- When the user chooses *keep both*, the losing version is written as a sibling file: `<name> (conflict from <device> <yyyy-mm-dd hh.mm>).<ext>`. It syncs like any other file.

## Consequences

- Non-overlapping edits merge silently; same-paragraph edits prompt. Some prompts will be false positives; that is the accepted trade against silent bad merges.
- Conflict copies are visible in the file explorer and preserve links to the original's folder. Users may accumulate copies; cleanup tooling is deferred.
- The merge core is a pure function and fully unit-tested.

## Alternatives rejected

- **Word-level merge**: fewer prompts, but produces grammatically broken results more often, is harder to explain, and forces the diff view to work at word level.
- **Plain line-level merge with no paragraph rule**: silently merges two rewrites of one paragraph and relies entirely on review-and-restore to catch it.
- **Conflicts folder at the vault root**: keeps folders tidy but breaks the link between a note and its copy and becomes a graveyard.
- **History only, no copy in the vault**: cleanest vault, but the user gets no visible cue that a conflict happened.

## Amendment · 2026-10-25: the overlap rule after spike S8

Status: Accepted · 2026-10-25

### Decision

- Lines are split so that each line carries the terminator before it (`\n` or `\r\n`), not after it. Text appended after a last line that has no newline is then an insertion, not an edit of that line. Bytes are joined back exactly, so untouched lines, mixed endings and a BOM (part of the first line) survive byte for byte.
- Each side is diffed against the base with Myers line diffs (`diff`'s `diffArrays`). Edits made identically on both sides agree and are taken once.
- Two edits conflict when their base ranges intersect, or when they touch the same paragraph of the base. An edit touches the paragraphs of the base lines it replaces, a paragraph its new text runs into with no blank line between, and the paragraph enclosing an edit strictly inside it. A new paragraph inserted between two paragraphs touches neither.
- Insertions at the same point that touch no paragraph are stacked, theirs first (it was pushed first). Text both sides inserted at the start or end of that point is kept once, and the stacked parts always meet at a blank line. If the two parts share a non-blank line, the user decides.
- An insertion next to an edit from the other side is dropped when that edit already holds it, and is a conflict when the two share a non-blank line. This is what keeps a re-merge after a failed push from duplicating text.
- Differing insertions into an empty file conflict, as a path added on both sides does.
- These go to the picker without merging: binary content (not strict UTF-8, or a NUL byte; known binary extensions are not read), any side over 1 MB or over 50,000 lines, a diff over 1,000 edited lines on either side, and a path added on both sides with different content.
- The keep-both sibling name follows the format above, with these rules for cases the format leaves open:
  - The time is the resolving device's local time.
  - The device name comes from the other side's `Univault-Device` trailer, else the commit author, else "another device". It is NFC-normalized; characters a filesystem or an Obsidian link refuses (`\ / : * ? " < > | # ^ [ ]`), control characters and invisible format characters (bidi overrides, zero-width) become `-`; leading dots are dropped; it is cut to 64 UTF-8 bytes.
  - The note's name is shortened so the whole file name stays within 200 UTF-8 bytes, leaving room for the temporary download suffix under the 255-byte filesystem limit.
  - A name with no extension, or a dotfile, takes the suffix at its end; otherwise the suffix goes before the last extension.
  - A second copy in the same minute is numbered: `… hh.mm 2)`, `… hh.mm 3)`.

### Consequences

- Known prompts a looser rule would merge: items appended to the same list on both sides, any two edits to one paragraph (including distant items of one long list), a paragraph added at the top of a note against an edit to its first paragraph, and a re-merge whose blank lines align differently the second time.
- The corpus (`test/merge/corpus/`, 47 cases) checks every case for symmetry (swapping sides never changes whether it conflicts) and for re-merge safety (merging a result again yields that result or a conflict, never a different merge).

### Why

- Each line carries the newline before it. The PRD's headline case is two devices appending different paragraphs to one note. With the usual split, appending to a note with no final newline also changes its last line, so every pair of appends would collide. The cost is smaller: a paragraph added at the top of a note now conflicts with an edit to its first paragraph, which is rarer.
- Myers line diffs, not `node-diff3`. Measured 2026-10-25 on the dev Mac with ordinary markdown and one small edit per side, `node-diff3` took 227 ms at 64 KB and 140 s at 512 KB; it gets worse much faster than the note grows, because markdown is full of identical blank lines. `diff`'s Myers diff took under 1 ms for both diffs at every size up to 2 MB; its cost grows with the edit, not the file. The paragraph rule works in base-line positions anyway, so the three-way merge on top had to be written in-house regardless.
- Paragraphs added at the same point are stacked. Both devices appending to the end of a note is the most common two-device edit (journals, logs, meeting notes), so asking there would make the picker routine. The other device's text goes first because it is already on the branch, where other devices have seen it; device clocks cannot be trusted to order the two. The stacked parts always meet at a blank line, so the next merge sees two paragraphs, not one.
- Re-merges must not add text twice. Merged bytes are written to disk before the push. A rejected push (up to three retries, ADR-002) or a failed sync merges that text again against a newer version from the other device. Without dropping an insertion the other side's edit already holds, an appended paragraph is duplicated on retry; the corpus's re-merge cases caught this.
- Symmetry and re-merge safety are tested properties. Whether a change merges must not depend on which device syncs second, and a retry must give the same result or a prompt, never a different merge.
- Caps send a change to the picker, not to a failure. The picker never loses a side, so a cap that is too low costs a prompt, while one that is too high can crash Obsidian on a phone mid-sync. 1 MB per side bounds bytes; 50,000 lines bounds memory, which grows with the line count (100,000 one-byte lines run out of a 16 MB heap); 1,000 edited lines bounds time (about 70 ms at 1 MB, against 210 ms at 2,000 lines warm and over a second cold).
- A path added on both sides always asks. There is no base, and a diff against an empty file conflicts on the whole file anyway. The usual case is a daily note created from the same template on two devices.
- The sibling name rules. The device name comes from a commit in the repository, so it is untrusted and unbounded, and a name the filesystem refuses would fail every later sync, since choices are applied first. The 255-byte filename limit minus the temporary download suffix sets the 200-byte budget. Invisible format characters could disguise the copy, so they are replaced. The time is local because the name is read by the person resolving the conflict.

### Alternatives rejected

- **`node-diff3` as the merge core**, as the TRD first named it: too slow on markdown (see Why), and it has no way to plug in a faster diff.
- **Lines that end with their newline**, the conventional split: breaks the headline case of two devices appending.
- **A within-N-lines overlap window** (spike S8's other candidate). Measured 2026-10-25 against the 47-case corpus with windows of 0 to 5 lines, and none matched it:
  - Windows of 0 or 1 merged edits the corpus asks about, such as two adjacent lines of one paragraph.
  - Windows of 2 or more asked about 9 to 20 cases that merge today, including edits to neighbouring paragraphs. Unless paragraphs added at the same point were handled separately, they also asked about every pair of appends.
  - On long paragraphs a window ignores where the edits are within the paragraph: edits to the first and last lines of an 8-line hard-wrapped paragraph merged under every window tried.
  - The corpus labels were written alongside the paragraph rule, so its full agreement with that rule is expected; the disagreements are the evidence.
- **Merging same-point insertions only when they are identical**: asks on the most common two-device edit.
- **Stacking ours first, or by timestamp**: ours first reorders text other devices already have; timestamps depend on device clocks.
- **Re-merging from the pre-merge snapshot instead of the file on disk**: the user can edit between attempts, and merging from the snapshot would drop those edits.
- **A byte cap alone**: a note of very short lines passes 1 MB within budget in bytes but not in memory.
- **UTC in the sibling name**, as the TRD's timestamp rule would suggest: reads wrongly to the person who sees the file.
- **Hashing or rejecting long device names**: shortening keeps the name readable, and "another device" covers a name with nothing usable left.
