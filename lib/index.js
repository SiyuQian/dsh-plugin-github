/**
 * Host half.
 *
 * RPCs: the composer's git preflight, the GitHub tab's PR inbox, per-session
 * PR links, review workspaces (a fresh checkout per reviewed PR, with
 * recycling), the configured prompts, and a skill-availability check.
 *
 * This plugin registers no skills. The prompts it sends start with `/name`
 * skill tokens (by default `/pr-creator`, `/pr-explain`, `/pr-review`); those
 * skills come from a separate plugin such as dsh-plugin-devpilot. Every prompt
 * is a template in the plugin config.
 *
 * Route wire format copied from dsh-plugin-no-project.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { createReviewWorkspaces, REVIEW_METHODS, reviewPrompt as reviewPromptFor, DEFAULT_REVIEW_PROMPT, DEFAULT_EXPLAIN_PROMPT } from "./review.js";

export { REVIEW_METHODS, DEFAULT_REVIEW_PROMPT, DEFAULT_EXPLAIN_PROMPT };

export const name = "dsh-plugin-github";
export const PREFLIGHT_METHOD = "github.preflight";
export const PROMPTS_METHOD = "github.prompts";
export const SKILLS_METHOD = "github.missingSkills";

// ---------------------------------------------------------------------------
// Config: the prompt templates. An empty create-PR template means the built-in,
// locale-specific text in lib/client.js (English or Chinese, as before).

export const PROMPT_DEFAULTS = {
	createPrPrompt: "",
	multiRepoCreatePrPrompt: "",
	reviewPrompt: DEFAULT_REVIEW_PROMPT,
	explainPrompt: DEFAULT_EXPLAIN_PROMPT
};

const PROMPT_HELP = {
	createPrPrompt: "Create PR, one repository. No placeholders. Empty = built-in: `/pr-creator Create a pull request for the current branch (or update the existing one).` (Chinese text in the Chinese UI).",
	multiRepoCreatePrPrompt: "Create PR, several repositories. Placeholders: {n} repository count, {root} session folder, {list} numbered repository list. Empty = built-in text.",
	reviewPrompt: "Review a PR. Placeholders: {url}, {number}, {path} checkout folder, {head} 12-char head SHA, {base} base branch.",
	explainPrompt: "Explain a PR. Same placeholders as reviewPrompt."
};

/** Fill missing or non-string keys with the defaults. */
export function resolveConfig(input) {
	const out = {};
	for (const [key, value] of Object.entries(PROMPT_DEFAULTS)) {
		const given = input?.[key];
		out[key] = typeof given === "string" ? given : value;
	}
	return out;
}

/**
 * The schemastery schema the Loader validates and the settings UI renders.
 * schemastery is supplied by the Host; without it (plain Node tests) Config is
 * a plain resolver with the same defaults.
 */
async function buildConfig() {
	for (const id of ["@deepseek-ai/schemastery", "schemastery"]) {
		try {
			const z = (await import(id)).default;
			return z.object(Object.fromEntries(Object.entries(PROMPT_DEFAULTS).map(([key, value]) => [key, z.string().role("textarea").default(value).description(PROMPT_HELP[key])])));
		} catch {}
	}
	return resolveConfig;
}
export const Config = await buildConfig();

/** Replace `{key}` with params[key]; unknown placeholders stay as they are. */
export function fillTemplate(template, params = {}) {
	return template.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(params, key) ? String(params[key]) : all));
}

/** The leading `/name` skill tokens of a prompt (the Host's skill gesture). */
export function leadingSkills(text) {
	const names = [];
	for (const token of String(text).trimStart().split(/\s+/)) {
		const m = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(token);
		if (m === null) break;
		names.push(m[1]);
	}
	return names;
}

/**
 * Which leading skills of `text` the session's skill catalog lacks. `null`
 * means the catalog could not be read; the caller then sends anyway.
 */
