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
	apply, createSkillProvider, hostOf, parseSkill, preflight, preflightRoute
} from "./lib/index.js";

let mod;
const stubPrimitives = { Tooltip: "Tooltip", IconBranchOutlineRegular: "Icon" };
const stubReact = { createElement: (type, props, ...children) => ({ type, props, children }), useState: (v) => [v, () => {}] };
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
	assert.deepEqual(seen, [["provider", PROVIDER_NAME], ["route", `/api/${PREFLIGHT_METHOD}`]]);
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
	assert.equal(typeof opts.inject().run, "function");
	assert.equal(component, mod.CreatePrAction);
});

function renderAction({ running = false, origin = "user" } = {}) {
	const runs = [];
	const tree = mod.CreatePrAction({
		sessionId: "s1",
		useSession: (select) => select({ running }),
		useSessions: (select) => select({ byId: { s1: { origin } } }),
		run: async (id) => { runs.push(id); },
		t
	});
	return { tree, runs };
}

test("composer button: idle, labelled, keeps focus, runs for its session", () => {
	const { tree, runs } = renderAction();
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

test("composer button: disabled with the busy hint while the agent runs", () => {
	const { tree } = renderAction({ running: true });
	assert.equal(tree.props.label, mod.en.busy);
	assert.equal(tree.children[0].props.disabled, true);
});

test("composer button: hidden in subagent sessions", () => {
	assert.equal(renderAction({ origin: "subagent" }).tree, null);
});
