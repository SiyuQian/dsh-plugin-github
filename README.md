# dsh-plugin-github

A DeepSeek Harness plugin for working with GitHub. It adds:

- a **GitHub** tab in the sidebar, beside 插件 and 自动化任务, that lists your open pull requests and the ones waiting for your review;
- one-click **中文解读** and **审查** on PRs waiting for your review, each in its own throwaway checkout;
- a **Create PR** button in the message box;
- a PR link in the message box, and PR titles on sessions in the sidebar.

The buttons send prompts that invoke skills (`/pr-creator`, `/pr-explain`, `/pr-review` by default). **This plugin registers no skills**: install a plugin that provides them, such as [dsh-plugin-devpilot](https://github.com/SiyuQian/dsh-plugin-devpilot), or point the prompts at your own skills (see [Configuration](#configuration)).

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
| **审查** | Opens a new session that first gives the same Chinese walkthrough, then runs `pr-review` and **posts the review to GitHub** (inline comments, and an Approve, Comment, or Request changes event), a `risk:<tier>` label, and a GitHub Project status where the token allows. | **Yes** |

The review on GitHub is written in the PR's own language (an English PR gets an English review), per the skill's rules. The walkthrough and the final summary in the session are in Chinese.

What one click does:

1. Checks the PR head out into a fresh folder: `~/.dsh/github-review/wt/<owner>/<repo>/pr-<n>-<time>` (a `git worktree` of one shared, blobless bare clone per repository under `~/.dsh/github-review/repos`). Your own working folders are never touched.
2. Creates a session in that folder, named `审查 #<n> <title>` or `解读 #<n> <title>`, and opens it.
3. Sends the first message (the configured `reviewPrompt` or `explainPrompt`), which by default starts with `/pr-explain /pr-review <url>` (or `/pr-explain <url>`), so both skills' full instructions are loaded for that turn.

While a PR has a session, its row shows **打开会话** instead, which goes back to that session rather than starting another.

### Review checkouts and recycling

Each click checks the PR out into its own folder under `~/.dsh/github-review`. Nothing needs managing by hand: a checkout is deleted automatically when

- its session is archived or deleted;
- it has not been used for 7 days;
- it was never attached to a session (after an hour; this happens if starting a session failed);
- there are more than 20, oldest idle first.

A checkout whose session is running is never deleted. Recycling runs 30 seconds after DSH starts and then every six hours. Session history is kept; only the code folder goes. A shared clone is removed once no checkout uses it.

### Create PR and the message box

- **Composer button.** Clicking **Create PR** first runs a quick, read-only git check on the session folder (local refs only, nothing fetched). If the folder is not a git repo, or the branch has no commits ahead of its base and no uncommitted changes, it shows a notice and sends nothing. Otherwise it sends this prompt to the session:

  > /pr-creator Create a pull request for the current branch (or update the existing one).

  If the git check fails for any reason, the prompt is still sent; the skill runs its own full preflight.
- **Multi-repo folders.** When the session folder is not a repository but holds several (for example a workspace with one folder per repo), **Create PR** checks every repository in it. If none has new commits or uncommitted changes, it says so. If exactly one does, it goes straight ahead. If several do, a picker lists them with their branch, commits ahead, uncommitted files, whether this session worked in them, and any open PR for the branch. Repositories this session worked in (seen from its own commands and file paths) are ticked; repositories without changes are listed but cannot be chosen. One message then asks the agent to run pr-creator on each chosen repository in turn.
- **PR link.** When a session has a pull request, a link such as `#191` appears just left of the button, with a dot for its state (green open, grey draft, purple merged, red closed). Hover shows the title. Clicking it opens the PR in your default browser. While the PR is open or a draft, the button reads **Update PR**. A session linked to several PRs shows the most recent one with **+N**; clicking it lists them all, most recent first, and choosing one opens it.
- **Sidebar title.** A session linked to a PR is renamed `#191 <PR title>`, so the sidebar shows which PR each session is about. The title follows the PR if it is renamed on GitHub.

  A session is linked to a PR when:
  - you paste a PR link into your message (for example, `https://github.com/.../pull/191 improve the docs`), or
  - the agent runs `gh pr create` (or `glab mr create`) and it prints the new PR's URL.

  Every linked PR is kept (up to 12), most recent first; the title follows the most recent one. Hovering over the session in the sidebar lists them all. A PR the agent only views, edits, or mentions does not link the session. A session with neither shows no PR link, even if its folder's current branch has a PR: a new session in a checkout left on an old branch should not inherit that branch's (often merged) PR.

  A title you set yourself (double-click to rename) is never overwritten. Subagent sessions are never renamed.

  PR details come from `gh pr view` (or `glab mr view`), using the CLI's own login. They are looked up when the session opens, after each agent turn ends, as soon as a link is pasted or a PR is created, and when you switch back to the app from another window (at most every 15 seconds). If a lookup fails, the last known link stays on screen.
- **Missing skills.** Before sending any prompt, the plugin reads the session's skill catalog (DSH's `skills/list`). If the prompt starts with `/name` tokens that no installed plugin provides, it shows 需要安装提供 /name 的插件（例如 dsh-plugin-devpilot） (or the English equivalent) and sends nothing. If the catalog cannot be read, the prompt is sent anyway.

