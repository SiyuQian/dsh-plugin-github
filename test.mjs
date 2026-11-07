// Self-check with stubs: verifies wiring against the APIs read from the app source, not the real app.
// The preflight tests run real git in throwaway repos under the OS temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PREFLIGHT_METHOD, PROMPTS_METHOD, SKILLS_METHOD, REVIEW_METHODS, PROMPT_DEFAULTS, Config, resolveConfig, fillTemplate, leadingSkills, missingSkills, missingSkillsRoute, promptsRoute,
	INBOX_METHOD, INBOX_QUERIES, LINK_KEY, REPOS_METHOD, SESSION_STATUS_METHOD, apply, argumentText, inbox, inboxRow, createLinkManager, foldLink, hostOf, linkOf, nextTitle,
	prByUrl, preflight, preflightRoute, prTitle, sessionStatusRoute
} from "./lib/index.js";

let mod;
const stubPrimitives = { Tooltip: "Tooltip", Menu: "Menu", Modal: "Modal", Button: "Button", Checkbox: "Checkbox", IconBranchOutlineRegular: "Icon", IconRefreshOutlineRegular: "Icon", IconChevronDownOutlineRegular: "Icon" };
// Effects run synchronously on "render" so tests can see the lookups they trigger.
const stubReact = { createElement: (type, props, ...children) => ({ type, props, children }), useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: (fn) => { fn(); } };
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory((n) => ({ react: stubReact, "@deepseek-ai/dsh-client-ui-primitives": stubPrimitives })[n] ?? null); } } };
new Function(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"))();

// --- no skills; prompt config -----------------------------------------------

test("the package ships no skills and no vendored copies", () => {
	const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
	assert.deepEqual(pkg.files.filter((f) => f === "vendor" || f === "skills"), []);
	assert.equal(pkg.scripts["sync-devpilot"], undefined);
	for (const dir of ["vendor", "skills"]) assert.equal(existsSync(new URL(`./${dir}`, import.meta.url)), false, dir);
});

test("config defaults keep today's prompts; partial config fills the rest", () => {
	assert.deepEqual(resolveConfig(undefined), PROMPT_DEFAULTS);
	assert.deepEqual(Config({}), PROMPT_DEFAULTS);
	assert.match(PROMPT_DEFAULTS.reviewPrompt, /^\/pr-explain \/pr-review \{url\}\n/);
	assert.match(PROMPT_DEFAULTS.explainPrompt, /^\/pr-explain \{url\}\n/);
	assert.equal(PROMPT_DEFAULTS.createPrPrompt, "", "empty = the built-in locale text");
	const c = resolveConfig({ reviewPrompt: "/my-review {url}", createPrPrompt: 7 });
	assert.equal(c.reviewPrompt, "/my-review {url}");
	assert.equal(c.createPrPrompt, "");
	assert.equal(c.explainPrompt, PROMPT_DEFAULTS.explainPrompt);
});

test("templates: known placeholders filled, unknown kept", () => {
	assert.equal(fillTemplate("{a} {b} {a}", { a: 1 }), "1 {b} 1");
});

test("leading skill tokens", () => {
	assert.deepEqual(leadingSkills("/pr-explain /pr-review https://x"), ["pr-explain", "pr-review"]);
	assert.deepEqual(leadingSkills("  /pr-creator Create"), ["pr-creator"]);
	assert.deepEqual(leadingSkills("Please run /pr-creator"), []);
});

test("missingSkills: reads the session skill catalog; unknown is null", async () => {
	const catalog = { list: async ({ sessionId }) => { assert.equal(sessionId, "s1"); return { skills: [{ name: "pr-explain" }] }; } };
	assert.deepEqual(await missingSkills(catalog, "s1", "/pr-explain /pr-review u"), ["pr-review"]);
	assert.deepEqual(await missingSkills(catalog, "s1", "no tokens"), []);
	assert.equal(await missingSkills(undefined, "s1", "/pr-review u"), null);
	assert.equal(await missingSkills({ list: async () => { throw new Error("x"); } }, "s1", "/pr-review u"), null);
});

test("prompt and skill routes", async () => {
	const prompts = promptsRoute(resolveConfig({ createPrPrompt: "/x go" }));
	assert.equal(prompts.path, `/api/${PROMPTS_METHOD}`);
	const skills = missingSkillsRoute(() => ({ list: async () => ({ skills: [] }) }));
	assert.equal(skills.path, `/api/${SKILLS_METHOD}`);
});

// --- preflight --------------------------------------------------------------

function sh(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** origin (bare) + a clone with origin/HEAD set, as `git clone` leaves it. */
function repoPair() {
	const root = mkdtempSync(join(tmpdir(), "create-pr-test-"));
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	sh(root, "init", "--bare", "-b", "main", origin);
	sh(root, "init", "-b", "main", work);
	writeFileSync(join(work, "a.txt"), "a\n");
	sh(work, "add", ".");
	sh(work, "commit", "-m", "init");
	sh(work, "remote", "add", "origin", origin);
	sh(work, "push", "-q", "-u", "origin", "main");
	sh(work, "remote", "set-head", "origin", "-a");
	return { root, work };
}

test("hostOf reads the origin URL, SSH aliases included", () => {
	assert.equal(hostOf("git@github.com:a/b.git"), "github");
	assert.equal(hostOf("github-work:a/b.git"), "github");
	assert.equal(hostOf("https://gitlab.example.com/a/b"), "gitlab");
	assert.equal(hostOf("/tmp/origin.git"), "other");
	assert.equal(hostOf(""), "none");
});

test("preflight: not a repo", async () => {
	const dir = mkdtempSync(join(tmpdir(), "create-pr-test-"));
	try {
		assert.deepEqual(await preflight(dir), { status: "not-a-repo" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preflight: clean branch level with base, then ahead, then dirty", async () => {
	const { root, work } = repoPair();
	try {
		let state = await preflight(work);
		assert.equal(state.status, "ok");
		assert.equal(state.base, "origin/main");
		assert.equal(state.ahead, 0);
		assert.equal(state.dirty, 0);

		sh(work, "checkout", "-q", "-b", "feat/x");
		writeFileSync(join(work, "b.txt"), "b\n");
		sh(work, "add", ".");
		sh(work, "commit", "-q", "-m", "feat: b");
		state = await preflight(work);
		assert.equal(state.branch, "feat/x");
		assert.equal(state.ahead, 1);

		writeFileSync(join(work, "c.txt"), "c\n");
		state = await preflight(work);
		assert.equal(state.dirty, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preflight rejects a relative cwd", async () => {
	await assert.rejects(preflight("relative/path"), /absolute/);
});

test("route answers the client-request envelope", async () => {
	const route = preflightRoute(async () => ({ ok: false, out: "", err: "" }));
	assert.equal(route.path, `/api/${PREFLIGHT_METHOD}`);
	const call = async (body) => (await route.fetch(new Request("http://x" + route.path, { method: "POST", body: JSON.stringify(body) }))).json();
	const ok = await call({ type: "client-request", rpcId: "r1", method: PREFLIGHT_METHOD, payload: { cwd: "/x" } });
	assert.deepEqual(ok, { type: "server-response", rpcId: "r1", result: { ok: true, value: { status: "not-a-repo" } } });
	const wrong = await call({ rpcId: "r2", method: "other" });
	assert.equal(wrong.result.ok, false);
	const relative = await call({ rpcId: "r3", method: PREFLIGHT_METHOD, payload: { cwd: "x" } });
	assert.equal(relative.result.ok, false);
	assert.match(relative.result.error.message, /absolute/);
});

test("host apply registers no skill provider, only routes and session listeners", () => {
	const seen = [];
	const scope = {
		skills: { registerProvider: () => seen.push(["provider"]) },
		get: (n) => ({
			connection: { fetch: { register: (route) => seen.push(["route", route.path]) } },
			sessions: { get: () => undefined }
		})[n],
		sessionProjections: { register: (def) => seen.push(["projection", def.key]) },
		effect: (fn) => fn(),
		on: (event) => seen.push(["on", event])
	};
	const realSetTimeout = globalThis.setTimeout;
	const realSetInterval = globalThis.setInterval;
	const timers = [];
	globalThis.setTimeout = (fn, ms) => { timers.push(["timeout", ms]); return { unref() {} }; };
	globalThis.setInterval = (fn, ms) => { timers.push(["interval", ms]); return { unref() {} }; };
	try {
		apply({ inject: (deps, cb) => { assert.ok(!deps.includes("skills")); cb(scope); } }, {});
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.setInterval = realSetInterval;
	}
	assert.deepEqual(seen, [
		["route", `/api/${PREFLIGHT_METHOD}`],
		["route", `/api/${INBOX_METHOD}`],
		["route", `/api/${PROMPTS_METHOD}`],
		["route", `/api/${SKILLS_METHOD}`],
		...Object.values(REVIEW_METHODS).map((m) => ["route", `/api/${m}`]),
		["on", "session/event"],
		["route", `/api/${SESSION_STATUS_METHOD}`],
		["route", `/api/${REPOS_METHOD}`],
		["on", "session/event"],
		["on", "session/created"],
		["projection", LINK_KEY]
	]);
	assert.deepEqual(timers, [["timeout", 30000], ["interval", 6 * 60 * 60 * 1000]], "recycling runs shortly after start, then every six hours");
});

// --- session link and title -------------------------------------------------

const userMsg = (text, kind = "user") => ({ type: "user/message", data: { content: [{ type: "text", text }], source: { kind } } });
const call = (callId, command) => ({ type: "tool/call", data: { callId, name: "bash", arguments: JSON.stringify({ description: "d", command }) } });
const result = (callId, text, isError = false) => ({ type: "tool/result", data: { message: { toolCallId: callId, content: [{ type: "text", text }], isError } } });
const titleEv = (title, kind) => ({ type: "session/title", data: { title, messageSeqs: [], source: { kind } } });
const U191 = "https://github.com/example-org/web-app/pull/191";
const U192 = "https://github.com/example-org/web-app/pull/192";

test("link: a PR URL pasted in your message links the session", () => {
	assert.equal(linkOf([userMsg(`${U191}\n用 asd-ste100 改进一下文档`)]), U191);
	assert.equal(linkOf([userMsg(`see ${U191}/files#diff-1`)]), U191, "deep links trim to the PR");
	assert.equal(linkOf([userMsg(U191, "skill-invocation")]), null, "only direct human input counts");
});

test("link: the URL printed by gh pr create links the session; the latest wins", () => {
	const create = "cat > /tmp/b.md <<'EOF'\nbody\nEOF\ngh pr create --base next --draft --title \"x\" --body-file /tmp/b.md 2>&1 | tail -1";
	assert.equal(linkOf([userMsg(U191), call("c1", create), result("c1", `${U192}\n`)]), U192);
	assert.equal(linkOf([call("c1", create), result("c1", "", true)]), null, "a failed create links nothing");
});

test("link: viewing, editing, or asking for help about other PRs does not relink", () => {
	const events = [
		userMsg(U191),
		call("v", `gh pr view ${U192} --json title`), result("v", U192),
		call("e", `gh pr edit 192 --body-file x`), result("e", U192),
		call("h", "gh pr create --help"), result("h", `see ${U192}`),
		{ type: "assistant/message", data: { message: { content: [{ type: "text", text: `Opened ${U192}` }] } } }
	];
	assert.equal(linkOf(events), U191);
});

test("link: tool arguments are read as text, so a newline before gh pr create still matches", () => {
	assert.match(argumentText(JSON.stringify({ command: "echo a\ngh pr create --fill" })), /\ngh pr create/);
	assert.equal(argumentText("not json"), "not json");
});

test("link: GitLab MR URLs", () => {
	const mr = "https://gitlab.example.com/group/sub/project/-/merge_requests/12";
	assert.equal(linkOf([userMsg(`${mr}/diffs`)]), mr);
});

test("title: '#191 <PR title>'; replaces automatic titles and our own, never one you typed", () => {
	const pr = { number: 191, title: "docs: Add harness docs", state: "open", url: U191 };
	assert.equal(prTitle(pr), "#191 docs: Add harness docs");
	assert.equal(nextTitle([titleEv("用ASD-STE100改进PR文档", "provider")], pr), "#191 docs: Add harness docs");
	assert.equal(nextTitle([titleEv("x", "fallback")], pr), "#191 docs: Add harness docs");
	assert.equal(nextTitle([], pr), "#191 docs: Add harness docs");
	assert.equal(nextTitle([titleEv("#191 docs: Add harness docs", "user")], pr), null, "already applied");
	assert.equal(nextTitle([titleEv("#191 docs: Add har", "user")], pr), null, "a title cut at the byte cap counts as applied");
	assert.equal(nextTitle([titleEv("#191 old PR title", "user")], pr), "#191 docs: Add harness docs", "follows a PR rename");
	assert.equal(nextTitle([titleEv("迁移进度与测试UAT环境调查 (1)", "user")], pr), null, "your own title stays");
	assert.equal(nextTitle([titleEv("Mine", "user")], pr, new Set(["Mine"])), "#191 docs: Add harness docs", "titles we wrote are ours to replace");
});

function liveSession(id, events, depth = 0) {
	return { id, header: { cwd: "/ws", delegationDepth: depth }, snapshotEvents: () => events };
}

test("link manager: looks up the linked PR by URL from any folder and retitles", async () => {
	const events = [titleEv("auto", "provider"), userMsg(U191)];
	const session = liveSession("s1", events);
	const renames = [];
	const { run, calls } = fakeCli({ gh: ok({ number: 191, url: U191, state: "OPEN", isDraft: true, title: "docs: Add harness docs" }) });
	const links = createLinkManager({ sessions: { get: (id) => (id === "s1" ? session : undefined) }, titles: { rename: (s, t) => { renames.push([s.id, t]); return { title: t }; } }, run });
	const r = await links.status("s1", 0);
	const one = { number: 191, url: U191, state: "draft", title: "docs: Add harness docs", repo: "example-org/web-app" };
	assert.deepEqual(r, { pr: one, prs: [one] });
	assert.deepEqual(calls[0], ["gh", "pr", "view", U191, "--json", "number,url,state,isDraft,title"], "by URL, so a parent workspace folder works");
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(renames, [["s1", "#191 docs: Add harness docs"]]);
	assert.ok(links.ours.has("#191 docs: Add harness docs"));
});

test("link manager: cache, unlinked, not live, subagent", async () => {
	const { run, calls } = fakeCli({ gh: ok({ number: 191, url: U191, state: "OPEN", isDraft: false, title: "t" }) });
	const sessions = new Map([
		["s1", liveSession("s1", [userMsg(U191)])],
		["s2", liveSession("s2", [userMsg("hello")])],
		["sub", liveSession("sub", [userMsg(U191)], 1)]
	]);
	const renames = [];
	const links = createLinkManager({ sessions, titles: { rename: (s, t) => { renames.push(s.id); return { title: t }; } }, run });
	await links.status("s1", 60000);
	await links.status("s1", 60000);
	assert.equal(calls.length, 1, "second lookup within maxAge is cached");
	assert.deepEqual(await links.status("s2"), { pr: null, prs: [], reason: "unlinked" });
	assert.deepEqual(await links.status("gone"), { pr: null, prs: [], reason: "not-live" });
	await links.status("sub", 0);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(renames, ["s1"], "subagent sessions are never retitled");
});

test("link manager: no title service still answers the link", async () => {
	const { run } = fakeCli({ gh: ok({ number: 191, url: U191, state: "MERGED", isDraft: false, title: "t" }) });
	const links = createLinkManager({ sessions: new Map([["s1", liveSession("s1", [userMsg(U191)])]]), titles: undefined, run });
	assert.equal((await links.status("s1")).pr.state, "merged");
});

test("prByUrl: GitLab passes the project and MR number to glab", async () => {
	const { run, calls } = fakeCli({ glab: ok({ iid: 12, web_url: "https://gitlab.com/g/p/-/merge_requests/12", state: "merged", title: "m" }) });
	assert.equal((await prByUrl("https://gitlab.com/g/p/-/merge_requests/12", "/ws", run)).pr.state, "merged");
	assert.deepEqual(calls[0], ["glab", "mr", "view", "12", "-R", "g/p", "-F", "json"]);
});

test("session status route requires a session id", async () => {
	const route = sessionStatusRoute({ status: async (id, age) => ({ id, age }) });
	const post = async (payload) => (await route.fetch(new Request("http://x" + route.path, { method: "POST", body: JSON.stringify({ rpcId: "r", method: SESSION_STATUS_METHOD, payload }) }))).json();
	assert.deepEqual((await post({ sessionId: "s1" })).result, { ok: true, value: { id: "s1", age: 15000 } });
	assert.equal((await post({})).result.ok, false);
});

test("real log: the plugin-dev session is not linked by its own gh pr view runs", () => {
	const cmd = "gh pr view https://github.com/example-org/web-app/pull/191 --json number,url 2>&1; gh pr edit --help | grep -i url";
	assert.equal(linkOf([call("c", cmd), result("c", U191)]), null);
});

// --- PR status --------------------------------------------------------------

/** Fake CLI: answers by executable name; records calls. */
function fakeCli(answers) {
	const calls = [];
	const run = async (file, cwd, args) => {
		calls.push([file, ...args]);
		const answer = answers[file];
		return typeof answer === "function" ? answer(args) : answer ?? { ok: false, missing: true, out: "", err: "" };
	};
	return { run, calls };
}
const ok = (value) => ({ ok: true, missing: false, out: typeof value === "string" ? value : JSON.stringify(value), err: "" });
const fail = { ok: false, missing: false, out: "", err: "no pull requests found" };

const P7 = "https://github.com/o/r/pull/7";

test("prByUrl: GitHub open, draft, merged, closed", async () => {
	const cases = [
		[{ state: "OPEN", isDraft: false }, "open"],
		[{ state: "OPEN", isDraft: true }, "draft"],
		[{ state: "MERGED", isDraft: false }, "merged"],
		[{ state: "CLOSED", isDraft: true }, "closed"]
	];
	for (const [extra, want] of cases) {
		const { run, calls } = fakeCli({ gh: ok({ number: 7, url: P7, title: "feat: x", ...extra }) });
		assert.deepEqual(await prByUrl(P7, "/ws", run), { pr: { number: 7, url: P7, state: want, title: "feat: x" } });
		assert.deepEqual(calls[0], ["gh", "pr", "view", P7, "--json", "number,url,state,isDraft,title"]);
	}
});

test("prByUrl: not found, gh missing, other host", async () => {
	assert.deepEqual(await prByUrl(P7, "/ws", fakeCli({ gh: fail }).run), { pr: null, reason: "none" });
	assert.deepEqual(await prByUrl(P7, "/ws", fakeCli({}).run), { pr: null, reason: "gh-missing" });
	assert.deepEqual(await prByUrl("https://bitbucket.org/o/r/pull-requests/1", "/ws", fakeCli({}).run), { pr: null, reason: "unsupported-host" });
});

test("prByUrl never passes a non-https URL to the page", async () => {
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://github.com/o/r/pull/1", "https://user:pw@github.com/o/r/pull/1"]) {
		const { run } = fakeCli({ gh: ok({ number: 1, url, state: "OPEN", isDraft: false, title: "t" }) });
		assert.deepEqual(await prByUrl(P7, "/ws", run), { pr: null, reason: "bad-output" }, url);
	}
});

test("a new session never shows the PR of the folder's current branch", async () => {
	// The bug: a fresh session in a checkout left on a merged branch showed that branch's PR (#150).
	const calls = [];
	const ctx = {
		get: (n) => ({
			connection: { rpc: { call: async (ch, method, payload) => { calls.push([method, payload]); return { ok: true, value: { pr: null, reason: "unlinked" } }; } } },
			sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: "/repo/on/old/branch" } } }) } }
		})[n]
	};
	assert.deepEqual(await mod.fetchPrStatus(ctx, "s1"), []);
	assert.deepEqual(calls, [[SESSION_STATUS_METHOD, { sessionId: "s1" }]], "only the session's own link is asked for");
});

