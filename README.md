# tq

To install dependencies:

```bash
bun install
```

To run the CLI:

```bash
bun run index.ts -- --help
```

The CLI entrypoint is `tq`. `init`, `create`, and `update` are available now; additional subcommands (like `list` and `show`) are planned.

## Configuration

`tq` stores machine and global workspace settings in `~/.config/tq/config.toml` (or `$XDG_CONFIG_HOME/tq/config.toml`).
Global task data lives under `~/.local/share/tq/tasks` (or `$XDG_DATA_HOME/tq/tasks`).

Example config:

```toml
[machine]
name = "workstation"

[workspaces]
"/path/to/project" = "a1b2"
```

If `machine.name` is omitted, `tq` falls back to `USER` or `LOGNAME` when claiming tasks.

## Workspace resolution

`tq` prefers local mode whenever a `.tasks` directory exists in the workspace root. If `.tasks` is missing, `tq` uses global mode and looks up the workspace id in the config before resolving the tasks directory under the global base path. If the workspace is not registered, `tq` reports an error and asks you to run `tq init --mode global`.

## Initialization

Use `tq init` to set up task storage for the current workspace. By default it uses local mode and creates a `.tasks` directory in the workspace. Use `tq init --mode global` to register the workspace in the config and create its tasks directory under the global data path. Global mode does not create `.tasks` in the project repo.

## Creating tasks

Use `tq create` to write a new task file with defaults and commit it to the tasks repository. The command returns the new task id.

```bash
tq create --name "Add task filters" --description "Support filtering by status." --priority 1
```

`status` defaults to `open`, `priority` defaults to `2`, and `claimed_by` starts empty.

## Updating tasks

Use `tq update <id>` to change task metadata or replace the description. Only `name`, `status`, `priority`, and `description` can be edited.

```bash
tq update ab12 -s in_progress -p 1 -d "Start implementing filters"
```

## Task repository

Each tasks directory is a git repository. `tq` initializes the repo on first use, creates an initial commit, and records every task change with a concise commit message. If a remote is configured, `tq` pulls before mutating tasks and pushes after each successful commit.

## Task format

Each task is a Markdown file named `<id>.md`, where the id is 4 lowercase alphanumeric characters (`[a-z0-9]`). Task metadata lives in a frontmatter block at the top of the file, followed by the task description.

```markdown
---
name: "Review queue"
created_at: "2026-01-27T10:00:00.000Z"
updated_at: "2026-01-27T10:00:00.000Z"
status: "open"
claimed_by: ""
priority: 2
---

Describe the work in Markdown here.
```

`priority` is an integer from 0 to 4. If it is missing when loading a task, `tq` defaults it to `2`.

This project was created using `bun init` in bun v1.3.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
