window.__ModuleLoader__.load({ id: "dsh-plugin-github", factory: (require) => {
var module = { exports: {} };
const React = require("react");
const { Tooltip, IconBranchOutlineRegular, IconRefreshOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
const h = React.createElement;

const NS = "createPr";
const METHOD = "github.preflight";
const SESSION_STATUS_METHOD = "github.sessionPr";
const SKILL = "pr-creator";

const zh = {
	button: "创建 PR",
	update: "更新 PR",
	hint: "用 devpilot pr-creator 为当前分支创建或更新 PR",
	busy: "Agent 正在运行，请等它停下后再创建 PR",
	notRepo: "当前会话目录不是 git 仓库，无法创建 PR",
	nothing: "{branch} 相对 {base} 没有新提交，也没有未提交的改动，没有可创建 PR 的内容",
	failed: "无法发起创建 PR：{reason}",
	prompt: "/pr-creator 为当前分支创建 PR（如果已有 PR 就更新它）。",
	linkHint: "在浏览器中打开 PR #{number}（{state}）：{title}",
	"state.open": "开启",
	"state.draft": "草稿",
	"state.merged": "已合并",
	"state.closed": "已关闭"
};
const en = {
	button: "Create PR",
	update: "Update PR",
	hint: "Create or update a pull request for this branch with devpilot pr-creator",
	busy: "The agent is still running. Create the PR once it stops.",
	notRepo: "This session's folder is not a git repository, so there is nothing to open a PR from.",
	nothing: "{branch} has no commits ahead of {base} and no uncommitted changes, so there is nothing to put in a PR.",
	failed: "Could not start the PR: {reason}",
	prompt: "/pr-creator Create a pull request for the current branch (or update the existing one).",
	linkHint: "Open PR #{number} ({state}) in the browser: {title}",
	"state.open": "open",
	"state.draft": "draft",
	"state.merged": "merged",
	"state.closed": "closed"
};

// ---------------------------------------------------------------------------
// PR status, per session

/** Minimal observable map: key (session id) -> { pr, at }. `pr` is null when there is no PR. */
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
			const job = fetchStatus(key).then((pr) => {
				const prev = state[key]?.pr;
				if (prev?.url !== pr?.url || prev?.state !== pr?.state || prev?.title !== pr?.title || last === undefined) set(key, { pr, at: now() });
				else state[key].at = now();
			}, (error) => {
				// Keep showing the last known link; a failed lookup is not "no PR".
				console.warn("github: status lookup failed:", error);
			}).finally(() => inflight.delete(key));
			inflight.set(key, job);
			return job;
		}
	};
}

/**
 * The PR for one session: only the PR the session itself is linked to (you
 * pasted its URL, or the agent created it with gh/glab). There is no fallback
 * to the folder's current branch: a new session in a checkout that happens to
 * sit on an old branch must not show that branch's PR. Looking up a linked PR
 * also makes the Host retitle the session "#<n> <PR title>".
 * @returns {Promise<{number, url, state, title} | null>}
 */
async function fetchPrStatus(ctx, sessionId) {
	const result = await ctx.get("connection").rpc.call("/api", SESSION_STATUS_METHOD, { sessionId });
	if (!result?.ok) throw new Error(result?.error?.message ?? "status lookup failed");
	return result.value.pr ?? null;
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
	if (state.status === "not-a-repo") return { kind: "stop", key: "notRepo" };
	if (state.ahead === 0 && state.dirty === 0) {
		return { kind: "stop", key: "nothing", params: { branch: state.branch, base: state.base ?? "origin" } };
	}
	return { kind: "send" };
}

/**
 * The whole button action. The prompt carries a `/pr-creator` token, which the
 * Host's skill tool turns into the skill's full instructions for this turn, so
 * the agent does not have to find and load the skill itself.
 */
async function createPr(ctx, sessionId, t) {
	const cwd = ctx.get("sessions").list.getSnapshot().byId[sessionId]?.cwd;
	const check = await precheck(ctx, cwd);
	if (check.kind === "stop") return { kind: "stop", text: t(check.key, check.params) };
	const scoped = ctx.get("sessions").scope(sessionId);
	const conversation = scoped?.get("conversation");
	if (conversation === undefined) throw new Error(`session ${sessionId} is not open`);
	await conversation.send(t("prompt"));
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
	".dsh-create-pr-link{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);text-decoration:none;align-items:center;gap:5px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;display:inline-flex}",
	".dsh-create-pr-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".dsh-create-pr-link:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-create-pr-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}",
	".dsh-create-pr-dot[data-state=draft]{background:var(--dsw-alias-label-tertiary)}",
	".dsh-create-pr-dot[data-state=merged]{background:#8957e5}",
	".dsh-create-pr-dot[data-state=closed]{background:var(--dsw-alias-state-error-primary)}"
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

function CreatePrAction({ sessionId, useSession, useSessions, usePrStatus, refreshStatus, run, t }) {
	const running = useSession((s) => s.running);
	const subagent = useSessions((state) => state.byId[sessionId]?.origin === "subagent");
	const pr = usePrStatus((state) => state[sessionId]?.pr ?? null);
	const [pending, setPending] = React.useState(false);
	// Look up on open, and again whenever a turn ends: the agent may just have opened, merged, or closed it.
	React.useEffect(() => {
		if (!subagent && !running) refreshStatus(sessionId, 0);
	}, [sessionId, running, subagent]);
	if (subagent) return null;
	const label = pr !== null && (pr.state === "open" || pr.state === "draft") ? t("update") : t("button");
	return h("span", { className: "dsh-create-pr-group" },
		pr === null ? null : h(PrLink, { pr, t }),
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
					run(sessionId).finally(() => setPending(false));
				}
			}, h(IconBranchOutlineRegular, { size: 14 }), h("span", { className: "dsh-create-pr-label" }, label))));
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
	"ago.d": "{n} 天前"
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
	"ago.d": "{n}d ago"
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
function PrRow({ pr, t, now, showAuthor }) {
	const badges = [];
	if (pr.state === "draft") badges.push(h("span", { key: "d", className: "dsh-gh-badge" }, t("state.draft")));
	if (pr.checks) badges.push(h("span", { key: "c", className: "dsh-gh-badge" }, h("span", { className: "dsh-gh-dot", "data-tone": pr.checks }), t(`checks.${pr.checks}`)));
	if (pr.review) badges.push(h("span", { key: "r", className: "dsh-gh-badge" }, t(`review.${pr.review}`)));
	return h("li", null,
		h("a", {
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
		h("span", { className: "dsh-gh-time" }, ago(pr.updatedAt, t, now))));
}

/** Owners present in the list, most PRs first, for the filter chips. */
function ownersOf(items) {
	const counts = new Map();
	for (const pr of items) counts.set(pr.owner, (counts.get(pr.owner) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([owner, count]) => ({ owner, count }));
}

function GithubPage({ useInbox, load, t, now = Date.now() }) {
	const state = useInbox((s) => s);
	const [tab, setTab] = React.useState("mine");
	const [owner, setOwner] = React.useState(null);
	React.useEffect(() => {
		load(STALE_MS);
	}, []);
	const data = state.data;
	const list = data?.[tab] ?? { total: 0, items: [] };
	const owners = ownersOf(list.items);
	const activeOwner = owner !== null && owners.some((o) => o.owner === owner) ? owner : null;
	const items = activeOwner === null ? list.items : list.items.filter((pr) => pr.owner === activeOwner);
	const busy = state.status === "loading";
	const errorText = state.error === null ? null : t(["gh-missing", "gh-auth", "gh-failed", "rpc"].includes(state.error.reason) ? `error.${state.error.reason}` : "error.gh-failed", { message: state.error.message });

	let body;
	if (data === null && state.status === "error") {
		body = h("div", { className: "dsh-gh-note", "data-tone": "error", role: "alert" }, errorText);
	} else if (data === null) {
		body = h("div", { className: "dsh-gh-note" }, t("loading"));
	} else if (items.length === 0) {
		body = h("div", { className: "dsh-gh-note" }, activeOwner !== null ? t("empty.filter") : t(`empty.${tab}`));
	} else {
		body = h("ul", { className: "dsh-gh-list" }, items.map((pr) => h(PrRow, { key: pr.url, pr, t, now, showAuthor: tab === "review" })));
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
							h("button", { type: "button", className: "dsh-gh-iconbtn", "aria-label": t("refresh"), disabled: busy, "data-busy": busy ? "" : undefined, onClick: () => load(0) },
								h(IconRefreshOutlineRegular, { size: 14 }))))),
				h("div", { className: "dsh-gh-tabs", role: "group" },
					["mine", "review"].map((id) => h("button", {
						key: id,
						type: "button",
						className: "dsh-gh-tab",
						"aria-pressed": tab === id,
						onClick: () => { setTab(id); setOwner(null); }
					}, t(`tab.${id}`), data !== null ? h("span", { className: "dsh-gh-count" }, String(data[id].total)) : null))),
				owners.length > 1 ? h("div", { className: "dsh-gh-owners", role: "group" },
					h("button", { type: "button", className: "dsh-gh-owner", "aria-pressed": activeOwner === null, onClick: () => setOwner(null) }, t("owner.all")),
					owners.map(({ owner: o, count }) => h("button", { key: o, type: "button", className: "dsh-gh-owner", "aria-pressed": activeOwner === o, onClick: () => setOwner(o) }, `${o} ${count}`))) : null,
				body,
				data !== null && list.total > list.items.length && activeOwner === null ? h("div", { className: "dsh-gh-foot" }, t("shown", { shown: list.items.length, total: list.total })) : null)));
}