test("status store: caches by key, skips fresh entries, keeps last link on failure", async () => {
	let clock = 1000;
	const answers = [{ number: 1, url: "https://github.com/o/r/pull/1", state: "open", title: "a" }];
	let calls = 0;
	const store = mod.createStatusStore(async () => {
		calls += 1;
		const next = answers.shift();
		if (next instanceof Error) throw next;
		return next;
	}, () => clock);
	let notified = 0;
	store.subscribe(() => { notified += 1; });
	await store.refresh("/repo", 0);
	assert.equal(store.getSnapshot()["/repo"].pr.number, 1);
	assert.equal(notified, 1);
	await store.refresh("/repo", 15000);
	assert.equal(calls, 1, "fresh entry is not looked up again");
	clock += 20000;
	answers.push(new Error("gh down"));
	const warn = console.warn; console.warn = () => {};
	await store.refresh("/repo", 15000);
	console.warn = warn;
	assert.equal(calls, 2);
	assert.equal(store.getSnapshot()["/repo"].pr.number, 1, "a failed lookup keeps the last known link");
	answers.push(null);
	await store.refresh("/repo", 0);
	assert.equal(store.getSnapshot()["/repo"].pr, null, "a successful 'no PR' answer clears it");
	assert.equal(notified, 2);
	await store.refresh(undefined, 0);
	assert.equal(calls, 3, "no folder, no lookup");
});

