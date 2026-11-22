import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLib, cleanBranch, planRepoChanges, worktreesDirFromSettings, shortHash, join, base, dirname, META, PRESELECT } from "../mods/worktree-group/lib.js";

const pexec = promisify(execFile);

// The same contract as Herdr's exec / readTextFile / writeTextFile, on real processes and files.
async function exec(cmd, args, opts = {}) {
  try {
    const r = await pexec(cmd, args, { cwd: opts.cwd });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
  }
}
const readTextFile = (p) => fs.readFile(p, "utf8").catch(() => null);
const writeTextFile = (p, text) => fs.writeFile(p, text).then(() => null);
const lib = createLib({ exec, readTextFile, writeTextFile });

const git = async (cwd, ...args) => (await pexec("git", ["-C", cwd, ...args])).stdout.trim();
const exists = (p) => fs.access(p).then(() => true, () => false);

let tmp;
before(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pw-test-")); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

let n = 0;
const root = (parent) => `${parent}-groups`; // stands in for <worktrees.directory>/groups
// A parent folder (name contains a space) with repos a, b, c, a plain folder, and parent-level files.
async function makeParent(repos = ["a", "b", "c"]) {
  const parent = join(tmp, `case ${++n}`, "UMG project");
  await fs.mkdir(parent, { recursive: true });
  for (const r of repos) {
    const d = join(parent, r);
    await fs.mkdir(d);
    await git(d, "init", "-q", "-b", "main");
    await git(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  }
  await fs.writeFile(join(parent, "AGENTS.md"), "source agents\n");
  await fs.mkdir(join(parent, ".claude"));
  await fs.writeFile(join(parent, ".claude", "settings.json"), "{}\n");
  return parent;
}

describe("cleanBranch", () => {
  test("accepts normal names and turns spaces into dashes", () => {
    assert.equal(cleanBranch("feature/login"), "feature/login");
    assert.equal(cleanBranch("  my feature "), "my-feature");
  });
  test("rejects names git would refuse", () => {
    for (const bad of ["", "   ", "-x", "a..b", "a//b", "a/", "a.", "x.lock", "a/.b", "a~b", "a:b", "a b?"]) {
      assert.equal(cleanBranch(bad), "", JSON.stringify(bad));
    }
  });
});

describe("paths", () => {
  test("join and base", () => {
    assert.equal(join("/a/b/", "/c/", "d"), "/a/b/c/d");
    assert.equal(base("/a/b/"), "b");
  });
});

describe("scanning", () => {
  test("childRepos lists only direct child git repos", async () => {
    const parent = await makeParent(["b", "a"]);
    await fs.mkdir(join(parent, "plain"));
    await fs.mkdir(join(parent, "plain", "nested"));
    await git(join(parent, "plain", "nested"), "init", "-q");
    assert.deepEqual(await lib.childRepos(parent), ["a", "b"]);
  });
  test("a parent that is not a repo is not a git repo; a child is", async () => {
    const parent = await makeParent();
    assert.equal(await lib.isGitRepo(parent), false);
    assert.equal(await lib.isGitRepo(join(parent, "a")), true);
  });
  test("scanFolder splits repos from files, keeps hidden entries, skips metadata, flags agent files", async () => {
    const parent = await makeParent();
    await fs.writeFile(join(parent, META), "{}");
    await fs.mkdir(join(parent, "docs"));
    await fs.mkdir(join(parent, ".skills"));
    const s = await lib.scanFolder(parent);
    assert.deepEqual(s.repos, ["a", "b", "c"]);
    assert.deepEqual(s.files.map((f) => f.name), [".claude", ".skills", "AGENTS.md", "docs"]);
    assert.deepEqual(s.files.filter((f) => f.preselected).map((f) => f.name), [".claude", ".skills", "AGENTS.md"]);
    assert.ok(PRESELECT.includes("CLAUDE.md"));
  });
  test("a symlink to a repo is a shared file, not a repo", async () => {
    const parent = await makeParent(["a"]);
    await fs.symlink(join(parent, "a"), join(parent, "link-to-a"));
    const s = await lib.scanFolder(parent);
    assert.deepEqual(s.repos, ["a"]);
    assert.ok(s.files.some((f) => f.name === "link-to-a"));
  });
});

describe("createWorktreeGroup", () => {
  test("creates worktrees, copies parent files, writes metadata (paths with spaces)", async () => {
    const parent = await makeParent();
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "feat/x", repos: ["a", "b"], files: ["AGENTS.md", ".claude"] });
    assert.equal(r.target, `${root(parent)}/${base(parent)}/feat-x`);
    assert.deepEqual(r.repos, ["a", "b"]);
    assert.equal(await git(join(r.target, "a"), "branch", "--show-current"), "feat/x");
    assert.equal(await git(join(r.target, "b"), "branch", "--show-current"), "feat/x");
    assert.equal(await exists(join(r.target, "c")), false, "unselected repo is not created");
    assert.equal(await fs.readFile(join(r.target, "AGENTS.md"), "utf8"), "source agents\n");
    assert.equal(await exists(join(r.target, ".claude", "settings.json")), true);
    const meta = JSON.parse(await fs.readFile(join(r.target, META), "utf8"));
    assert.equal(meta.sourceParentPath, parent);
    assert.equal(meta.branchName, "feat/x");
    assert.deepEqual(meta.repos, ["a", "b"]);
    assert.deepEqual(meta.copied, ["AGENTS.md", ".claude"]);
    const found = await lib.findMeta(join(r.target, "a"));
    assert.equal(found.dir, r.target, "findMeta walks up from a child repo");
  });

  test("checks out an existing branch instead of failing", async () => {
    const parent = await makeParent(["a"]);
    await git(join(parent, "a"), "branch", "already");
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "already", repos: ["a"] });
    assert.equal(await git(join(r.target, "a"), "branch", "--show-current"), "already");
  });

  test("rolls back everything when one repo fails", async () => {
    const parent = await makeParent(["a", "b"]);
    // b already has `feat` checked out elsewhere, so adding it again fails.
    await git(join(parent, "b"), "worktree", "add", "-b", "feat", join(tmp, "elsewhere"));
    await assert.rejects(lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "feat", repos: ["a", "b"] }), /b:/);
    assert.equal(await exists(`${root(parent)}/${base(parent)}/feat`), false, "target folder removed");
    assert.equal(await git(join(parent, "a"), "branch", "--list", "feat"), "", "branch created for a was deleted");
    assert.equal(await git(join(parent, "a"), "worktree", "list", "--porcelain").then((o) => o.split("worktree ").length - 1), 1);
  });

  test("refuses an existing target folder", async () => {
    const parent = await makeParent(["a"]);
    await fs.mkdir(`${root(parent)}/${base(parent)}/dup`, { recursive: true });
    await assert.rejects(lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "dup", repos: ["a"] }), /already exists/);
  });
});

