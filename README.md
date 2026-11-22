# Herdr Worktree Groups

A [Herdr](https://herdr.dev) mod that turns a folder holding several git repositories into a **worktree group**:
one Space with a git worktree of each chosen repo on a shared branch, plus the agent files
(`AGENTS.md`, `.skills`, ...) that live next to your repos.

```
~/Projects/UMG/            <- your parent folder (not a git repo)
  a/  b/  c/               <- repos
  AGENTS.md  .claude/      <- shared agent setup

~/.herdr/worktrees/groups/UMG/feature-x/     <- the group
  a/  b/                   <- git worktrees on branch feature-x
  AGENTS.md  .claude/      <- copies of the files you chose
  .herdr-worktree-group.json
```

## Using it

Right-click a Space in the sidebar.

- **Create worktree group from folder** (on a folder that is not a git repo): type a name (it is also
  the branch name), tick the repos (none are ticked by default) and the files to copy (agent files
  are ticked by default). A group with no repos is valid. Each repo shows whether its branch is new,
  existing, remote-only (will track it) or in use (blocked).
- **Edit group repos**: tick to add, untick to remove. A review screen lists what will happen first.
- **Sync shared files**: copies the files chosen at creation again, overwriting same-named ones.
- **Delete worktree group**: removes the worktrees, the copied files and the group folder, then closes
  the Space. Branches are never deleted; clean them up with git.

Groups live in `<worktrees.directory>/groups/<parent folder name>/<group>` (Herdr's
`worktrees.directory` setting, default `~/.herdr/worktrees`). Two parents with the same folder name get
a short hash on the second. Everything runs as `git -C <path> ...` with argument arrays, never through a
shell, so paths with spaces are safe.

## Install

```sh
./install.sh --layout
herdr-app do layout.switch '{"name":"main-wg"}'
```

This copies `worktree-group` (the mod) and `spaces-wg` (below) into `~/.config/herdr-app/mods`, checks
them with `herdr-app check`, and with `--layout` adds the `main-wg` layout. Press `ctrl-alt-shift-escape`
in Herdr to fall back to the default layout if anything misbehaves.

### Why a cloned sidebar?

Herdr's shipped mods and layouts are read-only and the Space right-click opens the shipped `menu` mod.
`spaces-wg` is Herdr's `spaces` sidebar (v0.1.16) with one change: right-click opens `worktree-group`
instead of `menu`, whose standard items are reproduced there. `layouts/main-wg.json` is Herdr's `main`
layout pointing at `spaces-wg`. If your layout is your own clone, change its sidebar block's `mod` to
`spaces-wg`, or make the same one-line change in your sidebar clone (`mod: "worktree-group"`,
`props: { mode: "menu", tab: "space", target: { id } }`).

## Development

```sh
npm test    # Node's built-in runner, real git in temp folders, no dependencies
```

The logic is in `mods/worktree-group/lib.js` (no Herdr imports, so it is unit tested); `main.js` is the UI.
The dialogs need Herdr itself: use `herdr-app check mods/worktree-group` and try them in the app.

## Limits

- Local Spaces only (remote machines are not supported).
- Uses `find`, `cp`, `rm` and friends: Linux, and probably macOS (CI runs both). Windows is not supported yet.
- Planned: archiving instead of deleting, see `docs/archive-feature-plan.md`.
