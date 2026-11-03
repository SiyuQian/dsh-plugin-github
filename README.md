# dsh-plugin-create-pr

A DeepSeek Harness plugin for opening pull requests in one click. It adds a **Create PR** button to the message box, just left of the model selector. The button hands the work to the devpilot [`pr-creator`](https://github.com/SiyuQian/devpilot-plugin/tree/main/skills/pr-creator) skill.

Tested only against DeepSeek Harness 0.2.1-rc.5. It uses internal APIs that may change between releases.

## What it does

- **Composer button.** Clicking **Create PR** first runs a quick, read-only git check on the session folder (local refs only, nothing fetched). If the folder is not a git repo, or the branch has no commits ahead of its base and no uncommitted changes, it shows a notice and sends nothing. Otherwise it sends this prompt to the session:

  > /pr-creator Create a pull request for the current branch (or update the existing one).

  If the git check fails for any reason, the prompt is still sent; the skill runs its own full preflight.
- **PR link.** When the session folder's branch has a pull request, a link such as `#191` appears just left of the button, with a dot for its state (green open, grey draft, purple merged, red closed). Hover shows the title. Clicking it opens the PR in your default browser (Chrome on this Mac). While the PR is open or a draft, the button reads **Update PR**.

  The link comes from `gh pr view` (or `glab mr view` for GitLab), using the CLI's own login. It is looked up when the session opens, after each agent turn ends, and when you switch back to the app from another window (at most every 15 seconds). If a lookup fails, the last known link stays on screen.
- **`pr-creator` skill.** Registered as a bundled skill, so it also works from the `/` menu or when you ask in plain words ("open a PR"). A `pr-creator` skill in your own or a project's skill folder takes precedence over this one.

The skill does the actual work: it reads the diff against `origin/<default branch>`, creates a branch if you are on `main`, commits relevant changes, pushes, fills in the repo's PR template (or one of its own), and creates or updates the PR with `gh` or `glab`. For user-visible frontend changes, it also handles screenshots. See the vendored [SKILL.md](vendor/devpilot/skills/pr-creator/SKILL.md) for the full rules, including when it stops and asks.

The button is disabled while the agent is running and hidden in subagent sessions.

## Requirements

- `git`, plus `gh` (GitHub) or `glab` (GitLab), logged in with an account that can see the repo.
- `python3` for the skill's screenshot checker.

## Install

In DeepSeek Harness, open **Plugins > Add plugin**. Enter the absolute path of a local checkout, or this repository's Git URL. Restart the app if the button does not appear.

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
- Only `https` PR links are shown, and only for the folder's current branch. Looking up the link adds one `gh` call (about a second, in the background) at the end of every agent turn.
- Notices appear above the message box. If that is unavailable, the plugin falls back to a native alert.

## Test

```sh
node --test test.mjs
```

The client tests use a stub context and check the wiring, not the real app. The preflight tests run real git in temporary repositories.

## Licence

MIT for the plugin code. The vendored devpilot files in `vendor/devpilot` are Apache-2.0; see `vendor/devpilot/LICENSE-APACHE-2.0.txt`.