describe("append / remove / sync / destroy", () => {
  let parent, dir, meta;
  async function fresh(repos = ["a"]) {
    parent = await makeParent();
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "feat", repos, files: ["AGENTS.md", ".claude"] });
    dir = r.target;
    meta = (await lib.findMeta(dir)).meta;
  }

  test("append adds only the given repos with the same branch and updates metadata", async () => {
    await fresh(["a"]);
    const remaining = (await lib.childRepos(parent)).filter((x) => !meta.repos.includes(x));
    assert.deepEqual(remaining, ["b", "c"]);
    const r = await lib.appendWorktrees({ dir, meta, repos: ["b"] });
    assert.deepEqual(r.added, ["b"]);
    assert.equal(await git(join(dir, "b"), "branch", "--show-current"), "feat");
    assert.deepEqual((await lib.findMeta(dir)).meta.repos, ["a", "b"]);
  });

  test("append reports a failure and does not record it", async () => {
    await fresh(["a"]);
    await git(join(parent, "b"), "worktree", "add", "-b", "feat", join(tmp, `other-${n}`));
    const r = await lib.appendWorktrees({ dir, meta, repos: ["b"] });
    assert.deepEqual(r.added, []);
    assert.equal(r.failures.length, 1);
    assert.deepEqual((await lib.findMeta(dir)).meta.repos, ["a"]);
  });

  test("remove fails on a dirty worktree without force, succeeds with it", async () => {
    await fresh(["a", "b"]);
    await fs.writeFile(join(dir, "a", "dirty.txt"), "x");
    let r = await lib.removeWorktrees({ dir, meta, repos: ["a"], force: false });
    assert.deepEqual(r.removed, []);
    assert.equal(r.failures.length, 1);
    assert.equal(await exists(join(dir, "a")), true);
    r = await lib.removeWorktrees({ dir, meta, repos: ["a"], force: true });
    assert.deepEqual(r.removed, ["a"]);
    assert.equal(await exists(join(dir, "a")), false);
    assert.deepEqual((await lib.findMeta(dir)).meta.repos, ["b"]);
  });

  test("sync re-copies only the stored selection: overwrites, merges folders, keeps worktree-only files", async () => {
    await fresh(["a"]);
    await fs.writeFile(join(dir, "AGENTS.md"), "edited locally\n");
    await fs.writeFile(join(dir, ".claude", "local-only"), "keep");
    await fs.writeFile(join(parent, "AGENTS.md"), "updated source\n");
    await fs.writeFile(join(parent, ".claude", "new.json"), "{}");
    await fs.writeFile(join(parent, "NEW.md"), "not selected at creation");
    const r = await lib.syncGroupFiles({ dir, meta });
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.copied, ["AGENTS.md", ".claude"]);
    assert.equal(await fs.readFile(join(dir, "AGENTS.md"), "utf8"), "updated source\n");
    assert.equal(await exists(join(dir, ".claude", "new.json")), true);
    assert.equal(await exists(join(dir, ".claude", ".claude")), false, "folder not nested");
    assert.equal(await fs.readFile(join(dir, ".claude", "local-only"), "utf8"), "keep");
    assert.equal(await exists(join(dir, "NEW.md")), false, "unselected entries are not synced");
  });

  test("sync reports an entry that vanished from the source and leaves the rest", async () => {
    await fresh(["a"]);
    await fs.rm(join(parent, "AGENTS.md"));
    const r = await lib.syncGroupFiles({ dir, meta });
    assert.equal(r.failures.length, 1);
    assert.deepEqual(r.copied, [".claude"]);
    assert.equal(await exists(join(dir, "AGENTS.md")), true, "the worktree's copy is not deleted");
  });

  test("destroy removes worktrees, copied files, metadata and the folder", async () => {
    await fresh(["a", "b"]);
    const r = await lib.destroyWorktreeGroup({ dir, meta, force: false });
    assert.deepEqual({ ok: r.ok, folderKept: r.folderKept }, { ok: true, folderKept: false });
    assert.equal(await exists(dir), false);
    assert.equal(await git(join(parent, "a"), "worktree", "list", "--porcelain").then((o) => o.split("worktree ").length - 1), 1, "git forgot the worktree");
    assert.equal(await exists(join(parent, "AGENTS.md")), true, "source files untouched");
  });

  test("destroy keeps everything when a worktree is dirty, then works with force", async () => {
    await fresh(["a", "b"]);
    await fs.writeFile(join(dir, "b", "dirty.txt"), "x");
    let r = await lib.destroyWorktreeGroup({ dir, meta, force: false });
    assert.equal(r.ok, false);
    assert.equal(await exists(join(dir, META)), true, "metadata kept");
    assert.equal(await exists(join(dir, "AGENTS.md")), true, "copied files kept");
    const after = (await lib.findMeta(dir)).meta;
    assert.deepEqual(after.repos, ["b"], "only the removed worktree is dropped from metadata");
    r = await lib.destroyWorktreeGroup({ dir, meta: after, force: true });
    assert.equal(r.ok, true);
    assert.equal(await exists(dir), false);
  });

  test("destroy keeps the folder when it holds other files", async () => {
    await fresh(["a"]);
    await fs.writeFile(join(dir, "mine.txt"), "x");
    const r = await lib.destroyWorktreeGroup({ dir, meta, force: false });
    assert.deepEqual({ ok: r.ok, folderKept: r.folderKept }, { ok: true, folderKept: true });
    assert.equal(await exists(join(dir, "mine.txt")), true);
  });
});

