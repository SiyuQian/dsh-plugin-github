/**
 * Host half.
 *
 * 1. Registers the vendored devpilot `pr-creator` skill with the skill registry,
 *    so it shows up in the `/` menu and the model's skill catalogue.
 * 2. Answers one RPC, `create-pr.preflight`, which reads the session folder's
 *    git state so the header button can say "nothing to PR" without spending a
 *    model turn. It only reads; every write (branch, commit, push, PR) is left
 *    to the agent following the skill.
 *
 * Route wire format copied from dsh-plugin-no-project.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-plugin-create-pr";
export const SKILL_NAME = "pr-creator";
export const PROVIDER_NAME = "devpilot-pr";
export const PREFLIGHT_METHOD = "create-pr.preflight";

/** Same precedence as other packaged skills (BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill),
 * so a user or project `pr-creator` skill on disk still wins. Inlined to avoid a hard import. */
const BUNDLED_SKILL_RANK = 600;

const VENDOR_ROOT = fileURLToPath(new URL("../vendor/devpilot/", import.meta.url));
export const SKILL_DIR = join(VENDOR_ROOT, "skills", SKILL_NAME);
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

/**
 * Split SKILL.md into its description and body. The description is a YAML
 * folded scalar (`description: >`); this reads only that shape and a plain
 * one-line value, which is all the devpilot file uses.
 */
