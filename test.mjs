// Self-check with stubs: verifies wiring against the APIs read from the app source, not the real app.
// The preflight tests run real git in throwaway repos under the OS temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PREFLIGHT_METHOD, PROVIDER_NAME, SKILL_DIR, SKILL_NAME, STATUS_METHOD,
	apply, createSkillProvider, hostOf, parseSkill, preflight, preflightRoute, prStatus, statusRoute
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

test("host apply registers the provider and the route through injected services", () => {
	const seen = [];
	const scope = {
		skills: { registerProvider: (create) => seen.push(["provider", create({ signal: undefined, invalidate() {} }).name]) },
		get: (n) => n === "connection" ? { fetch: { register: (route) => seen.push(["route", route.path]) } } : undefined,
		effect: (fn) => fn()
	};
	apply({ inject: (_deps, cb) => cb(scope) });
	assert.deepEqual(seen, [["provider", PROVIDER_NAME], ["route", `/api/${PREFLIGHT_METHOD}`], ["route", `/api/${STATUS_METHOD}`]]);
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

test("prStatus: GitHub open, draft, merged, closed", async () => {
	const cases = [
		[{ state: "OPEN", isDraft: false }, "open"],
		[{ state: "OPEN", isDraft: true }, "draft"],
		[{ state: "MERGED", isDraft: false }, "merged"],
		[{ state: "CLOSED", isDraft: true }, "closed"]
	];
	for (const [extra, want] of cases) {
		const { run, calls } = fakeCli({ git: ok("git@github.com:o/r.git"), gh: ok({ number: 7, url: "https://github.com/o/r/pull/7", title: "feat: x", ...extra }) });
		const r = await prStatus("/repo", run);
		assert.deepEqual(r, { pr: { number: 7, url: "https://github.com/o/r/pull/7", state: want, title: "feat: x" } });
		assert.deepEqual(calls[1], ["gh", "pr", "view", "--json", "number,url,state,isDraft,title"]);
	}
});

test("prStatus: no PR, gh missing, no remote, other host", async () => {
	assert.deepEqual(await prStatus("/repo", fakeCli({ git: ok("https://github.com/o/r"), gh: fail }).run), { pr: null, reason: "none" });
	assert.deepEqual(await prStatus("/repo", fakeCli({ git: ok("https://github.com/o/r") }).run), { pr: null, reason: "gh-missing" });
	assert.deepEqual(await prStatus("/repo", fakeCli({ git: fail }).run), { pr: null, reason: "no-remote" });
	assert.deepEqual(await prStatus("/repo", fakeCli({ git: ok("https://bitbucket.org/o/r") }).run), { pr: null, reason: "unsupported-host" });
});

test("prStatus: GitLab MR via glab", async () => {
	const { run, calls } = fakeCli({ git: ok("git@gitlab.com:o/r.git"), glab: ok({ iid: 12, web_url: "https://gitlab.com/o/r/-/merge_requests/12", state: "opened", draft: true, title: "Draft: y" }) });
	assert.deepEqual(await prStatus("/repo", run), { pr: { number: 12, url: "https://gitlab.com/o/r/-/merge_requests/12", state: "draft", title: "Draft: y" } });
	assert.deepEqual(calls[1], ["glab", "mr", "view", "-F", "json"]);
});

test("prStatus never passes a non-https URL to the page", async () => {
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://github.com/o/r/pull/1", "https://user:pw@github.com/o/r/pull/1"]) {
		const { run } = fakeCli({ git: ok("https://github.com/o/r"), gh: ok({ number: 1, url, state: "OPEN", isDraft: false, title: "t" }) });
		assert.deepEqual(await prStatus("/repo", run), { pr: null, reason: "bad-output" }, url);
	}
});

test("status route wraps prStatus in the RPC envelope", async () => {
	const route = statusRoute(fakeCli({ git: ok("https://github.com/o/r"), gh: fail }).run);
	assert.equal(route.path, `/api/${STATUS_METHOD}`);
	const res = await (await route.fetch(new Request("http://x" + route.path, { method: "POST", body: JSON.stringify({ rpcId: "s1", method: STATUS_METHOD, payload: { cwd: "/repo" } }) }))).json();
	assert.deepEqual(res, { type: "server-response", rpcId: "s1", result: { ok: true, value: { pr: null, reason: "none" } } });
});

test("status store: caches by folder, skips fresh entries, keeps last link on failure", async () => {
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
		slots: { inject: (name, fn) => { assert.equal(name, "conversation.input.right"); fn(); }, register: (opts, component) => registered.push([opts, component]) }
	};
	mod.apply(ctx);
	assert.equal(registered.length, 1);
	const [opts, component] = registered[0];
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
	assert.deepEqual(refreshes, [["/repo", 0]], "looks up the PR when shown");
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
	const { tree, link } = renderAction({ status: { "/repo": { pr: PR, at: 0 } } });
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
	const { tree, link } = renderAction({ status: { "/repo": { pr: { ...PR, state: "merged" }, at: 0 } } });
	assert.equal(link.props.pr.state, "merged");
	const label = tree.children[0].children.find((c) => c.props?.className === "dsh-create-pr-label");
	assert.deepEqual(label.children, [mod.en.button]);
});

test("PR link: another folder's PR is not shown", () => {
	const { link } = renderAction({ status: { "/other": { pr: PR, at: 0 } } });
	assert.equal(link, null);
});

test("both locales carry every key, including the state names", () => {
	assert.deepEqual(Object.keys(mod.zh).sort(), Object.keys(mod.en).sort());
	for (const s of ["open", "draft", "merged", "closed"]) assert.ok(mod.en[`state.${s}`] && mod.zh[`state.${s}`]);
});
