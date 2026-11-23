// The logic of the worktree-group mod, with no UI and no `herdr` imports, so it can be
// unit tested in Node. main.js passes Herdr's real exec/readTextFile/writeTextFile;
// the tests pass child_process / fs versions.
//
//   exec(command, args, {cwd?}) -> Promise<{code, stdout, stderr}>
//   readTextFile(path)          -> Promise<string | null>
//   writeTextFile(path, text, expected) -> Promise<null>
//
// Every command runs with an argv array, never through a shell, so paths with spaces are safe.

export const META = ".herdr-worktree-group.json";

// A folder in the source parent holding user hook scripts (never copied into groups):
//   <source>/.worktreegroup/hooks/repo   added|removing <worktree> <sourceRepo> <repo> <group> <branch>  (cwd: worktree)
//   <source>/.worktreegroup/hooks/group  changed <group> <source> <branch> <repo>...                     (cwd: group)
// A hook runs only when it exists and is executable. Failures are reported, never rolled back.
export const HOOKS_DIR = ".worktreegroup";
export const GROUP_CONFIG = `${HOOKS_DIR}/config.json`;

export async function readGroupConfig(folder, readTextFile) {
  try {
    const value = JSON.parse(await readTextFile(join(folder, GROUP_CONFIG)) ?? "{}");
    const paths = (items) => Array.isArray(items) ? items.filter((p) => typeof p === "string").map((p) => p.trim().replace(/^\.\//, "")).filter((p) => p && !p.startsWith("/") && !p.split("/").includes("..")) : [];
    return { excludedFolders: paths(value.excludedFolders), preselectedRepos: paths(value.preselectedRepos), repos: paths(value.repos) };
  } catch { return { excludedFolders: [], preselectedRepos: [], repos: [] }; }
}

// Parent-level entries that are ticked by default in the Create dialog (agent setup).
export const PRESELECT = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".skills", ".claude", ".cursor", ".agents", ".codex"];

export const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
export const dirname = (p) => trimSlash(p).slice(0, trimSlash(p).lastIndexOf("/")) || "/";
export const base = (p) => trimSlash(p).split("/").pop();
export const join = (...parts) => parts.map((p, i) => (i === 0 ? trimSlash(p) : p.replace(/^\/+|\/+$/g, ""))).join("/");

// A branch name that is safe as a git ref, or "" when it is not usable.
export function cleanBranch(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, "-");
  if (!s || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(s)) return "";
  if (s.includes("..") || s.includes("//") || /[\/.]$/.test(s) || s.endsWith(".lock") || s.includes("/.")) return "";
  return s;
}

// Where Herdr keeps worktrees: settings.json `worktrees.directory` (default ~/.herdr/worktrees).
// `~` expands to `home`. Groups live in <directory>/groups.
export function worktreesDirFromSettings(text, home) {
  let dir = "~/.herdr/worktrees";
  try {
    const d = JSON.parse(text ?? "{}")?.worktrees?.directory;
    if (typeof d === "string" && d.trim()) dir = d.trim();
  } catch {}
  if (dir === "~") return trimSlash(home);
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  return trimSlash(dir);
}

// Short stable hash (FNV-1a) used only to tell apart two parent folders that share a name.
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

// What ticking and unticking repos means for a group. All arguments are lists of repo names.
// -> { list, add, remove, missing }: `list` is every repo to show, `missing` are group repos that
// no longer exist in the source folder.
export function planRepoChanges({ sourceRepos, groupRepos, selected }) {
  const sel = new Set(selected);
  const inGroup = new Set(groupRepos);
  const missing = groupRepos.filter((n) => !sourceRepos.includes(n));
  const list = [...new Set([...sourceRepos, ...groupRepos])].sort((a, b) => a.localeCompare(b));
  return {
    list,
    missing,
    add: list.filter((n) => sel.has(n) && !inGroup.has(n)),
    remove: list.filter((n) => !sel.has(n) && inGroup.has(n)),
  };
}