describe("groups with no repos", () => {
  test("can be created with only files, and unselected files are not copied", async () => {
    const parent = await makeParent();
    await fs.writeFile(join(parent, "notes.txt"), "x");
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "empty", repos: [], files: ["AGENTS.md"] });
    assert.deepEqual(r.repos, []);
    assert.equal(await exists(join(r.target, "AGENTS.md")), true);
    assert.equal(await exists(join(r.target, "notes.txt")), false);
    assert.equal(await git(join(parent, "a"), "branch", "--list", "empty"), "", "no branch is created yet");
    const { meta } = await lib.findMeta(r.target);
    assert.deepEqual(meta.repos, []);
  });

  test("repos can be added later; the branch is created at that point", async () => {
    const parent = await makeParent();
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "later", files: [] });
    const { meta } = await lib.findMeta(r.target);
    const a = await lib.appendWorktrees({ dir: r.target, meta, repos: ["a"] });
    assert.deepEqual(a.added, ["a"]);
    assert.equal(await git(join(r.target, "a"), "branch", "--show-current"), "later");
  });

  test("removing every repo leaves a valid empty group; destroy then cleans it up", async () => {
    const parent = await makeParent();
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "g", repos: ["a", "b"], files: ["AGENTS.md"] });
    let { meta } = await lib.findMeta(r.target);
    const rm = await lib.removeWorktrees({ dir: r.target, meta, repos: ["a", "b"], force: false });
    assert.deepEqual(rm.removed, ["a", "b"]);
    meta = (await lib.findMeta(r.target)).meta;
    assert.deepEqual(meta.repos, []);
    const d = await lib.destroyWorktreeGroup({ dir: r.target, meta, force: false });
    assert.equal(d.ok, true);
    assert.equal(await exists(r.target), false);
  });
});

