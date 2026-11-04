/**
 * Review workspaces: a fresh, isolated checkout of a PR's head for one review
 * session, so a review never touches the user's own working folders.
 *
 * Layout under <root> (default ~/.dsh/github-review):
 *   repos/<owner>/<repo>.git            one shared bare clone per repository (blobless)
 *   wt/<owner>/<repo>/pr-<n>-<stamp>    one git worktree per review, detached at the PR head
 *   registry.json                       what exists, which session owns it, when it was last used
 *
 * Recycling: a workspace is removed when its session is archived or deleted,
 * when it is over `maxAgeDays` old, or when the user removes it from the
 * 审查工作区 tab. Workspaces whose session is still running are never touched.
 * Shared clones are dropped once no workspace uses them. Removal goes through
 * `git worktree remove --force` and is confined to paths under <root>.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const REVIEW_METHODS = {
	prepare: "github.review.prepare",
	bind: "github.review.bind",
	list: "github.review.list",
	remove: "github.review.remove",
	sweep: "github.review.sweep"
};

export const DEFAULTS = { maxAgeDays: 7, maxWorkspaces: 20 };

const SAFE = /^[A-Za-z0-9._-]+$/;

/** owner/repo/number from a GitHub PR URL; null for anything else. */
export function parsePrUrl(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" || u.username || u.password) return null;
	const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(u.pathname);
	if (m === null || !SAFE.test(m[1]) || !SAFE.test(m[2]) || m[1].startsWith(".") || m[2].startsWith(".")) return null;
	return { host: u.host, owner: m[1], repo: m[2], number: Number(m[3]), url: `https://${u.host}/${m[1]}/${m[2]}/pull/${m[3]}` };
}

function run(file, args, { cwd, timeoutMs = 120000 } = {}) {
	return new Promise((resolveRun) => {
		execFile(file, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 4 << 20,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
		}, (error, stdout, stderr) => {
			resolveRun({ ok: error === null, missing: error?.code === "ENOENT", out: String(stdout).trim(), err: String(stderr).trim() });
		});
	});
}

/** Throw unless `path` is strictly inside `root`. Every delete goes through this. */
export function assertInside(root, path) {
	const rel = relative(resolve(root), resolve(path));
	if (rel === "" || rel.startsWith("..") || resolve(rel) === rel || rel.split(sep).includes("..")) {
		throw new Error(`refusing to touch ${path}: not inside ${root}`);
	}
}