export function createLib({ exec, readTextFile, writeTextFile }) {
  async function git(cwd, args) {
    try {
      const r = await exec("git", ["-C", cwd, ...args]);
      return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim() };
    } catch (e) {
      return { ok: false, out: "", err: String(e) };
    }
  }

  async function exists(path) {
    try { return (await exec("test", ["-e", path])).code === 0; } catch { return false; }
  }

  const isGitRepo = async (folder) => (await git(folder, ["rev-parse", "--is-inside-work-tree"])).ok;

  // One pass over a folder's direct children: real directories holding a .git are repos,
  // everything else (files, other folders, symlinks, hidden entries) is a file/folder to share.
  // -> { repos: [names], files: [{ name, preselected }] }, each sorted. Our metadata file is skipped.
  async function scanFolder(folder) {
    const config = await readGroupConfig(folder, readTextFile);
    const all = await exec("find", [folder, "-mindepth", "1", "-maxdepth", "1"]);
    if (all.code !== 0) return { repos: [], files: [] };
    const dirs = await exec("find", [folder, "-mindepth", "1", "-maxdepth", "1", "-type", "d"]);
    const dirSet = new Set(dirs.code === 0 ? dirs.stdout.split("\n").filter(Boolean).map(base) : []);
    const repos = [];
    const files = [];
    for (const n of all.stdout.split("\n").filter(Boolean).map(base)) {
      if (n === META || n === HOOKS_DIR) continue;
      if (dirSet.has(n) && (await exists(join(folder, n, ".git")))) repos.push(n);
      else files.push({ name: n, preselected: PRESELECT.includes(n) });
    }
    const by = (a, b) => (a.name ?? a).localeCompare(b.name ?? b);
    for (const path of config.repos) {
      if (!repos.includes(path) && (await exists(join(folder, path, ".git")))) repos.push(path);
    }
    const selected = new Set(config.preselectedRepos);
    return { repos: repos.sort(by), files: files.sort(by), preselectedRepos: [...selected], excludedFolders: config.excludedFolders };
  }

  const childRepos = async (folder) => (await scanFolder(folder)).repos;

  // Copies one entry, overwriting what is there. Symlinks are followed (at any depth), so the group
  // gets real files and folders, never links back into the parent. A folder's contents are merged
  // into the existing folder (cp -R src dst would nest it). Symlinks already at the destination
  // (groups made before links were followed) are removed first, so nothing is written through them.
  async function copyEntry(from, to, excluded = []) {
    if ((await exec("test", ["-L", to])).code === 0) {
      const rm = await exec("rm", ["-f", "--", to]);
      if (rm.code !== 0) return rm;
    }
    if ((await exec("test", ["-d", from])).code !== 0) return exec("cp", ["-L", "-p", "--", from, to]);
    const mk = await exec("mkdir", ["-p", "--", to]);
    if (mk.code !== 0) return mk;
    const links = await exec("find", [to, "-type", "l", "-delete"]);
    if (links.code !== 0) return links;
    if (!excluded.length) return exec("cp", ["-R", "-L", "-p", "--", `${from}/.`, `${to}/`]);
    const findArgs = ["-L", from, "-mindepth", "1"];
    for (const path of excluded) findArgs.push("-path", join(from, path), "-prune", "-o");
    findArgs.push("-print0");
    const found = await exec("find", findArgs);
    if (found.code !== 0) return found;
    for (const path of found.stdout.split("\0").filter(Boolean)) {
      const rel = path.slice(from.length + 1);
      const destination = join(to, rel);
      if ((await exec("test", ["-d", path])).code === 0) {
        const mk = await exec("mkdir", ["-p", "--", destination]);
        if (mk.code !== 0) return mk;
      } else {
        const parent = destination.slice(0, destination.lastIndexOf("/"));
        const mk = await exec("mkdir", ["-p", "--", parent]);
        if (mk.code !== 0) return mk;
        const cp = await exec("cp", ["-L", "-p", "--", path, destination]);
        if (cp.code !== 0) return cp;
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async function copyAll(source, dest, names, excluded = []) {
    const copied = [];
    const failures = [];
    for (const n of names) {
      const withinEntry = excluded.filter((p) => p.startsWith(`${n}/`)).map((p) => p.slice(n.length + 1));
      const c = await copyEntry(join(source, n), join(dest, n), withinEntry);
      if (c.code === 0) copied.push(n); else failures.push(`${n}: ${c.stderr.trim()}`);
    }
    return { copied, failures };
  }

  // Walks up from `start` looking for the metadata file. -> { dir, meta } | null
  async function findMeta(start) {
    let dir = start && trimSlash(start);
    for (let i = 0; dir && dir !== "/" && i < 8; i++) {
      const txt = await readTextFile(join(dir, META)).catch(() => null);
      if (txt) {
        try {
          const meta = JSON.parse(txt);
          if (meta && typeof meta.sourceParentPath === "string" && typeof meta.branchName === "string" && Array.isArray(meta.repos)) return { dir, meta };
        } catch {}
      }
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
    return null;
  }

  async function writeMeta(dir, meta) {
    const path = join(dir, META);
    const prev = await readTextFile(path).catch(() => null);
    await writeTextFile(path, JSON.stringify(meta, null, 2) + "\n", prev);
  }

  // The state of `branch` in one repo, so the UI can warn before anything runs.
  //  new:      does not exist; would be created from the repo's current HEAD (`base`)
  //  existing: local branch, not checked out anywhere; would be checked out
  //  remote:   only on a remote (`remote`, e.g. origin/feat); would be created tracking it
  //  in-use:   checked out in another worktree (`usedAt`); git refuses
  async function inspectBranch(repoPath, branch) {
    const list = await git(repoPath, ["worktree", "list", "--porcelain"]);
    let usedAt = null;
    if (list.ok) {
      for (const block of list.out.split("\n\n")) {
        const lines = block.split("\n");
        if (lines.some((l) => l.startsWith("prunable"))) continue; // stale record: pruned before adding
        if (lines.includes(`branch refs/heads/${branch}`)) usedAt = (lines.find((l) => l.startsWith("worktree ")) ?? "").slice(9);
      }
    }
    if (usedAt) return { state: "in-use", usedAt };
    if ((await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) return { state: "existing" };
    const refs = await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]);
    const remote = refs.ok ? refs.out.split("\n").find((r) => r.endsWith(`/${branch}`) && !r.endsWith("/HEAD")) : null;
    if (remote) return { state: "remote", remote };
    const head = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { state: "new", base: head.ok ? head.out : "HEAD" };
  }

  // -> { repo: info } for each repo.
  async function inspectRepos(source, repos, branch) {
    const out = {};
    for (const repo of repos) out[repo] = await inspectBranch(join(source, repo), branch);
    return out;
  }

  // git worktree add: checks out an existing branch, tracks a remote one, or creates a new one.
  async function addWorktree(repoPath, branch, target) {
    const parent = target.slice(0, target.lastIndexOf("/"));
    const mk = await exec("mkdir", ["-p", "--", parent]);
    if (mk.code !== 0) return { ok: false, out: "", err: mk.stderr.trim(), created: false };
    await git(repoPath, ["worktree", "prune"]); // forget records of worktrees whose folder is gone
    const info = await inspectBranch(repoPath, branch);
    if (info.state === "in-use") return { ok: false, out: "", err: `Branch ${branch} is already checked out at ${info.usedAt}`, created: false };
    let r;
    if (info.state === "existing") r = await git(repoPath, ["worktree", "add", target, branch]);
    else if (info.state === "remote") r = await git(repoPath, ["worktree", "add", "--track", "-b", branch, target, info.remote]);
    else r = await git(repoPath, ["worktree", "add", "-b", branch, target]);
    return { ...r, created: info.state === "new" || info.state === "remote", state: info.state };
  }

  // <groupsRoot>/<parent folder name>/, or <name>-<hash> when another parent folder with the same
  // name already has groups there.
  async function parentDirFor(groupsRoot, source) {
    const plain = join(groupsRoot, base(source));
    const kids = await exec("find", [plain, "-mindepth", "1", "-maxdepth", "1", "-type", "d"]);
    if (kids.code !== 0) return plain;
    for (const kid of kids.stdout.split("\n").filter(Boolean)) {
      const txt = await readTextFile(join(kid, META)).catch(() => null);
      if (!txt) continue;
      try { if (JSON.parse(txt).sourceParentPath !== trimSlash(source)) return `${plain}-${shortHash(trimSlash(source))}`; } catch {}
    }
    return plain;
  }

  // Where a group with this branch name will be created, and whether that folder is taken.
  async function groupTarget({ groupsRoot, source, branch }) {
    const target = join(await parentDirFor(groupsRoot, trimSlash(source)), branch.replace(/\//g, "-"));
    return { target, taken: await exists(target) };
  }

  // ----- hooks -----

  // Runs <source>/.worktreegroup/hooks/<script> with `args`. -> null when there is no such hook,
  // else { script, args, ok, err }.
  async function runHook(source, script, args, cwd) {
    const path = join(source, HOOKS_DIR, "hooks", script);
    if (!(await exists(path))) return null;
    if ((await exec("test", ["-x", path])).code !== 0) return { script, args, ok: false, err: `${path} is not executable` };
    try {
      const r = await exec(path, args, { cwd });
      return { script, args, ok: r.code === 0, err: r.code === 0 ? "" : (r.stderr || r.stdout || `exit ${r.code}`).trim() };
    } catch (e) {
      return { script, args, ok: false, err: String(e) };
    }
  }

  // The `repo` hook for each named repo. -> failure messages
  async function runRepoHooks(event, { dir, meta }, names) {
    const failures = [];
    for (const repo of names) {
      const wt = join(dir, repo);
      const r = await runHook(meta.sourceParentPath, "repo", [event, wt, join(meta.sourceParentPath, repo), repo, trimSlash(dir), meta.branchName], wt);
      if (r && !r.ok) failures.push(`repo ${event} ${repo}: ${r.err}`);
    }
    return failures;
  }

  // The `group` hook, with the group's current repos. -> failure messages
  async function runGroupHook({ dir, meta }) {
    const r = await runHook(meta.sourceParentPath, "group", ["changed", trimSlash(dir), meta.sourceParentPath, meta.branchName, ...meta.repos], dir);
    return r && !r.ok ? [`group changed: ${r.err}`] : [];
  }

  // ----- flows: they return what happened; the UI shows toasts -----

  // `repos` may be empty (a group with only shared files is valid); `files` are the parent-level
  // entries to copy. -> { target, repos, copied, copyFailures }. Throws (after undoing) when a worktree fails.
  async function createWorktreeGroup({ source, branch, repos = [], files = [], excluded = [], groupsRoot }) {
    source = trimSlash(source);
    const { target, taken } = await groupTarget({ groupsRoot, source, branch });
    if (taken) throw new Error(`${target} already exists. Pick another name.`);
    const mk = await exec("mkdir", ["-p", target]);
    if (mk.code !== 0) throw new Error(`Could not create ${target}: ${mk.stderr.trim()}`);
    const made = [];
    for (const repo of repos) {
      const r = await addWorktree(join(source, repo), branch, join(target, repo));
      if (!r.ok) {
        // Undo this run so nothing half-made is left behind.
        for (const m of made) {
          await git(join(source, m.repo), ["worktree", "remove", "--force", join(target, m.repo)]);
          if (m.created) await git(join(source, m.repo), ["branch", "-D", branch]);
          let parent = dirname(join(target, m.repo));
          while (parent !== trimSlash(target) && parent.startsWith(`${trimSlash(target)}/`)) {
            if ((await exec("rmdir", [parent])).code !== 0) break;
            parent = dirname(parent);
          }
        }
        await exec("rmdir", [target]);
        throw new Error(`${repo}: ${r.err}`);
      }
      made.push({ repo, created: r.created });
    }
    const { copied, failures } = await copyAll(source, target, files, excluded);
    const names = made.map((m) => m.repo);
    const meta = { version: 1, sourceParentPath: source, branchName: branch, repos: names, copied, excluded };
    await writeMeta(target, meta);
    const hookFailures = [...(await runRepoHooks("added", { dir: target, meta }, names)), ...(await runGroupHook({ dir: target, meta }))];
    return { target, repos: names, copied, copyFailures: failures, hookFailures };
  }

  // -> { added, failures, hookFailures }
  async function appendWorktrees({ dir, meta, repos }) {
    const added = [];
    const failures = [];
    for (const repo of repos) {
      const r = await addWorktree(join(meta.sourceParentPath, repo), meta.branchName, join(dir, repo));
      if (r.ok) added.push(repo); else failures.push(`${repo}: ${r.err}`);
    }
    if (added.length) await writeMeta(dir, { ...meta, repos: [...meta.repos, ...added] });
    const hookFailures = await runRepoHooks("added", { dir, meta }, added);
    return { added, failures, hookFailures };
  }

  // The `repo` hook runs with `removing` before each removal. -> { removed, failures, hookFailures }
  async function removeWorktrees({ dir, meta, repos, force }) {
    const removed = [];
    const failures = [];
    const hookFailures = [];
    for (const repo of repos) {
      if (await exists(join(dir, repo))) hookFailures.push(...(await runRepoHooks("removing", { dir, meta }, [repo])));
      const r = await git(join(meta.sourceParentPath, repo), ["worktree", "remove", ...(force ? ["--force"] : []), join(dir, repo)]);
      if (r.ok) {
        removed.push(repo);
        let parent = dirname(join(dir, repo));
        while (parent !== trimSlash(dir) && parent.startsWith(`${trimSlash(dir)}/`)) {
          if ((await exec("rmdir", [parent])).code !== 0) break;
          parent = dirname(parent);
        }
      } else failures.push(`${repo}: ${r.err}`);
    }
    if (removed.length) await writeMeta(dir, { ...meta, repos: meta.repos.filter((n) => !removed.includes(n)) });
    return { removed, failures, hookFailures };
  }

  // Removes `remove` first, then adds `add`, then runs the `group` hook.
  // -> { added, removed, failures, hookFailures }
  async function applyRepoChanges({ dir, meta, add = [], remove = [], force = false }) {
    let removed = [];
    let added = [];
    const failures = [];
    const hookFailures = [];
    let current = meta;
    if (remove.length) {
      const r = await removeWorktrees({ dir, meta, repos: remove, force });
      removed = r.removed;
      failures.push(...r.failures);
      hookFailures.push(...r.hookFailures);
      current = { ...meta, repos: meta.repos.filter((n) => !removed.includes(n)) };
    }
    if (add.length) {
      const r = await appendWorktrees({ dir, meta: current, repos: add });
      added = r.added;
      failures.push(...r.failures);
      hookFailures.push(...r.hookFailures);
      current = { ...current, repos: [...current.repos, ...added] };
    }
    if (removed.length || added.length) hookFailures.push(...(await runGroupHook({ dir, meta: current })));
    return { added, removed, failures, hookFailures };
  }

  // Copies the group's stored file selection (meta.copied) from the source again, overwriting.
  // Entries that no longer exist in the source are reported as failures and left alone.
  // Then runs the `group` hook (copied files may have overwritten what it wrote). -> { copied, failures, hookFailures }
  async function syncGroupFiles({ dir, meta }) {
    const { copied, failures } = await copyAll(meta.sourceParentPath, dir, meta.copied ?? [], meta.excluded ?? []);
    return { copied, failures, hookFailures: await runGroupHook({ dir, meta }) };
  }

  // Removes every child worktree, the copied files, the metadata and the (empty) folder.
  // The `repo` hook runs with `removing` before each worktree is removed.
  // -> { ok, failures, folderKept, hookFailures }. On failure nothing but the removed worktrees is touched.
  async function destroyWorktreeGroup({ dir, meta, force }) {
    const failures = [];
    const removed = [];
    const hookFailures = [];
    for (const repo of meta.repos) {
      const target = join(dir, repo);
      if (!(await exists(target))) { removed.push(repo); continue; } // already gone: prune below
      hookFailures.push(...(await runRepoHooks("removing", { dir, meta }, [repo])));
      const r = await git(join(meta.sourceParentPath, repo), ["worktree", "remove", ...(force ? ["--force"] : []), target]);
      if (r.ok) removed.push(repo); else failures.push(`${repo}: ${r.err}`);
    }
    for (const repo of removed) await git(join(meta.sourceParentPath, repo), ["worktree", "prune"]);
    if (failures.length) {
      await writeMeta(dir, { ...meta, repos: meta.repos.filter((n) => !removed.includes(n)) });
      return { ok: false, failures, folderKept: true, hookFailures };
    }
    for (const n of meta.copied ?? []) await exec("rm", ["-rf", "--", join(dir, n)]);
    await exec("rm", ["-f", join(dir, META)]);
    const rm = await exec("rmdir", [dir]); // only succeeds when empty
    return { ok: true, failures: [], folderKept: rm.code !== 0, hookFailures };
  }

  // ----- archive: move a group instead of deleting it -----

  // Moves a whole group folder. Each repo worktree goes with `git worktree move`; when git refuses
  // (submodules, locked worktrees) it is moved with mv and re-registered with `git worktree repair`.
  // Everything else in the folder (copied files, metadata) is moved with mv. On failure all is moved back.
  async function moveGroup({ from, to, meta }) {
    from = trimSlash(from);
    to = trimSlash(to);
    if (await exists(to)) throw new Error(`${to} already exists.`);
    const mk = await exec("mkdir", ["-p", "--", to]);
    if (mk.code !== 0) throw new Error(`Could not create ${to}: ${mk.stderr.trim()}`);
    const done = [];
    try {
      for (const repo of meta.repos) {
        const src = join(from, repo);
        const dst = join(to, repo);
        if (!(await exists(src))) continue; // already gone; nothing to move
        const source = join(meta.sourceParentPath, repo);
        const r = await git(source, ["worktree", "move", src, dst]);
        if (r.ok) { done.push(repo); continue; }
        const mv = await exec("mv", ["--", src, dst]);
        if (mv.code !== 0) throw new Error(`${repo}: ${r.err || mv.stderr.trim()}`);
        done.push(repo);
        const rp = await git(source, ["worktree", "repair", dst]);
        if (!rp.ok) throw new Error(`${repo}: ${rp.err}`);
      }
      const list = await exec("find", [from, "-mindepth", "1", "-maxdepth", "1"]);
      for (const n of list.stdout.split("\n").filter(Boolean).map(base)) {
        const mv = await exec("mv", ["--", join(from, n), join(to, n)]);
        if (mv.code !== 0) throw new Error(`${n}: ${mv.stderr.trim()}`);
      }
      await exec("rmdir", [from]); // best effort: only succeeds when empty
    } catch (e) {
      for (const repo of [...done].reverse()) {
        await exec("mv", ["--", join(to, repo), join(from, repo)]);
        await git(join(meta.sourceParentPath, repo), ["worktree", "repair", join(from, repo)]);
      }
      const back = await exec("find", [to, "-mindepth", "1", "-maxdepth", "1"]);
      for (const n of back.stdout.split("\n").filter(Boolean).map(base)) await exec("mv", ["--", join(to, n), join(from, n)]);
      await exec("rmdir", [to]);
      throw e;
    }
  }

  // <groupsRoot>/.archive/<parent folder name>/<group>, with -2, -3... when that name is taken.
  async function archivePath({ dir, meta, groupsRoot }) {
    const parent = trimSlash(dir).startsWith(`${trimSlash(groupsRoot)}/`) ? base(dirname(dir)) : base(meta.sourceParentPath);
    const name = base(dir);
    let candidate = join(groupsRoot, ".archive", parent, name);
    for (let i = 2; await exists(candidate); i++) candidate = join(groupsRoot, ".archive", parent, `${name}-${i}`);
    return candidate;
  }

  // Moves the group into the archive folder, keeping uncommitted work, copied files and branches.
  // -> { target }. Nothing is deleted.
  async function archiveWorktreeGroup({ dir, meta, groupsRoot, now = new Date() }) {
    const target = await archivePath({ dir, meta, groupsRoot });
    const mk = await exec("mkdir", ["-p", "--", dirname(target)]);
    if (mk.code !== 0) throw new Error(`Could not create ${dirname(target)}: ${mk.stderr.trim()}`);
    await moveGroup({ from: dir, to: target, meta });
    await writeMeta(target, { ...meta, archived: true, archivedAt: now.toISOString(), archivedFrom: trimSlash(dir) });
    await exec("rmdir", [dirname(dir)]); // the parent's folder, when it is now empty
    return { target };
  }

  // Moves an archived group back to where it came from. -> { target }
  async function restoreWorktreeGroup({ dir, meta }) {
    const origin = meta.archivedFrom;
    if (!origin) throw new Error("This archive has no record of where it came from.");
    if (await exists(origin)) throw new Error(`${origin} already exists. Rename or remove it first.`);
    const mk = await exec("mkdir", ["-p", "--", dirname(origin)]);
    if (mk.code !== 0) throw new Error(`Could not create ${dirname(origin)}: ${mk.stderr.trim()}`);
    await moveGroup({ from: dir, to: origin, meta });
    const { archived, archivedAt, archivedFrom, ...rest } = meta;
    await writeMeta(origin, rest);
    await exec("rmdir", [dirname(dir)]);
    return { target: origin };
  }

  // The active (not archived) groups under <groupsRoot>/<parent>/<group>, by parent then name.
  // Groups made in the older sibling layout are not found here. -> [{ dir, meta }]
  async function listGroups(groupsRoot) {
    const r = await exec("find", [groupsRoot, "-mindepth", "2", "-maxdepth", "2", "-type", "d", "-not", "-path", join(groupsRoot, ".archive", "*")]);
    if (r.code !== 0) return [];
    const out = [];
    for (const dir of r.stdout.split("\n").filter(Boolean)) {
      const found = await findMeta(dir);
      if (found && found.dir === dir && !found.meta.archived) out.push(found);
    }
    return out.sort((a, b) => a.dir.localeCompare(b.dir));
  }

  // The archived groups under <groupsRoot>/.archive, newest first. -> [{ dir, meta }]
  async function listArchivedGroups(groupsRoot) {
    const r = await exec("find", [join(groupsRoot, ".archive"), "-mindepth", "2", "-maxdepth", "2", "-type", "d"]);
    if (r.code !== 0) return [];
    const out = [];
    for (const dir of r.stdout.split("\n").filter(Boolean)) {
      const found = await findMeta(dir);
      if (found && found.dir === dir && found.meta.archived) out.push(found);
    }
    return out.sort((a, b) => String(b.meta.archivedAt).localeCompare(String(a.meta.archivedAt)));
  }

  // The repos of a group that have uncommitted changes. -> [names]
  async function dirtyRepos({ dir, meta }) {
    const dirty = [];
    for (const repo of meta.repos) {
      const path = join(dir, repo);
      if (!(await exists(path))) continue;
      const st = await git(path, ["--no-optional-locks", "status", "--porcelain"]);
      if (st.ok && st.out) dirty.push(repo);
    }
    return dirty;
  }

  return { git, exists, isGitRepo, scanFolder, childRepos, copyEntry, findMeta, writeMeta, addWorktree, inspectBranch, inspectRepos, groupTarget, runHook,
    createWorktreeGroup, appendWorktrees, removeWorktrees, applyRepoChanges, syncGroupFiles, destroyWorktreeGroup,
    archiveWorktreeGroup, restoreWorktreeGroup, listGroups, listArchivedGroups, dirtyRepos };
}