The skill does the actual work (with dsh-plugin-devpilot's `pr-creator`: read the diff, branch, commit, push, fill in the PR template, and create or update the PR with `gh` or `glab`). See that plugin for the skills' rules.

The button is disabled while the agent is running and hidden in subagent sessions.

## Requirements

- `gh`, logged in (`gh auth login`) with an account that can see your repositories. GitLab MRs work in the message box through `glab`; the GitHub tab is GitHub only.
- `git`.
- A plugin that provides the skills the prompts name (for example dsh-plugin-devpilot).

## Install

In DeepSeek Harness, open **Plugins > Add plugin**. Enter the absolute path of a local checkout, or this repository's Git URL. Restart the app if the GitHub tab or the button does not appear.

Install a skills plugin as well, for example [dsh-plugin-devpilot](https://github.com/SiyuQian/dsh-plugin-devpilot), which provides `pr-creator`, `pr-review`, and `pr-explain`.

## Configuration

Every prompt the plugin sends is a template in the plugin's config (Plugins > dsh-plugin-github > settings, or `cordis.patch.yml`). Placeholders are written `{name}`; unknown placeholders are left as written. Leading `/name` tokens are skill tokens: DSH loads those skills for the turn.

| Key | Used for | Placeholders | Default |
|---|---|---|---|
| `createPrPrompt` | **Create PR**, one repository | none | empty: the built-in text in the UI language, `/pr-creator Create a pull request for the current branch (or update the existing one).` |
| `multiRepoCreatePrPrompt` | **Create PR**, several repositories | `{n}` count, `{root}` session folder, `{list}` numbered repository list | empty: the built-in text, starting with `/pr-creator` |
| `reviewPrompt` | **审查** | `{url}`, `{number}`, `{path}` checkout folder, `{head}` 12-character head SHA, `{base}` base branch | `/pr-explain /pr-review {url}` followed by the Chinese two-step instructions |
| `explainPrompt` | **中文解读** | same as `reviewPrompt` | `/pr-explain {url}` followed by the Chinese walkthrough instructions |

For example, to review with your own skill:

```yaml
- insert:
    - id: github
      name: dsh-plugin-github
      config:
        reviewPrompt: "/my-review {url}\nThe code is checked out in `{path}` at `{head}`, base `origin/{base}`."
```

## Limitations

- One click is one prompt. The skill is designed to run without asking for confirmation, so it will create the branch, commit, and push unless it hits one of its documented hard stops.
- The button prompt is in the UI language (English or Chinese). The skill writes the PR in the language of that prompt unless the repo's convention says otherwise.
- The preflight only reads local refs. A stale `origin/main` can make it think there is work to PR when there is not; the skill fetches before it decides.
- Only `https` PR links are shown. Looking up the link adds one `gh` call (about a second, in the background) at the end of every agent turn.
- The rename goes through DSH's own title service, the same as renaming by hand, so it is recorded as a user title in the session log. Titles are cut at DSH's 80-byte limit.
- Sessions are renamed only while open in DSH. An old session picks up its PR title the next time you open it.
- The GitHub tab shows at most 50 PRs per list; the owner chips filter those 50, not every PR on GitHub.
- **审查 posts to GitHub without asking.** That is how `pr-review` works: running it is the instruction to post. Use **中文解读** when you only want to read.
- A full review can take several minutes or more; what it does depends on the skill that provides `pr-review`.
- Notices appear above the message box. If that is unavailable, the plugin falls back to a native alert.

## Test

```sh
node --test test.mjs
```

The client tests use a stub context and check the wiring, not the real app. The preflight tests run real git in temporary repositories; the review workspace tests use a fake git and gh.

## Licence

MIT. See [LICENSE](LICENSE).