function stamp(now) {
	return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/**
 * @param {object} deps
 * @param {string} [deps.root] workspace root
 * @param {(sessionId: string) => ({live: boolean, running: boolean} | undefined)} [deps.sessionState]
 *        live state of a session on this Host, undefined when unknown
 * @param {(sessionId: string) => boolean} [deps.isArchived]
 * @param {(sessionId: string) => boolean} [deps.sessionExists] whether the session still exists on disk
 */
export function createReviewWorkspaces({
	root = join(homedir(), ".dsh", "github-review"),
	exec = run,
	now = () => new Date(),
	sessionState = () => undefined,
	isArchived = () => false,
	sessionExists = () => true,
	logger = console,
	limits = DEFAULTS
} = {}) {
	const registryFile = join(root, "registry.json");
	let chain = Promise.resolve();
	/** Serialise every registry read-modify-write and every git operation on the pool. */
	const locked = (fn) => {
		const next = chain.then(fn, fn);
		chain = next.catch(() => {});
		return next;
	};

	async function load() {
		try {
			const data = JSON.parse(await readFile(registryFile, "utf8"));
			return Array.isArray(data?.workspaces) ? data : { version: 1, workspaces: [] };
		} catch {
			return { version: 1, workspaces: [] };
		}
	}

	async function save(data) {
		await mkdir(root, { recursive: true });
		const tmp = `${registryFile}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
		await rename(tmp, registryFile);
	}

	const repoDir = (p) => join(root, "repos", p.owner, `${p.repo}.git`);

	async function exists(path) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	async function ensureRepo(p) {
		const dir = repoDir(p);
		assertInside(root, dir);
		if (!(await exists(join(dir, "HEAD")))) {
			await mkdir(dirname(dir), { recursive: true });
			// gh clones with the user's own login (HTTPS token or SSH, per gh config). Bare + blobless keeps it small.
			const cloned = await exec("gh", ["repo", "clone", `${p.owner}/${p.repo}`, dir, "--", "--bare", "--filter=blob:none", "--quiet"], { timeoutMs: 300000 });
			if (!cloned.ok) {
				await rm(dir, { recursive: true, force: true });
				throw new Error(cloned.missing ? "gh is not installed" : `could not clone ${p.owner}/${p.repo}: ${cloned.err.split("\n")[0]}`);
			}
			// A bare clone has no remote-tracking refs, so `origin/<branch>` and
			// `origin/HEAD` would not exist in a review folder. Give it the normal
			// layout, so the skills' own `git fetch origin <base>` and
			// `git symbolic-ref refs/remotes/origin/HEAD` behave as in any checkout.
			await exec("git", ["--git-dir", dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
			await exec("git", ["--git-dir", dir, "fetch", "--quiet", "--no-tags", "origin"], { timeoutMs: 300000 });
			await exec("git", ["--git-dir", dir, "remote", "set-head", "origin", "--auto"], { timeoutMs: 60000 });
		}
		return dir;
	}

	async function headOf(p) {
		const r = await exec("gh", ["pr", "view", p.url, "--json", "headRefOid,state,title,baseRefName,headRefName,isCrossRepository"], { timeoutMs: 30000 });
		if (!r.ok) throw new Error(r.missing ? "gh is not installed" : `could not read ${p.url}: ${r.err.split("\n")[0]}`);
		return JSON.parse(r.out);
	}

	/**
	 * Make a new workspace for one PR: fetch its head into the shared clone and
	 * add a detached worktree there. Never reuses or overwrites an existing one.
	 */
	function prepare(url, mode) {
		return locked(async () => {
			const p = parsePrUrl(url);
			if (p === null) throw new Error(`not a GitHub pull request URL: ${url}`);
			if (mode !== "review" && mode !== "explain") throw new Error(`unknown mode ${JSON.stringify(mode)}`);
			const info = await headOf(p);
			const dir = await ensureRepo(p);
			const fetched = await exec("git", ["--git-dir", dir, "fetch", "--quiet", "--no-tags", "origin",
				`+refs/pull/${p.number}/head:refs/review/pr-${p.number}`,
				`+refs/heads/${info.baseRefName}:refs/remotes/origin/${info.baseRefName}`], { timeoutMs: 300000 });
			if (!fetched.ok) throw new Error(`could not fetch PR #${p.number}: ${fetched.err.split("\n")[0]}`);
			const created = now();
			const path = join(root, "wt", p.owner, p.repo, `pr-${p.number}-${stamp(created)}`);
			assertInside(root, path);
			await mkdir(dirname(path), { recursive: true });
			const added = await exec("git", ["--git-dir", dir, "worktree", "add", "--quiet", "--detach", path, `refs/review/pr-${p.number}`], { timeoutMs: 300000 });
			if (!added.ok) {
				await rm(path, { recursive: true, force: true });
				throw new Error(`could not check out PR #${p.number}: ${added.err.split("\n")[0]}`);
			}
			const head = (await exec("git", ["-C", path, "rev-parse", "HEAD"])).out;
			const entry = {
				id: `${p.owner}/${p.repo}#${p.number}@${stamp(created)}`,
				url: p.url,
				owner: p.owner,
				repo: p.repo,
				number: p.number,
				title: String(info.title ?? ""),
				mode,
				path,
				head,
				base: info.baseRefName,
				sessionId: null,
				createdAt: created.toISOString(),
				usedAt: created.toISOString()
			};
			const data = await load();
			data.workspaces.push(entry);
			await save(data);
			return entry;
		});
	}

	/** Record which session uses a workspace (after the client created it). */
	function bind(path, sessionId) {
		return locked(async () => {
			const data = await load();
			const entry = data.workspaces.find((w) => w.path === path);
			if (entry === undefined) throw new Error(`unknown review workspace ${path}`);
			entry.sessionId = sessionId;
			entry.usedAt = now().toISOString();
			await save(data);
			return entry;
		});
	}

	async function sizeOf(path) {
		const r = await exec("du", ["-sk", path], { timeoutMs: 20000 });
		const kb = Number.parseInt(r.out.split(/\s+/)[0], 10);
		return Number.isFinite(kb) ? kb * 1024 : null;
	}

	/** Why a workspace may be recycled now, or null to keep it. Running sessions are always kept. */
	function recycleReason(w, at) {
		const state = w.sessionId === null ? undefined : sessionState(w.sessionId);
		if (state?.running) return null;
		if (w.sessionId !== null && isArchived(w.sessionId)) return "archived";
		if (w.sessionId !== null && !sessionExists(w.sessionId)) return "deleted";
		const ageDays = (at - Date.parse(w.usedAt ?? w.createdAt)) / 86400000;
		if (ageDays > limits.maxAgeDays) return "expired";
		if (w.sessionId === null && ageDays > 1 / 24) return "unbound";
		return null;
	}

	async function list() {
		const data = await load();
		const at = now().getTime();
		const rows = [];
		for (const w of data.workspaces) {
			const state = w.sessionId === null ? undefined : sessionState(w.sessionId);
			rows.push({
				...w,
				exists: await exists(w.path),
				running: state?.running === true,
				archived: w.sessionId !== null && isArchived(w.sessionId),
				recycle: recycleReason(w, at),
				size: await sizeOf(w.path)
			});
		}
		rows.sort((a, b) => Date.parse(b.usedAt ?? b.createdAt) - Date.parse(a.usedAt ?? a.createdAt));
		return { root, limits, workspaces: rows };
	}

	async function removeOne(w) {
		assertInside(root, w.path);
		const dir = repoDir(w);
		if (await exists(join(dir, "HEAD"))) {
			await exec("git", ["--git-dir", dir, "worktree", "remove", "--force", w.path]);
		}
		await rm(w.path, { recursive: true, force: true });
		if (await exists(join(dir, "HEAD"))) await exec("git", ["--git-dir", dir, "worktree", "prune"]);
	}

	function removeById(ids, { force = false } = {}) {
		return locked(async () => {
			const data = await load();
			const removed = [];
			const kept = [];
			for (const w of data.workspaces) {
				if (!ids.includes(w.id)) {
					kept.push(w);
					continue;
				}
				const state = w.sessionId === null ? undefined : sessionState(w.sessionId);
				if (state?.running && !force) {
					kept.push(w);
					continue;
				}
				await removeOne(w);
				removed.push(w.id);
			}
			data.workspaces = kept;
			await save(data);
			await pruneRepos(data);
			return { removed, skipped: ids.filter((id) => !removed.includes(id)) };
		});
	}

	/** Drop shared clones no remaining workspace uses. */
	async function pruneRepos(data) {
		const used = new Set(data.workspaces.map((w) => `${w.owner}/${w.repo}`));
		const reposRoot = join(root, "repos");
		if (!(await exists(reposRoot))) return;
		for (const owner of await readdir(reposRoot)) {
			if (!SAFE.test(owner)) continue;
			for (const entry of await readdir(join(reposRoot, owner))) {
				if (!entry.endsWith(".git")) continue;
				const key = `${owner}/${entry.slice(0, -4)}`;
				if (used.has(key)) continue;
				const dir = join(reposRoot, owner, entry);
				assertInside(root, dir);
				await rm(dir, { recursive: true, force: true });
			}
		}
	}

	/**
	 * Recycle everything that is due: archived or deleted sessions, workspaces
	 * past maxAgeDays, workspaces never bound to a session, and the oldest idle
	 * ones beyond maxWorkspaces. Also forgets entries whose folder is gone.
	 */
	function sweep() {
		return locked(async () => {
			const data = await load();
			const at = now().getTime();
			const keep = [];
			const removed = [];
			for (const w of data.workspaces) {
				if (!(await exists(w.path))) {
					removed.push({ id: w.id, reason: "missing" });
					continue;
				}
				const reason = recycleReason(w, at);
				if (reason === null) keep.push(w);
				else {
					try {
						await removeOne(w);
						removed.push({ id: w.id, reason });
					} catch (error) {
						logger.warn?.(`github-review: could not remove ${w.path}: ${error?.message ?? error}`);
						keep.push(w);
					}
				}
			}
			keep.sort((a, b) => Date.parse(b.usedAt ?? b.createdAt) - Date.parse(a.usedAt ?? a.createdAt));
			const final = [];
			for (const w of keep) {
				const state = w.sessionId === null ? undefined : sessionState(w.sessionId);
				if (final.length >= limits.maxWorkspaces && !state?.running) {
					try {
						await removeOne(w);
						removed.push({ id: w.id, reason: "over-limit" });
						continue;
					} catch (error) {
						logger.warn?.(`github-review: could not remove ${w.path}: ${error?.message ?? error}`);
					}
				}
				final.push(w);
			}
			data.workspaces = final;
			await save(data);
			await pruneRepos(data);
			return { removed, kept: final.length };
		});
	}

	/** Note activity on a workspace's session, so active reviews do not expire. */
	function touch(sessionId) {
		return locked(async () => {
			const data = await load();
			let changed = false;
			for (const w of data.workspaces) {
				if (w.sessionId === sessionId) {
					w.usedAt = now().toISOString();
					changed = true;
				}
			}
			if (changed) await save(data);
		});
	}

	return { root, prepare, bind, list, remove: removeById, sweep, touch, recycleReason, load };
}