export function parseSkill(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	if (match === null) throw new Error(`${name}: ${SKILL_FILE} has no frontmatter`);
	const lines = match[1].split(/\r?\n/);
	const at = lines.findIndex((line) => /^description:/.test(line));
	if (at === -1) throw new Error(`${name}: ${SKILL_FILE} has no description`);
	const inline = lines[at].replace(/^description:\s*/, "");
	let description;
	if (inline === ">" || inline === "|" || inline === ">-" || inline === "|-") {
		const body = [];
		for (const line of lines.slice(at + 1)) {
			if (!/^\s+\S/.test(line) && line.trim() !== "") break;
			body.push(line.trim());
		}
		description = body.join(" ").replace(/\s+/g, " ").trim();
	} else {
		description = inline.replace(/^["']|["']$/g, "").trim();
	}
	if (description === "") throw new Error(`${name}: ${SKILL_FILE} has an empty description`);
	return { description, content: raw.slice(match[0].length).trim() };
}

/**
 * The vendored skill says "<devpilot>" where it means the plugin root and
 * "devpilot:<skill>" for sibling skills that this plugin does not ship. Tell the
 * model both, ahead of the untouched body, so it neither guesses a path nor
 * stalls looking for a hand-off target.
 */
export function hostNote(vendorRoot = VENDOR_ROOT) {
	return [
		"## DeepSeek Harness notes (added by dsh-plugin-create-pr)",
		"",
		`- \`<devpilot>\` in this skill is \`${vendorRoot.replace(/[\\/]$/, "")}\`. The checker is \`${join(vendorRoot, "skills", SKILL_NAME, "scripts", "visual_evidence.py")}\`.`,
		"- Only `pr-creator` ships with this plugin. Other `devpilot:*` skills it mentions (pr-guard, pr-announce, babysit-prs, e2e-tests) may not be installed; if one is not in your skill catalogue, skip that optional hand-off and say so in the report.",
		"- Where the skill says to use the host task list, use the `todo_write` tool if it is available.",
		""
	].join("\n");
}

export function skillCandidate(description) {
	return {
		name: SKILL_NAME,
		description,
		invocation: { modelInvocable: true, userInvocable: true },
		provider: PROVIDER_NAME,
		source: "bundled",
		rank: BUNDLED_SKILL_RANK,
		path: SKILL_FILE,
		resourceBase: { kind: "directory", path: SKILL_DIR.split("\\").join("/") }
	};
}

export function createSkillProvider() {
	// Read once at load so a broken vendor copy fails the plugin loudly at startup.
	const candidate = skillCandidate(parseSkill(readFileSync(SKILL_FILE, "utf8")).description);
	return {
		name: PROVIDER_NAME,
		list: () => Promise.resolve([candidate]),
		async get(_candidate, options) {
			const raw = await readFile(SKILL_FILE, { encoding: "utf8", signal: options?.signal });
			const { rank: _rank, ...summary } = candidate;
			return { ...summary, content: `${hostNote()}\n${parseSkill(raw).content}` };
		}
	};
}

// ---------------------------------------------------------------------------
// Preflight: a read-only look at the session folder's git state.

/** Run a CLI read-only in `cwd`; never throws. `missing` is true when the executable is not on PATH. */
export function exec(file, cwd, args, timeoutMs = 10000) {
	return new Promise((resolve) => {
		execFile(file, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 1 << 20,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
		}, (error, stdout, stderr) => {
			resolve({ ok: error === null, missing: error?.code === "ENOENT", out: String(stdout).trim(), err: String(stderr).trim() });
		});
	});
}

const git = (cwd, args) => exec("git", cwd, args, 8000);

/** "github" | "gitlab" | "other" | "none", from the origin URL (SSH host aliases such as github-work: count as github). */
export function hostOf(url) {
	if (!url) return "none";
	if (/github/i.test(url)) return "github";
	if (/gitlab/i.test(url)) return "gitlab";
	return "other";
}

/**
 * Summarise whether the folder has anything to put in a PR. Local refs only
 * (no fetch), so it is fast and never touches the network; the skill does the
 * authoritative fetch-and-diff.
 * @returns {Promise<{status: "not-a-repo"} | {status: "ok", branch: string, base: string|null, host: string, ahead: number|null, dirty: number}>}
 */
export async function preflight(cwd, run = git) {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
	const top = await run(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) return { status: "not-a-repo" };
	const [branch, head, remote, status] = await Promise.all([
		run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		run(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
		run(cwd, ["remote", "get-url", "origin"]),
		run(cwd, ["status", "--porcelain"])
	]);
	let base = head.ok && head.out ? head.out : null;
	if (base === null) {
		for (const guess of ["origin/main", "origin/master"]) {
			if ((await run(cwd, ["rev-parse", "--verify", "--quiet", guess])).ok) { base = guess; break; }
		}
	}
	let ahead = null;
	if (base !== null) {
		const count = await run(cwd, ["rev-list", "--count", `${base}..HEAD`]);
		if (count.ok) ahead = Number.parseInt(count.out, 10) || 0;
	}
	return {
		status: "ok",
		branch: branch.ok ? branch.out : "HEAD",
		base,
		host: hostOf(remote.ok ? remote.out : ""),
		ahead,
		dirty: status.ok && status.out !== "" ? status.out.split("\n").length : 0
	};
}

// ---------------------------------------------------------------------------
// PR status: the pull request (if any) for the folder's current branch.

export const STATUS_METHOD = "create-pr.status";

const GITLAB_STATE = { opened: "open", merged: "merged", closed: "closed", locked: "closed" };

/** Only plain https links reach the page, so a hostile CLI output cannot inject a javascript: or file: URL. */
function httpsUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * Ask `gh` (GitHub) or `glab` (GitLab) for the current branch's PR/MR. Uses
 * the CLI's own login, so it sees exactly what `gh pr create` would.
 * @returns {Promise<{pr: null, reason: string} | {pr: {number: number, url: string, state: "open"|"draft"|"merged"|"closed", title: string}}>}
 */
export async function prStatus(cwd, run = exec) {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
	const remote = await run("git", cwd, ["remote", "get-url", "origin"], 8000);
	if (!remote.ok) return { pr: null, reason: "no-remote" };
	const host = hostOf(remote.out);
	if (host !== "github" && host !== "gitlab") return { pr: null, reason: "unsupported-host" };
	return viewPr(host, cwd, [], run);
}

/**
 * One `gh pr view` / `glab mr view`. `target` is empty for "the current
 * branch's PR", or a PR URL/number to look up a known PR from any folder.
 */
async function viewPr(host, cwd, target, run) {
	let raw;
	if (host === "github") {
		const r = await run("gh", cwd, ["pr", "view", ...target, "--json", "number,url,state,isDraft,title"]);
		if (!r.ok) return { pr: null, reason: r.missing ? "gh-missing" : "none" };
		const j = JSON.parse(r.out);
		const state = String(j.state).toLowerCase();
		raw = { number: j.number, url: j.url, title: j.title, state: j.isDraft && state === "open" ? "draft" : state };
	} else {
		const r = await run("glab", cwd, ["mr", "view", ...target, "-F", "json"]);
		if (!r.ok) return { pr: null, reason: r.missing ? "glab-missing" : "none" };
		const j = JSON.parse(r.out);
		const state = GITLAB_STATE[j.state] ?? "open";
		raw = { number: j.iid, url: j.web_url, title: j.title, state: (j.draft || j.work_in_progress) && state === "open" ? "draft" : state };
	}
	const url = httpsUrl(raw.url);
	if (url === null || !Number.isInteger(raw.number)) return { pr: null, reason: "bad-output" };
	const state = ["open", "draft", "merged", "closed"].includes(raw.state) ? raw.state : "open";
	return { pr: { number: raw.number, url, state, title: String(raw.title ?? "") } };
}

/** Look up a PR by its URL. Works from any folder, so a session in a parent workspace still resolves it. */
export async function prByUrl(url, cwd, run = exec) {
	const host = hostOf(url);
	if (host !== "github" && host !== "gitlab") return { pr: null, reason: "unsupported-host" };
	if (host === "gitlab") {
		// glab needs the project; pass it with -R and the MR number.
		const m = /^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url);
		if (m === null) return { pr: null, reason: "bad-url" };
		return viewPr(host, cwd, [m[2], "-R", m[1]], run);
	}
	return viewPr(host, cwd, [url], run);
}

// ---------------------------------------------------------------------------
// Session link: which PR a session is about, read from its own log.

/** A PR or MR web URL, ending at the number. */
const PR_URL = /https:\/\/[A-Za-z0-9.-]+\/[\w.-]+(?:\/[\w.-]+)+?\/(?:pull|-\/merge_requests)\/\d+(?!\d)/g;
/**
 * Commands that create a PR. `gh pr create` and `glab mr create` print the new
 * PR's URL, so the URL in their output is the PR this session made. Commands
 * that only view or edit an existing PR are left out: the agent often reads or
 * touches other PRs, and that should not relink the session. Help runs are
 * ignored. A pasted PR link in your own message covers the "work on this
 * existing PR" case.
 */
const PR_CREATE = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create)\b(?![^\n;&|]*(?:--help|-h\b))/;