export async function missingSkills(catalog, sessionId, text) {
	const wanted = leadingSkills(text);
	if (wanted.length === 0) return [];
	if (typeof catalog?.list !== "function") return null;
	let value;
	try {
		value = await catalog.list({ sessionId });
	} catch {
		return null;
	}
	if (!Array.isArray(value?.skills)) return null;
	const have = new Set(value.skills.map((s) => s.name));
	return wanted.filter((n) => !have.has(n));
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
// Multi-repo workspaces: a session folder that is not a repo but holds several.

export const REPOS_METHOD = "github.repos";

/** Child folders that are git checkouts (a `.git` directory, or a `.git` file for a worktree). */
export async function childRepos(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const repos = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		try {
			const info = await stat(join(dir, entry.name, ".git"));
			repos.push({ name: entry.name, path: join(dir, entry.name), worktree: info.isFile() });
		} catch {
			// not a checkout
		}
	}
	return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which child repos a session worked in, from its own log: a tool call whose
 * `workdir` names the repo, or whose arguments mention its folder path or a
 * `cd <repo>`. A rough signal; it only decides which boxes start ticked.
 */
export function touchedRepos(events, root, names) {
	const touched = new Set();
	const prefix = root.endsWith(sep) ? root : root + sep;
	const relative = (value) => (typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : value);
	for (const event of events) {
		if (event?.type !== "tool/call") continue;
		let args = event.data?.arguments;
		if (typeof args === "string") {
			try {
				args = JSON.parse(args);
			} catch {
				args = { text: args };
			}
		}
		if (args === null || typeof args !== "object") continue;
		const text = argumentText(args);
		const escRoot = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const name of names) {
			if (touched.has(name)) continue;
			const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// The name must end there: `web-app` must not match `web-app-cache`.
			const end = "(?![A-Za-z0-9._-])";
			const workdir = relative(args.workdir ?? args.cwd);
			if (typeof workdir === "string" && (workdir === name || workdir.startsWith(name + "/"))) touched.add(name);
			else if (new RegExp(`${escRoot}${esc}${end}`).test(text)) touched.add(name);
			else if (new RegExp(`(^|[\\s;&|(])cd\\s+(\\./)?${esc}${end}`).test(text)) touched.add(name);
		}
	}
	return touched;
}

/**
 * Local state of every repo under `cwd`, for the Create PR picker: branch,
 * base, commits ahead, uncommitted files, and whether this session touched
 * it. Local refs only, like `preflight`. The branch's open PR (if any) comes
 * from one `gh pr list` per repo with changes, run in parallel.
 */
export async function scanRepos(cwd, { events = [], run = git, gh = exec } = {}) {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
	const repos = await childRepos(cwd);
	const touched = touchedRepos(events, cwd, repos.map((r) => r.name));
	const states = await Promise.all(repos.map(async (repo) => {
		const state = await preflight(repo.path, run);
		const changed = state.status === "ok" && ((state.ahead ?? 0) > 0 || state.dirty > 0);
		let pr = null;
		if (changed && state.host === "github" && state.branch !== "HEAD") {
			const r = await gh("gh", repo.path, ["pr", "list", "--head", state.branch, "--state", "open", "--json", "number,url", "--limit", "1"], 15000);
			if (r.ok) {
				try {
					const found = JSON.parse(r.out)[0];
					const url = found ? httpsUrl(found.url) : null;
					if (url !== null && Number.isInteger(found.number)) pr = { number: found.number, url };
				} catch {
					// leave pr null
				}
			}
		}
		return {
			name: repo.name,
			path: repo.path,
			worktree: repo.worktree,
			branch: state.branch ?? null,
			base: state.base ?? null,
			host: state.host ?? "none",
			ahead: state.ahead ?? 0,
			dirty: state.dirty ?? 0,
			changed,
			touched: touched.has(repo.name),
			pr
		};
	}));
	return { root: cwd, repos: states };
}

// ---------------------------------------------------------------------------
// PR lookup by URL. A session only ever shows the PR it is linked to, never
// "whatever PR the folder's current branch has": a fresh session in a checkout
// left on an old branch would otherwise show that old, often merged, PR.

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