describe("editing group repos", () => {
  test("planRepoChanges computes the diff and flags repos missing from the source", () => {
    const p = planRepoChanges({ sourceRepos: ["a", "b", "c"], groupRepos: ["a", "gone"], selected: ["b", "gone"] });
    assert.deepEqual(p.list, ["a", "b", "c", "gone"]);
    assert.deepEqual(p.add, ["b"]);
    assert.deepEqual(p.remove, ["a"]);
    assert.deepEqual(p.missing, ["gone"]);
  });
  test("no change when the selection equals the group", () => {
    const p = planRepoChanges({ sourceRepos: ["a", "b"], groupRepos: ["a"], selected: ["a"] });
    assert.deepEqual([p.add, p.remove], [[], []]);
  });

  test("applyRepoChanges removes and adds in one go and keeps metadata consistent", async () => {
    const parent = await makeParent();
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "edit", repos: ["a", "b"], files: [] });
    const { meta } = await lib.findMeta(r.target);
    const res = await lib.applyRepoChanges({ dir: r.target, meta, add: ["c"], remove: ["a"], force: false });
    assert.deepEqual([res.added, res.removed, res.failures], [["c"], ["a"], []]);
    assert.deepEqual((await lib.findMeta(r.target)).meta.repos, ["b", "c"]);
    assert.equal(await exists(join(r.target, "a")), false);
    assert.equal(await git(join(r.target, "c"), "branch", "--show-current"), "edit");
  });

  test("applyRepoChanges: a dirty removal fails without force, the add still happens", async () => {
    const parent = await makeParent();
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "edit2", repos: ["a"], files: [] });
    await fs.writeFile(join(r.target, "a", "dirty.txt"), "x");
    const { meta } = await lib.findMeta(r.target);
    const res = await lib.applyRepoChanges({ dir: r.target, meta, add: ["b"], remove: ["a"], force: false });
    assert.deepEqual([res.added, res.removed], [["b"], []]);
    assert.equal(res.failures.length, 1);
    assert.deepEqual((await lib.findMeta(r.target)).meta.repos, ["a", "b"]);
  });
});

