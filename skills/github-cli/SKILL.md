---
name: github-cli
description: "Comprehensive GitHub CLI (gh) reference. Covers repos, issues, PRs, Actions, releases, gists, search, projects v2, API, secrets/variables, labels, codespaces, extensions, auth, and advanced GraphQL patterns."
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
            {
              "id": "apt",
              "kind": "apt",
              "package": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (apt)",
            },
          ],
      },
  }
---

# GitHub CLI (`gh`) — Comprehensive Skill

Version: gh 2.66.1+  
Auth: `gh auth login` or set `GH_TOKEN` env var  
Always use `--repo OWNER/REPO` (or `-R`) when not inside a git repo directory.

---

## Table of Contents

1. [Authentication & Config](#1-authentication--config)
2. [Repositories](#2-repositories)
3. [Issues](#3-issues)
4. [Pull Requests](#4-pull-requests)
5. [GitHub Actions (Runs & Workflows)](#5-github-actions-runs--workflows)
6. [Releases](#6-releases)
7. [Gists](#7-gists)
8. [Search](#8-search)
9. [Labels](#9-labels)
10. [Secrets & Variables](#10-secrets--variables)
11. [Caches](#11-caches)
12. [Projects V2](#12-projects-v2)
13. [API (REST & GraphQL)](#13-api-rest--graphql)
14. [Extensions](#14-extensions)
15. [Codespaces](#15-codespaces)
16. [Copilot](#16-copilot)
17. [Other Commands](#17-other-commands)
18. [JSON Output & Formatting](#18-json-output--formatting)
19. [Environment Variables](#19-environment-variables)
20. [Advanced Patterns](#20-advanced-patterns)
21. [Tips & Gotchas](#21-tips--gotchas)

---

## 1. Authentication & Config

### Auth

```bash
# Interactive login (browser-based OAuth)
gh auth login

# Login with a PAT from stdin
echo "$MY_TOKEN" | gh auth login --with-token

# Login to GitHub Enterprise
gh auth login --hostname enterprise.example.com

# Add extra scopes (e.g., project scope for Projects V2)
gh auth refresh -s project

# Add delete_repo scope
gh auth refresh -s delete_repo

# Check auth status (shows active account, scopes, token validity)
gh auth status
gh auth status --show-token

# Switch active account (when multiple accounts configured)
gh auth switch

# Print the active token (useful for piping to other tools)
gh auth token

# Logout
gh auth logout
```

**Required scopes by feature:**
| Feature | Scope needed |
|---------|-------------|
| Basic repo/PR/issue ops | `repo` |
| Gists | `gist` |
| Read org membership | `read:org` |
| Projects V2 | `project` |
| Delete repos | `delete_repo` |
| Actions workflows | `workflow` |
| Read user profile | `user` |

### Config

```bash
# List all config
gh config list

# Get/set individual values
gh config get git_protocol        # https or ssh
gh config set git_protocol ssh
gh config set editor "code --wait"
gh config set pager "less -R"
gh config set prompt disabled     # disable interactive prompts (good for scripts)
gh config set browser "firefox"

# Clear CLI cache
gh config clear-cache
```

### Git credential setup

```bash
# Configure git to use gh for HTTPS auth
gh auth setup-git
```

---

## 2. Repositories

### Create

```bash
# Interactive
gh repo create

# Public repo, clone locally
gh repo create my-project --public --clone

# In an org
gh repo create my-org/my-project --private

# From local directory
gh repo create my-project --private --source=. --remote=upstream --push

# From template
gh repo create my-project --template owner/template-repo --clone

# With options
gh repo create my-project --public --description "My project" \
  --license mit --gitignore Node --add-readme
```

### Clone

```bash
gh repo clone owner/repo
gh repo clone owner/repo my-dir
gh repo clone owner/repo -- --depth=1    # shallow clone

# Clone your own repo (owner defaults to you)
gh repo clone my-repo
```

### Fork

```bash
# Fork current repo
gh repo fork

# Fork and clone
gh repo fork owner/repo --clone

# Fork into an org
gh repo fork owner/repo --org my-org --fork-name new-name

# Fork default branch only
gh repo fork owner/repo --default-branch-only
```

### View

```bash
# View current repo (README + description)
gh repo view
gh repo view owner/repo

# Open in browser
gh repo view --web

# JSON output
gh repo view --json name,description,stargazerCount,url
gh repo view --json name,stargazerCount --jq '.stargazerCount'
```

**JSON fields for repo:** `archivedAt, assignableUsers, codeOfConduct, createdAt, defaultBranchRef, deleteBranchOnMerge, description, diskUsage, forkCount, hasDiscussionsEnabled, hasIssuesEnabled, hasProjectsEnabled, hasWikiEnabled, homepageUrl, id, isArchived, isEmpty, isFork, isPrivate, isTemplate, languages, latestRelease, licenseInfo, name, nameWithOwner, owner, parent, primaryLanguage, pullRequests, pushedAt, sshUrl, stargazerCount, updatedAt, url, visibility, watchers`

### List

```bash
# Your repos
gh repo list
gh repo list --limit 100

# Another user/org's repos
gh repo list my-org

# Filter
gh repo list --language go --visibility public
gh repo list --topic cli --no-archived
gh repo list --fork        # only forks
gh repo list --source      # only non-forks

# JSON output
gh repo list --json name,stargazerCount --jq '.[] | "\(.name): \(.stargazerCount) stars"'
```

### Edit

```bash
# Edit settings
gh repo edit --description "New description"
gh repo edit --homepage "https://example.com"
gh repo edit --enable-issues --enable-wiki
gh repo edit --enable-projects=false
gh repo edit --default-branch main
gh repo edit --enable-auto-merge
gh repo edit --delete-branch-on-merge
gh repo edit --add-topic "cli,automation"
gh repo edit --remove-topic "old-topic"
gh repo edit --template    # make it a template repo

# Change visibility (DANGEROUS — requires acknowledgment)
gh repo edit --visibility public --accept-visibility-change-consequences
```

### Delete / Archive

```bash
gh repo delete owner/repo --yes          # requires delete_repo scope
gh repo archive owner/repo --yes
gh repo unarchive owner/repo --yes
```

### Rename

```bash
gh repo rename new-name                  # renames current repo
gh repo rename new-name -R owner/repo
```

### Set Default

```bash
# Set which remote is used for gh commands in this local clone
gh repo set-default owner/repo
gh repo set-default --view     # see current default
gh repo set-default --unset
```

### Sync (Fork ↔ Upstream)

```bash
# Sync local repo from remote parent
gh repo sync

# Sync specific branch
gh repo sync --branch v1

# Sync remote fork from its parent
gh repo sync owner/my-fork

# Sync from a specific source
gh repo sync owner/repo --source owner2/repo2

# Force sync (hard reset)
gh repo sync --force
```

---

## 3. Issues

### Create

```bash
gh issue create --title "Bug report" --body "Description here"
gh issue create --title "Bug" --label "bug,urgent" --assignee "@me"
gh issue create --title "Feature" --project "Roadmap" --milestone "v2.0"
gh issue create --template "Bug Report"       # use issue template
gh issue create --body-file description.md    # body from file
gh issue create -R owner/repo --title "Bug"   # different repo
```

### List

```bash
gh issue list
gh issue list --state closed
gh issue list --state all --limit 100
gh issue list --label "bug" --assignee "@me"
gh issue list --author monalisa
gh issue list --milestone "v2.0"
gh issue list --search "error no:assignee sort:created-asc"

# JSON output
gh issue list --json number,title,labels,state --jq '.[] | "#\(.number) \(.title)"'
```

**JSON fields for issues:** `assignees, author, body, closed, closedAt, comments, createdAt, id, isPinned, labels, milestone, number, projectCards, projectItems, reactionGroups, state, stateReason, title, updatedAt, url`

### View

```bash
gh issue view 123
gh issue view 123 --web           # open in browser
gh issue view 123 --comments      # include comments
gh issue view 123 --json title,body,labels,assignees

# View by URL
gh issue view https://github.com/owner/repo/issues/123
```

### Edit

```bash
gh issue edit 123 --title "New title" --body "New body"
gh issue edit 123 --add-label "bug,help wanted" --remove-label "core"
gh issue edit 123 --add-assignee "@me" --remove-assignee monalisa
gh issue edit 123 --add-project "Roadmap" --remove-project "v1"
gh issue edit 123 --milestone "v2.0"
gh issue edit 123 --remove-milestone
gh issue edit 123 --body-file body.md

# Bulk edit multiple issues
gh issue edit 123 456 789 --add-label "help wanted"
```

### Close / Reopen

```bash
gh issue close 123
gh issue close 123 --comment "Fixed in PR #456"
gh issue close 123 --reason "not planned"     # completed | not planned
gh issue reopen 123
```

### Comment

```bash
gh issue comment 123 --body "Hello from CLI"
gh issue comment 123 --body-file comment.md
gh issue comment 123 --edit-last              # edit your last comment
```

### Pin / Unpin

```bash
gh issue pin 123
gh issue unpin 123
```

### Transfer

```bash
gh issue transfer 123 owner/other-repo
```

### Lock / Unlock

```bash
gh issue lock 123
gh issue unlock 123
```

### Develop (linked branches)

```bash
# Create a branch linked to issue
gh issue develop 123 --checkout
gh issue develop 123 --name "fix-bug-123" --base develop

# List linked branches
gh issue develop 123 --list
```

### Delete

```bash
gh issue delete 123 --yes
```

---

## 4. Pull Requests

### Create

```bash
gh pr create --title "Fix bug" --body "Description"
gh pr create --fill                    # auto-fill title/body from commits
gh pr create --fill-first              # use first commit only
gh pr create --fill-verbose            # use commit messages + bodies
gh pr create --draft                   # create as draft
gh pr create --base develop            # target branch
gh pr create --head owner:feature-branch
gh pr create --reviewer monalisa,hubot --reviewer myorg/team-name
gh pr create --label "bug" --assignee "@me"
gh pr create --project "Roadmap"
gh pr create --milestone "v2.0"
gh pr create --template "pull_request_template.md"
gh pr create --no-maintainer-edit      # prevent maintainers from pushing
gh pr create --dry-run                 # preview without creating
```

### List

```bash
gh pr list
gh pr list --state merged --limit 50
gh pr list --state all
gh pr list --author "@me"
gh pr list --assignee monalisa
gh pr list --label "bug" --label "priority"
gh pr list --base main
gh pr list --head feature-branch
gh pr list --draft                     # only drafts
gh pr list --search "status:success review:required"
gh pr list --search "<SHA>" --state merged   # find PR for a commit

# JSON output
gh pr list --json number,title,author,state --jq '.[].title'
```

**JSON fields for PRs:** `additions, assignees, author, autoMergeRequest, baseRefName, body, changedFiles, closed, closedAt, comments, commits, createdAt, deletions, files, headRefName, headRefOid, id, isDraft, labels, latestReviews, maintainerCanModify, mergeCommit, mergeStateStatus, mergeable, mergedAt, mergedBy, milestone, number, projectItems, reviewDecision, reviewRequests, reviews, state, statusCheckRollup, title, updatedAt, url`

### View

```bash
gh pr view 123
gh pr view 123 --web
gh pr view 123 --comments
gh pr view 123 --json title,body,reviews,mergeable
gh pr view feature-branch              # by branch name
```

### Checkout

```bash
gh pr checkout 123
gh pr checkout 123 --branch local-name
gh pr checkout 123 --force             # reset existing local branch
gh pr checkout 123 --recurse-submodules
gh co 123                              # alias
```

### Diff

```bash
gh pr diff 123
gh pr diff 123 --name-only             # list changed files
gh pr diff 123 --patch                 # patch format
```

### Merge

```bash
gh pr merge 123 --merge                # merge commit
gh pr merge 123 --squash               # squash merge
gh pr merge 123 --rebase               # rebase merge
gh pr merge 123 --squash --delete-branch
gh pr merge 123 --auto --squash        # enable auto-merge
gh pr merge 123 --disable-auto         # disable auto-merge
gh pr merge 123 --admin                # bypass merge queue / requirements
gh pr merge 123 --squash --subject "feat: new feature" --body "Details"
```

### Review

```bash
gh pr review 123 --approve
gh pr review 123 --comment --body "LGTM"
gh pr review 123 --request-changes --body "Please fix the tests"
gh pr review                           # review current branch's PR
```

### Checks (CI Status)

```bash
gh pr checks 123
gh pr checks 123 --watch               # live-update until done
gh pr checks 123 --watch --fail-fast   # stop on first failure
gh pr checks 123 --required            # only required checks
gh pr checks 123 --json name,state,bucket
gh pr checks 123 --web

# Exit codes: 0=pass, 1=fail, 8=pending
```

**JSON fields for checks:** `bucket, completedAt, description, event, link, name, startedAt, state, workflow`

### Edit

```bash
gh pr edit 123 --title "New title" --body "New body"
gh pr edit 123 --add-label "bug" --remove-label "wip"
gh pr edit 123 --add-reviewer monalisa --remove-reviewer hubot
gh pr edit 123 --add-assignee "@me"
gh pr edit 123 --add-project "Roadmap"
gh pr edit 123 --base develop          # change target branch
gh pr edit 123 --milestone "v2.0"
```

### Close / Reopen

```bash
gh pr close 123
gh pr close 123 --comment "Superseded by #456" --delete-branch
gh pr reopen 123
```

### Ready / Draft

```bash
gh pr ready 123           # mark ready for review
gh pr ready 123 --undo    # convert back to draft (requires plan support)
```

### Update Branch

```bash
gh pr update-branch 123              # merge base into head
gh pr update-branch 123 --rebase    # rebase head onto base
```

### Comment

```bash
gh pr comment 123 --body "Comment text"
gh pr comment 123 --body-file comment.md
```

### Lock / Unlock

```bash
gh pr lock 123
gh pr unlock 123
```

---

## 5. GitHub Actions (Runs & Workflows)

### Workflow Runs

```bash
# List runs
gh run list
gh run list --limit 50
gh run list --workflow build.yml
gh run list --branch main
gh run list --status failure
gh run list --user monalisa
gh run list --event push
gh run list --commit abc123
gh run list --json name,status,conclusion,url

# View a run
gh run view 12345
gh run view 12345 --verbose            # show job steps
gh run view 12345 --log                # full log output
gh run view 12345 --log-failed         # only failed step logs
gh run view 12345 --job 456789         # specific job
gh run view 12345 --job 456789 --log   # specific job logs
gh run view 12345 --attempt 3          # specific attempt
gh run view 12345 --web

# Watch a run (live progress)
gh run watch 12345
gh run watch 12345 --exit-status       # exit non-zero on failure

# Rerun
gh run rerun 12345                     # rerun entire run
gh run rerun 12345 --failed            # rerun only failed jobs
gh run rerun 12345 --debug             # rerun with debug logging
gh run rerun 12345 --job 456789        # rerun specific job

# ⚠️ GOTCHA: --job needs databaseId, NOT the number from the URL!
# Get the right ID:
gh run view 12345 --json jobs --jq '.jobs[] | {name, databaseId}'

# Cancel
gh run cancel 12345

# Delete
gh run delete 12345

# Download artifacts
gh run download 12345                  # all artifacts
gh run download 12345 --name "build-output"
gh run download 12345 --dir ./artifacts
gh run download --name "coverage" --pattern "*.xml"
```

**JSON fields for runs:** `attempt, conclusion, createdAt, databaseId, displayTitle, event, headBranch, headSha, name, number, startedAt, status, updatedAt, url, workflowDatabaseId, workflowName`

### Workflows

```bash
# List workflows
gh workflow list
gh workflow list --all                  # include disabled

# View a workflow
gh workflow view build.yml
gh workflow view build.yml --web

# Run a workflow (workflow_dispatch)
gh workflow run build.yml
gh workflow run build.yml --ref my-branch
gh workflow run build.yml -f name=value -f env=prod
echo '{"name":"value"}' | gh workflow run build.yml --json

# Enable / disable
gh workflow enable build.yml
gh workflow disable build.yml
```

---

## 6. Releases

### Create

```bash
# Interactive
gh release create

# With tag + notes
gh release create v1.2.3 --notes "Bug fix release"
gh release create v1.2.3 --generate-notes            # auto-generated notes
gh release create v1.2.3 --notes-from-tag             # from annotated tag
gh release create v1.2.3 -F CHANGELOG.md              # notes from file
gh release create v1.2.3 --draft                      # save as draft
gh release create v1.2.3 --prerelease
gh release create v1.2.3 --latest=false               # don't mark as latest
gh release create v1.2.3 --target release-branch      # tag from specific branch
gh release create v1.2.3 --verify-tag                 # abort if tag doesn't exist
gh release create v1.2.3 --discussion-category "General"

# With assets
gh release create v1.2.3 ./dist/*.tar.gz
gh release create v1.2.3 'binary.zip#Linux Build'     # with display label
```

### List / View

```bash
gh release list
gh release list --limit 50
gh release view v1.2.3
gh release view v1.2.3 --web
gh release view --json tagName,publishedAt,assets
```

### Download

```bash
gh release download v1.2.3                    # all assets
gh release download v1.2.3 --pattern '*.deb'
gh release download v1.2.3 -p '*.deb' -p '*.rpm'
gh release download v1.2.3 --archive zip      # source code archive
gh release download v1.2.3 --dir ./downloads
gh release download v1.2.3 --output single-file.tar.gz
gh release download --pattern '*.AppImage'    # latest release (no tag arg)
```

### Edit / Upload / Delete

```bash
gh release edit v1.2.3 --title "New Title" --notes "Updated notes"
gh release edit v1.2.3 --draft=false          # publish a draft
gh release edit v1.2.3 --prerelease=false
gh release upload v1.2.3 ./new-asset.zip
gh release upload v1.2.3 'asset.tar.gz#Display Label'
gh release delete v1.2.3 --yes
gh release delete-asset v1.2.3 asset-name
```

---

## 7. Gists

```bash
# Create
gh gist create file.py                        # secret gist
gh gist create --public file.py               # public gist
gh gist create file.py -d "My Python snippet"
gh gist create file1.py file2.js              # multi-file gist
echo "hello" | gh gist create -               # from stdin
cat data.json | gh gist create --filename data.json

# List
gh gist list
gh gist list --public
gh gist list --secret
gh gist list --limit 50

# View
gh gist view GIST_ID
gh gist view GIST_ID --raw                    # raw content
gh gist view GIST_ID --filename file.py       # specific file

# Edit
gh gist edit GIST_ID
gh gist edit GIST_ID --add newfile.txt
gh gist edit GIST_ID --filename file.py       # edit specific file

# Rename
gh gist rename GIST_ID old-name.py new-name.py

# Clone
gh gist clone GIST_ID

# Delete
gh gist delete GIST_ID
```

---

## 8. Search

### Repos

```bash
gh search repos "vim plugin"
gh search repos --owner=microsoft --visibility=public
gh search repos --language=go --stars=">1000"
gh search repos --topic=cli,automation
gh search repos --good-first-issues=">=10"
gh search repos --archived=false
gh search repos cli shell --sort stars --limit 10
gh search repos --json fullName,stargazersCount,description
```

### Issues

```bash
gh search issues "memory leak"
gh search issues --assignee=@me --state=open
gh search issues --owner=cli --label="bug"
gh search issues --comments=">100"
gh search issues --repo owner/repo "error"
gh search issues -- -label:bug                # exclude label
gh search issues --json number,title,repository,state
```

### Pull Requests

```bash
gh search prs "fix bug"
gh search prs --repo=cli/cli --draft
gh search prs --review-requested=@me --state=open
gh search prs --assignee=@me --merged
gh search prs --checks=success --review=approved
gh search prs --json number,title,repository,state
```

### Commits

```bash
gh search commits "bug fix"
gh search commits --author=monalisa
gh search commits --committer-date="<2024-01-01"
gh search commits --repo=cli/cli --hash=abc123
gh search commits --json sha,commit,repository
```

### Code

```bash
gh search code "TODO" --repo=owner/repo
gh search code "import React" --language=typescript
gh search code "api_key" --filename=".env"
gh search code panic --owner=cli --extension=go
gh search code --json path,repository,textMatches
```

---

## 9. Labels

```bash
# List
gh label list
gh label list -R owner/repo
gh label list --json name,color,description

# Create
gh label create "priority:high" --color FF0000 --description "High priority"

# Edit
gh label edit "bug" --name "bug 🐛" --color 00FF00 --description "Something broken"

# Delete
gh label delete "old-label" --yes

# Clone labels from one repo to another
gh label clone source-owner/source-repo --repo dest-owner/dest-repo
```

---

## 10. Secrets & Variables

### Secrets (encrypted)

```bash
# Set (repo-level, for Actions)
gh secret set MY_SECRET --body "secret-value"
gh secret set MY_SECRET < secret-file.txt
echo "value" | gh secret set MY_SECRET

# Set for specific app
gh secret set MY_SECRET --app dependabot --body "value"
gh secret set MY_SECRET --app codespaces --body "value"

# Set environment secret
gh secret set MY_SECRET --env production --body "value"

# Set org-level secret
gh secret set MY_SECRET --org my-org --visibility all --body "value"
gh secret set MY_SECRET --org my-org --visibility selected --repos repo1,repo2

# Set user secret (for Codespaces)
gh secret set MY_SECRET --user --body "value"

# Bulk set from .env file
gh secret set -f .env

# List
gh secret list
gh secret list --env production
gh secret list --org my-org

# Delete
gh secret delete MY_SECRET
gh secret delete MY_SECRET --env production
gh secret delete MY_SECRET --org my-org
```

### Variables (plaintext)

```bash
# Set
gh variable set MY_VAR --body "value"
gh variable set MY_VAR --env staging --body "value"
gh variable set MY_VAR --org my-org --visibility all --body "value"

# Bulk set from .env file
gh variable set -f .env

# Get
gh variable get MY_VAR

# List
gh variable list
gh variable list --env production
gh variable list --org my-org

# Delete
gh variable delete MY_VAR
gh variable delete MY_VAR --env production
```

---

## 11. Caches

```bash
# List Actions caches
gh cache list
gh cache list --limit 100
gh cache list --sort size --order desc

# Delete
gh cache delete CACHE_KEY
gh cache delete --all
```

---

## 12. Projects V2

**⚠️ Requires `project` scope: `gh auth refresh -s project`**

Projects V2 uses the GraphQL-based ProjectsV2 API. The CLI provides commands for most operations, but some advanced field mutations require direct GraphQL via `gh api graphql`.

### List Projects

```bash
gh project list                           # your projects
gh project list --owner my-org            # org projects
gh project list --owner my-org --closed   # include closed
gh project list --format json             # JSON output
```

### Create

```bash
gh project create --owner "@me" --title "My Roadmap"
gh project create --owner my-org --title "Sprint Board"
```

### View

```bash
gh project view 1                         # by number
gh project view 1 --owner my-org
gh project view 1 --web                   # open in browser
gh project view 1 --format json
```

### Edit

```bash
gh project edit 1 --owner "@me" --title "New Title"
gh project edit 1 --description "Updated description"
gh project edit 1 --readme "Project README content"
gh project edit 1 --visibility PUBLIC     # PUBLIC or PRIVATE
```

### Close / Reopen / Delete

```bash
gh project close 1 --owner "@me"
gh project close 1 --owner "@me" --undo   # reopen
gh project delete 1 --owner "@me"
```

### Copy

```bash
gh project copy 1 --source-owner monalisa --target-owner my-org --title "Copied Project"
gh project copy 1 --source-owner monalisa --target-owner my-org --drafts  # include drafts
```

### Link / Unlink to Repository or Team

```bash
gh project link 1 --owner monalisa --repo my-repo
gh project link 1 --owner my-org --team my-team
gh project unlink 1 --owner monalisa --repo my-repo
```

### Mark as Template

```bash
gh project mark-template 1 --owner my-org
gh project mark-template 1 --owner my-org --undo
```

### Fields

```bash
# List fields (shows IDs needed for item-edit)
gh project field-list 1 --owner "@me"
gh project field-list 1 --owner "@me" --format json

# Create field
gh project field-create 1 --owner "@me" --name "Priority" --data-type "SINGLE_SELECT" \
  --single-select-options "Low,Medium,High,Critical"
gh project field-create 1 --owner "@me" --name "Points" --data-type "NUMBER"
gh project field-create 1 --owner "@me" --name "Notes" --data-type "TEXT"
gh project field-create 1 --owner "@me" --name "Due Date" --data-type "DATE"

# Delete field
gh project field-delete --id FIELD_NODE_ID
```

**Field data types:** `TEXT`, `SINGLE_SELECT`, `DATE`, `NUMBER`  
(Iteration fields must be created via the web UI or GraphQL)

### Items

```bash
# List items
gh project item-list 1 --owner "@me"
gh project item-list 1 --owner "@me" --limit 100
gh project item-list 1 --owner "@me" --format json

# Add an existing issue/PR to project
gh project item-add 1 --owner "@me" --url https://github.com/owner/repo/issues/123

# Create a draft issue in project
gh project item-create 1 --owner "@me" --title "Draft task" --body "Details"

# Edit a draft issue (title/body)
gh project item-edit --id ITEM_NODE_ID --title "Updated title" --body "Updated body"

# Edit a field value on an item
gh project item-edit --id ITEM_NODE_ID --field-id FIELD_ID --project-id PROJECT_ID \
  --text "some value"
gh project item-edit --id ITEM_NODE_ID --field-id FIELD_ID --project-id PROJECT_ID \
  --number 5
gh project item-edit --id ITEM_NODE_ID --field-id FIELD_ID --project-id PROJECT_ID \
  --date "2024-12-31"
gh project item-edit --id ITEM_NODE_ID --field-id FIELD_ID --project-id PROJECT_ID \
  --single-select-option-id OPTION_ID
gh project item-edit --id ITEM_NODE_ID --field-id FIELD_ID --project-id PROJECT_ID \
  --iteration-id ITERATION_ID

# Clear a field value
gh project item-edit --id ITEM_NODE_ID --field-id FIELD_ID --project-id PROJECT_ID --clear

# Archive / unarchive item
gh project item-archive 1 --owner "@me" --id ITEM_NODE_ID
gh project item-archive 1 --owner "@me" --id ITEM_NODE_ID --undo

# Delete item from project
gh project item-delete 1 --owner "@me" --id ITEM_NODE_ID
```

### Getting Node IDs (Essential for item-edit)

The `item-edit` command requires node IDs for the item, field, project, and option. Here's how to get them:

```bash
# Get project ID and item IDs
gh project item-list 1 --owner "@me" --format json | jq '.'

# Get field IDs and single-select option IDs
gh project field-list 1 --owner "@me" --format json | jq '.'

# Via GraphQL (more control)
gh api graphql -f query='
  query {
    user(login: "USERNAME") {
      projectV2(number: 1) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
            ... on ProjectV2IterationField {
              id
              name
              configuration {
                iterations { id title startDate duration }
              }
            }
            ... on ProjectV2Field {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }
'
```

### Projects V2 via GraphQL (for what the CLI can't do)

Some operations require direct GraphQL:

```bash
# Update a field value (equivalent to item-edit but more flexible)
gh api graphql -f query='
  mutation {
    updateProjectV2ItemFieldValue(input: {
      projectId: "PVT_xxxx"
      itemId: "PVTI_xxxx"
      fieldId: "PVTF_xxxx"
      value: { singleSelectOptionId: "option_id" }
    }) {
      projectV2Item { id }
    }
  }
'

# Add issue/PR to project via GraphQL
gh api graphql -f query='
  mutation {
    addProjectV2ItemById(input: {
      projectId: "PVT_xxxx"
      contentId: "I_xxxx"
    }) {
      item { id }
    }
  }
'

# Update draft issue
gh api graphql -f query='
  mutation {
    updateProjectV2DraftIssue(input: {
      draftIssueId: "DI_xxxx"
      title: "New Title"
      body: "New body"
    }) {
      draftIssue { id title }
    }
  }
'

# Convert draft to real issue
gh api graphql -f query='
  mutation {
    convertProjectV2DraftIssueItemToIssue(input: {
      projectId: "PVT_xxxx"
      itemId: "PVTI_xxxx"
      repositoryId: "R_xxxx"
    }) {
      item {
        id
        content {
          ... on Issue { id number url }
        }
      }
    }
  }
'

# Get all items with field values
gh api graphql -f query='
  query {
    user(login: "USERNAME") {
      projectV2(number: 1) {
        items(first: 100) {
          nodes {
            id
            content {
              ... on Issue { title number url }
              ... on PullRequest { title number url }
              ... on DraftIssue { title body }
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
              }
            }
          }
        }
      }
    }
  }
'
```

### Projects V2 Workflow (Complete Example)

```bash
# 1. Create a project
gh project create --owner "@me" --title "Sprint 1"

# 2. Add fields
gh project field-create 1 --owner "@me" --name "Status" \
  --data-type SINGLE_SELECT --single-select-options "Todo,In Progress,Done"
gh project field-create 1 --owner "@me" --name "Priority" \
  --data-type SINGLE_SELECT --single-select-options "Low,Medium,High"
gh project field-create 1 --owner "@me" --name "Points" --data-type NUMBER

# 3. Get field IDs
FIELDS=$(gh project field-list 1 --owner "@me" --format json)
echo "$FIELDS" | jq '.'

# 4. Add issues to project
gh project item-add 1 --owner "@me" --url https://github.com/owner/repo/issues/1
gh project item-add 1 --owner "@me" --url https://github.com/owner/repo/issues/2

# 5. Create draft issues
gh project item-create 1 --owner "@me" --title "Research task" --body "Investigate X"

# 6. Set field values on items (need IDs from steps 3-5)
gh project item-edit --id ITEM_ID --field-id STATUS_FIELD_ID \
  --project-id PROJECT_ID --single-select-option-id TODO_OPTION_ID

# 7. Link project to repo
gh project link 1 --owner "@me" --repo my-repo
```

---

## 13. API (REST & GraphQL)

### REST API

```bash
# GET request (default)
gh api repos/{owner}/{repo}
gh api repos/cli/cli/releases --jq '.[].tag_name'

# With query parameters
gh api -X GET search/issues -f q='repo:cli/cli is:open label:bug'

# POST request
gh api repos/{owner}/{repo}/issues -f title="New Issue" -f body="Description"
gh api repos/{owner}/{repo}/issues/123/comments -f body='Comment text'

# PATCH / PUT / DELETE
gh api -X PATCH repos/{owner}/{repo} -f description="Updated"
gh api -X DELETE repos/{owner}/{repo}/issues/123/labels/bug

# With typed fields (-F for auto-type-conversion, -f for raw strings)
gh api repos/{owner}/{repo}/issues -f title="Bug" -F private=true -F number:=42

# Request body from file
gh api repos/{owner}/{repo}/issues --input issue.json

# Custom headers
gh api -H 'Accept: application/vnd.github.v3.raw+json' repos/{owner}/{repo}/readme

# Include response headers
gh api -i repos/{owner}/{repo}

# Verbose output (shows full HTTP request/response)
gh api --verbose repos/{owner}/{repo}

# Silent (no output)
gh api --silent repos/{owner}/{repo}/issues/123/labels -f labels[]=bug

# Caching
gh api --cache 3600s repos/{owner}/{repo}/releases
```

### Placeholders

The special placeholders `{owner}`, `{repo}`, and `{branch}` are auto-populated from the current git directory or `GH_REPO`.

### Pagination

```bash
# Auto-paginate REST results
gh api --paginate repos/{owner}/{repo}/issues --jq '.[].title'

# Slurp all pages into single array
gh api --paginate --slurp repos/{owner}/{repo}/issues | jq 'flatten | length'
```

### GraphQL API

```bash
# Basic query
gh api graphql -f query='{ viewer { login } }'

# With variables
gh api graphql -F owner='{owner}' -F name='{repo}' -f query='
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      releases(last: 5) {
        nodes { tagName publishedAt }
      }
    }
  }
'

# Mutation
gh api graphql -f query='
  mutation {
    addStar(input: {starrableId: "MDEwOlJlcG9zaXRvcnkxMjM="}) {
      starrable { stargazerCount }
    }
  }
'

# Paginated GraphQL (requires $endCursor variable and pageInfo)
gh api graphql --paginate -f query='
  query($endCursor: String) {
    viewer {
      repositories(first: 100, after: $endCursor) {
        nodes { nameWithOwner }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
'

# GraphQL with JQ filtering
gh api graphql -f query='{ viewer { repositories(first: 10) { nodes { nameWithOwner stargazerCount } } } }' \
  --jq '.data.viewer.repositories.nodes[] | "\(.nameWithOwner): \(.stargazerCount) ⭐"'
```

### Common GraphQL Patterns

```bash
# Get repository ID (needed for many mutations)
gh api graphql -f query='query { repository(owner: "OWNER", name: "REPO") { id } }' \
  --jq '.data.repository.id'

# Get issue/PR node ID
gh api graphql -f query='
  query {
    repository(owner: "OWNER", name: "REPO") {
      issue(number: 123) { id }
    }
  }
' --jq '.data.repository.issue.id'

# Get user/org ID
gh api graphql -f query='query { user(login: "USERNAME") { id } }' --jq '.data.user.id'

# Check rate limit
gh api graphql -f query='{ rateLimit { limit remaining resetAt } }'
gh api rate_limit --jq '.rate'
```

---

## 14. Extensions

```bash
# Search for extensions
gh extension search "copilot"
gh extension search --limit 30

# Browse extensions in TUI
gh extension browse

# Install
gh extension install owner/gh-extension-name
gh extension install https://github.com/owner/gh-extension-name

# List installed
gh extension list

# Upgrade
gh extension upgrade extension-name
gh extension upgrade --all

# Remove
gh extension remove extension-name

# Execute (useful if name conflicts with core command)
gh extension exec extension-name

# Create a new extension
gh extension create my-extension
gh extension create my-extension --precompiled=go
```

---

## 15. Codespaces

```bash
# List
gh codespace list

# Create
gh codespace create --repo owner/repo
gh codespace create --repo owner/repo --branch feature --machine largePremiumLinux

# SSH into codespace
gh codespace ssh

# Open in VS Code
gh codespace code

# Copy files
gh codespace cp local-file.txt remote:~/path/
gh codespace cp remote:~/path/file.txt ./local/

# View details
gh codespace view

# Port forwarding
gh codespace ports

# Rebuild
gh codespace rebuild

# Stop / Delete
gh codespace stop
gh codespace delete
```

---

## 16. Copilot

(Requires `gh-copilot` extension)

```bash
# Suggest a command
gh copilot suggest "find large files in current directory"

# Explain a command
gh copilot explain "find . -type f -size +100M -exec ls -lh {} +"

# Configure
gh copilot config
```

---

## 17. Other Commands

### Browse (open in browser)

```bash
gh browse                          # repo home
gh browse 123                      # issue or PR #123
gh browse src/main.go              # specific file
gh browse src/main.go:42           # file at line
gh browse --settings               # repo settings
gh browse --projects                # repo projects
gh browse --releases                # repo releases
gh browse --branch feature src/    # specific branch
gh browse --commit abc123          # specific commit
gh browse -n                       # print URL instead of opening
```

### Status (cross-repo overview)

```bash
gh status                          # assigned issues, PRs, review requests, mentions
gh status --org my-org             # limit to org
gh status -e owner/repo            # exclude repo
```

### Aliases

```bash
gh alias set pv 'pr view'
gh alias set bugs 'issue list --label=bug'
gh alias set --shell igrep 'gh issue list --label="$1" | grep "$2"'
gh alias list
gh alias delete pv
gh alias import aliases.yml
```

### SSH Keys / GPG Keys

```bash
gh ssh-key list
gh ssh-key add ~/.ssh/id_ed25519.pub --title "My Laptop"
gh ssh-key delete KEY_ID

gh gpg-key list
gh gpg-key add pubkey.gpg
gh gpg-key delete KEY_ID
```

### Rulesets

```bash
gh ruleset list
gh ruleset view RULESET_ID
gh ruleset check branch-name      # what rules apply to this branch
```

### Attestations

```bash
gh attestation verify artifact.tar.gz --owner owner
gh attestation download --owner owner artifact.tar.gz
```

### Org

```bash
gh org list
```

---

## 18. JSON Output & Formatting

Most listing/view commands support `--json`, `--jq`, and `--template` flags.

### Basic JSON

```bash
# Discover available fields (pass --json with no value)
gh pr list --json

# Select specific fields
gh pr list --json number,title,author

# JQ filtering
gh pr list --json number,title,author --jq '.[].author.login'
gh issue list --json number,title,labels --jq '
  map(select(.labels | length > 0))
  | map(.labels = (.labels | map(.name)))
  | .[:5]
'
```

### Go Template Formatting

```bash
# Table output
gh pr list --json number,title,headRefName,updatedAt --template \
  '{{range .}}{{tablerow (printf "#%v" .number | autocolor "green") .title .headRefName (timeago .updatedAt)}}{{end}}'

# Hyperlinks
gh issue list --json title,url --template \
  '{{range .}}{{hyperlink .url .title}}{{"\n"}}{{end}}'

# Color
gh pr list --json title,state --template \
  '{{range .}}{{.title}} ({{.state | color "green"}}){{"\n"}}{{end}}'
```

### Template Functions

| Function | Description |
|----------|-------------|
| `autocolor <style> <input>` | Color (terminal-aware) |
| `color <style> <input>` | Force color |
| `join <sep> <list>` | Join list values |
| `pluck <field> <list>` | Extract field from list items |
| `tablerow <fields>...` | Aligned table columns |
| `tablerender` | Render accumulated tablerows |
| `timeago <time>` | Relative timestamp |
| `timefmt <format> <time>` | Formatted timestamp |
| `truncate <length> <input>` | Truncate text |
| `hyperlink <url> <text>` | Terminal hyperlink |

---

## 19. Environment Variables

| Variable | Purpose |
|----------|---------|
| `GH_TOKEN` / `GITHUB_TOKEN` | Auth token for github.com (takes precedence over stored creds) |
| `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` | Auth token for GHES |
| `GH_HOST` | Default GitHub hostname |
| `GH_REPO` | Default repository in `[HOST/]OWNER/REPO` format |
| `GH_EDITOR` | Editor for authoring text |
| `GH_BROWSER` / `BROWSER` | Web browser for opening links |
| `GH_PAGER` / `PAGER` | Terminal pager (e.g., `less`) |
| `GH_DEBUG` | Enable verbose output (`1` or `api` for HTTP traffic) |
| `GH_FORCE_TTY` | Force terminal output (value = column count or percentage) |
| `GH_PROMPT_DISABLED` | Disable interactive prompts |
| `GH_NO_UPDATE_NOTIFIER` | Disable update notifications |
| `GH_CONFIG_DIR` | Custom config directory |
| `NO_COLOR` | Disable colored output |
| `GLAMOUR_STYLE` | Markdown rendering style |

---

## 20. Advanced Patterns

### Scripting Best Practices

```bash
# Disable prompts for non-interactive use
GH_PROMPT_DISABLED=1 gh pr create --fill

# Use GH_TOKEN for CI/automation
GH_TOKEN=${{ github.token }} gh pr list

# Use GH_REPO to avoid -R everywhere
export GH_REPO=owner/repo
gh issue list   # targets owner/repo
```

### Batch Operations

```bash
# Close all issues with a label
gh issue list --label "wontfix" --json number --jq '.[].number' | \
  xargs -I{} gh issue close {} --reason "not planned"

# Add label to all open PRs
gh pr list --json number --jq '.[].number' | \
  xargs -I{} gh pr edit {} --add-label "needs-review"

# Download all artifacts from recent failed runs
gh run list --status failure --json databaseId --jq '.[].databaseId' | \
  xargs -I{} gh run download {}
```

### Working with Multiple Accounts

```bash
# List configured accounts
gh auth status

# Switch active account
gh auth switch

# Use a specific token for one command
GH_TOKEN=ghp_xxx gh api user --jq '.login'

# Login to multiple hosts
gh auth login --hostname github.com
gh auth login --hostname github.enterprise.com
```

### Rate Limiting

```bash
# Check current rate limit
gh api rate_limit --jq '.rate | "\(.remaining)/\(.limit) (resets \(.reset | strftime("%H:%M:%S")))"'

# GraphQL rate limit (separate pool)
gh api graphql -f query='{ rateLimit { limit remaining resetAt } }'

# Use caching to reduce API calls
gh api --cache 3600s repos/{owner}/{repo}/releases
```

### Complex API Patterns

```bash
# Nested parameters
gh api gists -F 'files[myfile.txt][content]=@myfile.txt'

# Array parameters
gh api -X PATCH /orgs/{org}/properties/schema \
  -F 'properties[][property_name]=env' \
  -F 'properties[][allowed_values][]=staging' \
  -F 'properties[][allowed_values][]=production'

# Combine REST pagination with JQ
gh api --paginate repos/{owner}/{repo}/issues --jq '[.[] | select(.labels | length > 0)] | length'

# GraphQL with slurp for aggregation
gh api graphql --paginate --slurp -f query='
  query($endCursor: String) {
    viewer {
      repositories(first: 100, after: $endCursor) {
        nodes { isFork stargazerCount }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
' | jq '[.[].data.viewer.repositories.nodes[]] | map(.stargazerCount) | add'
```

---

## 21. Tips & Gotchas

### Common Mistakes

1. **`--json` field names differ from API field names.** For example, PR files use `files` (not `changed_files`), author uses `author.login` (not `user.login`). Always run `gh <cmd> --json` without arguments to see available fields.

2. **`gh run rerun --job` needs `databaseId`, not the URL number.** Get it with:
   ```bash
   gh run view RUN_ID --json jobs --jq '.jobs[] | {name, databaseId}'
   ```

3. **Projects V2 require the `project` scope.** If you get permission errors:
   ```bash
   gh auth refresh -s project
   ```

4. **`gh repo delete` requires `delete_repo` scope:**
   ```bash
   gh auth refresh -s delete_repo
   ```

5. **Subcommand quoting in shells:** PowerShell and some shells need `{owner}` escaped. Use quotes: `"{owner}"`.

### When to Use `gh api` vs Specific Commands

| Use specific commands when... | Use `gh api` when... |
|-------------------------------|---------------------|
| The command exists and does what you need | No CLI command covers the endpoint |
| You want interactive prompts | You need fine-grained control |
| You want pretty-printed output | You want raw JSON response |
| You're doing simple CRUD | You need GraphQL queries |
| | You need to set custom headers |
| | You need pagination control |

### Performance Tips

- Use `--limit` to fetch only what you need
- Use `--json` with specific fields (fetches less data)
- Use `--cache` with `gh api` for frequently accessed, slowly changing data
- Use `--paginate --slurp` for aggregations across all pages
- Set `GH_PAGER=cat` to disable paging in scripts

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error / failure |
| 2 | Usage error |
| 4 | Command cancelled |
| 8 | Checks pending (for `gh pr checks`) |

### Authentication Precedence

1. `GH_TOKEN` / `GITHUB_TOKEN` environment variable
2. `GH_ENTERPRISE_TOKEN` (for GHES hosts)
3. Stored credentials from `gh auth login`
4. `.env` file in repo (only if configured)

### Useful One-Liners

```bash
# My open PRs across all repos
gh search prs --author=@me --state=open --json repository,number,title

# Repos I starred recently
gh api --paginate user/starred --jq '.[].full_name' | head -20

# Who's the top contributor to a repo
gh api --paginate repos/owner/repo/contributors --jq '.[] | "\(.login): \(.contributions)"' | head -10

# Create issue from clipboard
pbpaste | gh issue create --title "From clipboard" --body-file -

# Get latest release tag
gh release view --json tagName --jq '.tagName'

# Watch CI and notify on completion
gh run watch && notify-send "CI done!"

# Export all issues as JSON
gh issue list --state all --limit 9999 --json number,title,state,labels,assignees > issues.json

# Find which PR merged a commit
gh pr list --search "SHA_HERE" --state merged --json number,title,url
```
