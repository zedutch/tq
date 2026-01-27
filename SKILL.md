---
name: tq
description: Guides agents through using the tq agent task queue system. Activate when the user mentions tq, tasks, or when working in a repository with a .tasks directory. Teaches proper workflow for managing, creating, and resolving tasks.
---
# TQ - the agentic task queue

This skill helps you work with tq, an agent-first Git-compatible task queue.

## Core concept

All tasks are stored as yml files in a workspace. The location of this workspace can be queried with `tq where`.
This could be in the current repo but could also be somewhere totally different.
The `tq` workspace uses a separate git repository to prevent changes to tasks from entering the main project git repo.
You seldomly need access to the workspace itself, you should generally query it using `tq` commands.
If you do need to manually change something in the `tq` workspace, make sure you clean up its working copy (e.g. by pushing your changes to the remote) before continuing on.
You can run git commands inside of the workspace by using `tq git <command>`. All usual git commands work as these just get passed along to git directly.

Each task in `tq` is identified by a 4-character task id. This id is always needed when querying or editing a single task.
When creating a new task, `tq` will return the new id as a response if the task was created correctly.

`tq` can be used in a distributed system with synchronisation going through a git server. Tasks can and should be claimed before work starts, that way
other users immediately know that a task has already started so we can prevent parallel redundant work.

### Workflow

If you don't know what task to work on, run `tq list` to show all open, unclaimed tasks.
If you do know what task to work on or if you've just chosen one, run `tq claim <task id>` to claim that task.
Only start working on the task if the claim was successful. If the claim failed, either look for another open task
(that could be the same one if it's still returned by `tq list`) or ask the user what to do instead if you're running in interactive mode.
Once the task has completed, run `tq close <task id>` to mark it as such.

### Essential `tq` commands

```bash
# Create a new task
tq create "<task name / summary>" -d "<description about what needs to be done and why>" -p "<priority 0..4, optional>"

# View all tasks that are ready to work on
tq list

# View all tasks that are ready to work on as json output
tq list --json

# View task details
tq show <task-id>

# View task details as json output
tq show <task-id> --json

# Claim a task
tq claim <task-id>

# Close a task (mark as 'completed')
tq close <task-id>

# Cancel a task
tq cancel <task-id>

# Update a task field
tq update <issue-id> -d "<updated description>"
tq update <issue-id> -s open
tq update <issue-id> -p 1
```

