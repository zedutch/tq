import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatConfig,
  loadConfig,
  normalizeConfig,
  resolveConfigPath,
  resolveGlobalTasksBase,
  resolveMachineName,
  resolveTasksDirectory,
  resolveXdgConfigHome,
  resolveXdgDataHome,
  saveConfig,
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