const inject = ["slots", "sessions", "locale", "connection"];

function apply(ctx) {
	ctx.effect(injectCss, "github: composer styles");
	ctx.effect(injectPageCss, "github: page styles");
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "github: copy dictionaries");
	ctx.effect(() => ctx.locale.register(PAGE_NS, { zh: pageZh, en: pageEn }), "github: page dictionaries");
	const t = ctx.locale.bind(NS);
	const pageT = ctx.locale.bind(PAGE_NS);
	const inboxStore = createInboxStore(() => fetchInbox(ctx));
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
			hooks: { inbox: inboxStore },
			load: (maxAgeMs) => inboxStore.load(maxAgeMs)
		})
	}, GithubPage));
	const status = createStatusStore((sessionId) => fetchPrStatus(ctx, sessionId));
	const run = (sessionId) => createPr(ctx, sessionId, t).then((outcome) => {
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
			run: (sessionId) => run(sessionId).finally(() => status.refresh(sessionId, 0))
		})
	}, CreatePrAction));
}

module.exports = {
	apply, inject, createPr, precheck, createStatusStore, fetchPrStatus, CreatePrAction, PrLink, SKILL, SLOT, SESSION_STATUS_METHOD, zh, en,
	PANEL_ID, INBOX_METHOD, createInboxStore, GithubPage, GithubIcon, PrRow, ownersOf, ago, pageZh, pageEn
};
return module.exports; } });
