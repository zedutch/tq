import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cancelTask,
  claimTask,
  closeTask,
  createTask,
  updateTask,
  formatConfig,
  formatTaskListJson,
  formatTaskShowJson,
  formatTaskMarkdown,
  commitTasksRepository,
  ensureGitRepository,
  generateTaskId,
  hasGitRemote,
  initWorkspace,
  listTasks,
  loadConfig,
  normalizeConfig,
  parseArgs,
  parseTaskMarkdown,
  runGitCommandPassthrough,
  runGitCommand,
  resolveConfigPath,
  resolveStealthTasksBase,
  resolveMachineName,
  resolveTasksDirectory,
  resolveXdgConfigHome,
  resolveXdgDataHome,
  saveConfig,
  showTask,
  toTaskListEntry,
} from "./index";

async function withTempEnv(
  testFn: (paths: { configHome: string; dataHome: string }) => Promise<void>,
) {
  const configHome = await mkdtemp(path.join(tmpdir(), "tq-config-"));
  const dataHome = await mkdtemp(path.join(tmpdir(), "tq-data-"));
  const original = { ...process.env };
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = dataHome;

  try {
    await testFn({ configHome, dataHome });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(original)) {
      process.env[key] = value;
    }
    await rm(configHome, { recursive: true, force: true });
    await rm(dataHome, { recursive: true, force: true });
  }
}

async function writeTaskFile(
  tasksDir: string,
  id: string,
  frontmatter: {
    name: string;
    created_at: string;
    updated_at: string;
    status: "open" | "in_progress" | "done" | "cancelled";
    claimed_by: string;
    claimed_at?: string;
    created_by?: string;
    priority: number;
  },
  description: string,
) {
  const content = formatTaskMarkdown(
    {
      ...frontmatter,
      created_by: frontmatter.created_by ?? "",
      claimed_at: frontmatter.claimed_at ?? "",
    },
    description,
  );
  await Bun.write(path.join(tasksDir, `${id}.md`), content);
}

describe("config paths", () => {
  test("uses explicit XDG overrides", () => {
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: "/tmp/custom-config",
      XDG_DATA_HOME: "/tmp/custom-data",
    } as NodeJS.ProcessEnv;

    expect(resolveXdgConfigHome(env)).toBe("/tmp/custom-config");
    expect(resolveXdgDataHome(env)).toBe("/tmp/custom-data");
    expect(resolveConfigPath(env)).toBe("/tmp/custom-config/tq/config.toml");
    expect(resolveStealthTasksBase(env)).toBe("/tmp/custom-data/tq/tasks");
  });
});

describe("arg parsing", () => {
  test("treats git subcommand flags as positionals", () => {
    const parsed = parseArgs(["git", "status", "-sb", "--untracked-files=no"]);
    expect(parsed.command).toBe("git");
    expect(parsed.flags).toEqual({});
    expect(parsed.positionals).toEqual([
      "status",
      "-sb",
      "--untracked-files=no",
    ]);
  });
});

describe("config load/save", () => {
  test("returns default config when missing", async () => {
    await withTempEnv(async () => {
      const config = await loadConfig();
      expect(config).toEqual({ machine: {}, workspaces: {} });
    });
  });

  test("round-trips config", async () => {
    await withTempEnv(async () => {
      const config = {
        machine: { name: "robin" },
        workspaces: {
          "/workspaces/tq": "a1b2",
        },
      };
      await saveConfig(config);
      const loaded = await loadConfig();
      expect(loaded).toEqual(config);
    });
  });

  test("rejects invalid config", async () => {
    await withTempEnv(async () => {
      const configPath = resolveConfigPath();
      await mkdir(path.dirname(configPath), { recursive: true });
      await Bun.write(configPath, 'machine = "bad"\n');
      await expect(loadConfig()).rejects.toThrow("machine must be a table");
    });
  });
});

