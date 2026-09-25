# PRD: Vaultline

Status: Draft v1 · 2026-09-25
Owner: Toan Tran

A community plugin that syncs an Obsidian vault across desktop, iOS, and Android using a private GitHub repository and the GitHub REST API. No local Git, no server, no subscription.

---

## 1. Why this exists

Obsidian users who want free, private, multi-device sync have three options today, and each fails at the same points.

| Option | What breaks |
|--------|-------------|
| obsidian-git (3.2M downloads) | Its own docs say do not use it on mobile. Crashes on first sync of large vaults, data loss on mobile conflicts, no conflict UI on phones. |
| GitHub Gitless Sync (19k) | Unmaintained since May 2025. 36 open issues, users compiling fixes from unmerged PRs. Deletions and renames unreliable, empty commits, conflicts in config files with no way out. |
| Git Vault Sync, Hybrid Git Sync, SyncGit, GitHub Sync Multi-Platform | Small and recent. Each has at least one data-loss path in its baseline logic, none merges text, none bounds memory, none has tests. |
| Roughly thirty more "Git sync" plugins in the store | Nearly all created in 2026, none above 17 GitHub stars, most abandoned after a single burst of commits. They prove demand and add noise; none is a credible incumbent. |

Across every tracker the same three complaints dominate: **conflicts that lose data or cannot be resolved**, **crashes on first sync of a large vault on Android**, and **deletions or renames that do not propagate**. Nobody has fixed them. Users of the abandoned plugin are asking for a fork.

This plugin exists to be the option that gets those three things right, and to add the two features paid Obsidian Sync users would miss most: sync that feels invisible, and per-note version history.

## 2. Target user

**Primary**: one person with a personal vault on two or more devices, at least one of them a phone. Comfortable creating a GitHub account. Does not want to learn Git.

**Secondary (supported, not featured)**: two to five people sharing one private repo asynchronously. The plugin must not break for them, but v1 ships no collaboration features. Three design rules keep the door open at no cost:

1. Repository identity is `owner/repo` from the picker, never derived from the authenticated user.
2. Devices are identified as `login/device-id`, not device alone.
3. Config sync is off by default.

**Not a target**: real-time co-editing, enterprise policy needs, users who want to run Git commands against the vault.

## 3. Product principles

1. **Never lose a side.** No operation may discard content the user has not seen. Deletions go to trash. Dismissed conflicts keep both versions. The sync baseline is only advanced after the remote confirms the commit.
2. **Invisible when it works.** Sync happens shortly after you stop typing and when you switch apps. The user should rarely press a button and rarely see a conflict.
3. **Loud when it matters.** Failures, conflicts, and skipped files are visible on every platform, including phones, and every error can be copied.
4. **Mobile is a first-class platform.** Every feature is designed for a 45 MB heap and a touch screen first. Peak memory is bounded by a transfer chunk, not by file size.
5. **Proven, not promised.** Every guarantee above has an automated test.

## 4. Scope

### In scope for v1

- GitHub.com and GitHub Enterprise Server
- Desktop (Windows, macOS, Linux), iOS, Android
- One vault per repository, synced to the repository root
- Text notes, attachments, and opt-in Obsidian config categories
- Files up to GitHub's 100 MB blob limit

### Explicit non-goals for v1

- End-to-end encryption of vault contents
- Whole-vault rollback to a point in time
- Git LFS or files above 100 MB
- Syncing to a subfolder, or several vaults in one repo
- GitLab, Gitea, Bitbucket, or self-hosted Git servers
- Real-time collaboration, presence, or locking
- Localization beyond English

The host and transfer layers are kept behind interfaces so items 3 and 5 can be added later without a rewrite.

## 5. Features

Priority: **P0** ships in v1.0. **P1** ships in v1.x. **P2** is on the roadmap.

### 5.1 Onboarding (P0)

**Goal**: from install to first successful sync in under two minutes, with no token to copy.

