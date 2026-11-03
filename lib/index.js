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

function git(cwd, args, timeoutMs = 8000) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
			resolve({ ok: error === null, out: String(stdout).trim(), err: String(stderr).trim() });
		});
	});
}

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

function rpcError(rpcId, code, message) {
	return Response.json({ type: "server-response", rpcId, result: { ok: false, error: { code, message, details: { issues: [] } } } });
}

export function preflightRoute(run = git) {
	return {
		path: `/api/${PREFLIGHT_METHOD}`,
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
			if (body?.method !== PREFLIGHT_METHOD) return rpcError(rpcId, "gateway/bad-request", `unexpected method ${JSON.stringify(body?.method)}`);
			try {
				const value = await preflight(body?.payload?.cwd, run);
				return Response.json({ type: "server-response", rpcId, result: { ok: true, value } });
			} catch (error) {
				return rpcError(rpcId, "gateway/bad-request", error?.message ?? String(error));
			}
		}
	};
}

export function apply(ctx) {
	ctx.inject(["skills"], (scope) => {
		scope.skills.registerProvider(() => createSkillProvider());
	});
	ctx.inject(["connection"], (scope) => {
		const connection = scope.get("connection");
		scope.effect(() => connection.fetch.register(preflightRoute()), `${name}: /api/${PREFLIGHT_METHOD} route`);
	});
}
