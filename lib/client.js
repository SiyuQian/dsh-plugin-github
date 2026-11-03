window.__ModuleLoader__.load({ id: "dsh-plugin-create-pr", factory: (require) => {
var module = { exports: {} };
const React = require("react");
const { Button, Tooltip, IconBranchOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
const h = React.createElement;

const NS = "createPr";
const METHOD = "create-pr.preflight";
const SKILL = "pr-creator";

const zh = {
	button: "创建 PR",
	hint: "用 devpilot pr-creator 为当前分支创建或更新 PR",
	busy: "Agent 正在运行，请等它停下后再创建 PR",
	notRepo: "当前会话目录不是 git 仓库，无法创建 PR",
	nothing: "{branch} 相对 {base} 没有新提交，也没有未提交的改动，没有可创建 PR 的内容",
	failed: "无法发起创建 PR：{reason}",
	prompt: "/pr-creator 为当前分支创建 PR（如果已有 PR 就更新它）。"
};
const en = {
	button: "Create PR",
	hint: "Create or update a pull request for this branch with devpilot pr-creator",
	busy: "The agent is still running. Create the PR once it stops.",
	notRepo: "This session's folder is not a git repository, so there is nothing to open a PR from.",
	nothing: "{branch} has no commits ahead of {base} and no uncommitted changes, so there is nothing to put in a PR.",
	failed: "Could not start the PR: {reason}",
	prompt: "/pr-creator Create a pull request for the current branch (or update the existing one)."
};

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

function CreatePrAction({ sessionId, useSession, useSessions, run, t }) {
	const running = useSession((s) => s.running);
	const subagent = useSessions((state) => state.byId[sessionId]?.origin === "subagent");
	const [pending, setPending] = React.useState(false);
	if (subagent) return null;
	const disabled = pending || running;
	return h(Tooltip, { label: running ? t("busy") : t("hint"), side: "bottom", delayMs: 400, portal: true },
		h(Button, {
			size: "sm",
			variant: "ghost",
			disabled,
			"aria-label": t("button"),
			"aria-busy": pending,
			icon: h(IconBranchOutlineRegular, { size: 14 }),
			onClick: () => {
				setPending(true);
				run(sessionId).finally(() => setPending(false));
			}
		}, t("button")));
}

const inject = ["slots", "sessions", "locale", "connection"];

function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "create-pr: copy dictionaries");
	const t = ctx.locale.bind(NS);
	const run = (sessionId) => createPr(ctx, sessionId, t).then((outcome) => {
		if (outcome.kind === "stop") notify(ctx, sessionId, "info", outcome.text);
	}, (error) => {
		console.error("create-pr:", error);
		notify(ctx, sessionId, "error", t("failed", { reason: error?.message ?? String(error) }));
	});
	ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
		name: "conversation.session.header.actions",
		id: "create-pr",
		order: 30,
		locale: NS,
		inject: () => ({ run })
	}, CreatePrAction));
}

module.exports = { apply, inject, createPr, precheck, SKILL, zh, en };
return module.exports; } });