function textOf(content) {
	return Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
}

/**
 * Tool arguments as plain text. They are stored as a JSON string, so a newline
 * before `gh pr create` would otherwise read as a literal `\n` and hide the
 * command from a word-boundary match.
 */
export function argumentText(args) {
	let value = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return value;
		}
	}
	const parts = [];
	const walk = (v) => {
		if (typeof v === "string") parts.push(v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(value);
	return parts.join("\n");
}

function lastUrl(text) {
	const all = text.match(PR_URL);
	return all === null ? null : all[all.length - 1];
}

/**
 * Fold one session event into the linked PR URL. The latest of these wins:
 * - a PR URL in the human's own message (pasting a PR link);
 * - the PR URL printed by a `gh pr create` / `glab mr create` the agent ran.
 * Model text alone never links a PR, so a PR the agent merely mentions does not rename the session.
 * State: { url, pending: callIds of PR-creating commands awaiting their result }.
 */
export function foldLink(state, event) {
	const data = event?.data;
	switch (event?.type) {
		case "user/message": {
			if (data?.source?.kind !== "user") return state;
			const url = lastUrl(textOf(data.content));
			return url === null || url === state.url ? state : { ...state, url };
		}
		case "tool/call": {
			if (typeof data?.callId !== "string" || !PR_CREATE.test(argumentText(data.arguments))) return state;
			return { ...state, pending: [...state.pending, data.callId].slice(-8) };
		}
		case "tool/result": {
			const callId = data?.message?.toolCallId;
			if (!state.pending.includes(callId)) return state;
			const pending = state.pending.filter((id) => id !== callId);
			const url = data.message.isError === true ? null : lastUrl(textOf(data.message.content));
			return { url: url ?? state.url, pending };
		}
		default:
			return state;
	}
}

const EMPTY_LINK = { url: null, pending: [] };

/** The session's linked PR URL, folded from its log. */
export function linkOf(events) {
	return events.reduce(foldLink, EMPTY_LINK).url;
}

/** Whether one event could change the link (cheap pre-check before a lookup). */
export function mayLink(event) {
	const data = event?.data;
	if (event?.type === "user/message") return data?.source?.kind === "user" && lastUrl(textOf(data.content)) !== null;
	if (event?.type === "tool/result") return lastUrl(textOf(data?.message?.content)) !== null;
	return false;
}

// ---------------------------------------------------------------------------
// Title sync: a linked session's title becomes "#191 <PR title>".

export function prTitle(pr) {
	return `#${pr.number} ${pr.title}`.replace(/\s+/g, " ").trim();
}

function latestTitleEvent(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === "session/title") return events[i];
	return undefined;
}

