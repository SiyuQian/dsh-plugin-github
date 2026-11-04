# dsh-plugin-github

A DeepSeek Harness plugin for working with GitHub. It adds:

- a **GitHub** tab in the sidebar, beside 插件 and 自动化任务, that lists your open pull requests and the ones waiting for your review;
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

### Create PR and the message box

- **Composer button.** Clicking **Create PR** first runs a quick, read-only git check on the session folder (local refs only, nothing fetched). If the folder is not a git repo, or the branch has no commits ahead of its base and no uncommitted changes, it shows a notice and sends nothing. Otherwise it sends this prompt to the session:

  > /pr-creator Create a pull request for the current branch (or update the existing one).

  If the git check fails for any reason, the prompt is still sent; the skill runs its own full preflight.
- **PR link.** When a session has a pull request, a link such as `#191` appears just left of the button, with a dot for its state (green open, grey draft, purple merged, red closed). Hover shows the title. Clicking it opens the PR in your default browser (Chrome on this Mac). While the PR is open or a draft, the button reads **Update PR**.
- **Sidebar title.** A session linked to a PR is renamed `#191 <PR title>`, so the sidebar shows which PR each session is about. The title follows the PR if it is renamed on GitHub.

  A session is linked to a PR when:
  - you paste a PR link into your message (for example, `https://github.com/.../pull/191 improve the docs`), or
  - the agent runs `gh pr create` (or `glab mr create`) and it prints the new PR's URL.

  The latest of these wins. A PR the agent only views, edits, or mentions does not link the session. If neither has happened, the link falls back to the PR of the session folder's current branch, without renaming the session.

  A title you set yourself (double-click to rename) is never overwritten. Subagent sessions are never renamed.

  PR details come from `gh pr view` (or `glab mr view`), using the CLI's own login. They are looked up when the session opens, after each agent turn ends, as soon as a link is pasted or a PR is created, and when you switch back to the app from another window (at most every 15 seconds). If a lookup fails, the last known link stays on screen.
- **`pr-creator` skill.** Registered as a bundled skill, so it also works from the `/` menu or when you ask in plain words ("open a PR"). A `pr-creator` skill in your own or a project's skill folder takes precedence over this one.

The skill does the actual work: it reads the diff against `origin/<default branch>`, creates a branch if you are on `main`, commits relevant changes, pushes, fills in the repo's PR template (or one of its own), and creates or updates the PR with `gh` or `glab`. For user-visible frontend changes, it also handles screenshots. See the vendored [SKILL.md](vendor/devpilot/skills/pr-creator/SKILL.md) for the full rules, including when it stops and asks.

The button is disabled while the agent is running and hidden in subagent sessions.

## Requirements

- `gh`, logged in (`gh auth login`) with an account that can see your repositories. GitLab MRs work in the message box through `glab`; the GitHub tab is GitHub only.
- `git`.
- `python3` for the skill's screenshot checker.

## Install

In DeepSeek Harness, open **Plugins > Add plugin**. Enter the absolute path of a local checkout, or this repository's Git URL. Restart the app if the GitHub tab or the button does not appear.

This repository is private, so installing from the Git URL needs a git login (SSH key or `gh auth login`) with access to it.

## Updating the skill

The skill is copied from devpilot-plugin into `vendor/devpilot`. To refresh it:

```sh
git -C <devpilot-plugin checkout> fetch origin
scripts/sync-devpilot.sh <devpilot-plugin checkout> [ref, default origin/main]
```

The script reads the ref with `git archive` and never changes the checkout. It records the commit and devpilot version in `vendor/devpilot/SOURCE.json`. The current copy is devpilot 1.38.0.

At load time, the plugin adds a short note to the top of the skill. The note:

- gives the real path for `<devpilot>`
- says other `devpilot:*` skills it mentions (pr-guard, pr-announce) may not be installed
- maps the skill's task list to `todo_write`

The skill text itself is unchanged.

## Limitations

- One click is one prompt. The skill is designed to run without asking for confirmation, so it will create the branch, commit, and push unless it hits one of its documented hard stops.
- The button prompt is in the UI language (English or Chinese). The skill writes the PR in the language of that prompt unless the repo's convention says otherwise.
- The preflight only reads local refs. A stale `origin/main` can make it think there is work to PR when there is not; the skill fetches before it decides.
- Only `https` PR links are shown. Looking up the link adds one `gh` call (about a second, in the background) at the end of every agent turn.
- The rename goes through DSH's own title service, the same as renaming by hand, so it is recorded as a user title in the session log. Titles are cut at DSH's 80-byte limit.
- Sessions are renamed only while open in DSH. An old session picks up its PR title the next time you open it.
- The GitHub tab shows at most 50 PRs per list; the owner chips filter those 50, not every PR on GitHub.
- Notices appear above the message box. If that is unavailable, the plugin falls back to a native alert.

## Test

```sh
node --test test.mjs
```

The client tests use a stub context and check the wiring, not the real app. The preflight tests run real git in temporary repositories.

## Licence

MIT for the plugin code. The vendored devpilot files in `vendor/devpilot` are Apache-2.0; see `vendor/devpilot/LICENSE-APACHE-2.0.txt`.