test("status store: concurrent refreshes share one lookup", async () => {
	let calls = 0;
	let release;
	const store = mod.createStatusStore(() => { calls += 1; return new Promise((r) => { release = r; }); });
	const a = store.refresh("/repo", 0);
	const b = store.refresh("/repo", 0);
	release(null);
	await Promise.all([a, b]);
	assert.equal(calls, 1);
});

// --- client -----------------------------------------------------------------

const t = (key, params = {}) => mod.en[key].replace(/\{(\w+)\}/g, (_, k) => params[k]);

function clientCtx({ cwd = "/repo", preflightResult, sent = [], rpcThrows = false, repos, calls = [], prompts = {}, missing = [] }) {
	const conversation = { send: async (text) => { sent.push(text); }, input: { for: () => ({ notify() {} }) } };
	return {
		get: (n) => ({
			connection: { rpc: { call: async (ch, m, payload) => {
				calls.push([m, payload]);
				if (rpcThrows) throw new Error("offline");
				assert.equal(ch, "/api");
				if (m === REPOS_METHOD) return { ok: true, value: repos };
				if (m === PROMPTS_METHOD) return { ok: true, value: prompts };
				if (m === SKILLS_METHOD) return { ok: true, value: { missing } };
				assert.equal(m, PREFLIGHT_METHOD);
				assert.deepEqual(payload, { cwd });
				return preflightResult;
			} } },
			sessions: {
				list: { getSnapshot: () => ({ byId: { s1: { cwd } } }) },
				scope: (id) => id === "s1" ? { get: (k) => k === "conversation" ? conversation : undefined } : undefined
			}
		})[n]
	};
}

test("sends a /pr-creator prompt when there is work to PR", async () => {
	const sent = [];
	const ctx = clientCtx({ sent, preflightResult: { ok: true, value: { status: "ok", branch: "feat/x", base: "origin/main", ahead: 2, dirty: 0 } } });
	assert.deepEqual(await mod.createPr(ctx, "s1", t), { kind: "sent" });
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^\/pr-creator\s/, "the leading token is what makes the Host inject the skill");
});

test("both prompts open with the skill token", () => {
	for (const dict of [mod.en, mod.zh]) assert.match(dict.prompt, /^\/pr-creator\s/);
	assert.deepEqual(Object.keys(mod.zh).sort(), Object.keys(mod.en).sort());
});

test("configured create-PR prompt replaces the built-in text", async () => {
	const sent = [];
	const ok = { ok: true, value: { status: "ok", branch: "f", base: "origin/main", ahead: 1, dirty: 0 } };
	await mod.createPr(clientCtx({ sent, preflightResult: ok, prompts: { createPrPrompt: "/ship it" } }), "s1", t);
	assert.deepEqual(sent, ["/ship it"]);
	const multi = mod.multiPrompt(t, "/ws", [{ name: "a", path: "/ws/a", branch: "b", pr: null }], "/x {n} {root}\n{list}");
	assert.equal(multi, "/x 1 /ws\n1. `a` (`/ws/a`, b)");
});

test("a missing skill shows the install notice instead of sending", async () => {
	const sent = [];
	const ok = { ok: true, value: { status: "ok", branch: "f", base: "origin/main", ahead: 1, dirty: 0 } };
	const outcome = await mod.createPr(clientCtx({ sent, preflightResult: ok, missing: ["pr-creator"] }), "s1", t);
	assert.deepEqual(outcome, { kind: "stop", text: "Install a plugin that provides /pr-creator" });
	assert.equal(sent.length, 0);
	assert.equal(mod.zh.missingSkill.replace("{names}", "/pr-creator"), "需要安装提供 /pr-creator 的插件");
});

test("stops without sending when the folder is not a repo and holds none", async () => {
	const sent = [];
	const outcome = await mod.createPr(clientCtx({ sent, preflightResult: { ok: true, value: { status: "not-a-repo" } }, repos: { root: "/repo", repos: [] } }), "s1", t);
	assert.equal(outcome.kind, "stop");
	assert.equal(outcome.text, mod.en.notRepo);
	assert.equal(sent.length, 0);
});

test("stops without sending when nothing is ahead and nothing is dirty", async () => {
	const sent = [];
	const outcome = await mod.createPr(clientCtx({ sent, preflightResult: { ok: true, value: { status: "ok", branch: "main", base: "origin/main", ahead: 0, dirty: 0 } } }), "s1", t);
	assert.equal(outcome.kind, "stop");
	assert.match(outcome.text, /main has no commits ahead of origin\/main/);
	assert.equal(sent.length, 0);
});

test("dirty tree on main still sends (the skill branches off main itself)", async () => {
	const sent = [];
	await mod.createPr(clientCtx({ sent, preflightResult: { ok: true, value: { status: "ok", branch: "main", base: "origin/main", ahead: 0, dirty: 3 } } }), "s1", t);
	assert.equal(sent.length, 1);
});

test("an unreachable preflight does not block the PR", async () => {
	const sent = [];
	await mod.createPr(clientCtx({ sent, rpcThrows: true }), "s1", t);
	assert.equal(sent.length, 1);
});

test("client apply puts the button in the composer, left of the model selector", () => {
	const registered = [];
	const ctx = {
		effect: (fn) => fn(),
		locale: { register: () => () => {}, bind: () => t },
		slots: { inject: (_name, fn) => { fn(); }, register: (opts, component) => registered.push([opts, component]) }
	};
	mod.apply(ctx);
	assert.deepEqual(registered.map(([o]) => o.name), ["sidebar.panellist", "main", "conversation.input.right", "sidebar.session.row.hover"]);
	const [opts, component] = registered.find(([o]) => o.name === "conversation.input.right");
	assert.equal(opts.name, mod.SLOT);
	assert.equal(opts.id, "create-pr");
	assert.equal(opts.locale, "createPr");
	const injected = opts.inject();
	assert.equal(typeof injected.run, "function");
	assert.equal(typeof injected.refreshStatus, "function");
	assert.equal(typeof injected.hooks.prStatus.getSnapshot, "function", "becomes the usePrStatus hook");
	assert.equal(typeof injected.hooks.prStatus.subscribe, "function");
	assert.equal(component, mod.CreatePrAction);
});

function renderAction({ running = false, origin = "user", cwd = "/repo", status = {} } = {}) {
	const runs = [];
	const refreshes = [];
	const group = mod.CreatePrAction({
		sessionId: "s1",
		useSession: (select) => select({ running }),
		useSessions: (select) => select({ byId: { s1: { origin, cwd } } }),
		usePrStatus: (select) => select(status),
		refreshStatus: (dir, maxAge) => { refreshes.push([dir, maxAge]); },
		run: async (id) => { runs.push(id); },
		t
	});
	if (group === null) return { tree: null, link: null, runs, refreshes };
	assert.equal(group.type, "span");
	const [link, tree] = group.children;
	return { tree, link, runs, refreshes };
}

const PR = { number: 191, url: "https://github.com/example-org/web-app/pull/191", state: "open", title: "docs: Add harness docs" };

test("composer button: idle, labelled, keeps focus, runs for its session", () => {
	const { tree, link, runs, refreshes } = renderAction();
	assert.equal(link, null, "no PR, no link");
	assert.deepEqual(refreshes, [["s1", 0]], "looks up the session's PR when shown");
	assert.equal(tree.type, "Tooltip");
	assert.equal(tree.props.label, mod.en.hint);
	assert.equal(tree.props.side, "top", "tooltip opens upward from the composer");
	const button = tree.children[0];
	assert.equal(button.type, "button");
	assert.equal(button.props.className, "dsh-create-pr");
	assert.equal(button.props.disabled, false);
	assert.equal(button.props["aria-label"], mod.en.button);
	let prevented = false;
	button.props.onMouseDown({ preventDefault: () => { prevented = true; } });
	assert.ok(prevented, "pressing the button must not steal focus from the composer");
	const label = button.children.find((c) => c.props?.className === "dsh-create-pr-label");
	assert.deepEqual(label.children, [mod.en.button]);
	button.props.onClick();
	assert.deepEqual(runs, ["s1"]);
});

test("composer button: disabled with the busy hint while the agent runs, no lookup mid-turn", () => {
	const { tree, refreshes } = renderAction({ running: true });
	assert.equal(tree.props.label, mod.en.busy);
	assert.equal(tree.children[0].props.disabled, true);
	assert.deepEqual(refreshes, []);
});

