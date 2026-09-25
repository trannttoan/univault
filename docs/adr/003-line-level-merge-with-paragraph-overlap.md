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