/**
 * Decide whether to retitle. Never overwrite a title the user typed, unless it
 * is one we wrote earlier (so a PR rename or a newly linked PR still updates).
 * The title service may have cut our title to its byte cap (80 by default),
 * so a stored prefix of the wanted title counts as already applied.
 * @returns the new title, or null to leave it alone.
 */
export function nextTitle(events, pr, ours = new Set()) {
	const want = prTitle(pr);
	const title = latestTitleEvent(events)?.data;
	const current = typeof title?.title === "string" ? title.title : "";
	if (current === want || (current.startsWith(`#${pr.number} `) && want.startsWith(current))) return null;
	if (title?.source?.kind === "user" && !ours.has(current) && !/^#\d+ /.test(current)) return null;
	return want;
}

/**
 * Host-side link manager. Keeps the PR lookup per session, retitles the
 * session through the title service (the same path as a manual rename), and
 * answers the client's per-session status RPC.
 */
export function createLinkManager({ sessions, titles, run = exec, now = () => Date.now(), logger = console }) {
	const cache = new Map(); // url -> { at, pr }
	const ours = new Set(); // titles this plugin wrote, so it may replace them later
	const applied = new Map(); // session id -> last title we set, so two quick lookups rename once
	const inflight = new Map();

	async function lookup(url, cwd, maxAgeMs) {
		const hit = cache.get(url);
		if (hit !== undefined && now() - hit.at < maxAgeMs) return hit.pr;
		if (inflight.has(url)) return inflight.get(url);
		const job = prByUrl(url, cwd, run).then((r) => {
			if (r.pr !== null || r.reason === "none") cache.set(url, { at: now(), pr: r.pr });
			return r.pr;
		}).finally(() => inflight.delete(url));
		inflight.set(url, job);
		return job;
	}

	function retitle(session, pr) {
		if (titles === undefined || pr === null) return;
		if ((session.header?.delegationDepth ?? 0) > 0) return; // subagent sessions keep their own titles
		const title = nextTitle(session.snapshotEvents(), pr, ours);
		if (title === null || applied.get(session.id) === title) return;
		try {
			const accepted = titles.rename(session, title);
			ours.add(accepted?.title ?? title);
			applied.set(session.id, title);
		} catch (error) {
			logger.warn?.(`${name}: could not retitle ${session.id}: ${error?.message ?? error}`);
		}
	}

	/** The session's linked PR, looked up and (when found) applied as its title. */
	async function status(sessionId, maxAgeMs = 15000) {
		const session = sessions.get(sessionId);
		if (session === undefined) return { pr: null, reason: "not-live" };
		const url = linkOf(session.snapshotEvents());
		if (url === null) return { pr: null, reason: "unlinked" };
		const pr = await lookup(url, session.header?.cwd ?? process.cwd(), maxAgeMs);
		if (pr === null) return { pr: null, reason: "none", url };
		// The rename appends to the log; never do it inside another append's publication.
		queueMicrotask(() => {
			if (sessions.get(sessionId) === session) retitle(session, pr);
		});
		return { pr };
	}

	/**
	 * React to the session's own log: a pasted PR link, or the result of the
	 * agent's `gh pr create`, retitles the session without waiting for a client.
	 * Deferred so the rename never appends inside another append's publication.
	 */
	function onEvent(session, event) {
		if (!mayLink(event) || (session.header?.delegationDepth ?? 0) > 0) return;
		setTimeout(() => {
			status(session.id, 0).catch((error) => logger.warn?.(`${name}: PR lookup for ${session.id} failed: ${error?.message ?? error}`));
		}, 0);
	}

	/** A session that becomes live (opened, resumed) gets its title checked once. */
	function onLive(session) {
		if ((session.header?.delegationDepth ?? 0) > 0) return;
		setTimeout(() => {
			status(session.id, 60000).catch((error) => logger.warn?.(`${name}: PR lookup for ${session.id} failed: ${error?.message ?? error}`));
		}, 0);
	}

	return { status, lookup, retitle, onEvent, onLive, ours };
}

export const SESSION_STATUS_METHOD = "create-pr.sessionStatus";

// ---------------------------------------------------------------------------
// Routes

function rpcError(rpcId, code, message) {
	return Response.json({ type: "server-response", rpcId, result: { ok: false, error: { code, message, details: { issues: [] } } } });
}

/** One exact `/api/<method>` route; the handler gets the request payload. Wire format copied from dsh-plugin-no-project. */
function payloadRoute(method, handler) {
	return {
		path: `/api/${method}`,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response("body is not JSON", { status: 400 });
			}
			const rpcId = typeof body?.rpcId === "string" ? body.rpcId : "invalid-request";
			if (body?.method !== method) return rpcError(rpcId, "gateway/bad-request", `unexpected method ${JSON.stringify(body?.method)}`);
			try {
				const value = await handler(body?.payload ?? {});
				return Response.json({ type: "server-response", rpcId, result: { ok: true, value } });
			} catch (error) {
				return rpcError(rpcId, "gateway/bad-request", error?.message ?? String(error));
			}
		}
	};
}