test("composer button: hidden in subagent sessions", () => {
	const { tree, refreshes } = renderAction({ origin: "subagent" });
	assert.equal(tree, null);
	assert.deepEqual(refreshes, []);
});

test("PR link: shown left of the button, opens the PR in a new browser window", () => {
	const { tree, link } = renderAction({ status: { s1: { pr: PR, at: 0 } } });
	assert.equal(link.type, mod.PrLink);
	const rendered = mod.PrLink({ ...link.props });
	assert.equal(rendered.type, "Tooltip");
	assert.equal(rendered.props.label, "Open PR #191 (open) in the browser: docs: Add harness docs");
	const anchor = rendered.children[0];
	assert.equal(anchor.type, "a");
	assert.equal(anchor.props.href, PR.url);
	assert.equal(anchor.props.target, "_blank", "desktop hands _blank https links to the default browser");
	assert.equal(anchor.props.rel, "noopener noreferrer");
	assert.equal(anchor.children.at(-1), "#191");
	assert.equal(anchor.children[0].props["data-state"], "open");
	const label = tree.children[0].children.find((c) => c.props?.className === "dsh-create-pr-label");
	assert.deepEqual(label.children, [mod.en.update], "an open PR turns the button into Update PR");
});

test("PR link: merged PR still links, button goes back to Create PR", () => {
	const { tree, link } = renderAction({ status: { s1: { pr: { ...PR, state: "merged" }, at: 0 } } });
	assert.equal(link.props.pr.state, "merged");
	const label = tree.children[0].children.find((c) => c.props?.className === "dsh-create-pr-label");
	assert.deepEqual(label.children, [mod.en.button]);
});

test("PR link: another session's PR is not shown", () => {
	const { link } = renderAction({ status: { s2: { pr: PR, at: 0 } } });
	assert.equal(link, null);
});

test("both locales carry every key, including the state names", () => {
	assert.deepEqual(Object.keys(mod.zh).sort(), Object.keys(mod.en).sort());
	for (const s of ["open", "draft", "merged", "closed"]) assert.ok(mod.en[`state.${s}`] && mod.zh[`state.${s}`]);
});

// --- GitHub tab: inbox --------------------------------------------------------

const node = (over = {}) => ({
	number: 192, title: "ABC-191: Promote", url: "https://github.com/example-org/web-app/pull/192",
	isDraft: false, state: "OPEN", updatedAt: "2026-11-03T22:18:40Z", headRefName: "feature/x", baseRefName: "next",
	author: { login: "SiyuQian" }, repository: { nameWithOwner: "example-org/web-app", owner: { login: "example-org" } },
	reviewDecision: "REVIEW_REQUIRED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
	...over
});

test("inbox row: flattens state, checks, review; drops non-https", () => {
	assert.deepEqual(inboxRow(node()), {
		number: 192, title: "ABC-191: Promote", url: "https://github.com/example-org/web-app/pull/192",
		repo: "example-org/web-app", owner: "example-org", author: "SiyuQian", state: "open",
		head: "feature/x", base: "next", updatedAt: "2026-11-03T22:18:40Z", checks: "failure", review: "required"
	});
	assert.equal(inboxRow(node({ isDraft: true, reviewDecision: null, commits: { nodes: [] } })).state, "draft");
	assert.equal(inboxRow(node({ reviewDecision: null })).review, null);
	assert.equal(inboxRow(node({ url: "javascript:alert(1)" })), null);
	assert.equal(inboxRow({}), null, "a non-PR search hit is skipped");
});

test("inbox: one gh api graphql call with both searches, parsed into two lists", async () => {
	const body = { data: { viewer: { login: "SiyuQian" }, mine: { issueCount: 137, nodes: [node(), {}] }, review: { issueCount: 0, nodes: [] } } };
	const { run, calls } = fakeCli({ gh: ok(body) });
	const r = await inbox(run, () => new Date("2026-11-04T00:00:00Z"));
	assert.equal(r.ok, true);
	assert.equal(r.login, "SiyuQian");
	assert.equal(r.fetchedAt, "2026-11-04T00:00:00.000Z");
	assert.equal(r.mine.total, 137);
	assert.equal(r.mine.items.length, 1);
	assert.deepEqual(r.review, { total: 0, items: [] });
	const args = calls[0];
	assert.deepEqual(args.slice(0, 3), ["gh", "api", "graphql"]);
	assert.ok(args.includes(`mine=${INBOX_QUERIES.mine}`));
	assert.ok(args.includes(`review=${INBOX_QUERIES.review}`));
	assert.match(INBOX_QUERIES.mine, /author:@me/);
	assert.match(INBOX_QUERIES.review, /review-requested:@me/);
});

test("inbox: gh missing, not logged in, GraphQL errors", async () => {
	assert.equal((await inbox(fakeCli({}).run)).reason, "gh-missing");
	assert.equal((await inbox(fakeCli({ gh: { ok: false, missing: false, out: "", err: "To get started with GitHub CLI, please run:  gh auth login" } }).run)).reason, "gh-auth");
	const gqlErr = await inbox(fakeCli({ gh: ok({ errors: [{ message: "rate limited" }] }) }).run);
	assert.deepEqual(gqlErr, { ok: false, reason: "gh-failed", message: "rate limited" });
});

// --- GitHub tab: page ---------------------------------------------------------

const pt = (key, params = {}) => (mod.pageEn[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k]);
const ROWS = [
	{ number: 192, title: "A", url: "https://github.com/example-org/web-app/pull/192", repo: "example-org/web-app", owner: "example-org", author: "SiyuQian", state: "open", updatedAt: "2026-11-04T00:00:00Z", checks: "success", review: null },
	{ number: 7, title: "B", url: "https://github.com/SiyuQian/travel-plans/pull/7", repo: "SiyuQian/travel-plans", owner: "SiyuQian", author: "SiyuQian", state: "draft", updatedAt: "2026-11-01T00:00:00Z", checks: "failure", review: "changes" },
	{ number: 191, title: "C", url: "https://github.com/example-org/web-app/pull/191", repo: "example-org/web-app", owner: "example-org", author: "SiyuQian", state: "open", updatedAt: "2026-11-03T00:00:00Z", checks: null, review: null }
];
const DATA = { ok: true, login: "SiyuQian", fetchedAt: "2026-11-04T00:00:00Z", mine: { total: 137, items: ROWS }, review: { total: 1, items: [ROWS[0]] } };

/** Walk a stub element tree, rendering function components (PrRow) on the way. */
function find(tree, pred, out = []) {
	if (tree === null || typeof tree !== "object") return out;
	if (Array.isArray(tree)) { tree.forEach((c) => find(c, pred, out)); return out; }
	if (typeof tree.type === "function") return find(tree.type({ ...tree.props, children: tree.children }), pred, out);
	if (pred(tree)) out.push(tree);
	find(tree.children, pred, out);
	return out;
}
const textOfTree = (tree) => find(tree, () => true).flatMap((n) => n.children.filter((c) => typeof c === "string")).join(" ");

function renderPage(state) {
	const loads = [];
	const tree = mod.GithubPage({ useInbox: (sel) => sel(state), load: (age) => loads.push(age), t: pt, now: Date.parse("2026-11-04T00:00:30Z") });
	return { tree, loads };
}

test("GitHub tab: sidebar entry and main page are registered under one id", () => {
	const registered = [];
	mod.apply({
		effect: (fn) => fn(),
		locale: { register: () => () => {}, bind: (ns) => (ns === "github" ? pt : t) },
		slots: { inject: (_n, fn) => fn(), register: (opts, component) => registered.push([opts, component]) }
	});
	const [panel, panelIcon] = registered.find(([o]) => o.name === "sidebar.panellist");
	const [main, page] = registered.find(([o]) => o.name === "main");
	assert.equal(panel.id, "github");
	assert.equal(main.key, "github", "the sidebar row opens the main panel with the same id");
	assert.equal(panel.label(), "GitHub");
	assert.ok(panel.order > 10, "after 插件 (0) and 自动化任务 (10)");
	assert.equal(panelIcon, mod.GithubIcon);
	assert.equal(page, mod.GithubPage);
	const injected = main.inject();
	assert.equal(typeof injected.hooks.inbox.getSnapshot, "function", "becomes useInbox");
	assert.equal(typeof injected.load, "function");
	assert.equal(mod.GithubIcon({ size: 18 }).props.width, 18);
});