/**
 * The first message of a review session. `/pr-explain` and `/pr-review` are
 * skill tokens, so DSH injects both skills' full instructions on this turn.
 */
export function reviewPrompt(entry, mode) {
	const where = `代码已经检出到当前会话目录 \`${entry.path}\`（PR #${entry.number} 的最新提交 \`${entry.head.slice(0, 12)}\`，基准分支 \`origin/${entry.base}\`）。只在这个目录里读代码，不要切换到其他目录。`;
	if (mode === "explain") {
		return [
			`/pr-explain ${entry.url}`,
			"",
			"请用中文解读这个 PR：为什么需要、做了什么、怎么做的、影响范围和风险、建议阅读顺序。",
			where,
			"这次只做解读，不要在 GitHub 上发布任何评论、评审或标签。"
		].join("\n");
	}
	return [
		`/pr-explain /pr-review ${entry.url}`,
		"",
		"请分两步完成：",
		"1. 先按 pr-explain 输出这个 PR 的中文解读（为什么需要、做了什么、怎么做的、影响范围和风险、建议阅读顺序）。",
		"2. 然后按 pr-review 完整审查这个 PR，并把评审发布到 GitHub。发布到 GitHub 的评审语言跟随 PR 本身的语言。",
		where,
		"全部完成后，用中文总结：评审结论（批准 / 需要修改 / 评论）、各级别意见各几条、评审链接，以及看板和风险标签是否设置成功。"
	].join("\n");
}
