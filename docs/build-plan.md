# Build Plan: Univault

Ordered vertical slices. Each phase delivers an observable behavior at a system boundary. Phases bind intent, not mechanism; implementation detail lives in per-phase docs. Order is by risk retired within dependency constraints. No dates.

Source documents: `docs/PRD.md`, `docs/TRD.md`, `docs/adr/`, `CLAUDE.md`.

## Operator prerequisites

Not phases. Human-provided inputs that phases depend on.

- **P-A** A public GitHub repository for the plugin, so releases can be installed through BRAT. Gates Phase 0. **Done:** `github.com/trannttoan/univault`, public, Actions enabled. The default `GITHUB_TOKEN` permission is read-only, so the release workflow declares `permissions: contents: write` itself. The plugin id `univault` was unclaimed in `obsidian-releases/community-plugins.json` on 2026-09-26.
- **P-B** A low-end Android device with about 3 GB of RAM, plus one iOS device and one desktop, all with Obsidian installed. Gates every memory acceptance criterion from Phase 0 onward.
- **P-C** A GitHub organization owning the Univault GitHub App: public, no webhook, device flow enabled, permissions *Contents: read and write* and *Metadata: read*. Gates Phase 4. **Done:** organization `univault-app`, app **Univault Sync** (slug `univault-sync`, client ID `Iv23liZmqSUyZ5EhTO5P`). Device flow, secret-free refresh, token lifetimes, and rotation were verified on 2026-09-26; details in ADR-006.

## Release environment

The environment actual releases use is: a GitHub release containing `main.js`, `manifest.json`, and `styles.css`, produced by CI from a tag, installed into real Obsidian on desktop and mobile through BRAT until Phase 9, and through the community store after it. Every phase's acceptance is demonstrated on that installed build, not in a development harness.

---

## Phase 0: Walking skeleton — `todo`

- **Goal:** A user who installs the tagged release through BRAT on a desktop and on the Android device can sign in with a token, name a repository and branch, press sync on one device, and see one changed note arrive on the other.
- **Scope out:** Device-flow sign-in, repository picker, merging, conflicts, deletions, renames, ignore rules, first-sync preview, automatic triggers, history, config sync, large files, devices list, any settings beyond token, owner/repo, branch, and device name.
- **Acceptance criteria:**
  - CI builds from a tag, runs the test suite, and publishes a GitHub release that BRAT installs on both devices with `minAppVersion` 1.13.0; if either device rejects the version, the true minimum is recorded and the manifest corrected within this phase (spike S6).
  - Editing one note and pressing sync on device A produces exactly one commit on the branch with a `Univault-Device` trailer naming device A.
  - Pressing sync on device B with no local changes downloads that note by streamed transfer and writes it byte-identical.
  - Pressing sync when neither side changed makes no commit and costs zero quota against the remote head check.
  - The sync anchor and index are stored in IndexedDB and survive an app restart on both devices.
  - The status bar shows idle, syncing, and error.
- **Risk retired:** The commit-anchored state model, IndexedDB persistence, and native streaming `fetch` against `api.github.com` all work inside Electron, the Android WebView, and the release pipeline. If any fails, ADR-001 or ADR-004 is revisited before features exist.
- **Depends on:** None. Prerequisites P-A, P-B.
- **TRD triggers:** None.

**Components the skeleton defers, and where each is first exercised:** merge engine (Phase 1), rename records and ignore file (Phase 2), first-sync preview, byte-budget scheduler, upload queue (Phase 3), session module device flow (Phase 4), trigger sources and foreground poll (Phase 5), snapshots and history view (Phase 6), config categories (Phase 7), status card and sync log (Phase 8), device manifests on hidden refs (Phase 10), `LargeObjectStore` LFS implementation (Phase 11).

## Phase 1: Two devices diverge — `todo`