describe("settings and location", () => {
  test("worktreesDirFromSettings: default, ~ expansion, absolute, invalid json", () => {
    assert.equal(worktreesDirFromSettings(null, "/home/u"), "/home/u/.herdr/worktrees");
    assert.equal(worktreesDirFromSettings("{not json", "/home/u"), "/home/u/.herdr/worktrees");
    assert.equal(worktreesDirFromSettings('{"worktrees":{"directory":"~/Dev/wt"}}', "/home/u"), "/home/u/Dev/wt");
    assert.equal(worktreesDirFromSettings('{"worktrees":{"directory":"/data/wt/"}}', "/home/u"), "/data/wt");
    assert.equal(worktreesDirFromSettings('{"worktrees":{"directory":"~"}}', "/home/u"), "/home/u");
  });
  test("shortHash is stable and differs per path", () => {
    assert.equal(shortHash("/a/UMG"), shortHash("/a/UMG"));
    assert.notEqual(shortHash("/a/UMG"), shortHash("/b/UMG"));
    assert.equal(shortHash("/a/UMG").length, 6);
  });
  test("groupTarget: <root>/<parent name>/<branch dashed>, and reports a taken folder", async () => {
    const parent = await makeParent(["a"]);
    const t = await lib.groupTarget({ groupsRoot: root(parent), source: parent, branch: "feat/x" });
    assert.deepEqual(t, { target: `${root(parent)}/UMG project/feat-x`, taken: false });
    await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "feat/x", repos: ["a"] });
    assert.equal((await lib.groupTarget({ groupsRoot: root(parent), source: parent, branch: "feat/x" })).taken, true);
    assert.equal((await lib.groupTarget({ groupsRoot: root(parent), source: parent, branch: "feat-x" })).taken, true, "feat/x and feat-x share a folder");
  });
  test("two different parents with the same folder name get separate group folders", async () => {
    const p1 = await makeParent(["a"]);
    const p2 = await makeParent(["a"]);
    assert.equal(base(p1), base(p2));
    const shared = join(tmp, `shared-root-${n}`);
    const g1 = await lib.createWorktreeGroup({ groupsRoot: shared, source: p1, branch: "one", repos: ["a"] });
    const g2 = await lib.createWorktreeGroup({ groupsRoot: shared, source: p2, branch: "two", repos: ["a"] });
    assert.equal(g1.target, `${shared}/UMG project/one`);
    assert.equal(g2.target, `${shared}/UMG project-${shortHash(p2)}/two`);
    const again = await lib.groupTarget({ groupsRoot: shared, source: p2, branch: "three" });
    assert.equal(again.target, `${shared}/UMG project-${shortHash(p2)}/three`, "same parent keeps using its own folder");
  });
});

describe("two parents with the same name", () => {
  test("same repo names and the same group/branch name: both succeed, fully independent", async () => {
    const p1 = await makeParent(["a", "b"]);
    const p2 = await makeParent(["a", "b"]);
    const shared = join(tmp, `same-root-${n}`);
    const g1 = await lib.createWorktreeGroup({ groupsRoot: shared, source: p1, branch: "feat", repos: ["a", "b"] });
    const g2 = await lib.createWorktreeGroup({ groupsRoot: shared, source: p2, branch: "feat", repos: ["a", "b"] });
    assert.notEqual(g1.target, g2.target);
    assert.equal((await lib.findMeta(g1.target)).meta.sourceParentPath, p1);
    assert.equal((await lib.findMeta(g2.target)).meta.sourceParentPath, p2);
    // removing from one group does not touch the other
    const m1 = (await lib.findMeta(g1.target)).meta;
    await lib.destroyWorktreeGroup({ dir: g1.target, meta: m1, force: false });
    assert.equal(await exists(join(g2.target, "a")), true);
    assert.equal(await git(join(g2.target, "a"), "branch", "--show-current"), "feat");
  });
});

