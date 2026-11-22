// Worktree groups: one Space holding git worktrees of several sibling repos, plus shared files.
//
// Opened by the `spaces-wg` sidebar (a clone of `spaces`) on right-click, and by itself as
// dialogs. props: { mode: "menu" | "create" | "edit" | "sync" | "destroy", space, folder?, force? }
//
// A group folder contains `.herdr-worktree-group.json`:
//   { version: 1, sourceParentPath, branchName, repos: ["repoA"], copied: ["AGENTS.md", ".skills"] }
// with one git worktree per repo at <group>/<repo> and the chosen files copied beside them.
// A group may have no repos at all. All commands run with argv arrays (never a shell).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, notify, readTextFile, writeTextFile, appHome, home } from "herdr";
import { META, trimSlash, base, join, cleanBranch, planRepoChanges, worktreesDirFromSettings, createLib } from "./lib.js";

const lib = createLib({ exec, readTextFile, writeTextFile });
const { git, isGitRepo, scanFolder, childRepos, findMeta, inspectRepos, groupTarget } = lib;

function place(s) {
  const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder;
}

const toast = (title, body, level = "error") => notify({ title, body, level, timeout: level === "error" ? 12000 : 5000 });

// ---------- the view ----------

export default class WorktreeGroup extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.mode ?? "menu";
    this.space = spaces().find((s) => s.id === (p.space ?? p.target?.id));
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.at = 0;
    this.busy = false;
    this.error = "";
    this.ready = false;
    this.force = !!p.force;
    this.checked = new Set();
    this.list = [];
    this.files = []; // create: the parent folder's non-repo entries
    this.checkedFiles = new Set();
    this.branchInfo = {}; // repo -> inspectBranch result, for the current branch name
    this.targetInfo = null; // create: { target, taken }
    this.token = 0;
    this.info = { git: null, pw: null }; // menu facts
    this.name = ""; // the user must type a name
    this.input = InputState.new({ value: "", placeholder: "Group / branch name (required)" });
    this.input.on("change", (_e, cx) => { this.name = this.input.value(); this.error = ""; this.refreshInfo(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    cx.spawn(async (cx) => {
      try { await this.load(); } catch (e) { this.error = String(e).replace(/^Error: /, ""); this.fatal = true; }
      this.ready = true;
      this.refreshInfo(cx);
      cx.notify();
      this.handle.focus();
      if (this.mode === "create") cx.timer.after(100, () => this.input.focus());
    });
  }

  close() { closeOverlay(props().overlay); }

  // Reads what this mode needs.
  async load() {
    const s = this.space;
    if (!s) throw new Error("That space is gone.");
    if (s.machine) { this.info = { git: null, pw: null, remote: true }; return; }
    const cwd = place(s);
    const found = (await findMeta(cwd)) ?? (s.folder !== cwd ? await findMeta(s.folder) : null);
    this.folder = props().folder ?? found?.dir ?? cwd;
    if (found) {
      this.pw = found; // { dir, meta }
      this.info = { pw: found, git: false };
    } else {
      this.info = { pw: null, git: await isGitRepo(this.folder) };
    }
    if (this.mode === "menu" && this.info.git) {
      const top = await git(this.folder, ["rev-parse", "--show-toplevel"]);
      const common = await git(this.folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      this.info.linked = top.ok && common.ok && common.out !== `${top.out}/.git`;
    }
    if (this.mode === "create") {
      if (this.info.git) throw new Error("This folder is a git repository, not a folder that contains repositories.");
      if (found) throw new Error("This Space is already a worktree group.");
      const settings = await readTextFile(join(appHome(), "settings.json")).catch(() => null);
      this.groupsRoot = join(worktreesDirFromSettings(settings, home()), "groups");
      const scan = await scanFolder(this.folder);
      this.list = scan.repos;
      this.checked = new Set(); // repos are never preselected: the user picks explicitly
      this.files = scan.files.map((f) => f.name);
      this.checkedFiles = new Set(scan.files.filter((f) => f.preselected).map((f) => f.name));
    } else if (this.mode === "edit") {
      if (!found) throw new Error("This space is not a worktree group.");
      this.groupRepos = [...found.meta.repos];
      const plan = planRepoChanges({ sourceRepos: await childRepos(found.meta.sourceParentPath), groupRepos: this.groupRepos, selected: this.groupRepos });
      this.list = plan.list;
      this.missing = new Set(plan.missing);
      this.checked = new Set(this.groupRepos); // ticked = in the group
      this.stage = "pick";
    } else if (this.mode === "sync") {
      if (!found) throw new Error("This space is not a parent worktree.");
      this.list = [...(found.meta.copied ?? [])];
    } else if (this.mode === "destroy") {
      if (!found) throw new Error("This space is not a parent worktree.");
      this.list = [...found.meta.repos];
    }
  }

  // Looks at the branch name in every repo (and the group's folder) so the dialog can warn early.
  refreshInfo(cx) {
    const mode = this.mode;
    if (!this.ready || (mode !== "create" && mode !== "edit")) return;
    const token = ++this.token;
    const create = mode === "create";
    const branch = create ? cleanBranch(this.name) : this.pw?.meta.branchName;
    const source = create ? this.folder : this.pw?.meta.sourceParentPath;
    const repos = create ? this.list : this.list.filter((n) => !this.groupRepos.includes(n) && !this.missing.has(n));
    cx.spawn(async (cx) => {
      let info = {};
      let target = null;
      if (branch && source) {
        info = await inspectRepos(source, repos, branch).catch(() => ({}));
        if (create) target = await groupTarget({ groupsRoot: this.groupsRoot, source, branch }).catch(() => null);
      }
      if (token !== this.token) return; // a newer name was typed meanwhile
      this.branchInfo = info;
      this.targetInfo = target;
      for (const r of Object.keys(info)) if (info[r].state === "in-use") this.checked.delete(r); // cannot be used
      cx.notify();
    });
  }

  // How a repo row reads for the current branch: { note, color, disabled }.
  repoNote(n) {
    const t = theme();
    const i = this.branchInfo[n];
    if (!i) return {};
    if (i.state === "in-use") return { note: `branch in use at ${i.usedAt}`, color: t.blocked, disabled: true };
    if (i.state === "existing") return { note: "branch exists: will be checked out", color: t.working };
    if (i.state === "remote") return { note: `exists on ${i.remote}: will track it`, color: t.working };
    return { note: `new branch from ${i.base}`, color: t.dim };
  }

  // ----- menu -----

  items() {
    const s = this.space;
    const i = this.info;
    const out = [["Rename", "space.rename", { id: s?.id }]];
    if (i.git) {
      out.push(["New worktree", "worktree", { space: s.id, action: "new" }], ["Open worktree", "worktree", { space: s.id, action: "open" }]);
      if (i.linked) out.push(["Remove worktree", "worktree", { space: s.id, action: "remove" }]);
    }
    if (!i.git && !i.pw && !i.remote) out.push(["Create worktree group from folder", "pw", "create"]);
    if (i.pw) {
      out.push(["Edit group repos", "pw", "edit"], ["Sync shared files", "pw", "sync"], ["Delete worktree group", "pw", "destroy"]);
    }
    out.push(["Close", "space.close", { id: s?.id }]);
    return out;
  }

  choose(i) {
    const it = this.items()[i];
    if (!it) return;
    this.close();
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else if (it[1] === "pw") {
      const tall = it[2] === "destroy" || it[2] === "sync" ? 340 : it[2] === "create" ? 640 : 480;
      openOverlay({ mod: "worktree-group", kind: "dialog", width: 480, height: tall, props: { mode: it[2], space: this.space.id, folder: this.folder } });
    } else run(it[1], it[2]);
  }

  // ----- actions -----

  go(cx) {
    if (this.busy || !this.ready) return;
    if (this.mode === "create" && !this.canCreate()) return;
    if (this.mode === "edit") {
      const plan = this.plan();
      if (plan.add.length + plan.remove.length === 0) return;
      if (this.stage === "pick") { this.stage = "review"; cx.notify(); return; } // show the summary first
    }
    if (this.mode === "sync" && this.list.length === 0) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let done = false;
      try {
        done = await this[this.mode]();
      } catch (e) {
        this.error = String(e);
        toast("Worktree failed", this.error);
      }
      this.busy = false;
      if (done) this.close();
      cx.notify();
    });
  }

  canCreate() {
    // No repo is needed (an empty group is valid), but the folder must be free and no chosen repo blocked.
    if (!cleanBranch(this.name) || this.targetInfo?.taken) return false;
    return ![...this.checked].some((r) => this.branchInfo[r]?.state === "in-use");
  }

  picked() { return this.list.filter((n) => this.checked.has(n)); }

  async create() {
    const branch = cleanBranch(this.name);
    const r = await lib.createWorktreeGroup({ groupsRoot: this.groupsRoot, source: this.folder, branch, repos: this.picked(), files: this.files.filter((f) => this.checkedFiles.has(f)) });
    if (r.copyFailures.length) toast("Some parent files were not copied", r.copyFailures.join("\n"), "warning");
    run("space.new", { name: `${base(trimSlash(this.folder))} · ${branch}`, folder: r.target, focus: true });
    toast("Worktree group created", r.repos.length ? `${r.repos.length} repo${r.repos.length === 1 ? "" : "s"} on ${branch}` : `No repos yet. Use “Add repos to group” (branch ${branch}).`, "success");
    return true;
  }

  plan() {
    return planRepoChanges({ sourceRepos: this.list.filter((n) => !this.missing?.has(n)), groupRepos: this.groupRepos ?? [], selected: [...this.checked] });
  }

  async edit() {
    const plan = this.plan();
    const r = await lib.applyRepoChanges({ ...this.pw, add: plan.add, remove: plan.remove, force: this.force });
    if (r.failures.length) {
      const dirty = !this.force && r.failures.some((f) => /modified|untracked|--force/.test(f));
      toast("Some changes could not be applied", r.failures.join("\n") + (dirty ? "\nUncommitted changes: tick “Force” to discard them." : ""));
    }
    if (r.removed.length) toast("Repos removed from group", r.removed.join(", "), "success");
    if (r.added.length) toast("Repos added to group", r.added.join(", "), "success");
    return r.failures.length === 0 || r.added.length + r.removed.length > 0;
  }

  async sync() {
    const { copied, failures } = await lib.syncGroupFiles(this.pw);
    if (failures.length) toast("Some files were not synced", failures.join("\n"));
    if (copied.length) toast("Shared files synced", copied.join(", "), "success");
    return failures.length === 0;
  }

  async destroy() {
    const r = await lib.destroyWorktreeGroup({ ...this.pw, force: this.force });
    if (!r.ok) {
      toast("Worktree group not removed", r.failures.join("\n") + (this.force ? "" : "\nTick “Force” to discard uncommitted changes."));
      return false;
    }
    if (r.folderKept) toast("Folder kept", `${this.pw.dir} still has other files, so it was not deleted.`, "warning");
    run("space.close", { id: this.space.id, confirmed: true });
    toast("Worktree group deleted", `Branch ${this.pw.meta.branchName} was left in the source repos.`, "success");
    return true;
  }

  // ----- drawing -----

  button(id, label, bg, fg, enabled, onClick) {
    const t = theme();
    return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "pw-cancel" ? t.input : bg).bg(bg).text_color(fg)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .when(!enabled, (el) => el.opacity(0.4))
      .child(label);
  }

  check(id, label, on, onToggle, o = {}) {
    const t = theme();
    return h_flex().id(id).h(o.note ? 40 : 30).px(8).gap(9).items_center().rounded(6)
      .when(!o.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onToggle(); cx.notify(); }))
      .when(o.disabled, (el) => el.opacity(0.55))
      .child(div().w(16).h(16).rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).flex_none().items_center().justify_center()
        .text_size(11).text_color(t.accent_foreground).child(on ? "✓" : ""))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(label))
        .when(!!o.note, (el) => el.child(div().text_size(10.5).truncate().text_color(o.color ?? t.dim).child(o.note))));
  }

  renderMenu(cx) {
    const t = theme();
    const list = this.items();
    const icon = (it) => {
      const c = it[1];
      const n = c.endsWith(".close") ? "x" : c.endsWith(".rename") ? "square-pen" : c === "worktree" || c === "pw" ? "git-branch" : "terminal";
      return `mods/workspace-chrome/${n}.svg`;
    };
    return v_flex().id("pw-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") this.close();
        else return;
        cx.notify();
      })
      .children(list.map((it, i) =>
        v_flex()
          .when(it[1] === "space.close", (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
          .child(h_flex().id(`pw-mi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.choose(i))
            .child(svg(icon(it)).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().truncate().child(it[0])))));
  }

  // A labelled, scrollable list of checkboxes.
  section(id, title, names, set, grow, label = (n) => n, note = () => ({})) {
    const t = theme();
    return v_flex().gap(4).when(grow, (el) => el.flex_1()).min_h(0)
      .child(div().text_size(11).text_color(t.muted).child(title))
      .child(div().id(`${id}-list`).when(grow, (el) => el.flex_1()).min_h(0).max_h(grow ? 9999 : 150).overflow_y_scrollbar().rounded(6).border_1().border_color(t.border).p(3)
        .children(names.length
          ? names.map((n) => this.check(`${id}-${n}`, label(n), set.has(n), () => { if (set.has(n)) set.delete(n); else set.add(n); }, note(n)))
          : [div().px(8).py(6).text_size(12).text_color(t.dim).child("None")]));
  }

  render(cx) {
    if (this.mode === "menu") return this.renderMenu(cx);
    const t = theme();
    const titles = { create: "Create worktree group", edit: "Edit group repos", sync: "Sync shared files", destroy: "Delete worktree group?" };
    const destroy = this.mode === "destroy";
    const create = this.mode === "create";
    const edit = this.mode === "edit";
    const plan = edit && this.ready ? this.plan() : { add: [], remove: [] };
    const review = edit && this.stage === "review";
    const valid = !this.busy && this.ready && !this.fatal &&
      (create ? this.canCreate() : this.mode === "sync" ? this.list.length > 0 : destroy ? true : plan.add.length + plan.remove.length > 0);
    const confirmLabel = this.busy ? "Working…" : { create: "Create", edit: review ? "Confirm and apply" : "Review changes…", sync: "Sync and overwrite", destroy: "Delete group" }[this.mode];
    const sub = create ? this.folder : this.pw?.dir;
    const target = create && cleanBranch(this.name) ? this.targetInfo?.target ?? null : null;
    const reused = create ? [...this.checked].filter((r) => ["existing", "remote"].includes(this.branchInfo[r]?.state)) : [];

    return v_flex().id("pw-dialog").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).rounded(8).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") this.close(); else return; cx.stop_propagation(); })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(titles[this.mode]))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(11).text_color(t.dim).truncate().child(sub ?? ""))
      .when(destroy && this.ready && this.pw, (el) => el.child(div().text_color(t.muted).child(
        `This removes every repo worktree in ${this.pw.dir} (${this.list.join(", ") || "none"}), deletes the copied files (${(this.pw.meta.copied ?? []).join(", ") || "none"}) and ${META}, and closes this Space. The branch ${this.pw.meta.branchName} stays in the source repos. Uncommitted work in those worktrees is lost if you force.`)))
      .when(this.mode === "sync" && this.ready && this.pw, (el) => el.child(div().text_color(t.muted).child(
        this.list.length
          ? `Copies these again from ${this.pw.meta.sourceParentPath}: ${this.list.join(", ")}. Files with the same name here are overwritten, so local edits to them are lost. Nothing is deleted.`
          : "This group has no shared files to sync.")))
      .when(create, (el) => el.child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1)
        .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground)))
      .when(create && target, (el) => el.child(div().text_size(11).text_color(this.targetInfo?.taken ? t.blocked : t.dim).truncate().child(this.targetInfo?.taken ? `A group with this name already exists: ${target}` : `→ ${target}`)))
      .when(create && this.ready && !cleanBranch(this.name), (el) => el.child(div().text_size(11).text_color(t.muted).child(this.name.trim() ? "Not a valid branch name (use letters, digits, - _ . /)." : "Enter a name for the group; it is also used as the branch name.")))
      .when(create && !this.ready, (el) => el.child(div().text_size(11).text_color(t.muted).child("Looking…")))
      .when(create && this.ready, (el) => el.child(this.section("pw-r", "Repositories (none selected by default)", this.list, this.checked, true, (n) => n, (n) => this.repoNote(n))))
      .when(create && this.ready, (el) => el.child(this.section("pw-f", "Files and folders to copy (kept in sync on request)", this.files, this.checkedFiles, true)))
      .when(reused.length > 0, (el) => el.child(div().text_size(11).text_color(t.working).child(`${reused.length} of ${this.checked.size} selected repos will reuse an existing branch (${reused.join(", ")}).`)))
      .when(create && this.ready && this.checked.size === 0, (el) => el.child(div().text_size(11).text_color(t.muted).child("No repositories selected: this creates a group with only the chosen files. Add repos later from the Space menu.")))
      .when(edit && !this.ready, (el) => el.child(div().text_size(11).text_color(t.muted).child("Looking…")))
      .when(edit && this.ready && !review, (el) => el.child(this.section("pw-r", "Repositories: tick to keep in or add to the group, untick to remove", this.list, this.checked, true, (n) => (this.missing.has(n) ? `${n} (missing in source)` : n), (n) => (this.groupRepos.includes(n) ? {} : this.repoNote(n)))))
      .when(edit && this.ready && !review && this.list.length === 0, (el) => el.child(div().text_size(11).text_color(t.muted).child("No repositories found in the source folder.")))
      .when(edit && this.ready && !review, (el) => el.child(div().text_size(11).text_color(plan.remove.length ? t.blocked : t.muted).truncate().child(
        plan.add.length + plan.remove.length === 0 ? "No changes yet." : `Will add: ${plan.add.join(", ") || "none"}.  Will remove: ${plan.remove.join(", ") || "none"}.`)))
      .when(review, (el) => el.child(v_flex().gap(8).flex_1().min_h(0)
        .child(div().text_color(t.muted).child("Please check what will happen:"))
        .child(div().text_color(t.foreground).child(plan.add.length ? `Add worktrees on branch ${this.pw.meta.branchName}: ${plan.add.join(", ")}` : "Add: nothing"))
        .child(div().text_color(plan.remove.length ? t.blocked : t.foreground).child(plan.remove.length ? `Remove worktrees (their folders in the group are deleted): ${plan.remove.join(", ")}` : "Remove: nothing"))
        .when(plan.remove.length > 0 && plan.remove.length === this.groupRepos.length, (e2) => e2.child(div().text_size(11).text_color(t.muted).child("This removes every repo. The group stays (empty); use “Delete worktree group” to remove it.")))))
      .when((review && plan.remove.length > 0) || destroy, (el) => el.child(this.check("pw-force", "Force (discard uncommitted changes)", this.force, () => { this.force = !this.force; })))
      .when(!!this.error, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .when(review, (el) => el.child(this.button("pw-back", "Back", t.raised, t.foreground, true, (_e, cx) => { this.stage = "pick"; cx.notify(); })))
        .child(this.button("pw-cancel", "Cancel", t.raised, t.foreground, true, () => this.close()))
        .child(this.button("pw-ok", confirmLabel, destroy ? t.blocked : t.solid, destroy ? t.background : t.solid_foreground, valid, (_e, cx) => this.go(cx))));
  }
}