- **Goal:** Two devices that edited the same note between syncs converge without either side's words being lost, silently when the edits do not overlap and through a picker when they do.
- **Scope out:** Diff view inside the picker, deletion conflicts, binary conflicts beyond "always ask", history view, snapshots older than the current conflict, config files.
- **Acceptance criteria:**
  - Different paragraphs edited on A and B: after both sync, both devices hold both edits and no dialog appeared; a notice with a review link appeared on the merging device.
  - Same paragraph edited on A and B: the second device to sync shows one picker naming the file, the other device, and the time. Keep mine, keep theirs, and keep both each produce the expected result on both devices after the next sync.
  - Keep both writes a sibling file named per ADR-003 that syncs to the other device.
  - Dismissing the picker behaves as keep both.
  - Force-quitting with a picker open leaves the conflict pending after restart with both versions recoverable.
  - Two devices pushing within the same second: the loser of the ref update re-syncs and retries, and afterwards both devices hold both changes; no local change was replaced by a download.
  - The merge core is exercised by an offline test corpus of at least 30 cases covering adjacent-line edits, paragraph rewrites, CRLF files, trailing-newline differences, and both-added files.
- **Risk retired:** Classification and merge never lose a side, and optimistic commits behave under real races.
- **Depends on:** 0.
- **TRD triggers:** Word-level merge as an option (if the corpus shows the paragraph rule prompting too often). Spike S8 informs the overlap rule.

## Phase 2: Deletions, renames, and ignore rules propagate — `todo`

- **Goal:** A file deleted, renamed, or excluded on one device is deleted, renamed, or excluded on every other device, and nothing is ever removed outright.
- **Scope out:** Deleted-note recovery view, context-menu exclude, folder-level rules UI beyond a text list, config folder handling.
- **Acceptance criteria:**
  - Delete on A: after B syncs, the file is gone from B's vault and present in B's trash location according to B's *Deleted files* setting.
  - Rename on A: B receives the rename; the commit carries a `Univault-Rename` trailer; the file's history on B lists versions from before the rename.
  - Delete on A while B modified the same file: B sees a conflict, not a silent deletion or resurrection.
  - Adding a pattern to `.univault-ignore` on A: after both sync, matching files stop syncing on both devices and no matching file is deleted anywhere.
  - Removing a synced file from the ignore list makes it sync again without a conflict if unchanged.
  - No sync with only ignore-rule changes produces a commit other than the ignore file itself.
- **Risk retired:** The failure class every competitor has open issues about (renames as "file does not exist", deletions not propagating, excludes deleting files) does not exist here.
- **Depends on:** 1.
- **TRD triggers:** None.

## Phase 3: Large vault first sync on a low-end phone — `todo`

- **Goal:** A user with a populated vault on the Android device and a populated repository sees a preview, confirms, and completes a first sync of 10,000 files and 1 GB without a crash, with large uploads queued for desktop.
- **Scope out:** Git LFS, tarball download path unless spike S4 makes it mandatory, inline tree batching unless spike S5 makes it mandatory, history, config sync.
- **Acceptance criteria:**
  - The preview shows five counts with expandable lists, transfer size, and a low-overlap warning; Cancel writes nothing anywhere.
  - Bulk rules for two-sided differences behave as specified; losers become sibling copies.
  - The synthetic 10,000-file, 1 GB vault completes first sync on the Android device with no crash and no file corrupted, and the same on iOS and desktop.
  - Peak JavaScript heap during the run stays under the mobile byte budget as measured through remote debugging.
  - A 50 MB attachment on the phone is listed as waiting for desktop, and the next desktop sync uploads it; a 50 MB attachment in the repository downloads to the phone by streaming.
  - Incremental sync of one changed note on the 10,000-file vault completes in under five seconds on the phone.
  - Spike S1 measurements (tree bytes, parse heap, scan time, request count, wall time) at 1k, 5k, 10k, 25k, and 50k are recorded and replace the PRD's provisional scale targets.
  - Spike S3 result (Blob-backed and streaming request bodies in each WebView, LFS endpoint CORS) is recorded for Phase 11.
- **Risk retired:** The mobile-first promise holds at the target scale with the byte budget and concurrent transfers. If it fails, the scale targets shrink or the deferred bulk paths become mandatory before Phase 9.
- **Depends on:** 2. Prerequisite P-B.
- **TRD triggers:** Bulk first-sync download via tarball (S4). Inline text batching in tree requests (S5). Non-recursive tree fallback above 50,000 files.

## Phase 4: Sign in with GitHub — `todo`