describe("branch inspection", () => {
  test("new branch reports its base", async () => {
    const parent = await makeParent(["a"]);
    assert.deepEqual(await lib.inspectBranch(join(parent, "a"), "fresh"), { state: "new", base: "main" });
  });
  test("existing local branch", async () => {
    const parent = await makeParent(["a"]);
    await git(join(parent, "a"), "branch", "old");
    assert.deepEqual(await lib.inspectBranch(join(parent, "a"), "old"), { state: "existing" });
  });
  test("a branch checked out in the source repo or another worktree is in-use, with the path", async () => {
    const parent = await makeParent(["a"]);
    let i = await lib.inspectBranch(join(parent, "a"), "main");
    assert.equal(i.state, "in-use");
    // git reports real paths (on macOS /var is a symlink to /private/var)
    assert.equal(await fs.realpath(i.usedAt), await fs.realpath(join(parent, "a")));
    await git(join(parent, "a"), "worktree", "add", "-b", "busy", join(tmp, `busy-${n}`));
    i = await lib.inspectBranch(join(parent, "a"), "busy");
    assert.equal(i.state, "in-use");
    assert.equal(await fs.realpath(i.usedAt), await fs.realpath(join(tmp, `busy-${n}`)));
  });
  test("a branch only on a remote is created tracking it", async () => {
    const parent = await makeParent(["a"]);
    const origin = join(tmp, `origin-${n}.git`);
    await pexec("git", ["init", "-q", "--bare", origin]);
    await git(join(parent, "a"), "remote", "add", "origin", origin);
    await git(join(parent, "a"), "push", "-q", "origin", "main:refs/heads/shared-feat");
    await git(join(parent, "a"), "fetch", "-q", "origin");
    assert.deepEqual(await lib.inspectBranch(join(parent, "a"), "shared-feat"), { state: "remote", remote: "origin/shared-feat" });
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "shared-feat", repos: ["a"] });
    assert.equal(await git(join(r.target, "a"), "rev-parse", "--abbrev-ref", "@{u}"), "origin/shared-feat");
  });
  test("a stale worktree record (folder deleted by hand) does not block re-adding", async () => {
    const parent = await makeParent(["a"]);
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "stale", repos: ["a"] });
    await fs.rm(join(r.target, "a"), { recursive: true });
    const i = await lib.inspectBranch(join(parent, "a"), "stale");
    assert.equal(i.state, "existing", "prunable record is ignored");
    const { meta } = await lib.findMeta(r.target);
    const res = await lib.appendWorktrees({ dir: r.target, meta: { ...meta, repos: [] }, repos: ["a"] });
    assert.deepEqual(res.added, ["a"]);
  });
  test("adding a repo whose branch is in use fails with a clear message", async () => {
    const parent = await makeParent(["a"]);
    await git(join(parent, "a"), "worktree", "add", "-b", "taken", join(tmp, `taken-${n}`));
    const r = await lib.addWorktree(join(parent, "a"), "taken", join(tmp, `new-${n}`));
    assert.equal(r.ok, false);
    assert.match(r.err, /already checked out at/);
  });
  test("re-adding a repo after removing it reuses the branch and its commits", async () => {
    const parent = await makeParent(["a"]);
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "again", repos: ["a"] });
    await git(join(r.target, "a"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
    let { meta } = await lib.findMeta(r.target);
    await lib.removeWorktrees({ dir: r.target, meta, repos: ["a"], force: false });
    assert.equal((await lib.inspectBranch(join(parent, "a"), "again")).state, "existing");
    meta = (await lib.findMeta(r.target)).meta;
    await lib.appendWorktrees({ dir: r.target, meta, repos: ["a"] });
    assert.equal(await git(join(r.target, "a"), "log", "-1", "--format=%s"), "work");
  });
});

