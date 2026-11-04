// Self-check with stubs: verifies wiring against the APIs read from the app source, not the real app.
// The preflight tests run real git in throwaway repos under the OS temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PREFLIGHT_METHOD, PROVIDER_NAME, SKILL_DIR, SKILL_NAME,
	INBOX_METHOD, INBOX_QUERIES, SESSION_STATUS_METHOD, apply, argumentText, inbox, inboxRow, createLinkManager, createSkillProvider, foldLink, hostOf, linkOf, nextTitle,
	parseSkill, prByUrl, preflight, preflightRoute, prTitle, sessionStatusRoute
} from "./lib/index.js";

let mod;
const stubPrimitives = { Tooltip: "Tooltip", IconBranchOutlineRegular: "Icon" };
// Effects run synchronously on "render" so tests can see the lookups they trigger.
const stubReact = { createElement: (type, props, ...children) => ({ type, props, children }), useState: (v) => [v, () => {}], useEffect: (fn) => { fn(); } };
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory((n) => ({ react: stubReact, "@deepseek-ai/dsh-client-ui-primitives": stubPrimitives })[n] ?? null); } } };
new Function(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"))();

// --- skill provider ---------------------------------------------------------

test("vendored SKILL.md parses to a one-line description and a body", () => {
	const { description, content } = parseSkill(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"));
	assert.match(description, /^Use when the user wants to create or update a pull request/);
	assert.doesNotMatch(description, /\n/);
	assert.match(content, /^# Pull Request \/ Merge Request Skill/);
});

test("folded and inline descriptions both parse", () => {
	assert.equal(parseSkill("---\nname: x\ndescription: >\n  one\n  two\nlicense: y\n---\nbody").description, "one two");
	assert.equal(parseSkill("---\ndescription: \"plain\"\n---\nbody").description, "plain");
	assert.throws(() => parseSkill("no frontmatter"));
});

test("provider lists one bundled, user- and model-invocable pr-creator", async () => {
	const provider = createSkillProvider();
	assert.equal(provider.name, PROVIDER_NAME);
	const [candidate, ...rest] = await provider.list();
	assert.equal(rest.length, 0);
	assert.equal(candidate.name, SKILL_NAME);
	assert.equal(candidate.provider, PROVIDER_NAME);
	assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
	assert.equal(candidate.rank, 600);
	assert.equal(candidate.resourceBase.kind, "directory");
	assert.ok(candidate.path.endsWith("SKILL.md"));
});

test("loaded body starts with the host note and resolves <devpilot> to a real path", async () => {
	const provider = createSkillProvider();
	const [candidate] = await provider.list();
	const skill = await provider.get(candidate, { signal: new AbortController().signal });
	assert.equal(skill.rank, undefined, "rank is a candidate-only field");
	assert.match(skill.content, /^## DeepSeek Harness notes/);
	const checker = /The checker is `([^`]+)`/.exec(skill.content)[1];
	assert.ok(readFileSync(checker, "utf8").startsWith("#!/usr/bin/env python3"));
	assert.match(skill.content, /# Pull Request \/ Merge Request Skill/);
});

test("the relative links the skill follows exist in the vendored copy", () => {
	for (const rel of ["../../docs/task-tracking.md", "references/visual-evidence.md", "templates/backend-feature.md", "templates/frontend-bugfix.md"]) {
		assert.ok(readFileSync(join(SKILL_DIR, rel), "utf8").length > 0, rel);
	}
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

test("host apply registers the provider, the routes, and the session listeners", () => {
	const seen = [];
	const scope = {
		skills: { registerProvider: (create) => seen.push(["provider", create({ signal: undefined, invalidate() {} }).name]) },
		get: (n) => ({
			connection: { fetch: { register: (route) => seen.push(["route", route.path]) } },
			sessions: { get: () => undefined }
		})[n],
		effect: (fn) => fn(),
		on: (event) => seen.push(["on", event])
	};
	apply({ inject: (_deps, cb) => cb(scope) });
	assert.deepEqual(seen, [
		["provider", PROVIDER_NAME],
		["route", `/api/${PREFLIGHT_METHOD}`],
		["route", `/api/${INBOX_METHOD}`],
		["route", `/api/${SESSION_STATUS_METHOD}`],
		["on", "session/event"],
		["on", "session/created"]
	]);
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
	assert.deepEqual(r, { pr: { number: 191, url: U191, state: "draft", title: "docs: Add harness docs" } });
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
	assert.deepEqual(await links.status("s2"), { pr: null, reason: "unlinked" });
	assert.deepEqual(await links.status("gone"), { pr: null, reason: "not-live" });
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
	assert.equal(await mod.fetchPrStatus(ctx, "s1"), null);
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

function clientCtx({ cwd = "/repo", preflightResult, sent = [], rpcThrows = false }) {
	const conversation = { send: async (text) => { sent.push(text); }, input: { for: () => ({ notify() {} }) } };
	return {
		get: (n) => ({
			connection: { rpc: { call: async (ch, m, payload) => {
				if (rpcThrows) throw new Error("offline");
				assert.equal(ch, "/api");
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

test("stops without sending when the folder is not a repo", async () => {
	const sent = [];
	const outcome = await mod.createPr(clientCtx({ sent, preflightResult: { ok: true, value: { status: "not-a-repo" } } }), "s1", t);
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
	assert.deepEqual(registered.map(([o]) => o.name), ["sidebar.panellist", "main", "conversation.input.right"]);
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
	assert.deepEqual(tabs.map((b) => textOfTree(b)), ["My PRs 137", "Review requested 1"]);
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