- **Goal:** A new user with no repository completes setup and first sync without handling a token, leaving Obsidian only to authorize on github.com.
- **Scope out:** GitHub Enterprise Server flows beyond the token fallback, organization repositories, multiple accounts.
- **Acceptance criteria:**
  - Sign in shows a code and opens github.com; after authorization the plugin knows the login and the repositories the installation covers.
  - The repository picker lists writable repositories with a private indicator; choosing one sets owner/repo and the default branch.
  - Create a private repository for this vault either succeeds from inside the plugin or, if spike S2 shows the app token cannot create user repositories, hands off to github.com and refreshes the picker on return; the outcome is recorded and the PRD updated.
  - An empty repository is bootstrapped and the first sync uploads the vault.
  - The setup checklist shows five rows and each incomplete row navigates to its fix.
  - Token expiry is handled by silent refresh; a revoked authorization surfaces `auth-expired` with a re-sign-in action and no other error text.
  - Token fallback still works end to end for a fine-grained PAT.
- **Risk retired:** The token-free onboarding differentiator is possible under a GitHub App's permission model.
- **Depends on:** 0. Prerequisite P-C.
- **TRD triggers:** Token expiry policy (if refresh failures appear during testing).

## Phase 5: Invisible sync — `todo`

- **Goal:** A user who edits on one device and picks up another sees the change there within 30 seconds without pressing anything, and the plugin stays within API quota and silent while offline.
- **Scope out:** Periodic timer as default, sync-on-change granularity below the settle period, background execution when the app is suspended by the OS.
- **Acceptance criteria:**
  - Stop typing on A; within the settle period plus network time the commit exists. B, foregrounded and idle, shows the change within 30 seconds.
  - Returning B to the foreground after an hour away pulls before the user can open a stale note.
  - Sending A to the background after edits pushes them.
  - With the network off, no automatic sync produces a notice or error state; the status shows offline; a manual sync reports offline once.
  - A one-hour session of continuous editing with ten changed files per pause stays under 500 requests, measured from the rate-limit headers.
  - Spike S7: an unchanged head check returns 304 and does not decrement the remaining quota; if it does, the poll interval is adjusted and the TRD deferred decision resolved.
  - A rate-limited response pauses automatic syncs until the reset time and says so; it is never shown as an authentication error.
- **Risk retired:** The propagation target and quota model hold with the chosen triggers.
- **Depends on:** 1.
- **TRD triggers:** Foreground poll interval.

## Phase 6: File history, restore, and merge review — `todo`

- **Goal:** A user who overwrote or lost content restores an earlier version of a note from any device in under thirty seconds, and can see and undo any automatic merge.
- **Scope out:** Whole-vault rollback, deleted-note recovery list, history across other Git clients' commits beyond what trailers provide.
- **Acceptance criteria:**
  - From a note's menu, the user sees versions with time and device, previews any version read-only, and restores one; the restore syncs as a new version.
  - History follows renames recorded by `Univault-Rename` trailers.
  - An automatic merge appears in history marked as a merge with both inputs listed; the other device's version restores from the repository and this device's pre-merge version restores from the local snapshot for 30 days.
  - The review link in the merge notice opens that history entry.
  - Snapshots older than 30 days are removed and their absence is shown, not errored.
- **Risk retired:** Trailers plus local snapshots are sufficient for history and merge review without extra storage.
- **Depends on:** 1, 2.
- **TRD triggers:** None.

## Phase 7: Config sync — `todo`

- **Goal:** A user's appearance, hotkeys, core settings, and community plugins follow them to a new device by default, and plugin settings holding credentials do not leave the device unless the user opts in.
- **Scope out:** Workspace layouts, cache, the plugin's own folder, per-file config conflict UI.
- **Acceptance criteria:**
  - A fresh device syncing a vault with config categories on ends up with the same theme, snippets, hotkeys, core plugin list, and community plugins enabled.
  - A plugin whose settings contain a value matching the credential detector is listed as *contains credentials*, excluded by default, and included after a per-plugin opt-in.
  - Enabling a category on a device with different settings prompts once for a bulk rule and applies it.
  - Two devices changing different plugin settings between syncs converge with newest wins and no dialog; the losing version is visible in history.
  - No file under the plugin's own folder ever appears in a commit, verified by test.
- **Risk retired:** The credential heuristic catches real plugin settings files, and newest-wins keeps config conflicts silent without losing recoverability.
- **Depends on:** 2, 6.
- **TRD triggers:** None.

## Phase 8: Status and diagnostics on every platform — `todo`