- **Sign in with GitHub** via the device flow of a GitHub App registered by the project. The plugin shows an eight-character code and a button that opens github.com. The user approves, chooses which repositories the app may access, and returns. No token is created or pasted. The app requests only *Contents: read and write* and *Metadata: read*, so it can never touch repositories the user did not select. The client ID is public by design; there is no client secret.
- **Personal access token fallback** for GitHub Enterprise Server (where the project's app does not exist) and for users whose organization blocks third-party apps. The settings page links directly to the fine-grained token page with the correct permission preselected.
- **Choose a repository**: either *Create a private repository for this vault* (named after the vault, created in one click; whether a GitHub App user token can do this, and how the new repository joins the app installation, is a spike with a fallback of sending the user to github.com to create it) or *Use an existing repository* (picker listing repos the account can write to, with a private padlock indicator). An empty repository is bootstrapped automatically with an initial commit.
- **Choose a branch**, defaulting to the repository's default branch. Never assume `main`.
- **First-sync preview** whenever the plugin has no sync record for the current repository and branch, and both the vault and the repository have content. This covers first setup, migrating from another plugin, switching repository or branch, and enabling a config category. The preview is read-only: it fetches the repository tree and hashes local files, but writes nothing until the user confirms.
  - Every file is classified as *identical* (adopted silently), *only in vault* (will upload), *only in repository* (will download), *different on both sides* (needs a decision), or *skipped* (over the size limit).
  - The dialog shows the five counts with expandable file lists, the total transfer size, and a warning when the overlap is small ("Only 3 of 1,200 files match. Is this the right repository?").
  - For files different on both sides, the user picks a bulk rule before continuing: *decide one by one*, *prefer this device*, or *prefer the repository*. Under a bulk rule the losing version is kept as a conflict copy, so no rule is destructive.
  - Buttons: *Continue* and *Cancel*. Cancel leaves the vault and repository untouched.
- **Setup checklist** at the top of settings: signed in, repository chosen, branch chosen, connection tested, first sync done. Each row is a link to fix it.

**Acceptance**: a new user with an empty vault and no repository completes setup without leaving Obsidian except to approve the device code. A migrating user with a populated vault and a populated repository sees the preview and loses nothing.

### 5.2 Sync engine (P0)

**Goal**: devices converge without the user thinking about it.

- **Automatic triggers, on by default**:
  - after the user stops editing, once no file has changed for a settle period (default 15 seconds, adjustable), so a writing session produces a handful of versions rather than one per keystroke,
  - on app launch and when the app returns to the foreground,
  - when the app goes to the background,
  - while the app is in the foreground, a check for new remote commits every 30 seconds. The check is a single conditional request that is free against the API quota when nothing changed, and a pull follows only when something did.
- **Periodic timer** as an optional safety net, off by default, minimum five minutes on mobile.
- **Manual sync** from the ribbon, the command palette, and the status indicator.
- **Offline awareness**: when the device is offline, automatic sync is skipped silently and the status shows offline. No error notices.
- **Deletions and renames** propagate in both directions. A rename is a delete plus an add. A file deleted on one device is deleted on others through Obsidian's own file manager, which honors the user's *Deleted files* setting (system trash, vault `.trash` folder, or permanent). The `.trash` folder is never synced. Users who chose permanent deletion still have version history as the safety net.
- **No empty commits.** A sync with nothing to push creates no commit.
- **Concurrent edits from another device** during a push are detected and retried against the new remote state. The retry never turns a local change into a download.
- **Baseline integrity**: the record of what was last synced is updated only after the remote confirms the commit, and records the remote commit it corresponds to. It is discarded when the repository or branch changes, so a stale record can never be read against a different repository. Changing an ignore rule never deletes files.

**Acceptance**: edit a note on the phone, switch to the desktop, and the change is there before you open the note. Delete a note on the desktop, it is in the phone's trash after the next sync. A `.mov` recorded on the phone arrives on the desktop byte-identical.

### 5.3 What syncs (P0)

- **Default**: all notes and attachments in the vault.
- **Never**: workspace layout files, cache, the plugin's own credentials, the `.git` folder if one exists.
- **Obsidian configuration syncs by default, because settings are reproducible, not authored.** Categories, each with a toggle that is on unless noted: appearance and themes, CSS snippets, hotkeys, core settings and core plugin list, community plugin list and installed plugin code, community plugin settings. Device-specific files (workspace layouts, cache, the plugin's own credentials) are never synced.
- **Credential detection.** Plugin settings files are scanned for keys or values that look like secrets (token, secret, API key, password, or known token prefixes). A plugin whose settings contain one is excluded from config sync by default and listed in settings as *contains credentials*, where the user can opt it in per plugin.
- **Config never prompts.** When a category is first enabled on a device that already has different settings, the user picks one bulk rule: *use this device's settings* or *use the repository's settings*. For ongoing conflicts in config files, the most recently modified side wins silently and the other side remains available in history. No conflict copies are created inside the config folder.
- **Ignore patterns** in a repository-level ignore file, so exclusions are shared across devices, with a settings UI to add and remove them.
- **Exclude from sync** from the file and folder context menu (P1).
- **Sync this file now** from the file context menu (P1).

### 5.4 Conflicts (P0)

**Goal**: most conflicts resolve themselves; the rest are resolved in two taps without losing anything.

- **Automatic three-way merge for text.** When both sides edited the same note in different places, the merge is applied silently and the result is synced. The user sees a brief notice with a *Review* link.
- **Every automatic merge is reversible.** Before merging, the plugin snapshots this device's pre-merge version locally and keeps it for 30 days. *Review* opens the note's history, where the merge appears as a version with both inputs beside it: the other device's version (already in the repository) and this device's version before the merge (local snapshot). Restoring either is one tap. This is what makes silent merging acceptable: a merge can be line-wise clean and still read wrongly, for example when two devices rewrote different sentences of the same paragraph, and the user must be able to see that it happened and get their own words back.
- **Picker on overlap.** When edits touch the same lines, or the file is binary, a compact dialog shows the file, which device made each change and when, and three choices: *keep mine*, *keep theirs*, *keep both*. Choosing *keep both* saves the other version beside the note with a suffix naming the device and time.
- **Expandable diff** (P1) beneath the picker for text files, so the user can see exactly what differs before choosing.
- **Dismissing the dialog is safe**: it behaves as *keep both*.
- **Conflicts never block other files.** Unconflicted changes sync while a conflict is pending.
- **Pending conflicts are visible** in the status indicator and the settings page on every platform, with a *Resolve now* action. They survive app restarts.

**Acceptance**: two devices append different paragraphs to the same note, sync, and both paragraphs appear on both devices with no dialog. Two devices edit the same sentence, sync, and the second device sees one dialog. Force-quitting during that dialog leaves both versions on disk.

### 5.5 Version history (P0)

**Goal**: recover from mistakes without visiting github.com.

- **File history** from the note's context menu and the command palette: a list of versions with time and device. Automatic merges are marked, with both merge inputs listed as restorable versions.
- **Preview** any version in a read-only pane.
- **Restore** a version in one tap. Restoring creates a new version; nothing is lost.
- **Recover a deleted note** (P1) from a list of recently deleted files with the same restore action.

**Acceptance**: a user who overwrote a note's contents restores yesterday's version from the phone in under thirty seconds.

### 5.6 Devices (P1)

- **Device name** set once during setup, defaulting to a sensible platform name.
- **Devices list** in settings showing every device that has synced this vault, its platform, and when it last synced.
- **Last synced from** appears in the status tooltip and in conflict dialogs.
- **Forget a device** removes it from the list.

Implemented as small manifest files stored in the repository outside the synced branch, so they never appear in the vault's history, never create commits on the branch, and cost no extra service.

### 5.7 Large files (P0)

- Files are transferred in chunks so that peak memory is bounded by the chunk size, not the file size, on every platform.
- Files above GitHub's 100 MB blob limit are skipped and listed by name in a *Skipped files* section of settings with the reason. The user is told once per file, not on every sync.
- Local hashing of unchanged files is skipped using modification time and size, so a sync of a large vault with one changed note takes seconds.

**Acceptance**: a vault with 2 GB of attachments completes first sync on a low-end Android phone without a crash.

### 5.8 Status and diagnostics (P0)

- **Status indicator** on desktop in the status bar: idle with last-sync time, syncing with progress, pending conflicts, offline, error. Clicking it opens a menu.
- **Status card** at the top of the settings page with the same information, because phones hide the status bar. Includes *Sync now*, *Resolve conflicts*, and *View log*.
- **Sync log** of recent syncs with device, duration, counts, and errors. Errors are copyable in one tap with credentials redacted.
- **Notices** are quiet: a manual sync reports its result once; automatic syncs report only conflicts, skipped files, and the first failure after a success.

### 5.9 Security (P0)

- Credentials are stored device-local, outside the vault folder, and never written into the repository.
- Tokens are sent only in request headers and only to the configured GitHub host over HTTPS. Plain HTTP is refused.
- Paths from the repository are validated before being written. Anything that would escape the vault or land in the plugin's own folder is rejected.
- The plugin's own configuration folder is never synced, even when config categories are enabled.
- Sign-in uses a GitHub App, not a classic OAuth app, so a user's token is limited to the repositories they selected and to file contents. A classic OAuth app with the `repo` scope would grant access to every private repository the user owns, which is what competitors ask for.

## 5.10 Distribution and operations (P0)

- **GitHub App ownership.** The app is registered under a dedicated GitHub organization for the project, not a personal account. An organization is free, survives changes to any one person's account, lets a co-maintainer be added without re-registering, and keeps the app name stable for users. The app is public so anyone can install it, has no webhook, has device flow enabled, and requests *Contents: read and write* and *Metadata: read*. User tokens expire after eight hours and are refreshed silently; the refresh token is the credential stored on the device.
- **If the app is ever unavailable**, sign-in falls back to a personal access token. Existing sessions keep working until their refresh token expires.
- **GitHub Enterprise Server** users always use a token, since apps are registered per instance.
- **No telemetry, no server.** The project runs nothing but the app registration.

## 6. What sets it apart

| | This plugin | obsidian-git | Gitless Sync | Git Vault Sync | SyncGit |
|---|---|---|---|---|---|
| Works on mobile with large vaults | Yes, chunked | No | Crashes | Crashes reported | 25 MB cap |
| Sign in without a token | Yes | No | No | No | No |
| Access limited to the chosen repositories | Yes (GitHub App) | Token grants all repos | Token grants all repos | Token grants all repos | Token grants all repos |
| Auto-merge same-note edits | Yes | Desktop only | No | Desktop only | No |
| Never loses a conflict side | Yes | No | No | No | Yes |
| Per-file history and restore | Yes | Desktop only | No | No | No |
| Deletions and renames propagate | Yes | Yes | Unreliable | Yes | Yes |
| Sync after edits | Yes | Timer | Timer | Timer | Timer |
| Device list | Yes | No | No | No | Name only |
| Automated tests | Yes | Yes | No | Partial | No |
| Maintained | New | Yes | No | Yes | Dormant |

## 7. Constraints the product must respect

- **GitHub API quota**: 5,000 requests per hour per user. Each changed file costs one request plus a fixed cost per sync. Debounced sync must batch edits and the timer must have a floor. Rate-limit responses must be recognized and shown as such, not as authentication errors.
- **Tree limit**: repositories above 100,000 files or 7 MB of tree data cannot be read in one call. v1 refuses to sync such repositories with a clear message.
- **Blob limit**: 100 MB per file.
- **Android heap**: assume about 45 MB available. All file I/O uses chunked read and append APIs available since Obsidian 1.12.
- **Minimum Obsidian version**: 1.13, for chunked binary APIs.
- **Community plugin guidelines**: no default hotkeys, no network calls before the user signs in, no telemetry.
- **Per-file request cost.** Every file uploaded or downloaded through the Git Data API is one request, against a quota of 5,000 per hour. A first sync of a very large vault can therefore take hours in each direction. The design should batch text files where the API allows it and use a bulk download path for first sync where one is available; both are spikes.
- **Repository growth.** Every sync that pushes changes creates one commit; pulls create none. GitHub recommends keeping repositories under 1 GB and may intervene above 5 GB. Text edits are cheap: GitHub stores versions of a note as compressed deltas, so even hundreds of commits a day add well under a megabyte. Attachments are the real cost: each edited version of an image or PDF is stored in full. Design consequences: the settle period coalesces edits, no commit is made when nothing changed, the status card shows repository size, and a warning appears when the repository passes 1 GB. A history-compaction tool (rewrite history older than N months) is a P2 candidate.

## 8. Success measures

Quality is measured before growth.

- Zero data-loss reports in the first 90 days after release. A data-loss report is a P0 incident.
- First-sync success rate on a populated 1 GB vault on a low-end Android device: 100% in the test matrix.
- Median time from stopping typing on one device to the change appearing on another: under 30 seconds on Wi-Fi.
- Automated test coverage of every guarantee in section 3, run on every pull request.
- Community store listing approved within one review cycle.

## 9. Release plan

**v1.0**: sections 5.1, 5.2, 5.3 (defaults, never-list, categories, ignore file), 5.4 (merge, picker, keep both, visibility), 5.5 (history, preview, restore), 5.7, 5.8, 5.9.

**v1.x**: context-menu exclude and sync-this-file, expandable diff, deleted-file recovery, devices list.

**Later, if demand appears**: whole-vault rollback, Git LFS, GitLab and Gitea, repository subfolders, encryption.

## 10. Decisions log

Resolved during PRD review on 2026-09-25:

- **Sign-in app**: a GitHub App under a project organization, device flow, repository-scoped. See 5.10.
- **Merge reversibility**: no separate undo mechanism. Each automatic merge keeps a 30-day local snapshot of the pre-merge version and surfaces both inputs in file history. See 5.4.
- **Config sync policy**: on by default for all categories, since settings are reproducible. Plugins whose settings contain credentials are excluded by default with per-plugin opt-in. Config conflicts are resolved by a bulk rule on enable and by newest-wins afterwards, never by a per-file picker. See 5.3.
- **Sync frequency and repository size**: the settle period coalesces edits into one commit per writing pause; text history is cheap, attachment history is not. See section 7.
- **Name**: Vaultline, plugin id `vaultline`. Store description leads with "Sync your vault across desktop and mobile through your own private GitHub repository." Chosen 2026-09-25.
- **Deletions**: go through Obsidian's file manager and honor the user's *Deleted files* setting. See 5.2.

## 11. Open questions

None at this time.
