# dsh-plugin-github

A DeepSeek Harness plugin for working with GitHub. It adds:

- a **GitHub** tab in the sidebar, beside 插件 and 自动化任务, that lists your open pull requests and the ones waiting for your review;
- one-click **中文解读** and **审查** on PRs waiting for your review, backed by the devpilot [`pr-review`](https://github.com/SiyuQian/devpilot-plugin/tree/main/skills/pr-review) skill, each in its own throwaway checkout;
- a **Create PR** button in the message box, backed by the devpilot [`pr-creator`](https://github.com/SiyuQian/devpilot-plugin/tree/main/skills/pr-creator) skill;
- a PR link in the message box, and PR titles on sessions in the sidebar.

Everything reads GitHub through your own `gh` login. Tested only against DeepSeek Harness 0.2.1-rc.5. It uses internal APIs that may change between releases.

## What it does

### GitHub tab

- **My PRs**: your open pull requests across every repository your `gh` login can see, most recently updated first.
- **Review requested**: open pull requests where someone asked you to review.

Each row shows the repository and number, draft state, CI checks (passed, failed, running), and review state (approved, changes requested, review required); the review list also shows the author. Clicking a row opens the PR in your default browser. Chips under the tabs filter by owner (for example `example-org`, `octocat`), sorted by how many PRs each has.

The list loads when you open the tab, at most once a minute, and the refresh button reloads it straight away. Each list shows the 50 most recently updated PRs, and the tab header gives the full count. If a reload fails, the last list stays on screen with the error beside it. The data comes from one `gh api graphql` call with two searches:

- `is:pr is:open author:@me archived:false`
- `is:pr is:open review-requested:@me archived:false`

### Reviewing a PR (待我审查)

Each row in **Review requested** has two buttons:

| Button | What it does | Writes to GitHub |
|---|---|---|
| **中文解读** | Opens a new session that explains the PR in plain Chinese: why it is needed, what it changes, how, what it affects, where to start reading. | No |
| **审查** | Opens a new session that first gives the same Chinese walkthrough, then runs devpilot `pr-review` and **posts the review to GitHub** (inline comments, and an Approve, Comment, or Request changes event), a `risk:<tier>` label, and a GitHub Project status where the token allows. | **Yes** |

The review on GitHub is written in the PR's own language (an English PR gets an English review), per the skill's rules. The walkthrough and the final summary in the session are in Chinese.

What one click does:

1. Checks the PR head out into a fresh folder: `~/.dsh/github-review/wt/<owner>/<repo>/pr-<n>-<time>` (a `git worktree` of one shared, blobless bare clone per repository under `~/.dsh/github-review/repos`). Your own working folders are never touched.
2. Creates a session in that folder, named `审查 #<n> <title>` or `解读 #<n> <title>`, and opens it.
3. Sends the first message, which starts with `/pr-explain /pr-review <url>` (or `/pr-explain <url>`), so both skills' full instructions are loaded for that turn.

While a PR has a session, its row shows **打开会话** instead, which goes back to that session rather than starting another.

### Review workspaces (审查工作区)

The third tab lists every review checkout with its PR, mode, size, last use, and session state. A workspace is recycled (its folder deleted) when:

- its session is archived or deleted;
- it has not been used for 7 days;
- it was never attached to a session (after an hour; this happens if starting a session failed);
- there are more than 20, oldest idle first.

A workspace whose session is running is never recycled. Recycling runs 30 seconds after DSH starts, every six hours, and when you click **立即回收**; **删除** removes one at once (not while its session is running). Session history is kept; only the code folder goes. A shared clone is removed once no workspace uses it.

### Create PR and the message box

- **Composer button.** Clicking **Create PR** first runs a quick, read-only git check on the session folder (local refs only, nothing fetched). If the folder is not a git repo, or the branch has no commits ahead of its base and no uncommitted changes, it shows a notice and sends nothing. Otherwise it sends this prompt to the session:

  > /pr-creator Create a pull request for the current branch (or update the existing one).

  If the git check fails for any reason, the prompt is still sent; the skill runs its own full preflight.
- **PR link.** When a session has a pull request, a link such as `#191` appears just left of the button, with a dot for its state (green open, grey draft, purple merged, red closed). Hover shows the title. Clicking it opens the PR in your default browser (Chrome on this Mac). While the PR is open or a draft, the button reads **Update PR**.
- **Sidebar title.** A session linked to a PR is renamed `#191 <PR title>`, so the sidebar shows which PR each session is about. The title follows the PR if it is renamed on GitHub.

  A session is linked to a PR when:
  - you paste a PR link into your message (for example, `https://github.com/.../pull/191 improve the docs`), or
  - the agent runs `gh pr create` (or `glab mr create`) and it prints the new PR's URL.

  The latest of these wins. A PR the agent only views, edits, or mentions does not link the session. A session with neither shows no PR link, even if its folder's current branch has a PR: a new session in a checkout left on an old branch should not inherit that branch's (often merged) PR.

  A title you set yourself (double-click to rename) is never overwritten. Subagent sessions are never renamed.

  PR details come from `gh pr view` (or `glab mr view`), using the CLI's own login. They are looked up when the session opens, after each agent turn ends, as soon as a link is pasted or a PR is created, and when you switch back to the app from another window (at most every 15 seconds). If a lookup fails, the last known link stays on screen.
- **Skills.** `pr-creator`, `pr-review` and `pr-explain` are registered as bundled skills, so they also work from the `/` menu or when you ask in plain words ("open a PR", "review this PR"). A skill of the same name in your own or a project's skill folder takes precedence.

The skill does the actual work: it reads the diff against `origin/<default branch>`, creates a branch if you are on `main`, commits relevant changes, pushes, fills in the repo's PR template (or one of its own), and creates or updates the PR with `gh` or `glab`. For user-visible frontend changes, it also handles screenshots. See the vendored [SKILL.md](vendor/devpilot/skills/pr-creator/SKILL.md) for the full rules, including when it stops and asks.

The button is disabled while the agent is running and hidden in subagent sessions.

## Requirements

- `gh`, logged in (`gh auth login`) with an account that can see your repositories. GitLab MRs work in the message box through `glab`; the GitHub tab is GitHub only.
- `git`.
- `python3` for devpilot's scripts (screenshot checker, review checks, risk tier, code graph wrapper).

## Install

In DeepSeek Harness, open **Plugins > Add plugin**. Enter the absolute path of a local checkout, or this repository's Git URL. Restart the app if the GitHub tab or the button does not appear.

This repository is private, so installing from the Git URL needs a git login (SSH key or `gh auth login`) with access to it.

## Updating devpilot

`vendor/devpilot` is a complete copy of the devpilot plugin (about 3 MB), not just the skills this plugin registers: devpilot's scripts check that their plugin root is a complete installation before they run, and `pr-review` uses scripts that belong to other devpilot skills. Only the repository's tests, evals, and CI files are left out. To refresh it:

```sh
git -C <devpilot-plugin checkout> fetch origin
scripts/sync-devpilot.sh <devpilot-plugin checkout> [ref, default origin/main]
```

The script reads the ref with `git archive` and never changes the checkout. It checks the copy with devpilot's own installation check and records the commit and devpilot version in `vendor/devpilot/SOURCE.json`. The current copy is devpilot 1.38.0.

At load time, the plugin adds a short note to the top of each devpilot skill. The note:

- gives the value for `DEVPILOT_PLUGIN_ROOT` (the vendored copy), which devpilot's scripts use to find themselves
- says other `devpilot:*` skills it mentions may not be in the catalogue
- maps the skill's task list to `todo_write`
- for `pr-review`: DSH cannot restrict subagents to read-only roles, so the review runs devpilot's `degraded` mode (all review angles in one session, disclosed in the posted review)

The skill text itself is unchanged. `pr-explain` is this plugin's own skill, in `skills/pr-explain`.

## Limitations

- One click is one prompt. The skill is designed to run without asking for confirmation, so it will create the branch, commit, and push unless it hits one of its documented hard stops.
- The button prompt is in the UI language (English or Chinese). The skill writes the PR in the language of that prompt unless the repo's convention says otherwise.
- The preflight only reads local refs. A stale `origin/main` can make it think there is work to PR when there is not; the skill fetches before it decides.
- Only `https` PR links are shown. Looking up the link adds one `gh` call (about a second, in the background) at the end of every agent turn.
- The rename goes through DSH's own title service, the same as renaming by hand, so it is recorded as a user title in the session log. Titles are cut at DSH's 80-byte limit.
- Sessions are renamed only while open in DSH. An old session picks up its PR title the next time you open it.
- The GitHub tab shows at most 50 PRs per list; the owner chips filter those 50, not every PR on GitHub.
- **审查 posts to GitHub without asking.** That is how `pr-review` works: running it is the instruction to post. Use **中文解读** when you only want to read.
- Reviews run in devpilot's `degraded` mode (one session, angles run one after another), which the posted review says. A full review can take several minutes or more.
- The GitHub Project step of `pr-review` needs the `project` token scope (`gh auth refresh -s project`). Without it that step fails, is reported in the summary, and the review is posted anyway.
- On first use in a repository, `pr-review` may build a CodeGraph index in the review folder; it goes when the folder is recycled.
- Notices appear above the message box. If that is unavailable, the plugin falls back to a native alert.

## Test

```sh
node --test test.mjs
```

The client tests use a stub context and check the wiring, not the real app. The preflight tests run real git in temporary repositories; the review workspace tests use a fake git and gh.

## Licence

MIT for the plugin code. The vendored devpilot files in `vendor/devpilot` are Apache-2.0; see `vendor/devpilot/LICENSE-APACHE-2.0.txt`.