- **Goal:** A user on a phone knows at a glance whether sync is healthy, when it last ran, what is pending or skipped, and can copy a redacted error in one tap.
- **Scope out:** Telemetry of any kind, console logging as the primary channel.
- **Acceptance criteria:**
  - The settings status card shows the same states as the desktop status bar plus last sync time, pending conflict count with a resolve action, skipped files with reasons, queued uploads, and repository size with a warning past 1 GB.
  - The sync log shows the last 200 syncs with trigger, duration, counts, and error code; copy produces text with no token or full filesystem path.
  - Manual sync reports once; automatic syncs report only conflicts, skipped files, and the first failure after a success.
  - Every error code in the TRD's closed set has a user-facing string and a suggested action.
- **Risk retired:** None structural. Ordered here because it tests nothing new, and because it is a P0 requirement that gates Phase 9.
- **Depends on:** 3, 4, 5.
- **TRD triggers:** None.

## Phase 9: Community store release (v1.0) — `todo`

- **Goal:** A user finds Univault in Obsidian's community plugin browser, installs it, and completes setup following only the in-app checklist.
- **Scope out:** Any feature not already accepted in Phases 0 through 8.
- **Acceptance criteria:**
  - Submission passes Obsidian's plugin review on the first cycle, or every requested change is addressed in one follow-up.
  - Listing description leads with token-free sign-in, mobile large-vault support, automatic merge, and per-note history.
  - README covers setup, what syncs by default, conflict behavior, LFS status, and how to report a problem with the copied log.
  - Every guarantee in the PRD's product principles has a passing test in CI.
  - The three prerequisite devices each complete a fresh install and first sync from the store build.
- **Risk retired:** Store acceptance and first-run experience with no developer present.
- **Depends on:** 8.
- **TRD triggers:** None.

## Phase 10: Devices list (v1.x) — `todo`

- **Goal:** A user sees every device that has synced this vault, when each last synced, and which device a conflict came from.
- **Scope out:** Remote actions on other devices, presence.
- **Acceptance criteria:**
  - Each device writes its manifest to its hidden ref on every sync that pushes; the branch history shows no manifest commits.
  - Settings lists devices with name, platform, and last sync time; forget removes one.
  - Conflict dialogs and the status tooltip name the other device using manifest data.
  - A documented command shows the hidden refs to a user with a Git client.
- **Risk retired:** Hidden refs are writable and readable through the API as designed.
- **Depends on:** 4.
- **TRD triggers:** None.

## Phase 11: Git LFS for large attachments (v1.1) — `todo`

- **Goal:** A user's attachments above a size threshold sync through LFS on every device, and, if spike S3 passed, a phone uploads files of any size.
- **Scope out:** Migrating existing history into LFS, LFS on Enterprise Server, storage billing UI beyond a usage display.
- **Acceptance criteria:**
  - Attachments above the threshold are stored as LFS objects with pointer files in the branch; other Git clients with LFS installed see real files.
  - Downloads and uploads of LFS objects stay within the byte budget on the phone; if S3 passed, a 200 MB video recorded on the phone uploads and the mobile cap is removed; if S3 failed, the cap remains and is documented.
  - Settings show LFS storage and bandwidth used against the account's allowance.
  - Repositories created before this phase continue to sync unchanged until the user enables LFS.
- **Risk retired:** LFS lifts the attachment ceiling on mobile.
- **Depends on:** 3, 9.
- **TRD triggers:** LFS size threshold and whether the mobile cap can be removed.

## Phase 12: v1.x tail — `todo`

Unordered. Each is a small slice with its own acceptance when picked up.

- **Expandable diff in the conflict picker**: the user sees what differs before choosing.
- **Deleted-note recovery**: a list of recently deleted files with one-tap restore.
- **Context-menu actions**: exclude this file or folder; sync this file now.
- **Conflict-copy cleanup**: find and remove sibling conflict copies from one place.

## Document gaps exposed by slicing

- PRD 5.1: the repository-creation path is conditional on spike S2; the PRD already marks it spike-dependent and should be updated with the outcome after Phase 4.
- PRD section 7 scale targets are provisional and are replaced by Phase 3's measurements.
- TRD stack: `minAppVersion` 1.13.0 is provisional until Phase 0 confirms it on both devices.