describe("archive", () => {
  const archiveRoot = (parent) => root(parent);
  async function groupWithWork() {
    const parent = await makeParent(["a", "b"]);
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "feat", repos: ["a", "b"], files: ["AGENTS.md", ".claude"] });
    await fs.writeFile(join(r.target, "a", "uncommitted.txt"), "precious");
    await git(join(r.target, "b"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "committed work");
    const { meta } = await lib.findMeta(r.target);
    return { parent, dir: r.target, meta };
  }
  const worktreePaths = async (repo) => (await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));

  test("archive moves everything, keeps uncommitted work and git links valid, deletes nothing", async () => {
    const { parent, dir, meta } = await groupWithWork();
    const { target } = await lib.archiveWorktreeGroup({ dir, meta, groupsRoot: root(parent), now: new Date("2026-01-02T03:04:05Z") });
    assert.equal(target, `${root(parent)}/.archive/UMG project/feat`);
    assert.equal(await exists(dir), false, "original folder is gone");
    assert.equal(await fs.readFile(join(target, "a", "uncommitted.txt"), "utf8"), "precious");
    assert.equal(await fs.readFile(join(target, "AGENTS.md"), "utf8"), "source agents\n");
    assert.equal(await git(join(target, "b"), "log", "-1", "--format=%s"), "committed work");
    assert.equal(await git(join(target, "a"), "branch", "--show-current"), "feat", "git works inside the moved worktree");
    const real = await fs.realpath(join(target, "a"));
    assert.ok((await Promise.all((await worktreePaths(join(parent, "a"))).map((p) => fs.realpath(p).catch(() => p)))).includes(real), "source repo points at the new path");
    const m = (await lib.findMeta(target)).meta;
    assert.deepEqual([m.archived, m.archivedAt, m.archivedFrom], [true, "2026-01-02T03:04:05.000Z", dir]);
    assert.equal(await exists(dirname(dir)), false, "the empty parent folder was tidied away");
  });

  test("listArchivedGroups and dirtyRepos", async () => {
    const { parent, dir, meta } = await groupWithWork();
    await lib.archiveWorktreeGroup({ dir, meta, groupsRoot: root(parent), now: new Date("2026-01-01T00:00:00Z") });
    const p2 = await makeParent(["a"]);
    const g2 = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: p2, branch: "newer", repos: ["a"] });
    await lib.archiveWorktreeGroup({ dir: g2.target, meta: (await lib.findMeta(g2.target)).meta, groupsRoot: root(parent), now: new Date("2026-02-01T00:00:00Z") });
    const list = await lib.listArchivedGroups(root(parent));
    assert.deepEqual(list.map((x) => x.meta.branchName), ["newer", "feat"], "newest first");
    const feat = list[1];
    assert.deepEqual(await lib.dirtyRepos(feat), ["a"], "only a has uncommitted changes");
    assert.deepEqual(await lib.listArchivedGroups(join(tmp, "nothing-here")), []);
  });

  test("restore puts everything back where it was", async () => {
    const { parent, dir, meta } = await groupWithWork();
    const { target } = await lib.archiveWorktreeGroup({ dir, meta, groupsRoot: root(parent) });
    const archived = (await lib.findMeta(target));
    const r = await lib.restoreWorktreeGroup(archived);
    assert.equal(r.target, dir);
    assert.equal(await exists(target), false);
    assert.equal(await fs.readFile(join(dir, "a", "uncommitted.txt"), "utf8"), "precious");
    assert.equal(await git(join(dir, "a"), "branch", "--show-current"), "feat");
    const m = (await lib.findMeta(dir)).meta;
    assert.equal(m.archived, undefined);
    assert.equal(m.archivedFrom, undefined);
    assert.deepEqual(m.repos, ["a", "b"]);
  });

  test("restore refuses when the original folder is taken, and leaves the archive intact", async () => {
    const { parent, dir, meta } = await groupWithWork();
    const { target } = await lib.archiveWorktreeGroup({ dir, meta, groupsRoot: root(parent) });
    await fs.mkdir(dir, { recursive: true });
    await assert.rejects(lib.restoreWorktreeGroup(await lib.findMeta(target)), /already exists/);
    assert.equal(await fs.readFile(join(target, "a", "uncommitted.txt"), "utf8"), "precious");
  });

  test("archiving the same group name twice does not collide", async () => {
    const parent = await makeParent(["a"]);
    const make = () => lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "again", repos: [] });
    const g1 = await make();
    const a1 = await lib.archiveWorktreeGroup({ dir: g1.target, meta: (await lib.findMeta(g1.target)).meta, groupsRoot: root(parent) });
    const g2 = await make();
    const a2 = await lib.archiveWorktreeGroup({ dir: g2.target, meta: (await lib.findMeta(g2.target)).meta, groupsRoot: root(parent) });
    assert.equal(a1.target, `${root(parent)}/.archive/UMG project/again`);
    assert.equal(a2.target, `${root(parent)}/.archive/UMG project/again-2`);
  });

  test("a group made outside the groups root (older sibling layout) is archived under the parent's name", async () => {
    const parent = await makeParent(["a"]);
    const old = `${parent}-worktrees/legacy`;
    const created = await lib.createWorktreeGroup({ groupsRoot: `${parent}-worktrees-tmp`, source: parent, branch: "legacy", repos: ["a"] });
    await fs.mkdir(dirname(old), { recursive: true });
    const meta = (await lib.findMeta(created.target)).meta;
    await lib.archiveWorktreeGroup({ dir: created.target, meta, groupsRoot: root(parent) }).then((r) => {
      assert.equal(r.target, `${root(parent)}/.archive/UMG project/legacy`);
    });
  });

  test("a worktree with an initialised submodule (git refuses to move it) is still archived via the fallback", async () => {
    const parent = await makeParent(["a"]);
    const sub = join(tmp, `subrepo-${n}`);
    await fs.mkdir(sub);
    await git(sub, "init", "-q", "-b", "main");
    await git(sub, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "sub");
    const allow = ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t"];
    await git(join(parent, "a"), ...allow, "submodule", "add", "-q", sub, "vendor");
    await git(join(parent, "a"), ...allow, "commit", "-q", "-m", "add submodule");
    const r = await lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch: "withsub", repos: ["a"] });
    await git(join(r.target, "a"), ...allow, "submodule", "update", "--init", "-q");
    const { meta } = await lib.findMeta(r.target);
    const { target } = await lib.archiveWorktreeGroup({ dir: r.target, meta, groupsRoot: root(parent) });
    assert.equal(await git(join(target, "a"), "branch", "--show-current"), "withsub");
    assert.equal(await exists(join(target, "a", "vendor", ".git")), true);
    assert.equal(await exists(r.target), false);
    const real = await fs.realpath(join(target, "a"));
    assert.ok((await Promise.all((await worktreePaths(join(parent, "a"))).map((p) => fs.realpath(p).catch(() => p)))).includes(real));
  });

  test("a failure part way moves everything back", async () => {
    const { parent, dir, meta } = await groupWithWork();
    await fs.rm(join(parent, "b"), { recursive: true, force: true }); // b's source repo is gone: its worktree cannot be moved
    await assert.rejects(lib.archiveWorktreeGroup({ dir, meta, groupsRoot: root(parent) }));
    assert.equal(await exists(join(dir, "a", "uncommitted.txt")), true, "a is back in the group");
    assert.equal(await exists(join(dir, "AGENTS.md")), true);
    assert.equal(await exists(join(dir, META)), true);
    assert.equal(await exists(`${root(parent)}/.archive/UMG project/feat`), false, "no half-made archive");
  });

  test("an archived group can be deleted permanently", async () => {
    const { parent, dir, meta } = await groupWithWork();
    const { target } = await lib.archiveWorktreeGroup({ dir, meta, groupsRoot: root(parent) });
    const archived = await lib.findMeta(target);
    let r = await lib.destroyWorktreeGroup({ dir: archived.dir, meta: archived.meta, force: false });
    assert.equal(r.ok, false, "a has uncommitted work, so a plain delete is refused");
    assert.equal(await exists(join(target, "a", "uncommitted.txt")), true);
    const again = await lib.findMeta(target);
    r = await lib.destroyWorktreeGroup({ dir: again.dir, meta: again.meta, force: true });
    assert.equal(r.ok, true);
    assert.equal(await exists(target), false);
    assert.equal((await worktreePaths(join(parent, "a"))).length, 1);
  });
});

describe("listing groups", () => {
  test("listGroups finds active groups only, sorted, and ignores the archive", async () => {
    const parent = await makeParent(["a"]);
    const mk = (branch) => lib.createWorktreeGroup({ groupsRoot: root(parent), source: parent, branch, repos: ["a"] });
    const g1 = await mk("beta");
    const g2 = await mk("alpha");
    const g3 = await mk("gone");
    await lib.archiveWorktreeGroup({ dir: g3.target, meta: (await lib.findMeta(g3.target)).meta, groupsRoot: root(parent) });
    const list = await lib.listGroups(root(parent));
    assert.deepEqual(list.map((g) => g.meta.branchName), ["alpha", "beta"]);
    assert.deepEqual(list.map((g) => g.dir), [g2.target, g1.target]);
    assert.deepEqual(await lib.listGroups(join(tmp, "no-such-root")), []);
  });
});