/** One `gh pr view` / `glab mr view` for a known PR (`target` is its URL, or number plus `-R project`). */
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

/** "owner/repo" from a PR or MR URL, for labels. */
export function repoOf(url) {
	const m = /^https:\/\/[^/]+\/(.+?)\/(?:pull|-\/merge_requests)\/\d+/.exec(url);
	return m === null ? "" : m[1];
}

/** Every distinct PR URL in the text, in the order written. */
function allUrls(text) {
	return [...new Set(text.match(PR_URL) ?? [])];
}

/**
 * Fold one session event into the linked PR URL. The latest of these wins:
 * - a PR URL in the human's own message (pasting a PR link);
 * - the PR URL printed by a `gh pr create` / `glab mr create` the agent ran.
 * Model text alone never links a PR, so a PR the agent merely mentions does not rename the session.
 * State: { url, pending: callIds of PR-creating commands awaiting their result }.
 */
/** Most PRs one session keeps; the oldest drop off first. */
export const MAX_LINKED = 12;

/** Put `url` first (most recent), dropping an earlier copy of it. Same reference when it is already first. */
function promote(urls, url) {
	if (urls[0] === url) return urls;
	return [url, ...urls.filter((u) => u !== url)].slice(0, MAX_LINKED);
}

/**
 * Fold one session event into the session's linked PRs, most recent first.
 * State: { url: the most recent, urls: every linked PR (most recent first),
 * pending: callIds of PR-creating commands awaiting their result }.
 * Unchanged events return the same state object (required by the projection registry).
 */
export function foldLink(state, event) {
	const data = event?.data;
	const urls = state.urls ?? (state.url ? [state.url] : []);
	switch (event?.type) {
		case "user/message": {
			if (data?.source?.kind !== "user") return state;
			const found = allUrls(textOf(data.content));
			if (found.length === 0) return state;
			// Several links in one message: keep them all, the last one written counts as most recent.
			let next = urls;
			for (const url of found) next = promote(next, url);
			return next === urls ? state : { ...state, url: next[0], urls: next };
		}
		case "tool/call": {
			if (typeof data?.callId !== "string" || !PR_CREATE.test(argumentText(data.arguments))) return state;
			return { ...state, urls, pending: [...state.pending, data.callId].slice(-8) };
		}
		case "tool/result": {
			const callId = data?.message?.toolCallId;
			if (!state.pending.includes(callId)) return state;
			const pending = state.pending.filter((id) => id !== callId);
			const url = data.message.isError === true ? null : lastUrl(textOf(data.message.content));
			const next = url === null ? urls : promote(urls, url);
			return { url: next[0] ?? null, urls: next, pending };
		}
		default:
			return state;
	}
}

const EMPTY_LINK = { url: null, urls: [], pending: [] };

/** The session's most recent linked PR URL, folded from its log. */
export function linkOf(events) {
	return events.reduce(foldLink, EMPTY_LINK).url;
}

/** Every PR URL the session is linked to, most recent first. */
export function linksOf(events) {
	return events.reduce(foldLink, EMPTY_LINK).urls ?? [];
}

/**
 * The link list as a session projection, so the client's session list (and the
 * sidebar hover card) carries it for every session, opened or not. Key and
 * state are plugin-owned; bump `stateVersion` when the state shape changes.
 */
export const LINK_KEY = "githubPrLinks";

const linkStateSchema = {
	parse(value) {
		const ok = value !== null && typeof value === "object"
			&& (value.url === null || typeof value.url === "string")
			&& Array.isArray(value.urls) && value.urls.every((u) => typeof u === "string")
			&& Array.isArray(value.pending) && value.pending.every((u) => typeof u === "string");
		if (!ok) throw new Error(`${LINK_KEY}: malformed state`);
		return value;
	}
};

const linkViewSchema = {
	parse(value) {
		if (!Array.isArray(value) || !value.every((u) => typeof u === "string")) throw new Error(`${LINK_KEY}: malformed view`);
		return value;
	}
};

