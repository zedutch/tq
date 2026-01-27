import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTask,
  updateTask,
  formatConfig,
  formatTaskListJson,
  formatTaskMarkdown,
  commitTasksRepository,
  ensureGitRepository,
  generateTaskId,
  hasGitRemote,
  initWorkspace,
  listTasks,
  loadConfig,
  normalizeConfig,
  parseTaskMarkdown,
  runGitCommand,
  resolveConfigPath,
  resolveGlobalTasksBase,
  resolveMachineName,
  resolveTasksDirectory,
  resolveXdgConfigHome,
  resolveXdgDataHome,
  saveConfig,
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
    expect(resolveGlobalTasksBase(env)).toBe("/tmp/custom-data/tq/tasks");
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

  test("resolves global workspace directory when registered", async () => {
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
          mode: "global",
          workspacePath: path.resolve(workspace),
          tasksDir: path.join(resolveGlobalTasksBase(), workspaceId),
          workspaceId,
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("errors when global workspace is not registered", async () => {
    await withTempEnv(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));

      try {
        await expect(resolveTasksDirectory(workspace)).rejects.toThrow(
          "Workspace not registered for global mode",
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

  test("initializes global mode and registers workspace", async () => {
    await withTempEnv(async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), "tq-workspace-"));
      const resolvedWorkspacePath = path.resolve(workspace);

      try {
        const resolved = await initWorkspace({
          mode: "global",
          workspacePath: workspace,
          initGit: false,
        });

        const config = await loadConfig();
        expect(resolved.mode).toBe("global");
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
        updated_at: "2026-01-27T10:00:00.000Z",
        status: "open",
        claimed_by: "",
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
      });

      expect(created.id).toMatch(/^[a-z0-9]{4}$/);
      const contents = await Bun.file(created.path).text();
      const parsed = parseTaskMarkdown(contents);
      expect(parsed.frontmatter.name).toBe("New task");
      expect(parsed.frontmatter.status).toBe("open");
      expect(parsed.frontmatter.priority).toBe(2);
      expect(parsed.frontmatter.claimed_by).toBe("");
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

describe("task list", () => {
  async function writeTask(
    tasksDir: string,
    id: string,
    frontmatter: {
      name: string;
      created_at: string;
      updated_at: string;
      status: "open" | "in_progress" | "done" | "cancelled";
      claimed_by: string;
      priority: number;
    },
    description: string,
  ) {
    const content = formatTaskMarkdown(frontmatter, description);
    await Bun.write(path.join(tasksDir, `${id}.md`), content);
  }

  test("filters across all fields with AND semantics", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));
    const createdAt = "2026-01-27T10:00:00.000Z";
    const updatedAt = "2026-01-27T10:30:00.000Z";

    try {
      await writeTask(
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
      await writeTask(
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
      await writeTask(
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
      await writeTask(
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
      await writeTask(
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

  test("formats JSON output with list entries", async () => {
    const tasksDir = await mkdtemp(path.join(tmpdir(), "tq-list-"));

    try {
      await writeTask(
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
        claimed_by: "",
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
});