test("GitHub page: loads on open, shows rows as https links, newest first as given", () => {
	const { tree, loads } = renderPage({ status: "ready", data: DATA, error: null });
	assert.deepEqual(loads, [60000], "opening the tab loads unless the list is under a minute old");
	const links = find(tree, (n) => n.type === "a");
	assert.deepEqual(links.map((a) => a.props.href), ROWS.map((r) => r.url));
	for (const a of links) {
		assert.equal(a.props.target, "_blank");
		assert.equal(a.props.rel, "noopener noreferrer");
	}
	const text = textOfTree(tree);
	assert.match(text, /example-org\/web-app#192/);
	assert.match(text, /Draft/);
	assert.match(text, /Checks failed/);
	assert.match(text, /Changes requested/);
	assert.match(text, /Showing the 3 most recently updated of 137/);
	assert.match(text, /Updated just now · SiyuQian/);
});

test("GitHub page: owner chips, most PRs first, with counts", () => {
	const { tree } = renderPage({ status: "ready", data: DATA, error: null });
	const chips = find(tree, (n) => n.type === "button" && n.props.className === "dsh-gh-owner");
	assert.deepEqual(chips.map((c) => c.children.join("")), ["All", "example-org 2", "SiyuQian 1"]);
	assert.equal(chips[0].props["aria-pressed"], true);
	assert.deepEqual(mod.ownersOf([ROWS[1]]), [{ owner: "SiyuQian", count: 1 }]);
});

test("GitHub page: tabs show both totals; refresh forces a reload", () => {
	const { tree, loads } = renderPage({ status: "ready", data: DATA, error: null });
	const tabs = find(tree, (n) => n.type === "button" && n.props.className === "dsh-gh-tab");
	assert.deepEqual(tabs.map((b) => textOfTree(b)), ["My PRs 137", "Review requested 1"], "no workspaces tab: recycling is automatic");
	assert.equal(tabs[0].props["aria-pressed"], true);
	const refresh = find(tree, (n) => n.type === "button" && n.props.className === "dsh-gh-iconbtn")[0];
	refresh.props.onClick();
	assert.deepEqual(loads, [60000, 0]);
});

test("GitHub page: loading, error before any data, error after data keeps the list", () => {
	assert.match(textOfTree(renderPage({ status: "loading", data: null, error: null }).tree), /Reading from GitHub/);
	const authErr = renderPage({ status: "error", data: null, error: { reason: "gh-auth", message: "x" } }).tree;
	assert.match(textOfTree(authErr), /gh is not logged in/);
	const odd = renderPage({ status: "error", data: null, error: { reason: "weird", message: "boom" } }).tree;
	assert.match(textOfTree(odd), /Could not read GitHub: boom/, "unknown reasons fall back to a readable message");
	const stale = renderPage({ status: "error", data: DATA, error: { reason: "gh-failed", message: "timeout" } }).tree;
	assert.equal(find(stale, (n) => n.type === "a").length, 3, "the last good list stays");
	assert.match(textOfTree(stale), /Could not read GitHub: timeout/);
});

test("GitHub page: empty lists", () => {
	const empty = { ...DATA, mine: { total: 0, items: [] } };
	assert.match(textOfTree(renderPage({ status: "ready", data: empty, error: null }).tree), /You have no open pull requests/);
});

test("inbox store: loads once, skips fresh data, keeps data on failure, shares inflight", async () => {
	let clock = 0;
	const answers = [DATA, { ok: false, reason: "gh-failed", message: "x" }];
	let calls = 0;
	const store = mod.createInboxStore(async () => { calls += 1; return answers.shift(); }, () => clock);
	await Promise.all([store.load(), store.load()]);
	assert.equal(calls, 1, "concurrent loads share one request");
	assert.equal(store.getSnapshot().status, "ready");
	clock = 30000;
	await store.load(60000);
	assert.equal(calls, 1, "fresh list is not reloaded");
	await store.load(0);
	assert.equal(calls, 2);
	assert.equal(store.getSnapshot().status, "error");
	assert.equal(store.getSnapshot().data, DATA, "the last good list stays");
	const failing = mod.createInboxStore(async () => { throw new Error("transport"); });
	await failing.load();
	assert.deepEqual(failing.getSnapshot().error, { reason: "rpc", message: "transport" });
});

test("ago: short relative times", () => {
	const now = Date.parse("2026-11-04T12:00:00Z");
	assert.equal(mod.ago("2026-11-04T11:59:30Z", pt, now), "just now");
	assert.equal(mod.ago("2026-11-04T11:15:00Z", pt, now), "45m ago");
	assert.equal(mod.ago("2026-11-03T12:00:00Z", pt, now), "24h ago");
	assert.equal(mod.ago("2026-10-30T12:00:00Z", pt, now), "5d ago");
	assert.deepEqual(Object.keys(mod.pageZh).sort(), Object.keys(mod.pageEn).sort());
});

// --- review workspaces (host) ---------------------------------------------------

import { assertInside, createReviewWorkspaces, parsePrUrl, reviewPrompt } from "./lib/review.js";

test("parsePrUrl: only plain https PR URLs with safe owner and repo names", () => {
	assert.deepEqual(parsePrUrl("https://github.com/example-org/web-app/pull/193"), { host: "github.com", owner: "example-org", repo: "web-app", number: 193, url: "https://github.com/example-org/web-app/pull/193" });
	assert.equal(parsePrUrl("https://github.com/o/r/pull/7/").number, 7);
	for (const bad of ["http://github.com/o/r/pull/1", "https://u:p@github.com/o/r/pull/1", "https://github.com/../r/pull/1", "https://github.com/o/..git/pull/1", "https://github.com/o/r/issues/1", "https://github.com/o/r/pull/1/files", "not a url"]) {
		assert.equal(parsePrUrl(bad), null, bad);
	}
});

test("assertInside: deletes are confined to the review root", () => {
	assert.doesNotThrow(() => assertInside("/r", "/r/wt/o/r/pr-1"));
	for (const bad of ["/r", "/", "/r/../etc", "/elsewhere", "/rx/wt"]) assert.throws(() => assertInside("/r", bad), bad);
});

/** A workspace pool with fake git/gh: records commands, makes folders, never touches the network. */
async function fakePool({ clock = { now: new Date("2026-11-04T01:00:00Z") }, ...rest } = {}) {
	const { mkdtempSync, mkdirSync, writeFileSync: write } = await import("node:fs");
	const root = mkdtempSync(join(tmpdir(), "gh-review-unit-"));
	const calls = [];
	const exec = async (file, args) => {
		calls.push([file, ...args]);
		if (file === "gh" && args[0] === "pr") return { ok: true, out: JSON.stringify({ headRefOid: "abc123", title: "ABC-242: push token", baseRefName: "next" }), err: "" };
		if (file === "gh" && args[0] === "repo") { const dir = args[3]; mkdirSync(dir, { recursive: true }); write(join(dir, "HEAD"), "ref: refs/heads/next\n"); return { ok: true, out: "", err: "" }; }
		if (file === "git" && args.includes("worktree") && args.includes("add")) { mkdirSync(args[args.length - 2], { recursive: true }); return { ok: true, out: "", err: "" }; }
		if (file === "git" && args.includes("rev-parse")) return { ok: true, out: "abc123def456", err: "" };
		if (file === "du") return { ok: true, out: "2048\t/x", err: "" };
		return { ok: true, out: "", err: "" };
	};
	const pool = createReviewWorkspaces({ root, exec, now: () => clock.now, ...rest });
	return { root, calls, pool, clock, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("prepare: shared clone once, a new detached worktree per click, registry entry", async () => {
	const { root, calls, pool, clock, cleanup } = await fakePool();
	try {
		const a = await pool.prepare("https://github.com/example-org/web-app/pull/193", "review");
		clock.now = new Date("2026-11-04T01:01:00Z");
		const b = await pool.prepare("https://github.com/example-org/web-app/pull/193", "explain");
		assert.notEqual(a.path, b.path, "never reuses a folder");
		assert.ok(a.path.startsWith(join(root, "wt", "example-org", "web-app", "pr-193-")));
		assert.equal(calls.filter((c) => c[0] === "gh" && c[1] === "repo").length, 1, "one clone per repository");
		const clone = calls.find((c) => c[0] === "gh" && c[1] === "repo");
		assert.deepEqual(clone.slice(-3), ["--bare", "--filter=blob:none", "--quiet"]);
		const fetch = calls.find((c) => c.includes("fetch") && c.some((x) => String(x).includes("refs/pull/193/head")));
		assert.ok(fetch.includes("+refs/heads/next:refs/remotes/origin/next"), "base lands at origin/<base>");
		assert.ok(calls.some((c) => c.includes("worktree") && c.includes("--detach")));
		assert.equal(a.mode, "review");
		assert.equal(a.base, "next");
		assert.equal(a.sessionId, null);
		assert.equal((await pool.load()).workspaces.length, 2);
		await assert.rejects(pool.prepare("https://example.com/x", "review"), /not a GitHub pull request URL/);
		await assert.rejects(pool.prepare("https://github.com/o/r/pull/1", "merge"), /unknown mode/);
	} finally {
		cleanup();
	}
});

test("recycling: archived, deleted, expired, unbound; never a running session; shared clone dropped last", async () => {
	const archived = new Set();
	const deleted = new Set();
	const running = new Set();
	const { root, pool, clock, cleanup } = await fakePool({
		isArchived: (id) => archived.has(id),
		sessionExists: (id) => !deleted.has(id),
		sessionState: (id) => ({ live: true, running: running.has(id) })
	});
	try {
		const url = "https://github.com/example-org/web-app/pull/193";
		const mk = async (sid, minutes) => {
			clock.now = new Date(Date.parse("2026-11-04T01:00:00Z") + minutes * 60000);
			const w = await pool.prepare(url, "review");
			if (sid) await pool.bind(w.path, sid);
			return w;
		};
		const wa = await mk("A", 0); // archived and running: kept until it stops
		const wb = await mk("B", 1); // deleted
		const wc = await mk("C", 2); // idle, recent: kept
		const wu = await mk(null, 3); // never bound
		archived.add("A"); running.add("A"); deleted.add("B");
		clock.now = new Date("2026-11-04T03:00:00Z");
		let r = await pool.sweep();
		assert.deepEqual(r.removed.map((x) => x.reason).sort(), ["deleted", "unbound"]);
		assert.ok(existsSync(wa.path) && existsSync(wc.path));
		assert.ok(!existsSync(wb.path) && !existsSync(wu.path));
		running.delete("A");
		clock.now = new Date("2026-11-20T00:00:00Z");
		r = await pool.sweep();
		assert.deepEqual(r.removed.map((x) => x.reason).sort(), ["archived", "expired"]);
		assert.equal((await pool.load()).workspaces.length, 0);
		assert.ok(!existsSync(join(root, "repos", "example-org", "web-app.git")), "no workspace left, so the clone goes too");
	} finally {
		cleanup();
	}
});

test("recycling: keeps at most maxWorkspaces, oldest idle first; manual remove skips running unless forced", async () => {
	const running = new Set();
	const { pool, clock, cleanup } = await fakePool({ limits: { maxAgeDays: 30, maxWorkspaces: 2 }, sessionState: (id) => ({ live: true, running: running.has(id) }) });
	try {
		const ws = [];
		for (let i = 0; i < 4; i++) {
			clock.now = new Date(Date.parse("2026-11-04T01:00:00Z") + i * 60000);
			const w = await pool.prepare(`https://github.com/o/r/pull/${10 + i}`, "explain");
			await pool.bind(w.path, `s${i}`);
			ws.push(w);
		}
		running.add("s0");
		const r = await pool.sweep();
		assert.deepEqual(r.removed.map((x) => x.reason), ["over-limit"], "the running oldest one stays; the next oldest goes");
		const left = (await pool.load()).workspaces.map((w) => w.number).sort();
		assert.deepEqual(left, [10, 12, 13]);
		const skipped = await pool.remove([ws[0].id]);
		assert.deepEqual(skipped.removed, []);
		const forced = await pool.remove([ws[0].id], { force: true });
		assert.deepEqual(forced.removed, [ws[0].id]);
	} finally {
		cleanup();
	}
});

test("list: reports size, running, archived and why each would be recycled", async () => {
	const { pool, clock, cleanup } = await fakePool({ isArchived: (id) => id === "gone", sessionState: (id) => ({ live: true, running: id === "busy" }) });
	try {
		const a = await pool.prepare("https://github.com/o/r/pull/1", "review");
		await pool.bind(a.path, "busy");
		clock.now = new Date("2026-11-04T01:00:01Z");
		const b = await pool.prepare("https://github.com/o/r/pull/2", "explain");
		await pool.bind(b.path, "gone");
		const l = await pool.list();
		const byNum = Object.fromEntries(l.workspaces.map((w) => [w.number, w]));
		assert.equal(byNum[1].running, true);
		assert.equal(byNum[1].recycle, null);
		assert.equal(byNum[2].archived, true);
		assert.equal(byNum[2].recycle, "archived");
		assert.equal(byNum[1].size, 2048 * 1024);
		assert.ok(l.root.length > 0 && l.limits.maxAgeDays === 7);
	} finally {
		cleanup();
	}
});


test("review prompt: a configured template with placeholders", () => {
	const entry = { url: "https://github.com/o/r/pull/9", number: 9, path: "/p", head: "0123456789abcdef", base: "main" };
	assert.equal(reviewPrompt(entry, "review", { reviewPrompt: "/rv {url} #{number} {path} {head} {base} {other}" }), "/rv https://github.com/o/r/pull/9 #9 /p 0123456789ab main {other}");
	assert.equal(reviewPrompt(entry, "explain", { explainPrompt: "/ex {url}" }), "/ex https://github.com/o/r/pull/9");
});

test("review prompt: both skill tokens, checkout path, post to GitHub, Chinese summary", () => {
	const entry = { url: "https://github.com/o/r/pull/193", number: 193, path: "/x/wt/o/r/pr-193", head: "3b7fbd6a4e39c5b0", base: "next" };
	const review = reviewPrompt(entry, "review");
	assert.match(review, /^\/pr-explain \/pr-review https:\/\/github\.com\/o\/r\/pull\/193\n/);
	assert.match(review, /发布到 GitHub/);
	assert.match(review, /评审语言跟随 PR 本身的语言/);
	assert.match(review, /\/x\/wt\/o\/r\/pr-193/);
	assert.match(review, /origin\/next/);
	assert.match(review, /用中文总结/);
	const explain = reviewPrompt(entry, "explain");
	assert.match(explain, /^\/pr-explain https:/);
	assert.doesNotMatch(explain, /\/pr-review/);
	assert.match(explain, /不要在 GitHub 上发布/);
	// The host's skill gesture regex picks up both tokens on the first line.
	const gesture = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
	assert.deepEqual([...review.matchAll(gesture)].map((m) => m[2]), ["pr-explain", "pr-review"]);
});

// --- review actions (client) ----------------------------------------------------

test("startReview: prepare, create session in the checkout, bind, name, open, then send", async () => {
	const steps = [];
	const conversation = { send: async (text) => steps.push(["send", text.split("\n")[0]]) };
	let opened = false;
	const ctx = {
		get: (n) => ({
			connection: { rpc: { call: async (_ch, method, payload) => {
				steps.push([method, payload]);
				if (method === "github.review.prepare") return { ok: true, value: { workspace: { path: "/ws/pr-193" }, prompt: "/pr-explain /pr-review https://x/pull/193\n..." } };
				return { ok: true, value: {} };
			} } },
			sessions: {
				create: async (opts) => { steps.push(["create", opts]); return "s-new"; },
				using: async (id, _o, fn) => fn({ binding: { session: { rename: async (title) => steps.push(["rename", id, title]) } } }),
				scope: (id) => (opened && id === "s-new" ? { get: (k) => (k === "conversation" ? conversation : undefined) } : undefined)
			},
			uiWorkspace: { openSession: (id) => { opened = true; steps.push(["open", id]); } }
		})[n]
	};
	const pr = { url: "https://github.com/o/r/pull/193", number: 193, title: "ABC-242: push token" };
	const r = await mod.startReview(ctx, pr, "review");
	assert.equal(r.sessionId, "s-new");
	assert.deepEqual(steps, [
		["github.review.prepare", { url: pr.url, mode: "review" }],
		["create", { cwd: "/ws/pr-193" }],
		["github.review.bind", { path: "/ws/pr-193", sessionId: "s-new" }],
		["rename", "s-new", "审查 #193 ABC-242: push token"],
		["open", "s-new"],
		["github.missingSkills", { sessionId: "s-new", text: "/pr-explain /pr-review https://x/pull/193\n..." }],
		["send", "/pr-explain /pr-review https://x/pull/193"]
	]);
});

test("startReview: a failed checkout creates no session", async () => {
	let created = false;
	const ctx = { get: (n) => ({
		connection: { rpc: { call: async () => ({ ok: false, error: { message: "could not clone o/r: auth" } }) } },
		sessions: { create: async () => { created = true; } }
	})[n] };
	await assert.rejects(mod.startReview(ctx, { url: "https://github.com/o/r/pull/1", number: 1, title: "t" }, "review"), /could not clone/);
	assert.equal(created, false);
});

test("sendWhenReady: waits for the session scope, gives up after the timeout", async () => {
	let tries = 0;
	const sent = [];
	const ctx = { get: () => ({ scope: () => (++tries >= 3 ? { get: () => ({ send: async (x) => sent.push(x) }) } : undefined) }) };
	await mod.sendWhenReady(ctx, "s", "hello", 10000, async () => {});
	assert.deepEqual(sent, ["hello"]);
	const never = { get: () => ({ scope: () => undefined }) };
	await assert.rejects(mod.sendWhenReady(never, "s", "x", -1, async () => {}), /did not open in time/);
});

test("activeWorkspace: newest live, unarchived workspace for the PR", () => {
	const data = { workspaces: [
		{ url: "u", sessionId: "s2", archived: false, exists: true },
		{ url: "u", sessionId: "s1", archived: false, exists: true }
	] };
	assert.equal(mod.activeWorkspace(data, "u", { s1: {}, s2: {} }).sessionId, "s2");
	assert.equal(mod.activeWorkspace(data, "u", { s1: {} }).sessionId, "s1", "a session gone from the list is skipped");
	assert.equal(mod.activeWorkspace({ workspaces: [{ url: "u", sessionId: "s", archived: true, exists: true }] }, "u", { s: {} }), null);
	assert.equal(mod.activeWorkspace(null, "u"), null);
});

function renderReviewTab({ review = {}, sessionsById = {}, start = () => {}, openSession = () => {} } = {}) {
	const r = { status: "ready", data: { workspaces: [] }, error: null, preparing: {}, ...review };
	const tree = mod.GithubPage({
		useInbox: (sel) => sel({ status: "ready", data: DATA, error: null }),
		useReview: (sel) => sel(r),
		useSessions: (sel) => sel({ byId: sessionsById }),
		load: () => {}, loadReview: () => {}, start, openSession,
		t: pt, now: Date.parse("2026-11-04T00:00:30Z")
	});
	return tree;
}

test("review tab rows: 中文解读 and 审查 buttons; click starts the right mode", () => {
	const page = renderReviewTab();
	// switch to the review tab via the stub's tab button handler is stateful; render ReviewRow directly instead.
	const started = [];
	const row = mod.ReviewRow({ pr: ROWS[0], t: pt, now: 0, preparing: undefined, active: null, onStart: (pr, mode) => started.push([pr.number, mode]), onOpen: () => {}, error: null });
	const buttons = find(row, (n) => n.type === "button");
	assert.deepEqual(buttons.map((b) => textOfTree(b)), ["Explain", "Review"]);
	assert.equal(buttons[1].props["data-primary"], "", "审查 is the primary button");
	buttons[0].props.onClick();
	buttons[1].props.onClick();
	assert.deepEqual(started, [[192, "explain"], [192, "review"]]);
	assert.equal(find(row, (n) => n.type === "a")[0].props.href, ROWS[0].url, "the row still links to the PR");
	assert.ok(page !== null);
});

test("review tab rows: preparing shows one busy button; a PR with a session links back to it", () => {
	const prep = mod.ReviewRow({ pr: ROWS[0], t: pt, now: 0, preparing: "review", active: null, onStart: () => {}, onOpen: () => {}, error: null });
	const pb = find(prep, (n) => n.type === "button");
	assert.equal(pb.length, 1, "only the clicked action stays, as a spinner");
	assert.equal(pb[0].props.disabled, true);
	assert.match(textOfTree(prep), /Preparing…/);
	assert.equal(find(prep, (n) => n.props?.className === "dsh-gh-item")[0].props["data-busy"], "", "busy rows keep their actions visible without hover");
	const opened = [];
	const act = mod.ReviewRow({ pr: ROWS[0], t: pt, now: 0, preparing: undefined, active: { sessionId: "s9", mode: "review" }, onStart: () => assert.fail("must not start"), onOpen: (w) => opened.push(w.sessionId), error: null });
	const ab = find(act, (n) => n.type === "button");
	assert.deepEqual(ab.map((b) => textOfTree(b)), ["Reviewing"]);
	assert.equal(ab[0].props.className, "dsh-gh-session");
	ab[0].props.onClick();
	assert.deepEqual(opened, ["s9"]);
	const explained = mod.ReviewRow({ pr: ROWS[0], t: pt, now: 0, preparing: undefined, active: { sessionId: "s8", mode: "explain" }, onStart: () => {}, onOpen: () => {}, error: null });
	assert.deepEqual(find(explained, (n) => n.type === "button").map((b) => textOfTree(b)), ["Explained"]);
	const times = find(act, (n) => n.props?.className === "dsh-gh-time");
	assert.equal(times.length, 1, "the time is rendered once, at the right edge");
	const err = mod.ReviewRow({ pr: ROWS[0], t: pt, now: 0, preparing: undefined, active: null, onStart: () => {}, onOpen: () => {}, error: "could not clone" });
	assert.match(textOfTree(err), /Could not start: could not clone/);
});

test("both page locales still carry every key", () => {
	assert.deepEqual(Object.keys(mod.pageZh).sort(), Object.keys(mod.pageEn).sort());
	assert.equal(mod.pageZh["action.explain"], "解读");
	assert.equal(mod.pageZh["action.openReview"], "审查中");
	assert.equal(mod.pageZh["action.review"], "审查");
	assert.equal(mod.pageZh["tab.workspaces"], undefined);
	assert.equal(mod.WorkspacesView, undefined);
});

// --- several PRs per session ----------------------------------------------------

import { linksOf, linkProjection, repoOf, scanRepos, touchedRepos, childRepos, MAX_LINKED } from "./lib/index.js";

const U176 = "https://github.com/example-org/website/pull/176";

test("links: every linked PR is kept, most recent first; relinking moves it to the front", () => {
	const create = "gh pr create --fill";
	const events = [userMsg(U191), call("c", create), result("c", U176), userMsg(`back to ${U191}`)];
	assert.deepEqual(linksOf(events), [U191, U176]);
	assert.equal(linkOf(events), U191, "the most recent stays the single link (and the title)");
	assert.deepEqual(linksOf([userMsg(`${U191} and ${U176}`)]), [U176, U191], "two in one message: the last written is most recent");
	assert.deepEqual(linksOf([]), []);
});

test("links: the list is capped, oldest dropped", () => {
	const events = Array.from({ length: MAX_LINKED + 3 }, (_, i) => userMsg(`https://github.com/o/r/pull/${i + 1}`));
	const urls = linksOf(events);
	assert.equal(urls.length, MAX_LINKED);
	assert.equal(urls[0], `https://github.com/o/r/pull/${MAX_LINKED + 3}`);
	assert.ok(!urls.includes("https://github.com/o/r/pull/1"));
});

test("link projection: same state object for unrelated events; view is the URL list; schemas validate", () => {
	const def = linkProjection();
	assert.equal(def.key, LINK_KEY);
	const s0 = def.init();
	assert.equal(def.apply(s0, { type: "step/start", data: {} }), s0);
	const s1 = def.apply(s0, userMsg(U191));
	assert.deepEqual(def.wire.view(s1), [U191]);
	assert.equal(def.wire.view(s1), def.wire.view(s1), "same array: no republish");
	assert.equal(def.apply(s1, userMsg(U191)), s1, "relinking the first PR changes nothing");
	assert.deepEqual(def.stateSchema.parse(s1), s1);
	assert.throws(() => def.stateSchema.parse({ url: 1 }));
	assert.throws(() => def.wire.viewSchema.parse([1]));
	// a state saved by an older build (no `urls`) still folds
	assert.deepEqual(def.apply({ url: U191, pending: [] }, userMsg(U176)).urls, [U176, U191]);
});

test("repoOf: owner/repo from GitHub and GitLab URLs", () => {
	assert.equal(repoOf(U191), "example-org/web-app");
	assert.equal(repoOf("https://gitlab.com/g/sub/p/-/merge_requests/3"), "g/sub/p");
	assert.equal(repoOf("nope"), "");
});

test("link manager: returns every linked PR; the title follows the most recent one", async () => {
	const session = liveSession("s1", [titleEv("auto", "provider"), userMsg(U191), userMsg(U176)]);
	const renames = [];
	const { run } = fakeCli({ gh: (args) => ok(args[2] === U176
		? { number: 176, url: U176, state: "OPEN", isDraft: false, title: "ABC-49" }
		: { number: 191, url: U191, state: "MERGED", isDraft: false, title: "docs" }) });
	const links = createLinkManager({ sessions: new Map([["s1", session]]), titles: { rename: (s, t) => { renames.push(t); return { title: t }; } }, run });
	const r = await links.status("s1", 0);
	assert.deepEqual(r.prs.map((p) => [p.number, p.state, p.repo]), [[176, "open", "example-org/website"], [191, "merged", "example-org/web-app"]]);
	assert.equal(r.pr.number, 176);
	await new Promise((res) => setTimeout(res, 0));
	assert.deepEqual(renames, ["#176 ABC-49"]);
});

test("link manager: a PR that cannot be read is left out; the title is left alone if it was the most recent", async () => {
	const session = liveSession("s1", [titleEv("auto", "provider"), userMsg(U191), userMsg(U176)]);
	const renames = [];
	const { run } = fakeCli({ gh: (args) => (args[2] === U176 ? fail : ok({ number: 191, url: U191, state: "OPEN", isDraft: false, title: "docs" })) });
	const links = createLinkManager({ sessions: new Map([["s1", session]]), titles: { rename: (s, t) => { renames.push(t); return { title: t }; } }, run });
	const r = await links.status("s1", 0);
	assert.deepEqual(r.prs.map((p) => p.number), [191]);
	await new Promise((res) => setTimeout(res, 0));
	assert.deepEqual(renames, [], "no rename to an older PR");
});

// --- multi-repo workspaces --------------------------------------------------------

test("touchedRepos: workdir, absolute path, cd; whole names only", () => {
	const root = "/ws";
	const names = ["web-app", "web-app-cache", "api-tool", "iam"];
	const c = (args) => ({ type: "tool/call", data: { callId: "x", name: "bash", arguments: JSON.stringify(args) } });
	assert.deepEqual([...touchedRepos([c({ workdir: "api-tool", command: "ls" })], root, names)], ["api-tool"]);
	assert.deepEqual([...touchedRepos([c({ workdir: "/ws/iam/sub" })], root, names)], ["iam"]);
	assert.deepEqual([...touchedRepos([c({ command: "cd /ws/iam && git log" })], root, names)], ["iam"]);
	assert.deepEqual([...touchedRepos([c({ file_path: "/ws/web-app-cache/a.md" })], root, names)], ["web-app-cache"], "prefix sibling is not a match");
	assert.deepEqual([...touchedRepos([c({ command: "cd web-app; ls" })], root, names)], ["web-app"]);
	assert.deepEqual([...touchedRepos([c({ command: "gh pr view 1 -R example-org/web-app" })], root, names)], [], "a GitHub repo name alone is not working in the folder");
	assert.deepEqual([...touchedRepos([{ type: "user/message", data: { content: [{ type: "text", text: "/ws/iam" }] } }], root, names)], [], "only the agent's tool calls count");
});

test("scanRepos: real git, child repos and worktrees, changed and touched, no network", async () => {
	const root = mkdtempSync(join(tmpdir(), "gh-scan-"));
	try {
		const origin = join(root, "origin.git");
		sh(root, "init", "--bare", "-q", "-b", "main", origin);
		const ws = join(root, "ws");
		sh(root, "init", "-q", "-b", "main", join(ws, "alpha"));
		writeFileSync(join(ws, "alpha", "a.txt"), "a\n");
		sh(join(ws, "alpha"), "add", ".");
		sh(join(ws, "alpha"), "commit", "-q", "-m", "init");
		sh(join(ws, "alpha"), "remote", "add", "origin", origin);
		sh(join(ws, "alpha"), "push", "-q", "-u", "origin", "main");
		sh(join(ws, "alpha"), "remote", "set-head", "origin", "-a");
		sh(join(ws, "alpha"), "worktree", "add", "-q", "-b", "feat/x", join(ws, "beta"));
		writeFileSync(join(ws, "beta", "b.txt"), "b\n");
		sh(join(ws, "beta"), "add", ".");
		sh(join(ws, "beta"), "commit", "-q", "-m", "feat");
		writeFileSync(join(ws, "alpha", "dirty.txt"), "d\n");
		sh(root, "init", "-q", "-b", "main", join(ws, "gamma"));
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(ws, "notes"));
		const listed = await childRepos(ws);
		assert.deepEqual(listed.map((r) => [r.name, r.worktree]), [["alpha", false], ["beta", true], ["gamma", false]]);
		const events = [{ type: "tool/call", data: { callId: "1", name: "bash", arguments: JSON.stringify({ workdir: "beta", command: "git log" }) } }];
		const gh = async () => ({ ok: false, missing: true, out: "", err: "" });
		const scan = await scanRepos(ws, { events, gh });
		const by = Object.fromEntries(scan.repos.map((r) => [r.name, r]));
		assert.equal(scan.root, ws);
		assert.equal(by.alpha.dirty, 1);
		assert.equal(by.alpha.changed, true);
		assert.equal(by.alpha.touched, false);
		assert.equal(by.beta.ahead, 1);
		assert.equal(by.beta.branch, "feat/x");
		assert.equal(by.beta.worktree, true);
		assert.equal(by.beta.touched, true);
		assert.equal(by.gamma.changed, false, "an empty repo with nothing to push is not a candidate");
		await assert.rejects(scanRepos("relative"), /absolute/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanRepos: the branch's open PR comes from gh pr list, only for repos with changes", async () => {
	const repoState = { "/ws/a": { ahead: "2", dirty: "" }, "/ws/b": { ahead: "0", dirty: "" } };
	const run = async (cwd, args) => {
		const st = repoState[cwd];
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, out: cwd };
		if (args[0] === "rev-parse") return { ok: true, out: "feat/a" };
		if (args[0] === "symbolic-ref") return { ok: true, out: "origin/main" };
		if (args[0] === "remote") return { ok: true, out: "git@github.com:o/r.git" };
		if (args[0] === "status") return { ok: true, out: st.dirty };
		if (args[0] === "rev-list") return { ok: true, out: st.ahead };
		return { ok: false, out: "" };
	};
	const ghCalls = [];
	const gh = async (file, cwd, args) => { ghCalls.push(cwd); return { ok: true, out: JSON.stringify([{ number: 17, url: "https://github.com/o/r/pull/17" }]) }; };
	const { mkdtempSync: mk, mkdirSync, writeFileSync: wf } = await import("node:fs");
	const ws = mk(join(tmpdir(), "gh-scan2-"));
	try {
		for (const n of ["a", "b"]) { mkdirSync(join(ws, n)); mkdirSync(join(ws, n, ".git")); }
		repoState[join(ws, "a")] = repoState["/ws/a"];
		repoState[join(ws, "b")] = repoState["/ws/b"];
		const scan = await scanRepos(ws, { run, gh });
		const by = Object.fromEntries(scan.repos.map((r) => [r.name, r]));
		assert.deepEqual(by.a.pr, { number: 17, url: "https://github.com/o/r/pull/17" });
		assert.equal(by.b.pr, null);
		assert.deepEqual(ghCalls, [join(ws, "a")], "unchanged repos are not looked up");
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

const SCAN = { root: "/ws/acme-workspace", repos: [
	{ name: "web-app", path: "/ws/acme-workspace/web-app", branch: "feature/harness-docs", ahead: 0, dirty: 2, changed: true, touched: true, worktree: false, pr: null },
	{ name: "infra-cicd", path: "/ws/acme-workspace/infra-cicd", branch: "main", ahead: 0, dirty: 0, changed: false, touched: true, worktree: false, pr: null },
	{ name: "studio", path: "/ws/acme-workspace/studio", branch: "feat/editor-data", ahead: 48, dirty: 0, changed: true, touched: false, worktree: false, pr: { number: 17, url: "https://github.com/x/pull/17" } },
	{ name: "api-parallel-run", path: "/ws/acme-workspace/api-parallel-run", branch: "feature/ABC-156-parallel-run-plan", ahead: 1, dirty: 0, changed: true, touched: true, worktree: true, pr: null }
] };

test("createPr in a multi-repo folder: picker gets the scan, the chosen repos go into one /pr-creator message", async () => {
	const sent = [];
	const calls = [];
	let picked = null;
	const ctx = clientCtx({ cwd: SCAN.root, sent, calls, preflightResult: { ok: true, value: { status: "not-a-repo" } }, repos: SCAN });
	const outcome = await mod.createPr(ctx, "s1", t, async (scan) => { picked = scan; return ["api-parallel-run", "web-app"]; });
	assert.equal(picked, SCAN);
	assert.deepEqual(calls.map((c) => c[0]), [PREFLIGHT_METHOD, REPOS_METHOD, PROMPTS_METHOD, SKILLS_METHOD]);
	assert.deepEqual(calls[1][1], { cwd: SCAN.root, sessionId: "s1" }, "the scan knows the session, so it can tell which repos it touched");
	assert.equal(outcome.kind, "sent");
	assert.deepEqual(outcome.repos, ["web-app", "api-parallel-run"], "in the scan's order");
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^\/pr-creator /, "the skill token leads, so DSH loads pr-creator");
	assert.match(sent[0], /1\. `web-app`/);
	assert.match(sent[0], /2\. `api-parallel-run`/);
	assert.doesNotMatch(sent[0], /studio`/, "unchosen repos are not in the message");
	const gesture = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
	assert.deepEqual([...sent[0].matchAll(gesture)].map((m) => m[2]), ["pr-creator"]);
});

test("createPr in a multi-repo folder: cancel sends nothing; one changed repo skips the picker; none stops", async () => {
	const sent = [];
	const not = { ok: true, value: { status: "not-a-repo" } };
	assert.equal((await mod.createPr(clientCtx({ cwd: SCAN.root, sent, preflightResult: not, repos: SCAN }), "s1", t, async () => null)).kind, "cancelled");
	assert.equal(sent.length, 0);
	const single = { root: SCAN.root, repos: [SCAN.repos[0], SCAN.repos[1]] };
	const r = await mod.createPr(clientCtx({ cwd: SCAN.root, sent, preflightResult: not, repos: single }), "s1", t, async () => assert.fail("no picker for one repo"));
	assert.deepEqual(r.repos, ["web-app"]);
	assert.equal(sent.length, 1);
	const none = { root: SCAN.root, repos: [SCAN.repos[1]] };
	const n = await mod.createPr(clientCtx({ cwd: SCAN.root, sent, preflightResult: not, repos: none }), "s1", t, async () => assert.fail("no picker"));
	assert.equal(n.kind, "stop");
	assert.match(n.text, /None of the 1 repositories/);
});

test("defaultSelection: touched repos with changes", () => {
	assert.deepEqual(mod.defaultSelection(SCAN.repos), ["web-app", "api-parallel-run"]);
});

const stubT = (key, params = {}) => (mod.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k]);

test("repo picker: touched first, tags, unchanged named but not choosable, confirm passes the ticked names", () => {
	const confirmed = [];
	const modal = mod.RepoPicker({ scan: SCAN, t: stubT, onCancel: () => {}, onConfirm: (names) => confirmed.push(names) });
	assert.equal(modal.type, "Modal");
	assert.equal(modal.props.title, mod.en["picker.title"]);
	assert.match(modal.props.description, /acme-workspace holds 4 repositories; 3 have new commits/);
	const rows = find(modal, (n) => n.props?.className === "dsh-create-pr-repo");
	const names = rows.map((r) => find(r, (n) => n.props?.className === "dsh-create-pr-repo-name")[0].children[0]);
	assert.deepEqual(names, ["web-app", "api-parallel-run", "studio"], "touched first");
	const checks = rows.map((r) => find(r, (n) => n.type === "Checkbox")[0].props.checked);
	assert.deepEqual(checks, [true, true, false]);
	assert.match(textOfTree(modal), /PR #17 exists/);
	assert.match(textOfTree(modal), /used in this session/);
	assert.match(textOfTree(modal), /worktree/);
	assert.match(textOfTree(modal), /2 uncommitted files/);
	assert.match(textOfTree(modal), /No changes, cannot be chosen: infra-cicd/);
	const footer = find(modal.props.footer, (n) => n.type === "Button");
	assert.equal(textOfTree(footer[1]), "Create PRs for 2 repositories");
	footer[1].props.onClick();
	assert.deepEqual(confirmed, [["web-app", "api-parallel-run"]]);
});

test("composer: several PRs show the latest with +N and a menu of all; one PR keeps the plain link", () => {
	const prs = [
		{ number: 176, url: U176, state: "open", title: "ABC-49: Record the sessions checks", repo: "example-org/website" },
		{ number: 191, url: U191, state: "merged", title: "docs: Add harness docs", repo: "example-org/web-app" }
	];
	const props = (list) => ({ sessionId: "s1", useSession: (sel) => sel({ running: false }), useSessions: (sel) => sel({ byId: { s1: { origin: "user" } } }), usePrStatus: (sel) => sel({ s1: { prs: list, pr: list[0] ?? null } }), refreshStatus: () => {}, run: async () => {}, t: stubT });
	const many = mod.CreatePrAction(props(prs));
	assert.equal(many.children[0].type, mod.PrLinks);
	const menu = mod.PrLinks({ prs, t: stubT });
	assert.equal(menu.type, "Menu");
	assert.deepEqual(menu.props.items.map((i) => i.id), ["head", U176, U191]);
	assert.equal(menu.props.items[0].kind, "label");
	assert.match(menu.props.items[0].text, /2 PRs linked/);
	assert.match(textOfTree(menu.props.items[1].label), /#176 ABC-49.*example-org\/website · open · latest/s);
	assert.match(textOfTree(menu.props.items[2].label), /merged/);
	const anchor = find(menu.props.anchor, (n) => n.type === "button")[0];
	assert.match(textOfTree(anchor), /#176/);
	assert.match(textOfTree(anchor), /\+1/);
	const one = mod.CreatePrAction(props([prs[0]]));
	assert.equal(one.children[0].type, mod.PrLink);
	const none = mod.CreatePrAction(props([]));
	assert.equal(none.children[0], null);
	assert.match(textOfTree(none), /Create PR/);
});

test("sidebar hover card: lists the session's PRs from the projection, with states when known", () => {
	const props = (urls, known) => ({ sessionId: "s1", useSessions: (sel) => sel({ byId: { s1: { projectionValues: { [LINK_KEY]: urls } } } }), usePrStatus: (sel) => sel(known), t: stubT });
	assert.equal(mod.SessionPrsHover(props([], {})), null);
	assert.equal(mod.SessionPrsHover({ ...props([], {}), useSessions: (sel) => sel({ byId: {} }) }), null, "unknown session: nothing");
	const card = mod.SessionPrsHover(props([U176, U191], { s1: { prs: [{ number: 176, url: U176, state: "open", title: "ABC-49" }] } }));
	const text = textOfTree(card);
	assert.match(text, /Linked PRs/);
	assert.match(text, /website#176 · open/);
	assert.match(text, /web-app#191/, "a PR not yet looked up still shows its number");
});

test("status store keeps every PR and only republishes when the list changes", async () => {
	const answers = [[{ url: U176, state: "open", title: "a" }, { url: U191, state: "merged", title: "b" }], [{ url: U176, state: "open", title: "a" }, { url: U191, state: "merged", title: "b" }], { url: U176, state: "open", title: "a" }];
	const store = mod.createStatusStore(async () => answers.shift());
	let n = 0;
	store.subscribe(() => { n += 1; });
	await store.refresh("s", 0);
	assert.equal(store.getSnapshot().s.prs.length, 2);
	assert.equal(store.getSnapshot().s.pr.url, U176);
	await store.refresh("s", 0);
	assert.equal(n, 1, "same list: no new snapshot");
	await store.refresh("s", 0);
	assert.equal(store.getSnapshot().s.prs.length, 1, "an older single-PR answer is accepted");
	assert.equal(n, 2);
});