describe("config helpers", () => {
  test("normalizes config tables", () => {
    const normalized = normalizeConfig({
      machine: { name: "  tq  " },
      workspaces: { "/repo": "id1" },
    });
    expect(normalized).toEqual({
      machine: { name: "tq" },
      workspaces: { "/repo": "id1" },
    });
  });

  test("formats config consistently", () => {
    const formatted = formatConfig({
      machine: { name: "tq" },
      workspaces: { "/repo": "id1" },
    });
    expect(formatted).toContain("[machine]");
    expect(formatted).toContain('name = "tq"');
    expect(formatted).toContain("[workspaces]");
    expect(formatted).toContain('"/repo" = "id1"');
    expect(formatted.endsWith("\n")).toBe(true);
  });

  test("resolves machine name from config or env", () => {
    const fromConfig = resolveMachineName(
      { machine: { name: "tq" }, workspaces: {} },
      {
        ...process.env,
        USER: "fallback",
      },
    );
    expect(fromConfig).toBe("tq");

    const fromEnv = resolveMachineName(
      { machine: {}, workspaces: {} },
      {
        ...process.env,
        USER: "fallback",
      },
    );
    expect(fromEnv).toBe("fallback");
  });
});

describe("workspace resolution", () => {
  test("prefers local tasks directory when present", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));
    const localTasks = path.join(workspace, ".tasks");
    await mkdir(localTasks, { recursive: true });

    try {
      const resolved = await resolveTasksDirectory(workspace);
      expect(resolved).toEqual({
        mode: "local",
        workspacePath: path.resolve(workspace),
        tasksDir: localTasks,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("resolves stealth workspace directory when registered", async () => {
    await withTempEnv(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));
      const workspaceId = "a1b2";
      await saveConfig({
        machine: {},
        workspaces: {
          [path.resolve(workspace)]: workspaceId,
        },
      });

      try {
        const resolved = await resolveTasksDirectory(workspace);
        expect(resolved).toEqual({
          mode: "stealth",
          workspacePath: path.resolve(workspace),
          tasksDir: path.join(resolveStealthTasksBase(), workspaceId),
          workspaceId,
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("errors when stealth workspace is not registered", async () => {
    await withTempEnv(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));

        try {
          await expect(resolveTasksDirectory(workspace)).rejects.toThrow(
            "Workspace not initialized",
          );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });
});

describe("workspace init", () => {
  test("initializes local mode without touching config", async () => {
    await withTempEnv(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));
      const localTasks = path.join(workspace, ".tasks");

      try {
        const resolved = await initWorkspace({
          mode: "local",
          workspacePath: workspace,
          initGit: false,
        });

        expect(resolved).toEqual({
          mode: "local",
          workspacePath: path.resolve(workspace),
          tasksDir: localTasks,
        });
        expect((await stat(localTasks)).isDirectory()).toBe(true);
        expect(await Bun.file(resolveConfigPath()).exists()).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("initializes stealth mode and registers workspace", async () => {
    await withTempEnv(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));
      const resolvedWorkspacePath = path.resolve(workspace);

      try {
        const resolved = await initWorkspace({
          mode: "stealth",
          workspacePath: workspace,
          initGit: false,
        });

        const config = await loadConfig();
        expect(resolved.mode).toBe("stealth");
        expect(resolved.workspacePath).toBe(resolvedWorkspacePath);
        expect(resolved.workspaceId).toBeTruthy();
        expect(config.workspaces[resolvedWorkspacePath]).toBe(
          resolved.workspaceId,
        );
        expect((await stat(resolved.tasksDir)).isDirectory()).toBe(true);
        await expect(stat(path.join(workspace, ".tasks"))).rejects.toThrow();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });
});

describe("task model", () => {
  test("parses frontmatter and defaults missing priority", () => {
    const text = `---
name: "Write tests"
created_at: "2026-01-27T10:00:00.000Z"
updated_at: "2026-01-27T10:00:00.000Z"
status: "open"
claimed_by: ""
---
Add tests for task parsing.`;

    const parsed = parseTaskMarkdown(text);
    expect(parsed.frontmatter.priority).toBe(2);
    expect(parsed.description).toBe("Add tests for task parsing.");
  });

  test("rejects missing required fields", () => {
    const text = `---
created_at: "2026-01-27T10:00:00.000Z"
updated_at: "2026-01-27T10:00:00.000Z"
status: "open"
claimed_by: ""
priority: 2
---
Missing name.`;

    expect(() => parseTaskMarkdown(text)).toThrow("name is required");
  });

  test("rejects duplicate frontmatter fields", () => {
    const text = `---
name: "Dupe"
name: "Other"
created_at: "2026-01-27T10:00:00.000Z"
updated_at: "2026-01-27T10:00:00.000Z"
status: "open"
claimed_by: ""
priority: 2
---
Duplicate name.`;

    expect(() => parseTaskMarkdown(text)).toThrow(
      "duplicate frontmatter field",
    );
  });

  test("rejects priority outside allowed range", () => {
    const text = `---
name: "Out of range"
created_at: "2026-01-27T10:00:00.000Z"
updated_at: "2026-01-27T10:00:00.000Z"
status: "open"
claimed_by: ""
priority: 9
---
Bad priority.`;

    expect(() => parseTaskMarkdown(text)).toThrow(
      "priority must be an integer",
    );
  });

  test("rejects non-numeric priority strings", () => {
    const text = `---
name: "Bad priority"
created_at: "2026-01-27T10:00:00.000Z"
updated_at: "2026-01-27T10:00:00.000Z"
status: "open"
claimed_by: ""
priority: 2foo
---
Bad priority.`;

    expect(() => parseTaskMarkdown(text)).toThrow("priority must be a number");
  });

  test("formats frontmatter deterministically", () => {
    const markdown = formatTaskMarkdown(
      {
        name: "Doc format",
        created_at: "2026-01-27T10:00:00.000Z",
        created_by: "robin",
        updated_at: "2026-01-27T10:00:00.000Z",
        status: "open",
        claimed_by: "",
        claimed_at: "",
        priority: 2,
      },
      "Body text",
    );

    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown).toContain('name: "Doc format"');
    expect(markdown).toContain("priority: 2");
  });

  test("generates ids and retries on collisions", () => {
    const existing = new Set(["aaaa"]);
    let calls = 0;
    const randomBytes = (_length: number) => {
      calls += 1;
      if (calls === 1) {
        return new Uint8Array([0, 0, 0, 0]);
      }
      return new Uint8Array([1, 0, 0, 0]);
    };

    const id = generateTaskId(existing, { randomBytes, maxAttempts: 3 });
    expect(id).toBe("baaa");
    expect(calls).toBe(2);
  });
});

describe("task creation", () => {
  test("creates task with defaults and writes markdown", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-tasks-"));
    const now = new Date("2026-01-27T12:00:00.000Z");

    try {
      const created = await createTask({
        tasksDir,
        name: "New task",
        description: "Ship the feature.",
        now,
        skipGit: true,
        env: { ...process.env, USER: "robin" },
      });

      expect(created.id).toMatch(/^[a-z0-9]{4}$/);
      const contents = await Bun.file(created.path).text();
      const parsed = parseTaskMarkdown(contents);
      expect(parsed.frontmatter.name).toBe("New task");
      expect(parsed.frontmatter.status).toBe("open");
      expect(parsed.frontmatter.priority).toBe(2);
      expect(parsed.frontmatter.created_by).toBe("robin");
      expect(parsed.frontmatter.claimed_by).toBe("");
      expect(parsed.frontmatter.claimed_at).toBe("");
      expect(parsed.frontmatter.created_at).toBe(now.toISOString());
      expect(parsed.frontmatter.updated_at).toBe(now.toISOString());
      expect(parsed.description).toBe("Ship the feature.");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("rejects empty task names", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-tasks-"));

    try {
      await expect(
        createTask({
          tasksDir,
          name: "   ",
          skipGit: true,
          env: { ...process.env, USER: "robin" },
        }),
      ).rejects.toThrow("Task name is required");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});

describe("task updates", () => {
  test("updates selected fields and bumps updated_at", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-tasks-"));
    const createdAt = new Date("2026-01-27T12:00:00.000Z");
    const updatedAt = new Date("2026-01-27T13:00:00.000Z");

    try {
      const created = await createTask({
        tasksDir,
        name: "Initial",
        description: "Original description",
        now: createdAt,
        skipGit: true,
        env: { ...process.env, USER: "robin" },
      });

      const updated = await updateTask({
        tasksDir,
        id: created.id,
        name: "Updated",
        description: "New description",
        status: "in_progress",
        priority: 1,
        now: updatedAt,
        skipGit: true,
      });

      const contents = await Bun.file(updated.path).text();
      const parsed = parseTaskMarkdown(contents);
      expect(parsed.frontmatter.name).toBe("Updated");
      expect(parsed.frontmatter.status).toBe("in_progress");
      expect(parsed.frontmatter.priority).toBe(1);
      expect(parsed.frontmatter.created_at).toBe(createdAt.toISOString());
      expect(parsed.frontmatter.updated_at).toBe(updatedAt.toISOString());
      expect(parsed.description).toBe("New description");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("rejects updates when task file is dirty", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-tasks-"));
    const gitEnv = {
      ...process.env,
      USER: "tq",
      GIT_AUTHOR_NAME: "tq",
      GIT_AUTHOR_EMAIL: "tq@example.com",
      GIT_COMMITTER_NAME: "tq",
      GIT_COMMITTER_EMAIL: "tq@example.com",
    } as NodeJS.ProcessEnv;

    try {
      await ensureGitRepository(tasksDir, true, gitEnv);
      const created = await createTask({
        tasksDir,
        name: "Dirty",
        description: "Do not touch",
        skipGit: false,
        env: gitEnv,
      });
      const current = await Bun.file(created.path).text();
      await Bun.write(created.path, `${current}\nextra`);

      await expect(
        updateTask({
          tasksDir,
          id: created.id,
          name: "Attempt",
          env: gitEnv,
          skipGit: false,
        }),
      ).rejects.toThrow("uncommitted changes");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("rejects invalid task ids", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-tasks-"));

    try {
      await expect(
        updateTask({
          tasksDir,
          id: "toolong",
          name: "Nope",
          skipGit: true,
        }),
      ).rejects.toThrow("Invalid task id");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});

describe("task claim/close/cancel", () => {
  test("claims a task and sets claimed_by", async () => {
    await withTempEnv(async () => {
      const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-claim-"));
      const now = new Date("2026-01-27T14:00:00.000Z");

      try {
        await writeTaskFile(
          tasksDir,
          "a1b2",
          {
            name: "Claim me",
            created_at: "2026-01-27T13:00:00.000Z",
            updated_at: "2026-01-27T13:00:00.000Z",
            status: "open",
            claimed_by: "",
            priority: 2,
          },
          "Take ownership",
        );

        const claimed = await claimTask({
          tasksDir,
          id: "a1b2",
          now,
          skipGit: true,
          env: { ...process.env, USER: "robin" },
        });

        expect(claimed.frontmatter.status).toBe("in_progress");
        expect(claimed.frontmatter.claimed_by).toBe("robin");
        expect(claimed.frontmatter.claimed_at).toBe(now.toISOString());
        expect(claimed.frontmatter.updated_at).toBe(now.toISOString());
      } finally {
        await rm(tasksDir, { recursive: true, force: true });
      }
    });
  });

  test("rejects claiming an already claimed task", async () => {
    await withTempEnv(async () => {
      const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-claim-"));

      try {
        await writeTaskFile(
          tasksDir,
          "b2c3",
          {
            name: "Already claimed",
            created_at: "2026-01-27T13:00:00.000Z",
            updated_at: "2026-01-27T13:00:00.000Z",
            status: "in_progress",
            claimed_by: "sam",
            priority: 1,
          },
          "Owned by sam",
        );

        await expect(
          claimTask({
            tasksDir,
            id: "b2c3",
            skipGit: true,
            env: { ...process.env, USER: "robin" },
          }),
        ).rejects.toThrow("already claimed by sam");
      } finally {
        await rm(tasksDir, { recursive: true, force: true });
      }
    });
  });

  test("closes a task by setting status to done", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-close-"));
    const now = new Date("2026-01-27T15:00:00.000Z");

    try {
      await writeTaskFile(
        tasksDir,
        "c3d4",
        {
          name: "Close me",
          created_at: "2026-01-27T13:00:00.000Z",
          updated_at: "2026-01-27T13:00:00.000Z",
          status: "open",
          claimed_by: "robin",
          priority: 2,
        },
        "Finish work",
      );

      const closed = await closeTask({
        tasksDir,
        id: "c3d4",
        now,
        skipGit: true,
      });

      expect(closed.frontmatter.status).toBe("done");
      expect(closed.frontmatter.updated_at).toBe(now.toISOString());
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("cancels a task by setting status to cancelled", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-cancel-"));
    const now = new Date("2026-01-27T16:00:00.000Z");

    try {
      await writeTaskFile(
        tasksDir,
        "d4e5",
        {
          name: "Cancel me",
          created_at: "2026-01-27T13:00:00.000Z",
          updated_at: "2026-01-27T13:00:00.000Z",
          status: "open",
          claimed_by: "",
          priority: 2,
        },
        "No longer needed",
      );

      const cancelled = await cancelTask({
        tasksDir,
        id: "d4e5",
        now,
        skipGit: true,
      });

      expect(cancelled.frontmatter.status).toBe("cancelled");
      expect(cancelled.frontmatter.updated_at).toBe(now.toISOString());
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});

describe("task list", () => {
  test("defaults to open tasks when status filter is omitted", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: "2026-01-27T10:00:00.000Z",
          updated_at: "2026-01-27T10:00:00.000Z",
          status: "open",
          claimed_by: "",
          priority: 1,
        },
        "First task",
      );
      await writeTaskFile(
        tasksDir,
        "b2c3",
        {
          name: "Beta",
          created_at: "2026-01-27T11:00:00.000Z",
          updated_at: "2026-01-27T11:00:00.000Z",
          status: "in_progress",
          claimed_by: "robin",
          priority: 2,
        },
        "Second task",
      );

      const filtered = await listTasks({ tasksDir });

      expect(filtered.map((task) => task.id)).toEqual(["a1b2"]);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("supports listing all statuses when includeAllStatuses is true", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: "2026-01-27T10:00:00.000Z",
          updated_at: "2026-01-27T10:00:00.000Z",
          status: "open",
          claimed_by: "",
          priority: 1,
        },
        "First task",
      );
      await writeTaskFile(
        tasksDir,
        "b2c3",
        {
          name: "Beta",
          created_at: "2026-01-27T11:00:00.000Z",
          updated_at: "2026-01-27T11:00:00.000Z",
          status: "done",
          claimed_by: "robin",
          priority: 2,
        },
        "Second task",
      );

      const filtered = await listTasks({
        tasksDir,
        includeAllStatuses: true,
      });

      expect(filtered.map((task) => task.id)).toEqual(["a1b2", "b2c3"]);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("filters across all fields with AND semantics", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));
    const createdAt = "2026-01-27T10:00:00.000Z";
    const updatedAt = "2026-01-27T10:30:00.000Z";

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: createdAt,
          updated_at: updatedAt,
          status: "open",
          claimed_by: "",
          priority: 1,
        },
        "First task",
      );
      await writeTaskFile(
        tasksDir,
        "b2c3",
        {
          name: "Beta",
          created_at: "2026-01-27T11:00:00.000Z",
          updated_at: "2026-01-27T11:30:00.000Z",
          status: "in_progress",
          claimed_by: "robin",
          priority: 2,
        },
        "Second task",
      );

      const filtered = await listTasks({
        tasksDir,
        filters: {
          names: ["Alpha"],
          statuses: ["open"],
          priorities: [1],
          claimedBy: [""],
          createdAt: ["2026-01-27T10:00:00Z"],
          updatedAt: ["2026-01-27T10:30:00Z"],
        },
      });

      expect(filtered.map((task) => task.id)).toEqual(["a1b2"]);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("supports OR matching within a field", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: "2026-01-27T10:00:00.000Z",
          updated_at: "2026-01-27T10:00:00.000Z",
          status: "open",
          claimed_by: "",
          priority: 1,
        },
        "First task",
      );
      await writeTaskFile(
        tasksDir,
        "b2c3",
        {
          name: "Beta",
          created_at: "2026-01-27T11:00:00.000Z",
          updated_at: "2026-01-27T11:00:00.000Z",
          status: "in_progress",
          claimed_by: "robin",
          priority: 2,
        },
        "Second task",
      );
      await writeTaskFile(
        tasksDir,
        "c3d4",
        {
          name: "Gamma",
          created_at: "2026-01-27T12:00:00.000Z",
          updated_at: "2026-01-27T12:00:00.000Z",
          status: "open",
          claimed_by: "sam",
          priority: 1,
        },
        "Third task",
      );

      const filtered = await listTasks({
        tasksDir,
        filters: {
          statuses: ["open", "in_progress"],
          priorities: [1],
        },
      });

      expect(filtered.map((task) => task.id)).toEqual(["a1b2", "c3d4"]);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("filters by created_by", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: "2026-01-27T10:00:00.000Z",
          updated_at: "2026-01-27T10:00:00.000Z",
          status: "open",
          created_by: "robin",
          claimed_by: "",
          priority: 1,
        },
        "First task",
      );
      await writeTaskFile(
        tasksDir,
        "b2c3",
        {
          name: "Beta",
          created_at: "2026-01-27T11:00:00.000Z",
          updated_at: "2026-01-27T11:00:00.000Z",
          status: "open",
          created_by: "sam",
          claimed_by: "",
          priority: 2,
        },
        "Second task",
      );

      const filtered = await listTasks({
        tasksDir,
        filters: {
          createdBy: ["robin"],
        },
      });

      expect(filtered.map((task) => task.id)).toEqual(["a1b2"]);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("formats JSON output with list entries", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: "2026-01-27T10:00:00.000Z",
          updated_at: "2026-01-27T10:00:00.000Z",
          status: "open",
          claimed_by: "",
          priority: 1,
        },
        "First task",
      );

      const tasks = await listTasks({ tasksDir });
      const entries = tasks.map(toTaskListEntry);
      const json = formatTaskListJson(entries);
      const parsed = JSON.parse(json) as Array<Record<string, unknown>>;

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        id: "a1b2",
        name: "Alpha",
        status: "open",
        priority: 1,
        created_by: null,
        claimed_by: null,
        claimed_at: null,
      });
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});

describe("task show", () => {
  test("returns full task details", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-show-"));
    const description = "First line\nSecond line";

    try {
      await writeTaskFile(
        tasksDir,
        "a1b2",
        {
          name: "Alpha",
          created_at: "2026-01-27T10:00:00.000Z",
          updated_at: "2026-01-27T11:00:00.000Z",
          status: "open",
          claimed_by: "",
          priority: 2,
        },
        description,
      );

      const entry = await showTask({ tasksDir, id: "a1b2" });

      expect(entry).toMatchObject({
        id: "a1b2",
        name: "Alpha",
        status: "open",
        priority: 2,
        created_by: "",
        claimed_by: "",
        claimed_at: "",
        created_at: "2026-01-27T10:00:00.000Z",
        updated_at: "2026-01-27T11:00:00.000Z",
        description,
      });
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("formats JSON output", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-show-"));

    try {
      await writeTaskFile(
        tasksDir,
        "b2c3",
        {
          name: "Beta",
          created_at: "2026-01-27T12:00:00.000Z",
          updated_at: "2026-01-27T12:00:00.000Z",
          status: "in_progress",
          created_by: "robin",
          claimed_by: "robin",
          claimed_at: "2026-01-27T12:00:00.000Z",
          priority: 1,
        },
        "Details",
      );

      const entry = await showTask({ tasksDir, id: "b2c3" });
      const json = formatTaskShowJson(entry);
      const parsed = JSON.parse(json) as Record<string, unknown>;

      expect(parsed).toMatchObject({
        id: "b2c3",
        name: "Beta",
        status: "in_progress",
        priority: 1,
        created_by: "robin",
        claimed_by: "robin",
        claimed_at: "2026-01-27T12:00:00.000Z",
        description: "Details",
      });
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});

describe("git helpers", () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "tq",
    GIT_AUTHOR_EMAIL: "tq@example.com",
    GIT_COMMITTER_NAME: "tq",
    GIT_COMMITTER_EMAIL: "tq@example.com",
  } as NodeJS.ProcessEnv;

  test("initializes repo and creates initial commit", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-git-"));

    try {
      await ensureGitRepository(tasksDir, true, gitEnv);
      const head = await runGitCommand(
        tasksDir,
        ["rev-parse", "--verify", "HEAD"],
        {
          env: gitEnv,
        },
      );
      expect(head.exitCode).toBe(0);

      const message = await runGitCommand(
        tasksDir,
        ["log", "-1", "--pretty=%B"],
        {
          env: gitEnv,
        },
      );
      expect(message.stdout.trim()).toBe("tq: initialize task repository");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("commits changes and skips empty commits", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-git-"));

    try {
      await ensureGitRepository(tasksDir, true, gitEnv);
      await Bun.write(path.join(tasksDir, "task.md"), "task");

      const first = await commitTasksRepository(
        tasksDir,
        "tq: add task",
        gitEnv,
      );
      expect(first.committed).toBe(true);

      const second = await commitTasksRepository(
        tasksDir,
        "tq: add task",
        gitEnv,
      );
      expect(second.committed).toBe(false);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  test("detects configured git remotes", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-git-"));
    const remoteDir = await mkdtemp(path.join(tmpdir(), "tq-remote-"));

    try {
      await ensureGitRepository(tasksDir, true, gitEnv);
      await runGitCommand(remoteDir, ["init", "--bare"], { env: gitEnv });

      expect(await hasGitRemote(tasksDir, gitEnv)).toBe(false);
      await runGitCommand(tasksDir, ["remote", "add", "origin", remoteDir], {
        env: gitEnv,
      });
      expect(await hasGitRemote(tasksDir, gitEnv)).toBe(true);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  test("runs git commands with passthrough mode", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-git-"));

    try {
      await ensureGitRepository(tasksDir, true, gitEnv);
      const result = await runGitCommandPassthrough(tasksDir, ["status"], {
        env: gitEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});
