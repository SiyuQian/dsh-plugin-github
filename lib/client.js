window.__ModuleLoader__.load({ id: "dsh-plugin-github", factory: (require) => {
var module = { exports: {} };
const React = require("react");
const { Tooltip, Menu, Modal, Button, Checkbox, IconBranchOutlineRegular, IconRefreshOutlineRegular, IconChevronDownOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
const h = React.createElement;

const NS = "createPr";
const METHOD = "github.preflight";
const REPOS_METHOD = "github.repos";
const SESSION_STATUS_METHOD = "github.sessionPr";
const SKILL = "pr-creator";
const PROMPTS_METHOD = "github.prompts";
const SKILLS_METHOD = "github.missingSkills";
/** The session-list projection key the Host publishes each session's PR URLs under. */
const LINK_KEY = "githubPrLinks";

const zh = {
	button: "创建 PR",
	update: "更新 PR",
	hint: "用 /pr-creator 为当前分支创建或更新 PR",
	missingSkill: "需要安装提供 {names} 的插件",
	busy: "Agent 正在运行，请等它停下后再创建 PR",
	notRepo: "当前会话目录不是 git 仓库，无法创建 PR",
	nothing: "{branch} 相对 {base} 没有新提交，也没有未提交的改动，没有可创建 PR 的内容",
	failed: "无法发起创建 PR：{reason}",
	prompt: "/pr-creator 为当前分支创建 PR（如果已有 PR 就更新它）。",
	linkHint: "在浏览器中打开 PR #{number}（{state}）：{title}",
	"state.open": "开启",
	"state.draft": "草稿",
	"state.merged": "已合并",
	"state.closed": "已关闭",
	"links.more": "这个会话关联的 {n} 个 PR，点击查看全部",
	"links.heading": "这个会话关联的 {n} 个 PR",
	"links.latest": "最新",
	"links.open": "打开",
	"hover.heading": "关联的 PR",
	noChanges: "这个目录下的 {n} 个仓库都没有新提交或未提交的改动，没有可创建 PR 的内容",
	"picker.title": "选择要创建 PR 的仓库",
	"picker.description": "{root} 下有 {total} 个仓库，其中 {changed} 个有新提交或未提交的改动。默认勾选这个会话里动过的仓库。",
	"picker.ahead": "{n} 个新提交",
	"picker.dirty": "{n} 个文件未提交",
	"picker.hasPr": "已有 PR #{number}",
	"picker.worktree": "worktree",
	"picker.touched": "本会话动过",
	"picker.noChange": "没有改动，不能选：{names}",
	"picker.cancel": "取消",
	"picker.confirm": "为 {n} 个仓库创建 PR",
	"picker.none": "先勾选至少一个仓库",
	"picker.loading": "正在检查各个仓库…",
	multiPrompt: "/pr-creator 下面 {n} 个仓库都在当前会话目录 `{root}` 下。请依次为每个仓库创建 PR（如果这个分支已有 PR 就更新它）：先进入那个仓库的目录，按 pr-creator 完整走一遍，再处理下一个。\n\n{list}\n\n全部完成后，列出每个仓库的 PR 链接；没能完成的仓库写明原因。"
};
const en = {
	button: "Create PR",
	update: "Update PR",
	hint: "Create or update a pull request for this branch with /pr-creator",
	missingSkill: "Install a plugin that provides {names}",
	busy: "The agent is still running. Create the PR once it stops.",
	notRepo: "This session's folder is not a git repository, so there is nothing to open a PR from.",
	nothing: "{branch} has no commits ahead of {base} and no uncommitted changes, so there is nothing to put in a PR.",
	failed: "Could not start the PR: {reason}",
	prompt: "/pr-creator Create a pull request for the current branch (or update the existing one).",
	linkHint: "Open PR #{number} ({state}) in the browser: {title}",
	"state.open": "open",
	"state.draft": "draft",
	"state.merged": "merged",
	"state.closed": "closed",
	"links.more": "This session is linked to {n} PRs; click to see them all",
	"links.heading": "{n} PRs linked to this session",
	"links.latest": "latest",
	"links.open": "Open",
	"hover.heading": "Linked PRs",
	noChanges: "None of the {n} repositories in this folder has new commits or uncommitted changes, so there is nothing to put in a PR.",
	"picker.title": "Choose repositories to open PRs for",
	"picker.description": "{root} holds {total} repositories; {changed} have new commits or uncommitted changes. Repositories this session worked in are ticked.",
	"picker.ahead": "{n} new commits",
	"picker.dirty": "{n} uncommitted files",
	"picker.hasPr": "PR #{number} exists",
	"picker.worktree": "worktree",
	"picker.touched": "used in this session",
	"picker.noChange": "No changes, cannot be chosen: {names}",
	"picker.cancel": "Cancel",
	"picker.confirm": "Create PRs for {n} repositories",
	"picker.none": "Tick at least one repository",
	"picker.loading": "Checking the repositories…",
	multiPrompt: "/pr-creator The {n} repositories below are under this session's folder `{root}`. Create a pull request for each one in turn (or update the branch's existing PR): change into that repository's folder, run pr-creator fully, then move to the next.\n\n{list}\n\nWhen all are done, list each repository's PR link; for any you could not finish, say why."
};

// ---------------------------------------------------------------------------
// PR status, per session

/** Same PRs in the same order and states: no new snapshot, no re-render. */
function samePrs(a = [], b = []) {
	return a.length === b.length && a.every((pr, i) => pr.url === b[i].url && pr.state === b[i].state && pr.title === b[i].title);
}

/**
 * Minimal observable map: key (session id) -> { pr, prs, at }. `prs` is every
 * linked PR, most recent first; `pr` is `prs[0]` or null.
 */
function createStatusStore(fetchStatus, now = () => Date.now()) {
	let state = {};
	const listeners = new Set();
	const inflight = new Map();
	const set = (key, entry) => {
		state = { ...state, [key]: entry };
		for (const listener of [...listeners]) listener();
	};
	return {
		getSnapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Refresh one key unless a lookup is already running or the last one is younger than `maxAgeMs`. */
		refresh(key, maxAgeMs = 0) {
			if (!key) return Promise.resolve();
			const last = state[key];
			if (last !== undefined && now() - last.at < maxAgeMs) return Promise.resolve();
			const running = inflight.get(key);
			if (running !== undefined) return running;
			const job = fetchStatus(key).then((result) => {
				// Older callers resolved a single PR (or null); accept both shapes.
				const prs = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
				if (last === undefined || !samePrs(state[key]?.prs, prs)) set(key, { pr: prs[0] ?? null, prs, at: now() });
				else state[key].at = now();
			}, (error) => {
				// Keep showing the last known links; a failed lookup is not "no PR".
				console.warn("github: status lookup failed:", error);
			}).finally(() => inflight.delete(key));
			inflight.set(key, job);
			return job;
		}
	};
}

/**
 * The PRs for one session: only those the session itself is linked to (you
 * pasted their URLs, or the agent created them with gh/glab), most recent
 * first. There is no fallback to the folder's current branch: a new session in
 * a checkout that happens to sit on an old branch must not show that branch's
 * PR. The Host also retitles the session after the most recent one.
 * @returns {Promise<Array<{number, url, state, title, repo}>>}
 */
async function fetchPrStatus(ctx, sessionId) {
	const result = await ctx.get("connection").rpc.call("/api", SESSION_STATUS_METHOD, { sessionId });
	if (!result?.ok) throw new Error(result?.error?.message ?? "status lookup failed");
	const value = result.value;
	if (Array.isArray(value.prs)) return value.prs;
	return value.pr ? [value.pr] : [];
}

/**
 * Ask the Host for the folder's git state. A failed check never blocks: the
 * skill does its own authoritative preflight, so we only use this to stop early
 * on the two cases that obviously cannot produce a PR.
 * @returns {Promise<{kind: "send"} | {kind: "stop", key: string, params?: object}>}
 */
async function precheck(ctx, cwd) {
	if (!cwd) return { kind: "send" };
	let result;
	try {
		result = await ctx.get("connection").rpc.call("/api", METHOD, { cwd });
	} catch (error) {
		console.warn("github: preflight unavailable, sending anyway:", error);
		return { kind: "send" };
	}
	if (!result?.ok) return { kind: "send" };
	const state = result.value;
	if (state.status === "not-a-repo") return { kind: "multi" };
	if (state.ahead === 0 && state.dirty === 0) {
		return { kind: "stop", key: "nothing", params: { branch: state.branch, base: state.base ?? "origin" } };
	}
	return { kind: "send" };
}

/** Child repos of a non-repo session folder, with their local state; see `scanRepos` on the Host. */
async function scanRepos(ctx, cwd, sessionId) {
	const result = await ctx.get("connection").rpc.call("/api", REPOS_METHOD, { cwd, sessionId });
	if (!result?.ok) throw new Error(result?.error?.message ?? "could not scan the repositories");
	return result.value;
}

/** Which repos start ticked: those this session worked in that have changes. */
function defaultSelection(repos) {
	return repos.filter((r) => r.changed && r.touched).map((r) => r.name);
}

/** Replace `{key}` with params[key]; unknown placeholders stay as they are. */
function fill(template, params = {}) {
	return template.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(params, key) ? String(params[key]) : all));
}

/** The message for several repos: one /pr-creator run per listed repo, in order. A non-empty `template` (plugin config) replaces the built-in text. */
function multiPrompt(t, root, repos, template = "") {
	const list = repos.map((r, i) => `${i + 1}. \`${r.name}\` (\`${r.path}\`, ${r.branch})${r.pr ? `: PR #${r.pr.number}` : ""}`).join("\n");
	const params = { n: repos.length, root, list };
	return template ? fill(template, params) : t("multiPrompt", params);
}

/** The configured create-PR templates; empty or unreadable means the built-in text. */
async function configuredPrompts(ctx) {
	try {
		const result = await ctx.get("connection").rpc.call("/api", PROMPTS_METHOD, {});
		return result?.ok && result.value ? result.value : {};
	} catch {
		return {};
	}
}

/**
 * The leading `/name` skills of `text` this session cannot load, per the
 * Host's session skill catalog. Unknown (no catalog, failed lookup) is [], so a
 * failed check never blocks sending.
 */
async function missingSkills(ctx, sessionId, text) {
	try {
		const result = await ctx.get("connection").rpc.call("/api", SKILLS_METHOD, { sessionId, text });
		const missing = result?.ok ? result.value?.missing : null;
		return Array.isArray(missing) ? missing : [];
	} catch {
		return [];
	}
}

function missingText(t, missing) {
	return t("missingSkill", { names: missing.map((n) => `/${n}`).join(" ") });
}

async function send(ctx, sessionId, text) {
	const scoped = ctx.get("sessions").scope(sessionId);
	const conversation = scoped?.get("conversation");
	if (conversation === undefined) throw new Error(`session ${sessionId} is not open`);
	await conversation.send(text);
}

/**
 * The whole button action. The prompt carries a `/pr-creator` token, which the
 * Host's skill tool turns into the skill's full instructions for this turn, so
 * the agent does not have to find and load the skill itself.
 *
 * A session folder that is not itself a repo but holds several (a multi-repo
 * workspace) is scanned: no repo with changes stops with a notice, exactly
 * one goes straight ahead, more than one asks `choose(scan)` for the repos to
 * use (a picker; it resolves to the chosen names, or null when cancelled).
 */
async function createPr(ctx, sessionId, t, choose = async () => null) {
	const cwd = ctx.get("sessions").list.getSnapshot().byId[sessionId]?.cwd;
	const check = await precheck(ctx, cwd);
	if (check.kind === "stop") return { kind: "stop", text: t(check.key, check.params) };
	if (check.kind === "multi") {
		const scan = await scanRepos(ctx, cwd, sessionId);
		const changed = scan.repos.filter((r) => r.changed);
		if (scan.repos.length === 0) return { kind: "stop", text: t("notRepo") };
		if (changed.length === 0) return { kind: "stop", text: t("noChanges", { n: scan.repos.length }) };
		const names = changed.length === 1 ? [changed[0].name] : await choose(scan);
		if (names === null || names.length === 0) return { kind: "cancelled" };
		const chosen = changed.filter((r) => names.includes(r.name));
		const text = multiPrompt(t, scan.root, chosen, (await configuredPrompts(ctx)).multiRepoCreatePrPrompt);
		const missing = await missingSkills(ctx, sessionId, text);
		if (missing.length > 0) return { kind: "stop", text: missingText(t, missing) };
		await send(ctx, sessionId, text);
		return { kind: "sent", repos: chosen.map((r) => r.name) };
	}
	const text = (await configuredPrompts(ctx)).createPrPrompt || t("prompt");
	const missing = await missingSkills(ctx, sessionId, text);
	if (missing.length > 0) return { kind: "stop", text: missingText(t, missing) };
	await send(ctx, sessionId, text);
	return { kind: "sent" };
}

/** Show a notice in the session's composer, falling back to an alert outside one. */
function notify(ctx, sessionId, level, text) {
	try {
		const scoped = ctx.get("sessions").scope(sessionId);
		const conversation = scoped?.get("conversation");
		if (conversation !== undefined) {
			conversation.input.for(scoped).notify(level, text);
			return;
		}
	} catch (error) {
		console.warn("github: notice failed:", error);
	}
	window.alert(text);
}

/** The composer slot to the left of the model selector. */
const SLOT = "conversation.input.right";

/**
 * Styled to match the composer's own text chips (the permission selector's
 * trigger): borderless, 28px high, secondary label colour, hover wash. The
 * label hides on a narrow composer, as the permission chip's does.
 */
const CSS_ID = "dsh-plugin-github/composer.css";
const CSS = [
	".dsh-create-pr{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;display:inline-flex}",
	".dsh-create-pr:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-create-pr:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-create-pr:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
	".dsh-create-pr svg{width:14px;height:14px;flex:none}",
	"@container (width<=460px){.dsh-create-pr-label{display:none}}",
	".dsh-create-pr-group{display:inline-flex;align-items:center;gap:2px;min-width:0}",
	".dsh-create-pr-link{box-sizing:border-box;border:0;background:0 0;font:inherit;cursor:pointer;border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);text-decoration:none;align-items:center;gap:5px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;display:inline-flex}",
	".dsh-create-pr-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".dsh-create-pr-link:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-create-pr-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}",
	".dsh-create-pr-dot[data-state=draft]{background:var(--dsw-alias-label-tertiary)}",
	".dsh-create-pr-dot[data-state=merged]{background:#8957e5}",
	".dsh-create-pr-dot[data-state=closed]{background:var(--dsw-alias-state-error-primary)}",
	/* "+N ▾" on the PR chip when a session has several PRs */
	".dsh-create-pr-more{color:var(--dsw-alias-label-caption);font-weight:400}",
	".dsh-create-pr-caret{width:12px;height:12px;opacity:.7;flex:none}",
	/* rows inside the PR menu */
	".dsh-create-pr-item{display:flex;flex-direction:column;min-width:0;max-width:340px;line-height:18px}",
	".dsh-create-pr-item-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}",
	".dsh-create-pr-item-sub{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
	/* sidebar hover card */
	".dsh-create-pr-hover{display:flex;flex-direction:column;gap:2px;margin:6px 0 2px}",
	".dsh-create-pr-hover-head{font-size:11px;color:var(--dsw-alias-label-caption)}",
	".dsh-create-pr-hover-row{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}",
	".dsh-create-pr-hover-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	/* repo picker */
	".dsh-create-pr-picker{display:flex;flex-direction:column;gap:2px;max-height:min(52vh,420px);overflow:auto;margin:4px -8px 0;padding:0 8px}",
	".dsh-create-pr-repo{display:flex;align-items:flex-start;gap:10px;padding:7px 8px;border-radius:10px}",
	".dsh-create-pr-repo:hover{background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-create-pr-repo>label{flex:none;margin-top:1px}",
	".dsh-create-pr-repo-body{flex:1;min-width:0;cursor:pointer}",
	".dsh-create-pr-repo-name{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;line-height:20px;flex-wrap:wrap}",
	".dsh-create-pr-repo-sub{font-size:12px;color:var(--dsw-alias-label-caption);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-create-pr-tag{font-size:11px;font-weight:400;line-height:16px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
	".dsh-create-pr-tag[data-kind=touched]{color:var(--dsw-alias-state-success-primary)}",
	".dsh-create-pr-muted{font-size:12px;color:var(--dsw-alias-label-caption);padding:8px 8px 0;line-height:18px}"
].join("");

function injectCss() {
	if (typeof document === "undefined") return () => {};
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-plugin-github";
	tag.dataset.pluginCss = CSS_ID;
	tag.textContent = CSS;
	document.head.appendChild(tag);
	return () => tag.remove();
}

/** Keep the caret in the composer when the button is pressed, as the composer's own buttons do. */
const keepFocus = (event) => event.preventDefault();

/**
 * A plain https anchor. In the desktop app a target=_blank link is denied as a
 * new window and handed to the OS default browser (shell.openExternal); in
 * the web GUI it opens a new tab.
 */
function PrLink({ pr, t }) {
	const stateLabel = t(`state.${pr.state}`);
	return h(Tooltip, { label: t("linkHint", { number: pr.number, state: stateLabel, title: pr.title }), side: "top", delayMs: 300, portal: true, maxWidth: 360 },
		h("a", {
			className: "dsh-create-pr-link",
			href: pr.url,
			target: "_blank",
			rel: "noopener noreferrer",
			"aria-label": t("linkHint", { number: pr.number, state: stateLabel, title: pr.title }),
			onMouseDown: keepFocus
		}, h("span", { className: "dsh-create-pr-dot", "data-state": pr.state, "aria-hidden": "true" }), `#${pr.number}`));
}

/** Open a PR in the OS default browser (the desktop app hands `_blank` https windows to it). */
function openExternal(url) {
	window.open?.(url, "_blank", "noopener,noreferrer");
}

/**
 * Several linked PRs: the most recent one with "+N ▾"; clicking lists them
 * all (most recent first), and choosing one opens it in the browser.
 */
function PrLinks({ prs, t }) {
	const [open, setOpen] = React.useState(false);
	const latest = prs[0];
	const items = [
		{ kind: "label", id: "head", text: t("links.heading", { n: prs.length }) },
		...prs.map((pr, i) => ({
			id: pr.url,
			icon: h("span", { className: "dsh-create-pr-dot", "data-state": pr.state, "aria-hidden": "true" }),
			label: h("span", { className: "dsh-create-pr-item" },
				h("span", { className: "dsh-create-pr-item-title" }, `#${pr.number} ${pr.title}`),
				h("span", { className: "dsh-create-pr-item-sub" }, [pr.repo, t(`state.${pr.state}`), i === 0 ? t("links.latest") : null].filter(Boolean).join(" · ")))
		}))
	];
	return h(Menu, {
		open,
		align: "end",
		side: "top",
		portal: true,
		items,
		onClose: () => setOpen(false),
		onSelect: (url) => {
			setOpen(false);
			openExternal(url);
		},
		anchor: h(Tooltip, { label: t("links.more", { n: prs.length }), side: "top", delayMs: 300, portal: true },
			h("button", {
				type: "button",
				className: "dsh-create-pr-link",
				"aria-haspopup": "menu",
				"aria-expanded": open,
				"aria-label": t("links.more", { n: prs.length }),
				onMouseDown: keepFocus,
				onClick: () => setOpen((v) => !v)
			},
			h("span", { className: "dsh-create-pr-dot", "data-state": latest.state, "aria-hidden": "true" }),
			`#${latest.number}`,
			h("span", { className: "dsh-create-pr-more" }, `+${prs.length - 1}`),
			h(IconChevronDownOutlineRegular, { className: "dsh-create-pr-caret" })))
	});
}

/**
 * The Create PR picker for a multi-repo folder. Lists every repo with
 * changes; repos without changes are named in one line and cannot be chosen.
 */
function RepoPicker({ scan, t, onCancel, onConfirm }) {
	const changed = scan.repos.filter((r) => r.changed);
	const unchanged = scan.repos.filter((r) => !r.changed);
	const [selected, setSelected] = React.useState(() => new Set(defaultSelection(scan.repos)));
	const toggle = (name, on) => setSelected((prev) => {
		const next = new Set(prev);
		if (on) next.add(name);
		else next.delete(name);
		return next;
	});
	const folder = scan.root.split(/[\\/]/).filter(Boolean).pop() ?? scan.root;
	// Touched repos first, then the rest; both alphabetical (the scan already is).
	const ordered = [...changed.filter((r) => r.touched), ...changed.filter((r) => !r.touched)];
	return h(Modal, {
		open: true,
		onClose: onCancel,
		title: t("picker.title"),
		closeLabel: t("picker.cancel"),
		description: t("picker.description", { root: folder, total: scan.repos.length, changed: changed.length }),
		footer: h(React.Fragment, null,
			h(Button, { variant: "outline", onClick: onCancel }, t("picker.cancel")),
			h(Button, { variant: "primary", disabled: selected.size === 0, title: selected.size === 0 ? t("picker.none") : undefined, onClick: () => onConfirm(ordered.filter((r) => selected.has(r.name)).map((r) => r.name)) },
				t("picker.confirm", { n: selected.size })))
	},
	h("div", { className: "dsh-create-pr-picker", role: "group", "aria-label": t("picker.title") },
		...ordered.map((repo) => {
			const facts = [repo.branch];
			if (repo.ahead > 0) facts.push(t("picker.ahead", { n: repo.ahead }));
			if (repo.dirty > 0) facts.push(t("picker.dirty", { n: repo.dirty }));
			return h("div", { key: repo.name, className: "dsh-create-pr-repo" },
				h(Checkbox, { checked: selected.has(repo.name), onChange: (on) => toggle(repo.name, on), label: "", title: repo.name }),
				h("div", { className: "dsh-create-pr-repo-body", onClick: () => toggle(repo.name, !selected.has(repo.name)) },
					h("div", { className: "dsh-create-pr-repo-name" },
						repo.name,
						repo.touched ? h("span", { className: "dsh-create-pr-tag", "data-kind": "touched" }, t("picker.touched")) : null,
						repo.pr ? h("span", { className: "dsh-create-pr-tag" }, t("picker.hasPr", { number: repo.pr.number })) : null,
						repo.worktree ? h("span", { className: "dsh-create-pr-tag" }, t("picker.worktree")) : null),
					h("div", { className: "dsh-create-pr-repo-sub", title: facts.join(" · ") }, facts.join(" · "))));
		}),
		unchanged.length > 0 ? h("div", { className: "dsh-create-pr-muted" }, t("picker.noChange", { names: unchanged.map((r) => r.name).join("、") })) : null));
}

function CreatePrAction({ sessionId, useSession, useSessions, usePrStatus, refreshStatus, run, t }) {
	const running = useSession((s) => s.running);
	const subagent = useSessions((state) => state.byId[sessionId]?.origin === "subagent");
	const prs = usePrStatus((state) => state[sessionId]?.prs ?? (state[sessionId]?.pr ? [state[sessionId].pr] : NO_PRS));
	const [pending, setPending] = React.useState(false);
	const [picking, setPicking] = React.useState(null); // { scan, resolve } while the repo picker is open
	// Look up on open, and again whenever a turn ends: the agent may just have opened, merged, or closed one.
	React.useEffect(() => {
		if (!subagent && !running) refreshStatus(sessionId, 0);
	}, [sessionId, running, subagent]);
	if (subagent) return null;
	const pr = prs[0] ?? null;
	const label = pr !== null && (pr.state === "open" || pr.state === "draft") ? t("update") : t("button");
	const choose = (scan) => new Promise((resolve) => setPicking({ scan, resolve }));
	const settle = (names) => {
		picking?.resolve(names);
		setPicking(null);
	};
	return h("span", { className: "dsh-create-pr-group" },
		prs.length > 1 ? h(PrLinks, { prs, t }) : pr !== null ? h(PrLink, { pr, t }) : null,
		h(Tooltip, { label: running ? t("busy") : t("hint"), side: "top", delayMs: 500, portal: true },
			h("button", {
				type: "button",
				className: "dsh-create-pr",
				disabled: pending || running,
				"aria-label": label,
				"aria-busy": pending,
				onMouseDown: keepFocus,
				onClick: () => {
					setPending(true);
					run(sessionId, choose).finally(() => setPending(false));
				}
			}, h(IconBranchOutlineRegular, { size: 14 }), h("span", { className: "dsh-create-pr-label" }, label))),
		picking !== null ? h(RepoPicker, { scan: picking.scan, t, onCancel: () => settle(null), onConfirm: (names) => settle(names) }) : null);
}

const NO_PRS = [];

/**
 * Sidebar hover card section: every PR the session is linked to, read from
 * the Host's session-list projection, so it works for sessions never opened
 * in this window. Status dots appear once this window has looked them up.
 */
function SessionPrsHover({ sessionId, useSessions, usePrStatus, t }) {
	const urls = useSessions((state) => state.byId[sessionId]?.projectionValues?.[LINK_KEY] ?? NO_PRS);
	const known = usePrStatus((state) => state[sessionId]?.prs ?? NO_PRS);
	if (!Array.isArray(urls) || urls.length === 0) return null;
	const byUrl = new Map(known.map((pr) => [pr.url, pr]));
	return h("div", { className: "dsh-create-pr-hover" },
		h("span", { className: "dsh-create-pr-hover-head" }, t("hover.heading")),
		...urls.map((url) => {
			const pr = byUrl.get(url);
			const m = /^https:\/\/[^/]+\/(.+?)\/(?:pull|-\/merge_requests)\/(\d+)/.exec(url);
			const repo = m ? m[1].split("/").pop() : url;
			const text = pr ? `${repo}#${pr.number} · ${t(`state.${pr.state}`)}` : `${repo}#${m ? m[2] : "?"}`;
			return h("span", { key: url, className: "dsh-create-pr-hover-row", title: pr?.title ?? url },
				h("span", { className: "dsh-create-pr-dot", "data-state": pr?.state ?? "draft", "aria-hidden": "true" }),
				h("span", null, text));
		}));
}

// ---------------------------------------------------------------------------
// GitHub tab: a sidebar entry (beside 插件 / 自动化任务) and its main page.

const PANEL_ID = "github";
const PAGE_NS = "github";
const INBOX_METHOD = "github.inbox";
const STALE_MS = 60000;

const pageZh = {
	panel: "GitHub",
	title: "GitHub",
	"tab.mine": "我的 PR",
	"tab.review": "待我审查",
	"owner.all": "全部",
	refresh: "刷新",
	loading: "正在从 GitHub 读取…",
	updated: "{time} 更新 · {login}",
	shown: "显示最近更新的 {shown} 个，共 {total} 个",
	"empty.mine": "你没有打开中的 PR。",
	"empty.review": "没有等你审查的 PR。",
	"empty.filter": "这个组织下没有 PR。",
	"error.gh-missing": "没有找到 gh。请安装 GitHub CLI 后运行 gh auth login。",
	"error.gh-auth": "gh 还没有登录。请在终端运行 gh auth login。",
	"error.gh-failed": "读取 GitHub 失败：{message}",
	"error.rpc": "读取 GitHub 失败：{message}",
	"state.draft": "草稿",
	"checks.success": "检查通过",
	"checks.failure": "检查失败",
	"checks.pending": "检查进行中",
	"review.approved": "已批准",
	"review.changes": "需要修改",
	"review.required": "待审查",
	open: "在浏览器中打开 {repo}#{number}",
	"ago.now": "刚刚",
	"ago.m": "{n} 分钟前",
	"ago.h": "{n} 小时前",
	"ago.d": "{n} 天前",
	"action.explain": "解读",
	"action.review": "审查",
	"action.explainHint": "新开一个会话，用中文解读这个 PR（只读，不会发到 GitHub）",
	"action.reviewHint": "新开一个会话：先用中文解读，再用 /pr-review 审查，并把评审发布到 GitHub",
	"action.preparing": "准备代码…",
	"action.openReview": "审查中",
	"action.openExplain": "解读过",
	"action.openHint": "这个 PR 已经有一个会话，点击回到那个会话",
	"action.failed": "无法开始：{message}"
};
const pageEn = {
	panel: "GitHub",
	title: "GitHub",
	"tab.mine": "My PRs",
	"tab.review": "Review requested",
	"owner.all": "All",
	refresh: "Refresh",
	loading: "Reading from GitHub…",
	updated: "Updated {time} · {login}",
	shown: "Showing the {shown} most recently updated of {total}",
	"empty.mine": "You have no open pull requests.",
	"empty.review": "Nobody is waiting on your review.",
	"empty.filter": "No pull requests under this owner.",
	"error.gh-missing": "gh was not found. Install the GitHub CLI, then run gh auth login.",
	"error.gh-auth": "gh is not logged in. Run gh auth login in a terminal.",
	"error.gh-failed": "Could not read GitHub: {message}",
	"error.rpc": "Could not read GitHub: {message}",
	"state.draft": "Draft",
	"checks.success": "Checks passed",
	"checks.failure": "Checks failed",
	"checks.pending": "Checks running",
	"review.approved": "Approved",
	"review.changes": "Changes requested",
	"review.required": "Review required",
	open: "Open {repo}#{number} in the browser",
	"ago.now": "just now",
	"ago.m": "{n}m ago",
	"ago.h": "{n}h ago",
	"ago.d": "{n}d ago",
	"action.explain": "Explain",
	"action.review": "Review",
	"action.explainHint": "Open a new session that explains this PR in Chinese (read-only; nothing is posted to GitHub)",
	"action.reviewHint": "Open a new session: explain in Chinese, then review with /pr-review and post the review to GitHub",
	"action.preparing": "Preparing…",
	"action.openReview": "Reviewing",
	"action.openExplain": "Explained",
	"action.openHint": "This PR already has a session; click to go back to it",
	"action.failed": "Could not start: {message}"
};

/** Short relative time, in the page's own words. */
function ago(iso, t, now = Date.now()) {
	const ms = now - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 60000) return t("ago.now");
	const m = Math.floor(ms / 60000);
	if (m < 60) return t("ago.m", { n: m });
	const hrs = Math.floor(m / 60);
	if (hrs < 48) return t("ago.h", { n: hrs });
	return t("ago.d", { n: Math.floor(hrs / 24) });
}

/** Inbox store: { status: "idle"|"loading"|"ready"|"error", data, error, at }. */
function createInboxStore(fetchInbox, now = () => Date.now()) {
	let state = { status: "idle", data: null, error: null, at: 0 };
	let inflight = null;
	const listeners = new Set();
	const set = (next) => {
		state = { ...state, ...next };
		for (const listener of [...listeners]) listener();
	};
	return {
		getSnapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Load unless fresh. Keeps showing the last good list while reloading or after a failure. */
		load(maxAgeMs = STALE_MS) {
			if (inflight !== null) return inflight;
			if (state.data !== null && now() - state.at < maxAgeMs) return Promise.resolve();
			set({ status: "loading" });
			inflight = fetchInbox().then((result) => {
				if (result.ok) set({ status: "ready", data: result, error: null, at: now() });
				else set({ status: "error", error: { reason: result.reason, message: result.message } });
			}, (error) => {
				set({ status: "error", error: { reason: "rpc", message: error?.message ?? String(error) } });
			}).finally(() => {
				inflight = null;
			});
			return inflight;
		}
	};
}

async function fetchInbox(ctx) {
	const result = await ctx.get("connection").rpc.call("/api", INBOX_METHOD, {});
	if (!result?.ok) throw new Error(result?.error?.message ?? "inbox request failed");
	return result.value;
}

// ---------------------------------------------------------------------------
// Review actions: one fresh checkout + one new session per click.

const REVIEW = {
	prepare: "github.review.prepare",
	bind: "github.review.bind",
	list: "github.review.list"
};

async function rpc(ctx, method, payload) {
	const result = await ctx.get("connection").rpc.call("/api", method, payload);
	if (!result?.ok) throw new Error(result?.error?.message ?? `${method} failed`);
	return result.value;
}

/** Review workspaces as the page sees them (the Host's list), plus which PRs are being prepared right now. */
function createReviewStore(load, now = () => Date.now()) {
	let state = { status: "idle", data: null, error: null, at: 0, preparing: {} };
	let inflight = null;
	const listeners = new Set();
	const set = (next) => {
		state = { ...state, ...next };
		for (const listener of [...listeners]) listener();
	};
	return {
		getSnapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		load(maxAgeMs = 0) {
			if (inflight !== null) return inflight;
			if (state.data !== null && now() - state.at < maxAgeMs) return Promise.resolve();
			set({ status: "loading" });
			inflight = load().then(
				(data) => set({ status: "ready", data, error: null, at: now() }),
				(error) => set({ status: "error", error: error?.message ?? String(error) })
			).finally(() => {
				inflight = null;
			});
			return inflight;
		},
		setPreparing(url, mode) {
			const preparing = { ...state.preparing };
			if (mode === null) delete preparing[url];
			else preparing[url] = mode;
			set({ preparing });
		}
	};
}

/**
 * The newest workspace for a PR whose session is still in the session list and
 * not archived: a second click goes back to it instead of starting over.
 */
function activeWorkspace(data, url, sessionsById) {
	for (const w of data?.workspaces ?? []) {
		if (w.url !== url || w.sessionId === null || w.archived || !w.exists) continue;
		if (sessionsById !== undefined && sessionsById[w.sessionId] === undefined) continue;
		return w;
	}
	return null;
}

/**
 * The click: check out the PR on the Host, create a session in that folder,
 * record the binding, name it, switch the main view to it, send the first
 * message. A failure after `prepare` leaves an unbound workspace, which the
 * next recycle removes (after an hour).
 */
async function startReview(ctx, pr, mode) {
	const { workspace, prompt } = await rpc(ctx, REVIEW.prepare, { url: pr.url, mode });
	const sessions = ctx.get("sessions");
	const sessionId = await sessions.create({ cwd: workspace.path });
	await rpc(ctx, REVIEW.bind, { path: workspace.path, sessionId });
	const label = mode === "review" ? "审查" : "解读";
	try {
		await sessions.using(sessionId, { source: "workspaceOperation" }, (reference) => reference.binding.session.rename(`${label} #${pr.number} ${pr.title}`));
	} catch (error) {
		console.warn("github: could not name the review session:", error);
	}
	ctx.get("uiWorkspace").openSession(sessionId);
	const missing = await missingSkills(ctx, sessionId, prompt);
	if (missing.length > 0) {
		notify(ctx, sessionId, "info", missingText(ctx.locale?.bind?.(NS) ?? ((k, p) => fill(zh[k], p)), missing));
		return { sessionId, workspace, missing };
	}
	await sendWhenReady(ctx, sessionId, prompt);
	return { sessionId, workspace };
}

/** The session scope appears once the main view retains it; wait for it before sending. */
async function sendWhenReady(ctx, sessionId, text, timeoutMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
	const sessions = ctx.get("sessions");
	const until = Date.now() + timeoutMs;
	for (;;) {
		const conversation = sessions.scope(sessionId)?.get("conversation");
		if (conversation !== undefined) {
			await conversation.send(text);
			return;
		}
		if (Date.now() > until) throw new Error("the new session did not open in time");
		await sleep(100);
	}
}

const PAGE_CSS_ID = "dsh-plugin-github/page.css";
const PAGE_CSS = [
	".dsh-gh-page{width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;flex-direction:column;overflow:hidden}",
	".dsh-gh-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}",
	".dsh-gh-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}",
	".dsh-gh-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:20px}",
	"[data-platform=darwin] .dsh-gh-heading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}",
	".dsh-gh-heading h1{margin:0;font-size:20px;font-weight:500;line-height:28px}",
	".dsh-gh-meta{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}",
	".dsh-gh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}",
	".dsh-gh-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-gh-iconbtn:disabled{opacity:.5;cursor:default}",
	".dsh-gh-iconbtn[data-busy] svg{animation:dsh-gh-spin 1s linear infinite}",
	"@keyframes dsh-gh-spin{to{transform:rotate(360deg)}}",
	".dsh-gh-tabs,.dsh-gh-owners{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-bottom:12px}",
	".dsh-gh-tab{height:28px;padding:0 10px;border:0;border-radius:14px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}",
	".dsh-gh-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-gh-tab[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".dsh-gh-count{color:var(--dsw-alias-label-caption);font-size:12px}",
	".dsh-gh-owner{height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
	".dsh-gh-owner:hover{border-color:var(--dsw-alias-border-l2)}",
	".dsh-gh-owner[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
	".dsh-gh-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}",
	".dsh-gh-row{display:flex;gap:12px;align-items:flex-start;padding:8px;border-radius:12px;color:inherit;text-decoration:none}",
	".dsh-gh-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
	/* Review rows follow the sidebar's session rows: the time sits at the right, and
	   on hover (or keyboard focus, or while preparing) the actions take its place. */
	".dsh-gh-item{position:relative;display:flex;align-items:flex-start;border-radius:12px}",
	".dsh-gh-item:hover,.dsh-gh-item:focus-within{background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-gh-item>.dsh-gh-row{flex:1;min-width:0;padding-right:4px}",
	".dsh-gh-item>.dsh-gh-row:hover{background:0 0}",
	".dsh-gh-trail{flex:none;display:flex;align-items:center;gap:4px;height:22px;margin:8px 8px 0 0}",
	".dsh-gh-actions{display:none;align-items:center;gap:4px}",
	".dsh-gh-item:hover .dsh-gh-actions,.dsh-gh-item:focus-within .dsh-gh-actions,.dsh-gh-item[data-busy] .dsh-gh-actions{display:flex}",
	".dsh-gh-item:hover .dsh-gh-trail>.dsh-gh-time,.dsh-gh-item:focus-within .dsh-gh-trail>.dsh-gh-time,.dsh-gh-item[data-busy] .dsh-gh-trail>.dsh-gh-time{display:none}",
	".dsh-gh-act{box-sizing:border-box;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:4px}",
	".dsh-gh-act svg{width:13px;height:13px;flex:none}",
	".dsh-gh-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".dsh-gh-act:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}",
	".dsh-gh-act:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-gh-act:disabled{opacity:.5;cursor:default}",
	".dsh-gh-act[data-primary]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
	".dsh-gh-act[data-primary]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}",
	".dsh-gh-session{box-sizing:border-box;height:24px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;gap:5px}",
	".dsh-gh-session:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".dsh-gh-session:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-gh-session svg{width:12px;height:12px;opacity:.6}",
	".dsh-gh-live{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}",
	".dsh-gh-live[data-mode=explain]{background:var(--dsw-alias-label-tertiary)}",
	".dsh-gh-spin{width:10px;height:10px;box-sizing:border-box;border-radius:50%;border:1.5px solid currentColor;border-right-color:transparent;animation:dsh-gh-spin .8s linear infinite}",
	".dsh-gh-inline-error{padding:0 8px 8px 36px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary));font-size:12px}",
	".dsh-gh-row:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-gh-glyph{flex:none;width:16px;height:20px;margin-top:2px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-success-primary)}",
	".dsh-gh-glyph[data-state=draft]{color:var(--dsw-alias-label-tertiary)}",
	".dsh-gh-body{flex:1;min-width:0}",
	".dsh-gh-title{font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-gh-sub{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
	".dsh-gh-badge{display:inline-flex;align-items:center;gap:4px}",
	".dsh-gh-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}",
	".dsh-gh-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}",
	".dsh-gh-dot[data-tone=failure]{background:var(--dsw-alias-state-error-primary)}",
	".dsh-gh-dot[data-tone=pending]{background:var(--dsw-alias-state-warn-primary)}",
	".dsh-gh-time{flex:none;color:var(--dsw-alias-label-caption);font-size:12px;line-height:22px;white-space:nowrap}",
	".dsh-gh-note{padding:24px 8px;color:var(--dsw-alias-label-tertiary);font-size:13px}",
	".dsh-gh-note[data-tone=error]{color:var(--dsw-alias-label-error)}",
	".dsh-gh-foot{padding:12px 8px 0;color:var(--dsw-alias-label-caption);font-size:12px}"
].join("");

