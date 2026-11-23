# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A [Herdr](https://herdr.dev) mod (plain ES modules, no build step, no dependencies) that turns a folder of sibling git repos into a "worktree group": one Space with a worktree of each chosen repo on a shared branch, plus copied agent files. `README.md` covers how it works for users; `RECIPE.md` is the full behaviour/UI spec and the "Done when" checklist. Keep both in sync when behaviour or UI changes.

## Commands

```sh
npm test                                              # node --test test/*.test.js (real git in temp dirs)
node --test --test-name-pattern="cleanBranch" test/   # run one test / describe block
herdr-app check mods/worktree-group                   # static check of a mod (also mods/spaces-wg, tabs-wg, new-menu-wg)
./install.sh [--layout]                               # copy mods (and main-wg layout) into ~/.config/herdr-app — makes them live
```

CI runs `npm test` on Node 22, Ubuntu and macOS. `herdr-app check` does not render dialogs or run async work, so UI flows can only be verified in the running app. Don't run `install.sh` unless asked; it overwrites the user's installed mods.

## Architecture

- `mods/worktree-group/lib.js` holds all logic and imports nothing from `herdr`. `createLib({ exec, readTextFile, writeTextFile })` takes injected I/O; `main.js` passes Herdr's functions and `test/lib.test.js` passes `child_process`/`fs` versions with the same contract (`exec` resolves `{code, stdout, stderr}` and never throws). New logic belongs here, with tests.
- `mods/worktree-group/main.js` is the UI: one `View` (`gpui-kit`/`gpui-base`) switching on `props().mode`: `menu | create | edit | sync | archive | archives | open`. Other mods open it with `openOverlay({ mod: "worktree-group", kind: "popup" | "dialog", width, height, props })`.
- `mods/spaces-wg`, `mods/tabs-wg`, `mods/new-menu-wg` and `layouts/main-wg.json` are clones of Herdr's shipped (read-only) `spaces`, `tabs`, `new-menu` and `main` layout, each with a minimal change to route entry points to `worktree-group` (sidebar right-click → `menu` mode; tab bar **+** → `new-menu-wg`, which adds group rows). Keep the diffs from upstream minimal so they can be re-synced when Herdr updates (cloned from Herdr v0.1.16).
- User hooks in `<source>/.worktreegroup/hooks/{repo,group}` run from the `lib.js` flows (`runHook`) and return `hookFailures`. The contract is in README "Hooks", and it is public: don't change argument order. Tool-specific setup (Serena, Codex, ...) belongs in hook scripts (`examples/worktreegroup/hooks/`), not in the mod.
- A group is identified by `.herdr-worktree-group.json` (`META`), found by walking up from a Space's folder. Groups live in `<worktrees.directory>/groups/<parent name>[-hash]/<group>`; archives under `<groups>/.archive/...`.

## Conventions and pitfalls

- Every external command runs as an argv array (`git -C <path> ...`, `cp`, `find`, `mv`, ...), never through a shell. Tests use paths with spaces.
- Only Linux/macOS tools; no Windows support.
- Multi-step operations roll back on failure (create removes worktrees/branches/folder; archive moves everything back; permanent delete removes nothing more if any worktree removal fails). Branches are never deleted.
- Shared files are copied with symlinks followed (`cp -R -L -p`, folder contents as `src/.` because `cp -R src dst` onto an existing folder nests it). Symlinks already in the group are removed before copying so nothing is written through them into the parent.
- Ignore `prunable` blocks of `git worktree list --porcelain` when checking whether a branch is in use.
- A symlink to a repo counts as a shared file, not a repo.