export function linkProjection() {
	return {
		key: LINK_KEY,
		stateSchema: linkStateSchema,
		stateVersion: 1,
		init: () => EMPTY_LINK,
		apply: foldLink,
		// The view is the same array object until the list changes, so unrelated events publish nothing.
		wire: { viewSchema: linkViewSchema, view: (state) => state.urls ?? [] }
	};
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

	/**
	 * Every PR the session is linked to, most recent first, looked up in
	 * parallel. The most recent one found also becomes the session's title.
	 * `pr` stays the most recent one, for callers that show a single link.
	 */
	async function status(sessionId, maxAgeMs = 15000) {
		const session = sessions.get(sessionId);
		if (session === undefined) return { pr: null, prs: [], reason: "not-live" };
		const urls = linksOf(session.snapshotEvents());
		if (urls.length === 0) return { pr: null, prs: [], reason: "unlinked" };
		const cwd = session.header?.cwd ?? process.cwd();
		const found = await Promise.all(urls.map((url) => lookup(url, cwd, maxAgeMs).catch(() => null)));
		const prs = found.map((pr, i) => (pr === null ? null : { ...pr, repo: repoOf(urls[i]) })).filter((pr) => pr !== null);
		if (prs.length === 0) return { pr: null, prs: [], reason: "none", url: urls[0] };
		// Retitle only from the most recent link; if that one could not be read, leave the title alone.
		if (found[0] !== null) {
			// The rename appends to the log; never do it inside another append's publication.
			queueMicrotask(() => {
				if (sessions.get(sessionId) === session) retitle(session, found[0]);
			});
		}
		return { pr: prs[0], prs };
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

export const SESSION_STATUS_METHOD = "github.sessionPr";

// ---------------------------------------------------------------------------
// PR inbox: the GitHub tab's lists, from the gh login's own view of GitHub.

export const INBOX_METHOD = "github.inbox";
export const INBOX_LIMIT = 50;

/** One search per list. `sort:updated-desc` puts recent activity first. */
export const INBOX_QUERIES = {
	mine: "is:pr is:open author:@me archived:false sort:updated-desc",
	review: "is:pr is:open review-requested:@me archived:false sort:updated-desc"
};

const INBOX_GRAPHQL = `query($mine: String!, $review: String!, $first: Int!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: $first) { issueCount nodes { ...Pr } }
  review: search(query: $review, type: ISSUE, first: $first) { issueCount nodes { ...Pr } }
}
fragment Pr on PullRequest {
  number title url isDraft state updatedAt headRefName baseRefName
  author { login }
  repository { nameWithOwner owner { login } }
  reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const CHECKS = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending" };
const REVIEWS = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "required" };

/** Flatten one GraphQL PR node into what the page renders. Drops anything without an https URL. */
export function inboxRow(node) {
	const url = httpsUrl(node?.url);
	if (url === null || !Number.isInteger(node?.number)) return null;
	const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
	return {
		number: node.number,
		title: String(node.title ?? ""),
		url,
		repo: String(node.repository?.nameWithOwner ?? ""),
		owner: String(node.repository?.owner?.login ?? ""),
		author: String(node.author?.login ?? ""),
		state: node.isDraft ? "draft" : "open",
		head: String(node.headRefName ?? ""),
		base: String(node.baseRefName ?? ""),
		updatedAt: String(node.updatedAt ?? ""),
		checks: CHECKS[rollup] ?? null,
		review: REVIEWS[node.reviewDecision] ?? null
	};
}

function inboxList(search) {
	return {
		total: Number.isInteger(search?.issueCount) ? search.issueCount : 0,
		items: (search?.nodes ?? []).map(inboxRow).filter((row) => row !== null)
	};
}

/**
 * Read both lists with one `gh api graphql` call, using gh's own login and host.
 * @returns {Promise<{ok: true, login, fetchedAt, mine: {total, items}, review: {total, items}} | {ok: false, reason, message}>}
 */
export async function inbox(run = exec, now = () => new Date()) {
	const r = await run("gh", homedir(), [
		"api", "graphql",
		"-F", `first=${INBOX_LIMIT}`,
		"-F", `mine=${INBOX_QUERIES.mine}`,
		"-F", `review=${INBOX_QUERIES.review}`,
		"-f", `query=${INBOX_GRAPHQL}`
	], 20000);
	if (!r.ok) {
		if (r.missing) return { ok: false, reason: "gh-missing", message: "gh is not installed" };
		const auth = /auth|login|token|401/i.test(r.err);
		return { ok: false, reason: auth ? "gh-auth" : "gh-failed", message: (r.err || "gh api graphql failed").split("\n")[0].slice(0, 300) };
	}
	let body;
	try {
		body = JSON.parse(r.out);
	} catch {
		return { ok: false, reason: "gh-failed", message: "gh returned non-JSON output" };
	}
	const data = body?.data;
	if (data === undefined || data === null) {
		return { ok: false, reason: "gh-failed", message: String(body?.errors?.[0]?.message ?? "no data").slice(0, 300) };
	}
	return {
		ok: true,
		login: String(data.viewer?.login ?? ""),
		fetchedAt: now().toISOString(),
		mine: inboxList(data.mine),
		review: inboxList(data.review)
	};
}

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

export function inboxRoute(run = exec) {
	return payloadRoute(INBOX_METHOD, () => inbox(run));
}

/** The Create PR picker's scan. `sessionId` (optional) lets it read which repos the session touched. */
export function reposRoute(sessions, run = git, gh = exec) {
	return payloadRoute(REPOS_METHOD, ({ cwd, sessionId }) => {
		const session = typeof sessionId === "string" ? sessions?.get(sessionId) : undefined;
		return scanRepos(cwd, { events: session?.snapshotEvents() ?? [], run, gh });
	});
}

export function sessionStatusRoute(links) {
	return payloadRoute(SESSION_STATUS_METHOD, ({ sessionId, maxAgeMs }) => {
		if (typeof sessionId !== "string" || sessionId === "") throw new Error("sessionId is required");
		return links.status(sessionId, Number.isFinite(maxAgeMs) ? maxAgeMs : 15000);
	});
}

/**
 * Review workspace routes. `prepare` checks out the PR and returns the folder
 * plus the first message; the client creates the session there (so it gets the
 * same placeholder and navigation as a normal new session), then calls `bind`.
 */
export function reviewRoutes(workspaces, { reviewPrompt: prompt = reviewPromptFor } = {}) {
	return [
		payloadRoute(REVIEW_METHODS.prepare, async ({ url, mode }) => {
			const entry = await workspaces.prepare(url, mode);
			return { workspace: entry, prompt: prompt(entry, mode) };
		}),
		payloadRoute(REVIEW_METHODS.bind, async ({ path, sessionId }) => {
			if (typeof path !== "string" || typeof sessionId !== "string") throw new Error("path and sessionId are required");
			return workspaces.bind(path, sessionId);
		}),
		payloadRoute(REVIEW_METHODS.list, () => workspaces.list())
	];
}

/** Archived sessions and stored session ids, from the Host's own services. Both are optional. */
function hostSessionFacts(scope) {
	let stored = null;
	let storedAt = 0;
	const refreshStored = async () => {
		const persistence = scope.get("sessionPersistence");
		if (persistence === undefined) return;
		try {
			stored = new Set((await persistence.list()).map((s) => s.header.id));
			storedAt = Date.now();
		} catch (error) {
			scope.logger?.warn?.(`${name}: could not list stored sessions: ${error?.message ?? error}`);
		}
	};
	return {
		refreshStored,
		get storedAt() {
			return storedAt;
		},
		isArchived: (id) => (scope.get("workspaceRegistry")?.archivedSessionIds ?? []).includes(id),
		// Unknown (no persistence service, or not listed yet) counts as existing: never delete on a guess.
		sessionExists: (id) => stored === null || stored.has(id) || scope.get("sessions")?.get(id) !== undefined,
		sessionState: (id) => {
			const live = scope.get("sessions")?.get(id) !== undefined;
			const running = scope.get("agents")?.get(id)?.status === "running";
			return { live, running };
		}
	};
}

export const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** The create-PR templates, for the client (it fills them and falls back to its own text when empty). */
export function promptsRoute(config) {
	return payloadRoute(PROMPTS_METHOD, () => ({ createPrPrompt: config.createPrPrompt, multiRepoCreatePrPrompt: config.multiRepoCreatePrPrompt }));
}

/** Which leading `/name` skills of a prompt the session cannot load; `missing: null` when unknown. */
export function missingSkillsRoute(getCatalog) {
	return payloadRoute(SKILLS_METHOD, async ({ sessionId, text }) => {
		if (typeof sessionId !== "string" || typeof text !== "string") throw new Error("sessionId and text are required");
		return { missing: await missingSkills(getCatalog(), sessionId, text) };
	});
}

export function apply(ctx, input) {
	const config = resolveConfig(input);
	ctx.inject(["connection"], (scope) => {
		const connection = scope.get("connection");
		// sessionSkillCatalog (api-session-controller, `skills/list`) is optional: read it lazily.
		for (const route of [preflightRoute(), inboxRoute(), promptsRoute(config), missingSkillsRoute(() => scope.get("sessionSkillCatalog"))]) {
			scope.effect(() => connection.fetch.register(route), `${name}: ${route.path} route`);
		}
		const facts = hostSessionFacts(scope);
		const workspaces = createReviewWorkspaces({
			sessionState: facts.sessionState,
			isArchived: facts.isArchived,
			sessionExists: facts.sessionExists,
			logger: scope.logger ?? console
		});
		const sweep = async () => {
			await facts.refreshStored();
			const result = await workspaces.sweep();
			if (result.removed.length > 0) scope.logger?.info?.(`${name}: recycled ${result.removed.length} review workspace(s)`);
			return result;
		};
		const routes = reviewRoutes({ ...workspaces, sweep, list: async () => { await facts.refreshStored(); return workspaces.list(); } }, { reviewPrompt: (entry, mode) => reviewPromptFor(entry, mode, config) });
		for (const route of routes) scope.effect(() => connection.fetch.register(route), `${name}: ${route.path} route`);
		// Recycle on startup and every six hours; an archived review session frees its folder on the next pass.
		scope.effect(() => {
			const first = setTimeout(() => { sweep().catch((e) => scope.logger?.warn?.(`${name}: sweep failed: ${e?.message ?? e}`)); }, 30000);
			const timer = setInterval(() => { sweep().catch((e) => scope.logger?.warn?.(`${name}: sweep failed: ${e?.message ?? e}`)); }, SWEEP_EVERY_MS);
			first.unref?.();
			timer.unref?.();
			return () => {
				clearTimeout(first);
				clearInterval(timer);
			};
		}, `${name}: review workspace recycling`);
		// A review that is still being worked on should not expire.
		scope.on?.("session/event", (session, event) => {
			if (event?.type === "turn/end") workspaces.touch(session.id).catch(() => {});
		});
	});
	// Session-to-PR link and title sync. Needs the live session store; the title
	// service is optional (without it the link still shows, the title does not change).
	ctx.inject(["connection", "sessions"], (scope) => {
		const links = createLinkManager({ sessions: scope.get("sessions"), titles: scope.get("sessionTitle"), logger: scope.logger ?? console });
		scope.effect(() => scope.get("connection").fetch.register(sessionStatusRoute(links)), `${name}: /api/${SESSION_STATUS_METHOD} route`);
		scope.effect(() => scope.get("connection").fetch.register(reposRoute(scope.get("sessions"))), `${name}: /api/${REPOS_METHOD} route`);
		scope.on("session/event", (session, event) => links.onEvent(session, event));
		scope.on("session/created", (session) => links.onLive(session));
	});
	// Every session's PR list as a projection, so the sidebar hover card can show it without opening the session.
	ctx.inject(["sessionProjections"], (scope) => {
		scope.sessionProjections.register(linkProjection());
	});
}
