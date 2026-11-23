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

![Create worktree group dialog](preview.png)

## Using it

Right-click a Space in the sidebar, or use the **+** button in the tab bar (**New worktree group…**, for the
active Space's folder).

![Space menu](preview_menu.png)

- **Create worktree group from folder** (on a folder that is not a git repo): type a name (it is also
  the branch name), tick the repos (none are ticked by default) and the files to copy (agent files
  are ticked by default), and optionally list folders to exclude as comma-separated paths relative to
  the parent folder (for example `.skills/cache, docs/drafts`). Exclusions apply inside copied folders
  and are retained for later syncs. A group with no repos is valid. Each repo shows whether its branch is new,
  existing, remote-only (will track it) or in use (blocked).
  Symlinks in the parent folder are followed: the group gets real copies, so editing them in the group never changes the
  originals. A symlink to a repo is listed as a file, and ticking it copies the whole repo.

### Parent configuration

Create `<parent>/.worktreegroup/config.json` to customize repo discovery and shared-file copying:

```json
{
  "repos": ["services/api", "tools/migrator"],
  "preselectedRepos": ["services/api", "a"],
  "excludedFolders": [".skills/cache", "docs/drafts"]
}
```

`repos` adds Git repositories at paths below the parent folder to the Create list; top-level repositories
continue to be discovered automatically. `preselectedRepos` names which listed repositories start checked.
`excludedFolders` paths are relative to the parent and apply to shared folders during creation and sync.
Paths must be relative and cannot traverse above the parent. This file stays in the parent and is never copied.

- **Edit group repos**: tick to add, untick to remove. A review screen lists what will happen first.
- **Sync shared files**: copies the files chosen at creation again, overwriting same-named ones and
  applying the same folder exclusions.
- **Open worktree group…** (Space menu, and the tab bar's **+** menu): lists your groups (open ones are
  marked) and opens a Space on the one you click, or switches to its Space if it is already open. Use it
  to bring back a group whose Space you closed. Groups made in the older sibling layout are not listed.
- **Archive worktree group**: moves the whole group to `<groups>/.archive/...` and closes its Space. Nothing
  is deleted: uncommitted changes, copied files and branches are kept.
- **Archived worktree groups…** (Space menu, and the tab bar's **+** menu): lists the archives with their
  repos and any uncommitted work. **Restore** moves a group back and opens its Space; **Delete permanently…**
  (with its own confirmation and a Force option for uncommitted changes) is the only way a group is deleted.
  Branches are never deleted; clean them up with git.

Groups live in `<worktrees.directory>/groups/<parent folder name>/<group>` (Herdr's
`worktrees.directory` setting, default `~/.herdr/worktrees`). Two parents with the same folder name get
a short hash on the second. Everything runs as `git -C <path> ...` with argument arrays, never through a
shell, so paths with spaces are safe.

## Hooks

To set up tools per repo (MCP servers, agent config, ...) without the mod knowing about them, put executable
scripts in `.worktreegroup/hooks/` of the parent folder. They are run from there (never copied into groups), with
argument arrays and no shell. Nothing is run if a script is missing. A failing script shows a warning and undoes nothing.

| Script | Arguments | cwd | Runs |
|---|---|---|---|
| `repo` | `added <worktree> <sourceRepo> <repo> <group> <branch>` | worktree | for each repo after Create (after files are copied) and Edit adds it |
| `repo` | `removing <worktree> <sourceRepo> <repo> <group> <branch>` | worktree | before Edit or Delete permanently removes it |
| `group` | `changed <group> <sourceParent> <branch> <repo>...` | group | once after Create, Edit and Sync |

Use `group` to write files that list every repo: Sync copies the parent's files again, so it runs afterwards to restore them.
Archive and Restore run no hooks.

`examples/worktreegroup/hooks/` holds an example: a Serena MCP server per repo for Codex. Copy it into your parent folder
(`cp -R examples/worktreegroup <parent>/.worktreegroup`) and adapt it.

- `repo` copies a repo's untracked `.serena/project.yml` and `memories/` into the worktree when the worktree has none.
  Committed Serena config is already there. The memories are a copy, so use a symlink if you want them shared. `cache/` is not
  copied, so the index is rebuilt per worktree. Ignore `.serena/` in the repo so the copies are not committed.
- `group` writes one `[mcp_servers.serena-<repo>]` per repo (`serena start-mcp-server --context codex --project <group>/<repo>`)
  between marker lines in `<group>/.codex/config.toml`. The rest of the file (for example the parent's `.codex/config.toml`)
  is kept, except that an existing `[mcp_servers.serena-<repo>]` for one of the group's repos (with its sub-tables) is
  replaced by the generated one. Run `codex` in the group folder. Codex only
  reads a project's `.codex/config.toml` once you trust the folder.

One Serena server serves one project, so each repo gets its own server (and language server). In the group root, Serena's
`--project-from-cwd` finds nothing: the root has no `.git` and no `.serena/project.yml`.

## Install

```sh
./install.sh --layout
herdr-app do layout.switch '{"name":"main-wg"}'
```

This copies `worktree-group` (the mod) and `spaces-wg`, `tabs-wg`, `new-menu-wg` (below) into `~/.config/herdr-app/mods`, checks
them with `herdr-app check`, and with `--layout` adds the `main-wg` layout. Press `ctrl-alt-shift-escape`
in Herdr to fall back to the default layout if anything misbehaves.

### Why cloned mods?

Herdr's shipped mods and layouts are read-only, and the Space right-click and the tab bar's **+** open
shipped mods. So three small clones, each with one change (Herdr v0.1.16):

- `spaces-wg`: Herdr's `spaces` sidebar; right-click opens `worktree-group` instead of `menu` (whose standard
  items are reproduced there).
- `tabs-wg`: the `tabs` bar; **+** opens `new-menu-wg`.
- `new-menu-wg`: the `new-menu` popup with an extra **New worktree group…** row.

`layouts/main-wg.json` is Herdr's `main` layout pointing at `spaces-wg` and `tabs-wg`. If your layout is your own clone, change its sidebar block's `mod` to
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
- Hooks are run directly (they need a `#!` line and `chmod +x`).
- Design notes for archiving: `docs/archive-feature-plan.md`.
