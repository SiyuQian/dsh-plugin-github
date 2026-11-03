window.__ModuleLoader__.load({ id: "dsh-plugin-create-pr", factory: (require) => {
var module = { exports: {} };
const React = require("react");
const { Tooltip, IconBranchOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
const h = React.createElement;

const NS = "createPr";
const METHOD = "create-pr.preflight";
const STATUS_METHOD = "create-pr.status";
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
// PR status, per session folder

/** Minimal observable map: cwd -> { pr, at }. `pr` is null when the branch has no PR. */
function createStatusStore(fetchStatus, now = () => Date.now()) {
	let state = {};
	const listeners = new Set();
	const inflight = new Map();
	const set = (cwd, entry) => {
		state = { ...state, [cwd]: entry };
		for (const listener of [...listeners]) listener();
	};
	return {
		getSnapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Refresh one folder unless a lookup is already running or the last one is younger than `maxAgeMs`. */
		refresh(cwd, maxAgeMs = 0) {
			if (!cwd) return Promise.resolve();
			const last = state[cwd];
			if (last !== undefined && now() - last.at < maxAgeMs) return Promise.resolve();
			const running = inflight.get(cwd);
			if (running !== undefined) return running;
			const job = fetchStatus(cwd).then((pr) => {
				const prev = state[cwd]?.pr;
				if (prev?.url !== pr?.url || prev?.state !== pr?.state || prev?.title !== pr?.title || last === undefined) set(cwd, { pr, at: now() });
				else state[cwd].at = now();
			}, (error) => {
				// Keep showing the last known link; a failed lookup is not "no PR".
				console.warn("create-pr: status lookup failed:", error);
			}).finally(() => inflight.delete(cwd));
			inflight.set(cwd, job);
			return job;
		}
	};
}

/** @returns {Promise<{number, url, state, title} | null>} */
async function fetchPrStatus(ctx, cwd) {
	const result = await ctx.get("connection").rpc.call("/api", STATUS_METHOD, { cwd });
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
		console.warn("create-pr: preflight unavailable, sending anyway:", error);
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
		console.warn("create-pr: notice failed:", error);
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
const CSS_ID = "dsh-plugin-create-pr/composer.css";
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
	tag.dataset.plugin = "dsh-plugin-create-pr";
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
	const cwd = useSessions((state) => state.byId[sessionId]?.cwd);
	const pr = usePrStatus((state) => (cwd ? state[cwd]?.pr : undefined) ?? null);
	const [pending, setPending] = React.useState(false);
	// Look up on open, and again whenever a turn ends: the agent may just have opened, merged, or closed it.
	React.useEffect(() => {
		if (!subagent && !running && cwd) refreshStatus(cwd, 0);
	}, [cwd, running, subagent]);
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

const inject = ["slots", "sessions", "locale", "connection"];

function apply(ctx) {
	ctx.effect(injectCss, "create-pr: composer styles");
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "create-pr: copy dictionaries");
	const t = ctx.locale.bind(NS);
	const status = createStatusStore((cwd) => fetchPrStatus(ctx, cwd));
	const sessions = () => ctx.get("sessions");
	const cwdOf = (sessionId) => sessions()?.list.getSnapshot().byId[sessionId]?.cwd;
	const run = (sessionId) => createPr(ctx, sessionId, t).then((outcome) => {
		if (outcome.kind === "stop") notify(ctx, sessionId, "info", outcome.text);
	}, (error) => {
		console.error("create-pr:", error);
		notify(ctx, sessionId, "error", t("failed", { reason: error?.message ?? String(error) }));
	});
	// Coming back from Chrome after merging or closing the PR there: refresh the folders on screen.
	if (typeof window.addEventListener === "function") {
		ctx.effect(() => {
			const onFocus = () => {
				for (const cwd of Object.keys(status.getSnapshot())) status.refresh(cwd, 15000);
			};
			window.addEventListener("focus", onFocus);
			return () => window.removeEventListener("focus", onFocus);
		}, "create-pr: refresh on focus");
	}
	ctx.slots.inject(SLOT, () => ctx.slots.register({
		name: SLOT,
		id: "create-pr",
		locale: NS,
		inject: () => ({
			hooks: { prStatus: status },
			refreshStatus: (cwd, maxAgeMs) => status.refresh(cwd, maxAgeMs),
			run: (sessionId) => run(sessionId).finally(() => status.refresh(cwdOf(sessionId), 0))
		})
	}, CreatePrAction));
}

module.exports = { apply, inject, createPr, precheck, createStatusStore, CreatePrAction, PrLink, SKILL, SLOT, STATUS_METHOD, zh, en };
return module.exports; } });
