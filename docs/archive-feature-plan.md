# Plan: archived worktree groups (not implemented yet)

Status: **built** (logic, tests, confirmation, archive screen, entry points). Original plan below.
Previously: **logic built and tested** (`lib.js`: `archiveWorktreeGroup`, `restoreWorktreeGroup`,
`listArchivedGroups`, `dirtyRepos`; permanent delete reuses `destroyWorktreeGroup`). **UI not built yet**:
the confirmation, the archive screen and the entry points below.

## Goal

Nothing gets deleted by accident. "Delete worktree group" becomes **Archive**, a safe, reversible
step. Permanent deletion moves to an archive screen where it is a deliberate cleanup.

## What archiving means

- Move the group folder instead of deleting it:
  `<worktrees.directory>/groups/<parent>/<name>` -> `<worktrees.directory>/groups/.archive/<parent>/<name>`
  (groups now live under one user-level root, see below).
- Move each repo's worktree with `git worktree move`, so git keeps its links valid. Uncommitted work,
  copied files and branches all survive.
- Fallback when `git worktree move` refuses (worktrees with submodules, locked worktrees): plain
  move, then `git worktree repair` in each source repo.
- Close the group's Space.
- Record `archived: true` and `archivedAt` in `.herdr-worktree-group.json`.
- Restore does the reverse (move back, `git worktree repair` if needed) and opens a Space on the group.

## Menu changes (group Space) and entry points

- **Delete worktree group** becomes **Archive worktree group** (light confirmation with a summary).
  The direct delete is removed from the group Space menu; permanent deletion exists only in the archive screen.
- **Archived worktree groups...** opens the archive screen. Archiving closes the group's Space, so the screen
  must be reachable when no group Space exists. Entry points:
  1. the tab bar's **+** menu (`new-menu-wg`), next to **New worktree group...** (the main one: the screen is
     global and does not depend on the active Space);
  2. the Space right-click menu, on group Spaces and on any Space that is not a git repo.
- No separate sidebar section, and no automatic deletion of old archives.

## Archive screen

- Lists the archived groups found under `<worktrees.directory>/groups/.archive/`. Groups now live
  under a single user-level root (`worktrees.directory` from settings.json, default
  `~/.herdr/worktrees`), so no registry of parent folders is needed: the screen scans that one folder.
- Groups created before the user-level root existed (siblings of the parent folder) keep working
  through their metadata file; the archive screen would only list groups archived from now on.
- Each row: name, branch, repos, archived date, and whether any worktree has uncommitted changes.
- Actions:
  - **Restore**.
  - **Delete permanently**: shows what will be lost, offers Force for dirty worktrees, then removes
    the worktrees, copied files, metadata and folder (what "Delete worktree group" does today).
    Branches stay in the source repos, as now.

## Known caveats

- An archived worktree still holds its branch checked out, so a new group cannot use that branch
  name until the archived one is deleted. Show a clear error that points at the archive screen.
- Archived groups keep their disk usage (build output included) until deleted.
- Per-repo removal through "Edit group repos" stays a real removal (with its review step). Per-repo
  archiving is out of scope for the first version.
- Restore can conflict if the source repo changed meanwhile (branch deleted, path reused): report
  the git error, leave the archive untouched.

## Behaviour of the built logic

- Archive path: `<groupsRoot>/.archive/<parent folder name>/<group>`, with `-2`, `-3`... when that name is taken.
  A group made outside the groups root (older sibling layout) is archived under its source parent's name.
- Each repo worktree moves with `git worktree move`; if git refuses (e.g. an initialised submodule: "working
  trees containing submodules cannot be moved or removed") it is moved with `mv` and re-registered with
  `git worktree repair`. Other entries (copied files, metadata) move with `mv`.
- If anything fails part way, everything is moved back and the half-made archive folder is removed.
- Archive writes `archived`, `archivedAt` (ISO) and `archivedFrom` to the metadata; restore removes them and
  refuses when the original folder is taken, leaving the archive untouched.
- Known gap: permanently deleting a worktree that contains an initialised submodule fails without Force, because
  `git worktree remove` refuses those; the error is shown and Force works.

## Implementation notes

- Logic is in `mods/worktree-group/lib.js` (done): `archiveWorktreeGroup`, `restoreWorktreeGroup`,
  `listArchivedGroups`, `dirtyRepos`, and `destroyWorktreeGroup` for permanent deletion.
- UI: new modes in `main.js` (`archive` confirmation, `archives` screen).
- Unit tests (`npm test`, real git in temp folders): archive moves folder and keeps git links valid,
  uncommitted changes survive, restore round-trip, dirty detection, submodule fallback, branch-in-use
  error, permanent delete from the archive, paths with spaces.
- The archive screen needs a manual pass in Herdr, like the other dialogs.
- Update the README when built.