function injectPageCss() {
	if (typeof document === "undefined") return () => {};
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-plugin-github";
	tag.dataset.pluginCss = PAGE_CSS_ID;
	tag.textContent = PAGE_CSS;
	document.head.appendChild(tag);
	return () => tag.remove();
}

/** Sidebar glyph: GitHub's mark, drawn in currentColor so it follows the theme. */
function GithubIcon({ size = 16 }) {
	return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
		h("path", { d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" }));
}

/** One PR row: the whole row is an https link, opened by the OS default browser. */
function PrRow({ pr, t, now, showAuthor, bare = false, showTime = true }) {
	const badges = [];
	if (pr.state === "draft") badges.push(h("span", { key: "d", className: "dsh-gh-badge" }, t("state.draft")));
	if (pr.checks) badges.push(h("span", { key: "c", className: "dsh-gh-badge" }, h("span", { className: "dsh-gh-dot", "data-tone": pr.checks }), t(`checks.${pr.checks}`)));
	if (pr.review) badges.push(h("span", { key: "r", className: "dsh-gh-badge" }, t(`review.${pr.review}`)));
	const link = h("a", {
			className: "dsh-gh-row",
			href: pr.url,
			target: "_blank",
			rel: "noopener noreferrer",
			"aria-label": t("open", { repo: pr.repo, number: pr.number })
		},
		h("span", { className: "dsh-gh-glyph", "data-state": pr.state }, h(IconBranchOutlineRegular, { size: 14 })),
		h("span", { className: "dsh-gh-body" },
			h("span", { className: "dsh-gh-title", title: pr.title, style: { display: "block" } }, pr.title),
			h("span", { className: "dsh-gh-sub" },
				h("span", null, `${pr.repo}#${pr.number}`),
				showAuthor && pr.author ? h("span", null, `@${pr.author}`) : null,
				...badges)),
		showTime ? h("span", { className: "dsh-gh-time" }, ago(pr.updatedAt, t, now)) : null);
	return bare ? link : h("li", null, link);
}

const svg = (d, props = {}) => h("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...props }, h("path", { d }));
/** Lines of text: read / explain. */
const ExplainGlyph = () => svg("M3 4h10M3 8h10M3 12h6");
/** A tick: review. */
const ReviewGlyph = () => svg("M3.5 8.5 6.5 11.5 12.5 4.5");
const ChevronGlyph = () => svg("M6 3.5 10.5 8 6 12.5");

/**
 * A review-list row, styled like the sidebar's session rows: the right edge
 * shows the time, and on hover (or keyboard focus, or while preparing) the
 * two actions take its place. A PR that already has a session shows a quiet
 * "审查中 ›" / "解读过 ›" link back to it instead of the buttons.
 */
function ReviewRow({ pr, t, now, preparing, active, onStart, onOpen, error }) {
	const busy = preparing !== undefined;
	const action = (mode, Glyph, primary) => h(Tooltip, { key: mode, label: t(`action.${mode}Hint`), side: "top", delayMs: 400, portal: true, maxWidth: 320 },
		h("button", {
			type: "button",
			className: "dsh-gh-act",
			"data-primary": primary ? "" : undefined,
			disabled: busy,
			"aria-busy": preparing === mode,
			"aria-label": t(`action.${mode}Hint`),
			onClick: () => onStart(pr, mode)
		},
		preparing === mode ? h("span", { className: "dsh-gh-spin", "aria-hidden": "true" }) : h(Glyph),
		preparing === mode ? t("action.preparing") : t(`action.${mode}`)));
	let actions;
	if (busy) actions = [action(preparing, preparing === "review" ? ReviewGlyph : ExplainGlyph, preparing === "review")];
	else if (active !== null) actions = [];
	else actions = [action("explain", ExplainGlyph, false), action("review", ReviewGlyph, true)];
	return h("li", null,
		h("div", { className: "dsh-gh-item", "data-busy": busy ? "" : undefined },
			h(PrRow, { pr, t, now, showAuthor: true, bare: true, showTime: false }),
			h("div", { className: "dsh-gh-trail" },
				active !== null && !busy
					? h(Tooltip, { label: t("action.openHint"), side: "top", delayMs: 400, portal: true },
						h("button", { type: "button", className: "dsh-gh-session", onClick: () => onOpen(active) },
							h("span", { className: "dsh-gh-live", "data-mode": active.mode ?? "review", "aria-hidden": "true" }),
							t(active.mode === "explain" ? "action.openExplain" : "action.openReview"),
							h(ChevronGlyph)))
					: null,
				h("span", { className: "dsh-gh-time" }, ago(pr.updatedAt, t, now)),
				actions.length > 0 ? h("span", { className: "dsh-gh-actions" }, ...actions) : null)),
		error ? h("div", { className: "dsh-gh-inline-error", role: "alert" }, t("action.failed", { message: error })) : null);
}

/** Owners present in the list, most PRs first, for the filter chips. */
function ownersOf(items) {
	const counts = new Map();
	for (const pr of items) counts.set(pr.owner, (counts.get(pr.owner) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([owner, count]) => ({ owner, count }));
}

const NO_REVIEW = { status: "idle", data: null, error: null, preparing: {} };

function GithubPage({ useInbox, useReview = (sel) => sel(NO_REVIEW), useSessions = (sel) => sel({ byId: {} }), load, loadReview = () => {}, start = () => {}, openSession = () => {}, t, now = Date.now() }) {
	const state = useInbox((s) => s);
	const review = useReview((s) => s);
	const sessionsById = useSessions((s) => s.byId);
	const [tab, setTab] = React.useState("mine");
	const [owner, setOwner] = React.useState(null);
	const [errors, setErrors] = React.useState({});
	React.useEffect(() => {
		load(STALE_MS);
		loadReview(0);
	}, []);
	const data = state.data;
	const list = data?.[tab] ?? { total: 0, items: [] };
	const owners = ownersOf(list.items);
	const activeOwner = owner !== null && owners.some((o) => o.owner === owner) ? owner : null;
	const items = activeOwner === null ? list.items : list.items.filter((pr) => pr.owner === activeOwner);
	const busy = state.status === "loading";
	const errorText = state.error === null ? null : t(["gh-missing", "gh-auth", "gh-failed", "rpc"].includes(state.error.reason) ? `error.${state.error.reason}` : "error.gh-failed", { message: state.error.message });
	const onStart = (pr, mode) => {
		setErrors((e) => ({ ...e, [pr.url]: null }));
		Promise.resolve(start(pr, mode)).catch((error) => setErrors((e) => ({ ...e, [pr.url]: error?.message ?? String(error) })));
	};

	let body;
	if (data === null && state.status === "error") {
		body = h("div", { className: "dsh-gh-note", "data-tone": "error", role: "alert" }, errorText);
	} else if (data === null) {
		body = h("div", { className: "dsh-gh-note" }, t("loading"));
	} else if (items.length === 0) {
		body = h("div", { className: "dsh-gh-note" }, activeOwner !== null ? t("empty.filter") : t(`empty.${tab}`));
	} else if (tab === "review") {
		body = h("ul", { className: "dsh-gh-list" }, items.map((pr) => h(ReviewRow, {
			key: pr.url, pr, t, now,
			preparing: review.preparing[pr.url],
			active: activeWorkspace(review.data, pr.url, sessionsById),
			error: errors[pr.url] ?? null,
			onStart,
			onOpen: (w) => openSession(w.sessionId)
		})));
	} else {
		body = h("ul", { className: "dsh-gh-list" }, items.map((pr) => h(PrRow, { key: pr.url, pr, t, now, showAuthor: false })));
	}

	return h("section", { className: "dsh-gh-page", "aria-label": t("title") },
		h("div", { className: "dsh-gh-scroll" },
			h("div", { className: "dsh-gh-content" },
				h("div", { className: "dsh-gh-heading" },
					h("h1", null, t("title")),
					h("span", { className: "dsh-gh-meta" },
						data !== null && state.status === "error" ? h("span", { role: "alert" }, errorText) : null,
						data !== null ? h("span", null, t("updated", { time: ago(data.fetchedAt, t, now), login: data.login })) : null,
						h(Tooltip, { label: t("refresh"), side: "bottom", delayMs: 400, portal: true },
							h("button", { type: "button", className: "dsh-gh-iconbtn", "aria-label": t("refresh"), disabled: busy, "data-busy": busy ? "" : undefined, onClick: () => { load(0); loadReview(0); } },
								h(IconRefreshOutlineRegular, { size: 14 }))))),
				h("div", { className: "dsh-gh-tabs", role: "group" },
					["mine", "review"].map((id) => {
						const count = data?.[id]?.total;
						return h("button", {
							key: id,
							type: "button",
							className: "dsh-gh-tab",
							"aria-pressed": tab === id,
							onClick: () => {
								setTab(id);
								setOwner(null);
							}
						}, t(`tab.${id}`), count !== undefined ? h("span", { className: "dsh-gh-count" }, String(count)) : null);
					})),
				owners.length > 1 ? h("div", { className: "dsh-gh-owners", role: "group" },
					h("button", { type: "button", className: "dsh-gh-owner", "aria-pressed": activeOwner === null, onClick: () => setOwner(null) }, t("owner.all")),
					owners.map(({ owner: o, count }) => h("button", { key: o, type: "button", className: "dsh-gh-owner", "aria-pressed": activeOwner === o, onClick: () => setOwner(o) }, `${o} ${count}`))) : null,
				body,
				data !== null && list.total > list.items.length && activeOwner === null ? h("div", { className: "dsh-gh-foot" }, t("shown", { shown: list.items.length, total: list.total })) : null)));
}

const inject = ["slots", "sessions", "locale", "connection", "uiWorkspace"];

function apply(ctx) {
	ctx.effect(injectCss, "github: composer styles");
	ctx.effect(injectPageCss, "github: page styles");
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "github: copy dictionaries");
	ctx.effect(() => ctx.locale.register(PAGE_NS, { zh: pageZh, en: pageEn }), "github: page dictionaries");
	const t = ctx.locale.bind(NS);
	const pageT = ctx.locale.bind(PAGE_NS);
	const inboxStore = createInboxStore(() => fetchInbox(ctx));
	const reviewStore = createReviewStore(() => rpc(ctx, REVIEW.list, {}));
	const start = async (pr, mode) => {
		if (reviewStore.getSnapshot().preparing[pr.url] !== undefined) return;
		reviewStore.setPreparing(pr.url, mode);
		try {
			await startReview(ctx, pr, mode);
		} finally {
			reviewStore.setPreparing(pr.url, null);
			reviewStore.load(0);
		}
	};
	ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
		name: "sidebar.panellist",
		id: PANEL_ID,
		order: 20,
		locale: PAGE_NS,
		label: () => pageT("panel")
	}, GithubIcon));
	ctx.slots.inject("main", () => ctx.slots.register({
		name: "main",
		key: PANEL_ID,
		locale: PAGE_NS,
		inject: () => ({
			hooks: { inbox: inboxStore, review: reviewStore },
			load: (maxAgeMs) => inboxStore.load(maxAgeMs),
			loadReview: (maxAgeMs) => reviewStore.load(maxAgeMs),
			start,
			openSession: (sessionId) => ctx.get("uiWorkspace").openSession(sessionId)
		})
	}, GithubPage));
	const status = createStatusStore((sessionId) => fetchPrStatus(ctx, sessionId));
	const run = (sessionId, choose) => createPr(ctx, sessionId, t, choose).then((outcome) => {
		if (outcome.kind === "stop") notify(ctx, sessionId, "info", outcome.text);
	}, (error) => {
		console.error("github: create PR:", error);
		notify(ctx, sessionId, "error", t("failed", { reason: error?.message ?? String(error) }));
	});
	// Coming back from Chrome after merging, closing, or renaming the PR there: refresh the sessions seen so far.
	if (typeof window.addEventListener === "function") {
		ctx.effect(() => {
			const onFocus = () => {
				for (const sessionId of Object.keys(status.getSnapshot())) status.refresh(sessionId, 15000);
			};
			window.addEventListener("focus", onFocus);
			return () => window.removeEventListener("focus", onFocus);
		}, "github: refresh on focus");
	}
	ctx.slots.inject(SLOT, () => ctx.slots.register({
		name: SLOT,
		id: "create-pr",
		locale: NS,
		inject: () => ({
			hooks: { prStatus: status },
			refreshStatus: (sessionId, maxAgeMs) => status.refresh(sessionId, maxAgeMs),
			run: (sessionId, choose) => run(sessionId, choose).finally(() => status.refresh(sessionId, 0))
		})
	}, CreatePrAction));
	// Sidebar hover card: every PR the session is linked to.
	ctx.slots.inject("sidebar.session.row.hover", () => ctx.slots.register({
		name: "sidebar.session.row.hover",
		id: "github-prs",
		order: 5,
		locale: NS,
		inject: () => ({ hooks: { prStatus: status } })
	}, SessionPrsHover));
}

module.exports = {
	apply, inject, createPr, precheck, createStatusStore, fetchPrStatus, CreatePrAction, PrLink, PrLinks, RepoPicker, SessionPrsHover, defaultSelection, multiPrompt, missingSkills, configuredPrompts, fill, PROMPTS_METHOD, SKILLS_METHOD, LINK_KEY, REPOS_METHOD, SKILL, SLOT, SESSION_STATUS_METHOD, zh, en,
	PANEL_ID, INBOX_METHOD, createInboxStore, GithubPage, GithubIcon, PrRow, ownersOf, ago, pageZh, pageEn,
	REVIEW, createReviewStore, activeWorkspace, startReview, sendWhenReady, ReviewRow
};
return module.exports; } });
