# Plan: archived worktree groups (not implemented yet)

Status: idea, agreed in principle, to be built later.

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

## Menu changes (group Space)

- **Delete worktree group** becomes **Archive worktree group** (light confirmation with a summary).
- New item **Archived worktree groups...** opens the archive screen.
- Permanent deletion exists only in the archive screen.

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

## Implementation notes

- Logic goes in `mods/worktree-group/lib.js`: `archiveWorktreeGroup`, `restoreWorktreeGroup`,
  `listArchivedGroups`, `groupDirtyState`, and reuse `destroyWorktreeGroup` for permanent deletion.
- UI: new modes in `main.js` (`archive` confirmation, `archives` screen).
- Unit tests (`npm test`, real git in temp folders): archive moves folder and keeps git links valid,
  uncommitted changes survive, restore round-trip, dirty detection, submodule fallback, branch-in-use
  error, permanent delete from the archive, paths with spaces.
- The archive screen needs a manual pass in Herdr, like the other dialogs.
- Update the README when built.
