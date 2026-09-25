---
name: github
description: "GitHub CLI for issues, PRs, CI/check logs, comments, reviews, releases, repos, and gh api queries."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# GitHub

Use `gh` for GitHub. Use `git` for local commits/branches/push/pull. Use code-reading tools for deep reviews.

## Auth

```bash
gh auth status
gh auth login
```

Gateway HOME can differ from operator HOME. If `gh` auth exists elsewhere, set `GH_CONFIG_DIR` in the gateway service env and restart.

## PRs

```bash
gh pr list --repo owner/repo --json number,title,state,author,url
gh pr view 55 --repo owner/repo --json title,body,author,files,commits,reviews,reviewDecision
gh pr checks 55 --repo owner/repo
gh pr diff 55 --repo owner/repo
gh pr create --repo owner/repo --title "feat: title" --body-file /tmp/pr.md
gh pr merge 55 --repo owner/repo --squash
```

When creating a commit or new PR, use the exact ordered `Worked on by` GitHub logins supplied by the session's Git co-author prompt. Preserve its exact `Co-authored-by` trailers in commits, including after history rewrites. Never infer identities from names, chat, or trailers, include bots or opted-out people, or reorder the supplied contributors.

For a new PR, include `## Worked on by` only when both that list and the Runtime line's `sessionUrl=<exact-url>` are present. Append the final footer below in that case; when the URL is absent, omit the public credit section and footer but retain the verified commit trailers. If no credit list is present, append the footer only when the URL is present. Replace `<sessionUrl>` with the supplied URL verbatim; do not construct or modify it. Preserve any publication marker before exactly one footer, and keep the footer final:

```text
---
[View the OpenClaw team session](<sessionUrl>)
```

URLs work directly: `gh pr view https://github.com/owner/repo/pull/55`.

When refreshing an existing PR from a different session, preserve its verified
`## Worked on by` section and exact canonical footer. Keep the new session's
verified contributors in its commit trailers only; do not replace the earlier
session URL or add a second footer. If no public footer exists, the new session
may add its own verified credit and canonical footer under the conditions above.

## Codex review gate (mandatory)

A PR you submit is not finished when it is pushed. It is finished when the GitHub Codex
reviewer has reviewed the current head with nothing outstanding.

```bash
gh pr view 55 --repo owner/repo --json headRefOid,reviews,comments
gh api "repos/owner/repo/pulls/55/comments"       # inline findings and locations
gh pr comment 55 --repo owner/repo --body "@codex review"   # when no review appears
```

- Wait for `chatgpt-codex-connector` after opening a PR and after every push that moves the
  head. It reviews on PR open, on a draft marked ready, and on a `@codex review` comment;
  it reacts 👀 while running, comments when it has findings, 👍 when a review finishes clean.
- Its `<!-- codex-pull-request-review-summary -->` comment tabulates each review's status and
  the commit it covered. A review of an earlier commit says nothing about the current head.
- Silence is not approval — an old PR, a rebase, or a push that did not trigger a review needs
  an explicit `@codex review` request.
- Read both PR issue comments and inline pull-request review comments before resolving findings; `gh pr view --json comments,reviews` does not include inline comment bodies or locations.
- Address every finding: fix it, or reply on its thread with the reason it does not hold. Then
  push, request the re-review, and wait for that one too.
- Report the PR only when the newest Codex review covers the current head SHA with no
  unaddressed findings; otherwise say what is outstanding instead of calling it done.
- A `github_publish` result with `status: "published"` means the Gateway created
  or reused a PR, not that this review gate cleared. Report review as pending;
  check whether the PR is a draft and mark it ready if so, then verify the
  current-head review before reporting the PR task complete. The tool result
  itself is not review evidence.

When the user asks to land or merge a PR, a clean review is a gate, not the terminal outcome.
Keep the job active through pending CI checks, conflicts, and required merge gates; address
in-scope failures and recheck the updated head. Verify `state == MERGED` with
`gh pr view ... --json state,mergedAt,mergeCommit` before reporting the merge complete.
If new authority or an unavailable credential blocks the merge, report that blocker and
leave the PR unmerged.

## Issues

```bash
gh issue list --repo owner/repo --state open --json number,title,labels,url
gh issue view 42 --repo owner/repo --json title,body,comments,labels,state
gh issue create --repo owner/repo --title "Bug: ..." --body-file /tmp/issue.md
gh issue comment 42 --repo owner/repo --body-file /tmp/comment.md
gh issue close 42 --repo owner/repo --comment "Fixed in ..."
```

## CI/runs

```bash
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo --json status,conclusion,headSha,url
gh run view <run-id> --repo owner/repo --log-failed
gh run rerun <run-id> --repo owner/repo --failed
```

## API

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh api repos/owner/repo/labels --jq '.[].name'
gh api --cache 1h repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```

Use `--json` + `--jq` for structured output. Use `--body-file` for comments/bodies containing backticks, shell snippets, env names, or user text.