export function preflightRoute(run = git) {
	return payloadRoute(PREFLIGHT_METHOD, ({ cwd }) => preflight(cwd, run));
}

export function statusRoute(run = exec) {
	return payloadRoute(STATUS_METHOD, ({ cwd }) => prStatus(cwd, run));
}

export function sessionStatusRoute(links) {
	return payloadRoute(SESSION_STATUS_METHOD, ({ sessionId, maxAgeMs }) => {
		if (typeof sessionId !== "string" || sessionId === "") throw new Error("sessionId is required");
		return links.status(sessionId, Number.isFinite(maxAgeMs) ? maxAgeMs : 15000);
	});
}

export function apply(ctx) {
	ctx.inject(["skills"], (scope) => {
		scope.skills.registerProvider(() => createSkillProvider());
	});
	ctx.inject(["connection"], (scope) => {
		const connection = scope.get("connection");
		for (const route of [preflightRoute(), statusRoute()]) {
			scope.effect(() => connection.fetch.register(route), `${name}: ${route.path} route`);
		}
	});
	// Session-to-PR link and title sync. Needs the live session store; the title
	// service is optional (without it the link still shows, the title does not change).
	ctx.inject(["connection", "sessions"], (scope) => {
		const links = createLinkManager({ sessions: scope.get("sessions"), titles: scope.get("sessionTitle"), logger: scope.logger ?? console });
		scope.effect(() => scope.get("connection").fetch.register(sessionStatusRoute(links)), `${name}: /api/${SESSION_STATUS_METHOD} route`);
		scope.on("session/event", (session, event) => links.onEvent(session, event));
		scope.on("session/created", (session) => links.onLive(session));
	});
}
