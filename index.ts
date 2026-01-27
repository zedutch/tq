import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import packageJson from "./package.json";

type FlagValue = string | boolean;
type FlagBucket = FlagValue | FlagValue[];

const buildVersion =
  typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "unknown";

type MachineConfig = {
  name?: string;
};

type TqConfig = {
  machine: MachineConfig;
  workspaces: Record<string, string>;
};

function createDefaultConfig(): TqConfig {
  return {
    machine: {},
    workspaces: {},
  };
}

function assertSupportedPlatform() {
  if (process.platform === "win32") {
    throw new Error("tq does not support Windows config paths yet.");
  }
}

export function resolveXdgConfigHome(env: NodeJS.ProcessEnv = process.env) {
  assertSupportedPlatform();
  const configured = env.XDG_CONFIG_HOME?.trim();
  if (configured) {
    return configured;
  }
  const home = env.HOME?.trim() ?? homedir();
  if (!home) {
    throw new Error("Unable to resolve HOME directory for config.");
  }
  return path.join(home, ".config");
}

export function resolveXdgDataHome(env: NodeJS.ProcessEnv = process.env) {
  assertSupportedPlatform();
  const configured = env.XDG_DATA_HOME?.trim();
  if (configured) {
    return configured;
  }
  const home = env.HOME?.trim() ?? homedir();
  if (!home) {
    throw new Error("Unable to resolve HOME directory for data.");
  }
  return path.join(home, ".local", "share");
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveXdgConfigHome(env), "tq", "config.toml");
}

export function resolveStealthTasksBase(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveXdgDataHome(env), "tq", "tasks");
}

function ensurePlainObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid config: ${label} must be a table.`);
  }
  return value as Record<string, unknown>;
}

export function normalizeConfig(raw: unknown): TqConfig {
  if (raw === null || raw === undefined) {
    return createDefaultConfig();
  }
  const record = ensurePlainObject(raw, "root");
  const allowedKeys = new Set(["machine", "workspaces"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid config: unsupported field "${key}".`);
    }
  }

  const machine: MachineConfig = {};
  if (record.machine !== undefined) {
    const machineRecord = ensurePlainObject(record.machine, "machine");
    if (machineRecord.name !== undefined) {
      if (
        typeof machineRecord.name !== "string" ||
        machineRecord.name.trim() === ""
      ) {
        throw new Error(
          "Invalid config: machine.name must be a non-empty string.",
        );
      }
      machine.name = machineRecord.name.trim();
    }
  }

  const workspaces: Record<string, string> = {};
  if (record.workspaces !== undefined) {
    const workspaceRecord = ensurePlainObject(record.workspaces, "workspaces");
    for (const [key, value] of Object.entries(workspaceRecord)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `Invalid config: workspaces.${key} must be a non-empty string.`,
        );
      }
      workspaces[key] = value;
    }
  }

  return { machine, workspaces };
}

export function formatConfig(config: TqConfig) {
  const normalized = normalizeConfig(config);
  const lines: string[] = [];
  lines.push("[machine]");
  if (normalized.machine.name) {
    lines.push(`name = ${JSON.stringify(normalized.machine.name)}`);
  }
  lines.push("");
  lines.push("[workspaces]");
  for (const key of Object.keys(normalized.workspaces).sort()) {
    const value = normalized.workspaces[key];
    lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  assertSupportedPlatform();
  const configPath = resolveConfigPath(env);
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return createDefaultConfig();
  }

  const text = await file.text();
  try {
    const parsed = Bun.TOML.parse(text);
    return normalizeConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid config at ${configPath}: ${message}`);
  }
}

export async function saveConfig(
  config: TqConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  assertSupportedPlatform();
  const configPath = resolveConfigPath(env);
  const content = formatConfig(config);
  await mkdir(path.dirname(configPath), { recursive: true });

  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tempPath, content);
  await rename(tempPath, configPath);
}

export function resolveMachineName(
  config: TqConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (config.machine.name) {
    return config.machine.name;
  }
  const fromEnv = env.USER?.trim() || env.LOGNAME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  throw new Error(
    "Unable to resolve machine name. Set machine.name in config or define USER/LOGNAME.",
  );
}

type WorkspaceMode = "local" | "stealth";

export type ResolvedWorkspace = {
  mode: WorkspaceMode;
  workspacePath: string;
  tasksDir: string;
  workspaceId?: string;
};

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export type TaskFrontmatter = {
  name: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  status: TaskStatus;
  claimed_by: string;
  claimed_at: string;
  priority: number;
};

const taskFieldOrder: Array<keyof TaskFrontmatter> = [
  "name",
  "created_at",
  "created_by",
  "updated_at",
  "status",
  "claimed_by",
  "claimed_at",
  "priority",
];

const taskFieldSet = new Set(taskFieldOrder);

const taskStatusSet = new Set<TaskStatus>([
  "open",
  "in_progress",
  "done",
  "cancelled",
]);

const taskIdAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

function isIsoTimestamp(value: string) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseFrontmatterValue(value: string): string | number {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

function normalizePriority(value: unknown, fallback = 2) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("Invalid task: priority must be a number.");
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error("Invalid task: priority must be a number.");
    }
    return Number.parseInt(trimmed, 10);
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error("Invalid task: priority must be a number.");
  }
  return value;
}

export function normalizeTaskFrontmatter(raw: Record<string, unknown>) {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!taskFieldSet.has(key as keyof TaskFrontmatter)) {
      throw new Error(`Invalid task: unsupported frontmatter field "${key}".`);
    }
    if (key in record) {
      throw new Error(`Invalid task: duplicate frontmatter field "${key}".`);
    }
    record[key] = value;
  }

  const name = record.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("Invalid task: name is required.");
  }

  const createdAt = record.created_at;
  if (typeof createdAt !== "string" || !isIsoTimestamp(createdAt)) {
    throw new Error("Invalid task: created_at must be an ISO 8601 timestamp.");
  }

  const updatedAt = record.updated_at;
  if (typeof updatedAt !== "string" || !isIsoTimestamp(updatedAt)) {
    throw new Error("Invalid task: updated_at must be an ISO 8601 timestamp.");
  }

  const status = record.status;
  if (typeof status !== "string" || status.trim() === "") {
    throw new Error("Invalid task: status is required.");
  }
  if (!taskStatusSet.has(status as TaskStatus)) {
    throw new Error(`Invalid task: status "${status}" is not supported.`);
  }

  const createdByRaw = record.created_by;
  let createdBy = "";
  if (createdByRaw !== undefined) {
    if (typeof createdByRaw !== "string") {
      throw new Error("Invalid task: created_by must be a string.");
    }
    createdBy = createdByRaw.trim();
  }

  const claimedByRaw = record.claimed_by;
  let claimedBy = "";
  if (claimedByRaw !== undefined) {
    if (typeof claimedByRaw !== "string") {
      throw new Error("Invalid task: claimed_by must be a string.");
    }
    claimedBy = claimedByRaw.trim();
  }

  const claimedAtRaw = record.claimed_at;
  let claimedAt = "";
  if (claimedAtRaw !== undefined) {
    if (typeof claimedAtRaw !== "string") {
      throw new Error("Invalid task: claimed_at must be a string.");
    }
    claimedAt = claimedAtRaw.trim();
    if (claimedAt && !isIsoTimestamp(claimedAt)) {
      throw new Error("Invalid task: claimed_at must be an ISO 8601 timestamp.");
    }
  }

  const priority = normalizePriority(record.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Error("Invalid task: priority must be an integer from 0 to 4.");
  }

  return {
    name: name.trim(),
    created_at: createdAt,
    created_by: createdBy,
    updated_at: updatedAt,
    status: status as TaskStatus,
    claimed_by: claimedBy,
    claimed_at: claimedAt,
    priority,
  } satisfies TaskFrontmatter;
}

export function parseTaskMarkdown(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error("Invalid task: missing frontmatter header.");
  }
  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1) {
    throw new Error("Invalid task: missing frontmatter terminator.");
  }

  const rawFields: Record<string, unknown> = {};
  for (const line of lines.slice(1, endIndex)) {
    if (!line.trim()) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`Invalid task: malformed frontmatter line "${line}".`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`Invalid task: malformed frontmatter line "${line}".`);
    }
    if (key in rawFields) {
      throw new Error(`Invalid task: duplicate frontmatter field "${key}".`);
    }
    rawFields[key] = parseFrontmatterValue(value);
  }

  const frontmatter = normalizeTaskFrontmatter(rawFields);
  const description = lines.slice(endIndex + 1).join("\n");
  return { frontmatter, description };
}

export function formatTaskFrontmatter(frontmatter: TaskFrontmatter) {
  const normalized = normalizeTaskFrontmatter(
    frontmatter as Record<string, unknown>,
  );
  const lines: string[] = ["---"];
  for (const key of taskFieldOrder) {
    const value = normalized[key];
    if (
      (key === "claimed_by" || key === "created_by" || key === "claimed_at") &&
      value === ""
    ) {
      continue;
    }
    if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function formatTaskMarkdown(
  frontmatter: TaskFrontmatter,
  description: string,
) {
  const header = formatTaskFrontmatter(frontmatter);
  if (!description) {
    return `${header}\n`;
  }
  const body = description.replace(/\r\n/g, "\n");
  return `${header}\n${body}`;
}

export function generateTaskId(
  existingIds: ReadonlySet<string>,
  options: {
    randomBytes?: (length: number) => Uint8Array;
    maxAttempts?: number;
  } = {},
) {
  const randomBytes =
    options.randomBytes ??
    ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const maxAttempts = options.maxAttempts ?? 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const bytes = randomBytes(4);
    let id = "";
    for (let i = 0; i < 4; i += 1) {
      const value = bytes[i] ?? 0;
      id += taskIdAlphabet[value % taskIdAlphabet.length];
    }
    if (!existingIds.has(id)) {
      return id;
    }
  }
  throw new Error("Unable to generate unique task id.");
}

async function listTaskIds(tasksDir: string) {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    const name = entry.name.slice(0, -3);
    if (/^[a-z0-9]{4}$/.test(name)) {
      ids.add(name);
    }
  }
  return ids;
}

async function isDirectory(targetPath: string) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type GitCommandOptions = {
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
};

type GitPassthroughOptions = {
  env?: NodeJS.ProcessEnv;
  stdout?: "inherit" | "pipe";
  stderr?: "inherit" | "pipe";
  stdin?: "inherit" | "pipe";
};

export async function runGitCommand(
  tasksDir: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const env = options.env ?? process.env;
  const processResult = Bun.spawn(["git", ...args], {
    cwd: tasksDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);

  const result = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !options.allowFailure) {
    const details = stderr.trim() || stdout.trim();
    const detailMessage = details ? `: ${details}` : "";
    throw new Error(
      `Git command failed (git ${args.join(" ")})${detailMessage}`,
    );
  }
  return result;
}

export async function runGitCommandPassthrough(
  tasksDir: string,
  args: string[],
  options: GitPassthroughOptions = {},
) {
  const env = options.env ?? process.env;
  const processResult = Bun.spawn(["git", ...args], {
    cwd: tasksDir,
    env,
    stdin: options.stdin ?? "inherit",
    stdout: options.stdout ?? "inherit",
    stderr: options.stderr ?? "inherit",
  });
  const exitCode = await processResult.exited;
  return { exitCode };
}

async function getGitRemotes(
  tasksDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const result = await runGitCommand(tasksDir, ["remote"], { env });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getGitUpstream(
  tasksDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const result = await runGitCommand(
    tasksDir,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { env, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed ? trimmed : null;
}

function sanitizeEmailLocalPart(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || "tq";
}

function resolveGitCommitIdentity(env: NodeJS.ProcessEnv) {
  const name =
    env.GIT_AUTHOR_NAME?.trim() ||
    env.GIT_COMMITTER_NAME?.trim() ||
    env.USER?.trim() ||
    env.LOGNAME?.trim() ||
    "tq";
  const email =
    env.GIT_AUTHOR_EMAIL?.trim() ||
    env.GIT_COMMITTER_EMAIL?.trim() ||
    `${sanitizeEmailLocalPart(name)}@localhost`;
  return { name, email };
}

function withGitCommitIdentity(args: string[], env: NodeJS.ProcessEnv) {
  const identity = resolveGitCommitIdentity(env);
  return [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    ...args,
  ];
}

async function hasGitCommits(tasksDir: string, env: NodeJS.ProcessEnv) {
  const result = await runGitCommand(
    tasksDir,
    ["rev-parse", "--verify", "HEAD"],
    {
      env,
      allowFailure: true,
    },
  );
  return result.exitCode === 0;
}

export async function ensureGitRepository(
  tasksDir: string,
  initGit = true,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!initGit) {
    return;
  }
  await mkdir(tasksDir, { recursive: true });
  const gitDir = path.join(tasksDir, ".git");
  if (!(await isDirectory(gitDir))) {
    try {
      await runGitCommand(tasksDir, ["init"], { env });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to initialize git repo in ${tasksDir}: ${message}`,
      );
    }
  }

  if (!(await hasGitCommits(tasksDir, env))) {
    await runGitCommand(
      tasksDir,
      withGitCommitIdentity(
        ["commit", "--allow-empty", "-m", "tq: initialize task repository"],
        env,
      ),
      {
        env,
      },
    );
  }
}

export async function hasGitRemote(
  tasksDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const remotes = await getGitRemotes(tasksDir, env);
  return remotes.length > 0;
}

export async function pullTasksRepository(
  tasksDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const remotes = await getGitRemotes(tasksDir, env);
  if (remotes.length === 0) {
    return false;
  }
  const upstream = await getGitUpstream(tasksDir, env);
  if (upstream) {
    await runGitCommand(tasksDir, ["pull", "--rebase", "--autostash"], { env });
  } else {
    await runGitCommand(
      tasksDir,
      ["pull", "--rebase", "--autostash", remotes[0] ?? "origin", "HEAD"],
      { env },
    );
  }
  return true;
}

export async function pushTasksRepository(
  tasksDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const remotes = await getGitRemotes(tasksDir, env);
  if (remotes.length === 0) {
    return false;
  }
  const upstream = await getGitUpstream(tasksDir, env);
  if (upstream) {
    await runGitCommand(tasksDir, ["push"], { env });
  } else {
    await runGitCommand(
      tasksDir,
      ["push", "--set-upstream", remotes[0] ?? "origin", "HEAD"],
      { env },
    );
  }
  return true;
}

export async function prepareTasksRepository(
  tasksDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  await ensureGitRepository(tasksDir, true, env);
  await pullTasksRepository(tasksDir, env);
}

export async function commitTasksRepository(
  tasksDir: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  await runGitCommand(tasksDir, ["add", "-A"], { env });
  const status = await runGitCommand(tasksDir, ["status", "--porcelain"], {
    env,
  });
  if (!status.stdout.trim()) {
    return { committed: false, pushed: false };
  }
  await runGitCommand(
    tasksDir,
    withGitCommitIdentity(["commit", "-m", message], env),
    { env },
  );
  const pushed = await pushTasksRepository(tasksDir, env);
  return { committed: true, pushed };
}

export async function resolveTasksDirectory(
  workspacePath = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedWorkspace> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const localTasksDir = path.join(resolvedWorkspacePath, ".tasks");
  if (await isDirectory(localTasksDir)) {
    return {
      mode: "local",
      workspacePath: resolvedWorkspacePath,
      tasksDir: localTasksDir,
    };
  }

  const config = await loadConfig(env);
  const workspaceId = config.workspaces[resolvedWorkspacePath];
  if (!workspaceId) {
    throw new Error(
      `Workspace not initialized: ${resolvedWorkspacePath}. Run "tq init" or "tq init --stealth" first.`,
    );
  }

  return {
    mode: "stealth",
    workspacePath: resolvedWorkspacePath,
    tasksDir: path.join(resolveStealthTasksBase(env), workspaceId),
    workspaceId,
  };
}

type InitWorkspaceOptions = {
  mode?: WorkspaceMode;
  workspacePath?: string;
  env?: NodeJS.ProcessEnv;
  initGit?: boolean;
};

async function generateWorkspaceId(
  existingIds: ReadonlySet<string>,
  baseDir: string,
) {
  const checked = new Set(existingIds);
  const maxAttempts = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateTaskId(checked);
    if (!(await isDirectory(path.join(baseDir, candidate)))) {
      return candidate;
    }
    checked.add(candidate);
  }
  throw new Error("Unable to generate unique workspace id.");
}

export async function initWorkspace(
  options: InitWorkspaceOptions = {},
): Promise<ResolvedWorkspace> {
  const mode = options.mode ?? "local";
  const env = options.env ?? process.env;
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const localTasksDir = path.join(workspacePath, ".tasks");

  if (mode === "local") {
    await mkdir(localTasksDir, { recursive: true });
    await ensureGitRepository(localTasksDir, options.initGit ?? true, env);
    return {
      mode: "local",
      workspacePath,
      tasksDir: localTasksDir,
    };
  }

  if (await isDirectory(localTasksDir)) {
    throw new Error(
      `Workspace already has a .tasks directory at ${localTasksDir}. Remove it or run "tq init" without --stealth.`,
    );
  }

  const config = await loadConfig(env);
  let workspaceId = config.workspaces[workspacePath];
  const baseDir = resolveStealthTasksBase(env);
  if (!workspaceId) {
    const existingIds = new Set(Object.values(config.workspaces));
    workspaceId = await generateWorkspaceId(existingIds, baseDir);
    config.workspaces[workspacePath] = workspaceId;
    await saveConfig(config, env);
  }

  const tasksDir = path.join(baseDir, workspaceId);
  await mkdir(tasksDir, { recursive: true });
  await ensureGitRepository(tasksDir, options.initGit ?? true, env);

  return {
    mode: "stealth",
    workspacePath,
    tasksDir,
    workspaceId,
  };
}

type CreateTaskOptions = {
  tasksDir: string;
  name: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  skipGit?: boolean;
};

export async function createTask(options: CreateTaskOptions) {
  const env = options.env ?? process.env;
  const name = options.name.trim();
  if (!name) {
    throw new Error("Task name is required.");
  }
  if (!(await isDirectory(options.tasksDir))) {
    throw new Error(
      `Tasks directory not initialized at ${options.tasksDir}. Run "tq init" first.`,
    );
  }

  const createdBy = resolveMachineName(await loadConfig(env), env);

  if (!options.skipGit) {
    await prepareTasksRepository(options.tasksDir, env);
    await ensureNoStagedChanges(options.tasksDir, env, "creating");
  }

  const existingIds = await listTaskIds(options.tasksDir);
  const id = generateTaskId(existingIds);
  const timestamp = (options.now ?? new Date()).toISOString();
  const frontmatter = normalizeTaskFrontmatter({
    name,
    created_at: timestamp,
    created_by: createdBy,
    updated_at: timestamp,
    status: options.status ?? "open",
    claimed_by: "",
    claimed_at: "",
    priority: options.priority ?? 2,
  });
  const description = options.description ?? "";
  const content = formatTaskMarkdown(frontmatter, description);
  const taskFileName = `${id}.md`;
  const taskPath = path.join(options.tasksDir, taskFileName);
  await Bun.write(taskPath, content);

  if (!options.skipGit) {
    if (await stageTaskFile(options.tasksDir, taskFileName, env)) {
      await runGitCommand(
        options.tasksDir,
        withGitCommitIdentity(["commit", "-m", `tq: create task ${id}`], env),
        { env },
      );
      await pushTasksRepository(options.tasksDir, env);
    }
  }

  return { id, path: taskPath, frontmatter, description };
}

function assertValidTaskId(id: string) {
  if (!/^[a-z0-9]{4}$/.test(id)) {
    throw new Error(
      `Invalid task id "${id}". Expected 4 lowercase alphanumeric characters.`,
    );
  }
}

async function loadTaskById(tasksDir: string, id: string) {
  assertValidTaskId(id);
  const taskPath = path.join(tasksDir, `${id}.md`);
  const file = Bun.file(taskPath);
  if (!(await file.exists())) {
    throw new Error(`Task ${id} not found.`);
  }
  const contents = await file.text();
  const parsed = parseTaskMarkdown(contents);
  return { path: taskPath, ...parsed };
}

async function resolveTaskPath(tasksDir: string, id: string) {
  assertValidTaskId(id);
  const taskPath = path.join(tasksDir, `${id}.md`);
  const file = Bun.file(taskPath);
  if (!(await file.exists())) {
    throw new Error(`Task ${id} not found.`);
  }
  return taskPath;
}

type UpdateTaskOptions = {
  tasksDir: string;
  id: string;
  name?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  skipGit?: boolean;
};

type ClaimTaskOptions = {
  tasksDir: string;
  id: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  skipGit?: boolean;
};

type CloseTaskOptions = {
  tasksDir: string;
  id: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  skipGit?: boolean;
};

type CancelTaskOptions = {
  tasksDir: string;
  id: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  skipGit?: boolean;
};

export async function updateTask(options: UpdateTaskOptions) {
  const env = options.env ?? process.env;
  const id = options.id.trim();
  if (!id) {
    throw new Error("Task id is required.");
  }
  if (!(await isDirectory(options.tasksDir))) {
    throw new Error(
      `Tasks directory not initialized at ${options.tasksDir}. Run "tq init" first.`,
    );
  }

  if (!options.skipGit) {
    await prepareTasksRepository(options.tasksDir, env);
    await ensureNoStagedChanges(options.tasksDir, env, "updating");
  }

  const task = await loadTaskById(options.tasksDir, id);

  if (!options.skipGit) {
    await ensureTaskFileClean(options.tasksDir, id, env, "updating");
  }
  const updatedFrontmatter = {
    ...task.frontmatter,
  };

  if (options.name !== undefined) {
    const trimmed = options.name.trim();
    if (!trimmed) {
      throw new Error("Task name is required.");
    }
    updatedFrontmatter.name = trimmed;
  }

  if (options.status !== undefined) {
    updatedFrontmatter.status = options.status;
  }

  if (options.priority !== undefined) {
    updatedFrontmatter.priority = options.priority;
  }

  updatedFrontmatter.updated_at = (options.now ?? new Date()).toISOString();

  const description =
    options.description !== undefined ? options.description : task.description;
  const normalized = normalizeTaskFrontmatter(
    updatedFrontmatter as Record<string, unknown>,
  );
  const content = formatTaskMarkdown(normalized, description);
  await Bun.write(task.path, content);

  if (!options.skipGit) {
    const fileName = `${id}.md`;
    if (await stageTaskFile(options.tasksDir, fileName, env)) {
      await runGitCommand(
        options.tasksDir,
        withGitCommitIdentity(["commit", "-m", `tq: update task ${id}`], env),
        { env },
      );
      await pushTasksRepository(options.tasksDir, env);
    }
  }

  return { id, path: task.path, frontmatter: normalized, description };
}

async function ensureNoStagedChanges(
  tasksDir: string,
  env: NodeJS.ProcessEnv,
  actionLabel: string,
) {
  const staged = await runGitCommand(
    tasksDir,
    ["diff", "--cached", "--name-only"],
    { env },
  );
  if (staged.stdout.trim()) {
    throw new Error(
      `Tasks repository has staged changes. Commit or unstage them before ${actionLabel} a task.`,
    );
  }
}

async function ensureTaskFileClean(
  tasksDir: string,
  id: string,
  env: NodeJS.ProcessEnv,
  actionLabel: string,
) {
  const status = await runGitCommand(
    tasksDir,
    ["status", "--porcelain", "--", `${id}.md`],
    { env },
  );
  if (status.stdout.trim()) {
    throw new Error(
      `Task ${id} has uncommitted changes. Commit or discard them before ${actionLabel}.`,
    );
  }
}

async function stageTaskFile(
  tasksDir: string,
  fileName: string,
  env: NodeJS.ProcessEnv,
) {
  await runGitCommand(tasksDir, ["add", "--", fileName], { env });
  const staged = await runGitCommand(
    tasksDir,
    ["diff", "--cached", "--name-only"],
    { env },
  );
  return staged.stdout.trim().length > 0;
}

async function pushTasksRepositoryWithRetry(
  tasksDir: string,
  env: NodeJS.ProcessEnv,
  actionLabel: string,
) {
  try {
    return await pushTasksRepository(tasksDir, env);
  } catch (error) {
    try {
      await pullTasksRepository(tasksDir, env);
    } catch (pullError) {
      await runGitCommand(tasksDir, ["rebase", "--abort"], {
        env,
        allowFailure: true,
      });
      throw new Error(
        `${actionLabel} failed due to conflicting remote updates. Please retry.`,
      );
    }
    return await pushTasksRepository(tasksDir, env);
  }
}

async function updateTaskStatus(options: {
  tasksDir: string;
  id: string;
  status: TaskStatus;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  skipGit?: boolean;
  commitMessage: string;
  actionLabel: string;
  retryPush?: boolean;
}) {
  const env = options.env ?? process.env;
  const id = options.id.trim();
  if (!id) {
    throw new Error("Task id is required.");
  }
  if (!(await isDirectory(options.tasksDir))) {
    throw new Error(
      `Tasks directory not initialized at ${options.tasksDir}. Run "tq init" first.`,
    );
  }

  if (!options.skipGit) {
    await prepareTasksRepository(options.tasksDir, env);
    await ensureNoStagedChanges(options.tasksDir, env, options.actionLabel);
  }

  const task = await loadTaskById(options.tasksDir, id);

  if (!options.skipGit) {
    await ensureTaskFileClean(options.tasksDir, id, env, options.actionLabel);
  }

  const updatedFrontmatter = {
    ...task.frontmatter,
    status: options.status,
    updated_at: (options.now ?? new Date()).toISOString(),
  };

  const normalized = normalizeTaskFrontmatter(
    updatedFrontmatter as Record<string, unknown>,
  );
  const content = formatTaskMarkdown(normalized, task.description);
  await Bun.write(task.path, content);

  if (!options.skipGit) {
    const fileName = `${id}.md`;
    if (await stageTaskFile(options.tasksDir, fileName, env)) {
      await runGitCommand(
        options.tasksDir,
        withGitCommitIdentity(["commit", "-m", options.commitMessage], env),
        { env },
      );
      if (options.retryPush) {
        await pushTasksRepositoryWithRetry(
          options.tasksDir,
          env,
          `${options.actionLabel[0]?.toUpperCase() ?? ""}${options.actionLabel.slice(1)} task ${id}`,
        );
      } else {
        await pushTasksRepository(options.tasksDir, env);
      }
    }
  }

  return {
    id,
    path: task.path,
    frontmatter: normalized,
    description: task.description,
  };
}

export async function claimTask(options: ClaimTaskOptions) {
  const env = options.env ?? process.env;
  const id = options.id.trim();
  if (!id) {
    throw new Error("Task id is required.");
  }
  if (!(await isDirectory(options.tasksDir))) {
    throw new Error(
      `Tasks directory not initialized at ${options.tasksDir}. Run "tq init" first.`,
    );
  }

  if (!options.skipGit) {
    await prepareTasksRepository(options.tasksDir, env);
    await ensureNoStagedChanges(options.tasksDir, env, "claiming");
  }

  const task = await loadTaskById(options.tasksDir, id);

  if (!options.skipGit) {
    await ensureTaskFileClean(options.tasksDir, id, env, "claiming");
  }

  const claimedBy = resolveMachineName(await loadConfig(env), env);
  if (task.frontmatter.claimed_by.trim()) {
    throw new Error(
      `Task ${id} is already claimed by ${task.frontmatter.claimed_by}.`,
    );
  }

  const now = options.now ?? new Date();

  const updatedFrontmatter = {
    ...task.frontmatter,
    status: "in_progress" as TaskStatus,
    claimed_by: claimedBy,
    claimed_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const normalized = normalizeTaskFrontmatter(
    updatedFrontmatter as Record<string, unknown>,
  );
  const content = formatTaskMarkdown(normalized, task.description);
  await Bun.write(task.path, content);

  if (!options.skipGit) {
    const fileName = `${id}.md`;
    if (await stageTaskFile(options.tasksDir, fileName, env)) {
      await runGitCommand(
        options.tasksDir,
        withGitCommitIdentity(["commit", "-m", `tq: claim task ${id}`], env),
        { env },
      );
      await pushTasksRepositoryWithRetry(
        options.tasksDir,
        env,
        `Claiming task ${id}`,
      );
    }
  }

  return {
    id,
    path: task.path,
    frontmatter: normalized,
    description: task.description,
  };
}

export async function closeTask(options: CloseTaskOptions) {
  return updateTaskStatus({
    tasksDir: options.tasksDir,
    id: options.id,
    status: "done",
    now: options.now,
    env: options.env,
    skipGit: options.skipGit,
    commitMessage: `tq: close task ${options.id.trim()}`,
    actionLabel: "closing",
    retryPush: true,
  });
}

export async function cancelTask(options: CancelTaskOptions) {
  return updateTaskStatus({
    tasksDir: options.tasksDir,
    id: options.id,
    status: "cancelled",
    now: options.now,
    env: options.env,
    skipGit: options.skipGit,
    commitMessage: `tq: cancel task ${options.id.trim()}`,
    actionLabel: "cancelling",
    retryPush: true,
  });
}

type TaskRecord = {
  id: string;
  frontmatter: TaskFrontmatter;
  description: string;
};

export type TaskListEntry = {
  id: string;
  name: string;
  status: TaskStatus;
  priority: number;
  created_by: string;
  claimed_by: string;
  claimed_at: string;
  created_at: string;
  updated_at: string;
};

export type TaskShowEntry = TaskListEntry & {
  description: string;
};

type TaskListFilters = {
  names: string[];
  statuses: TaskStatus[];
  priorities: number[];
  createdBy: string[];
  claimedBy: string[];
  createdAt: string[];
  updatedAt: string[];
};

function ensureTasksDir(tasksDir: string) {
  if (!tasksDir.trim()) {
    throw new Error("Tasks directory is required.");
  }
}

async function loadTaskRecords(tasksDir: string): Promise<TaskRecord[]> {
  ensureTasksDir(tasksDir);
  if (!(await isDirectory(tasksDir))) {
    throw new Error(
      `Tasks directory not initialized at ${tasksDir}. Run "tq init" first.`,
    );
  }
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const tasks: TaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const id = entry.name.slice(0, -3);
    if (!/^[a-z0-9]{4}$/.test(id)) {
      continue;
    }
    const contents = await Bun.file(path.join(tasksDir, entry.name)).text();
    try {
      const parsed = parseTaskMarkdown(contents);
      tasks.push({ id, ...parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid task ${entry.name}: ${message}`);
    }
  }
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  return tasks;
}

function matchesFilter<T>(value: T, filters: T[]) {
  if (filters.length === 0) {
    return true;
  }
  return filters.includes(value);
}

function applyTaskFilters(task: TaskRecord, filters: TaskListFilters) {
  const { frontmatter } = task;
  if (!matchesFilter(frontmatter.name, filters.names)) {
    return false;
  }
  if (!matchesFilter(frontmatter.status, filters.statuses)) {
    return false;
  }
  if (!matchesFilter(frontmatter.priority, filters.priorities)) {
    return false;
  }
  if (!matchesFilter(frontmatter.created_by, filters.createdBy)) {
    return false;
  }
  if (!matchesFilter(frontmatter.claimed_by, filters.claimedBy)) {
    return false;
  }
  if (!matchesFilter(frontmatter.created_at, filters.createdAt)) {
    return false;
  }
  if (!matchesFilter(frontmatter.updated_at, filters.updatedAt)) {
    return false;
  }
  return true;
}

export async function listTasks(options: {
  tasksDir: string;
  filters?: Partial<TaskListFilters>;
  includeAllStatuses?: boolean;
}) {
  const tasks = await loadTaskRecords(options.tasksDir);
  const requestedStatuses = options.filters?.statuses ?? [];
  const statuses: TaskStatus[] =
    requestedStatuses.length > 0
      ? requestedStatuses
      : options.includeAllStatuses
        ? []
        : ["open"];
  const filters: TaskListFilters = {
    names: options.filters?.names ?? [],
    statuses,
    priorities: options.filters?.priorities ?? [],
    createdBy: options.filters?.createdBy ?? [],
    claimedBy: options.filters?.claimedBy ?? [],
    createdAt: normalizeTimestampFilterValues(options.filters?.createdAt ?? []),
    updatedAt: normalizeTimestampFilterValues(options.filters?.updatedAt ?? []),
  };
  return tasks.filter((task) => applyTaskFilters(task, filters));
}

export async function showTask(options: { tasksDir: string; id: string }) {
  ensureTasksDir(options.tasksDir);
  if (!(await isDirectory(options.tasksDir))) {
    throw new Error(
      `Tasks directory not initialized at ${options.tasksDir}. Run "tq init" first.`,
    );
  }
  const taskId = options.id.trim();
  if (!taskId) {
    throw new Error("Task id is required.");
  }
  const task = await loadTaskById(options.tasksDir, taskId);
  return toTaskShowEntry({
    id: taskId,
    frontmatter: task.frontmatter,
    description: task.description,
  });
}

export function toTaskListEntry(task: TaskRecord): TaskListEntry {
  return {
    id: task.id,
    name: task.frontmatter.name,
    status: task.frontmatter.status,
    priority: task.frontmatter.priority,
    created_by: task.frontmatter.created_by,
    claimed_by: task.frontmatter.claimed_by,
    claimed_at: task.frontmatter.claimed_at,
    created_at: task.frontmatter.created_at,
    updated_at: task.frontmatter.updated_at,
  };
}

export function toTaskShowEntry(task: TaskRecord): TaskShowEntry {
  return {
    ...toTaskListEntry(task),
    description: task.description,
  };
}

function normalizeTaskEntryAuthors<
  T extends { claimed_by: string; created_by: string; claimed_at: string },
>(entry: T) {
  return {
    ...entry,
    created_by: entry.created_by ? entry.created_by : null,
    claimed_by: entry.claimed_by ? entry.claimed_by : null,
    claimed_at: entry.claimed_at ? entry.claimed_at : null,
  };
}

export function formatTaskListJson(entries: TaskListEntry[]) {
  const normalized = entries.map((entry) => normalizeTaskEntryAuthors(entry));
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function formatTaskShowJson(entry: TaskShowEntry) {
  const normalized = normalizeTaskEntryAuthors(entry);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

const ansiCodes = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  brightWhite: "\u001b[97m",
};

function shouldUseColor(
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stdout,
) {
  if (!stream.isTTY) {
    return false;
  }
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  if (env.TERM?.trim().toLowerCase() === "dumb") {
    return false;
  }
  if (env.FORCE_COLOR?.trim() === "0") {
    return false;
  }
  return true;
}

function applyAnsi(text: string, enabled: boolean, ...codes: string[]) {
  if (!enabled || codes.length === 0) {
    return text;
  }
  return `${codes.join("")}${text}${ansiCodes.reset}`;
}

const statusColors: Record<TaskStatus, string> = {
  open: ansiCodes.blue,
  in_progress: ansiCodes.yellow,
  done: ansiCodes.green,
  cancelled: ansiCodes.red,
};

function formatTaskSummary(entry: TaskListEntry) {
  const useColor = shouldUseColor();
  const id = applyAnsi(entry.id, useColor, ansiCodes.gray);
  const name = applyAnsi(
    entry.name,
    useColor,
    ansiCodes.brightWhite,
    ansiCodes.bold,
  );
  const status = applyAnsi(
    `[${entry.status}]`,
    useColor,
    statusColors[entry.status],
  );
  const priority = applyAnsi(
    `p${entry.priority}`,
    useColor,
    ansiCodes.magenta,
  );
  const claimedBy = entry.claimed_by
    ? applyAnsi(entry.claimed_by, useColor, ansiCodes.cyan)
    : applyAnsi("-", useColor, ansiCodes.dim);
  return `${id} ${name} ${status} ${priority} ${claimedBy}`;
}

function formatTaskDetails(entry: TaskShowEntry) {
  const createdBy = entry.created_by ? entry.created_by : "-";
  const claimed = entry.claimed_by ? entry.claimed_by : "-";
  const claimedAt = entry.claimed_at ? entry.claimed_at : "-";
  const lines = [
    `id: ${entry.id}`,
    `name: ${entry.name}`,
    `status: ${entry.status}`,
    `priority: ${entry.priority}`,
    `created_by: ${createdBy}`,
    `claimed_by: ${claimed}`,
    `claimed_at: ${claimedAt}`,
    `created_at: ${entry.created_at}`,
    `updated_at: ${entry.updated_at}`,
    "",
    "description:",
  ];

  if (entry.description) {
    lines.push(entry.description);
  } else {
    lines.push("(no description)");
  }

  return lines.join("\n");
}

type ParsedArgs = {
  command: string | null;
  flags: Record<string, FlagBucket>;
  positionals: string[];
};

const knownCommands = new Set([
  "init",
  "create",
  "update",
  "list",
  "show",
  "edit",
  "where",
  "claim",
  "close",
  "cancel",
  "git",
  "help",
]);

const helpText = `tq - task queue CLI

Usage:
  tq <command> [options] [--] [args]
  tq create <name> [options]
  tq edit <id>
  tq help [command]

Commands:
  init      initialize a workspace
  create    create a task
  update    update a task
  list      list tasks
  show      show task details
  edit      edit a task in $EDITOR
  where     show tasks directory location
  claim     claim a task
  close     close a task
  cancel    cancel a task
  git       run git in tasks repo
  help      show this help

Options:
  -h, --help  show help
  -v, --version  show version

Init options:
  --stealth  store tasks in XDG data dir (no .tasks in this repo; use when you can't or won't ignore it)

Create options:
  -d, --description <text>  task description
  -s, --status <status>     open, in_progress, done, cancelled
  -p, --priority <0-4>      task priority (default: 2)

Update options:
  -n, --name <text>         task name
  -d, --description <text>  task description
  -s, --status <status>     open, in_progress, done, cancelled
  -p, --priority <0-4>      task priority

Show options:
  --json            emit JSON output

Claim options:
  (no options)

Close options:
  (no options)

Cancel options:
  (no options)

List options:
  -n, --name <text>          filter by name (repeatable)
  -s, --status <status>      filter by status (repeatable)
  -p, --priority <0-4>       filter by priority (repeatable)
  -c, --claimed-by <name>    filter by claimed_by (repeatable)
  -C, --created <timestamp>  filter by created_at (repeatable)
  -U, --updated <timestamp>  filter by updated_at (repeatable)
  --mine                     only tasks created by the current user
  --all                      include all statuses
  --json                        emit JSON output
`;

const helpByCommand: Record<string, string> = {
  init: `tq init - initialize a workspace

Usage:
  tq init [options]

Options:
  --stealth  store tasks in XDG data dir (no .tasks in this repo; use when you can't or won't ignore it)
  -h, --help                 show help for init
`,
  create: `tq create - create a task

Usage:
  tq create <name> [options]

Options:
  -d, --description <text>  task description (markdown)
  -s, --status <status>     open | in_progress | done | cancelled (default: open)
  -p, --priority <0-4>      task priority (default: 2)
  -h, --help                show help for create
`,
  update: `tq update - update task fields

Usage:
  tq update <id> [options]

Options:
  -n, --name <text>         task name
  -d, --description <text>  task description (markdown)
  -s, --status <status>     open | in_progress | done | cancelled
  -p, --priority <0-4>      task priority
  -h, --help                show help for update

Notes:
  At least one of --name, --description, --status, or --priority is required.
`,
  list: `tq list - list tasks

Usage:
  tq list [options]

Options:
  -n, --name <text>          filter by name (repeatable)
  -s, --status <status>      filter by status (repeatable)
  -p, --priority <0-4>       filter by priority (repeatable)
  -c, --claimed-by <name>    filter by claimed_by (repeatable)
  -C, --created <timestamp>  filter by created_at (repeatable)
  -U, --updated <timestamp>  filter by updated_at (repeatable)
  --mine                     only tasks created by the current user
  --all                      include all statuses
  --json                     emit JSON output
  -h, --help                 show help for list

Notes:
  Defaults to open tasks when no status filter is provided.
  Use --all to include every status.
  Timestamps must be ISO 8601 (e.g. 2025-01-05T12:34:56.000Z).
`,
  show: `tq show - show task details

Usage:
  tq show <id> [options]

Options:
  --json     emit JSON output
  -h, --help show help for show
`,
  edit: `tq edit - edit a task in $EDITOR

Usage:
  tq edit <id>

Options:
  -h, --help show help for edit
`,
  where: `tq where - show tasks directory location

Usage:
  tq where

Options:
  -h, --help show help for where
`,
  claim: `tq claim - claim a task

Usage:
  tq claim <id>

Options:
  -h, --help show help for claim
`,
  close: `tq close - close a task

Usage:
  tq close <id>

Options:
  -h, --help show help for close
`,
  cancel: `tq cancel - cancel a task

Usage:
  tq cancel <id>

Options:
  -h, --help show help for cancel
`,
  git: `tq git - run git in tasks repo

Usage:
  tq git <args...>

Examples:
  tq git status
  tq git log --oneline

Options:
  -h, --help show help for git
`,
  help: `tq help - show help for a command

Usage:
  tq help [command]

Examples:
  tq help
  tq help list
  tq list --help
`,
};

function addFlag(
  flags: Record<string, FlagBucket>,
  name: string,
  value: FlagValue,
) {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  flags[name] = [existing, value];
}

function readFlagValue(bucket: FlagBucket | undefined) {
  if (bucket === undefined) {
    return undefined;
  }
  if (Array.isArray(bucket)) {
    return bucket[bucket.length - 1];
  }
  return bucket;
}

type ParseStringFlagOptions = {
  allowEmpty?: boolean;
  allowUndefined?: boolean;
  trim?: boolean;
};

function parseStringFlag(
  raw: FlagValue | undefined,
  label: string,
  options: ParseStringFlagOptions & { allowUndefined: true },
): string | undefined;
function parseStringFlag(
  raw: FlagValue | undefined,
  label: string,
  options?: ParseStringFlagOptions,
): string;
function parseStringFlag(
  raw: FlagValue | undefined,
  label: string,
  options: ParseStringFlagOptions = {},
) {
  if (raw === undefined) {
    if (options.allowUndefined) {
      return undefined;
    }
    throw new Error(`${label} requires a value.`);
  }
  if (raw === true) {
    throw new Error(`${label} requires a value.`);
  }
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const value = options.trim === false ? raw : raw.trim();
  if (!options.allowEmpty && !value) {
    throw new Error(`${label} cannot be empty.`);
  }
  return value;
}

function parseFlagPriority(raw: FlagValue | undefined) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    throw new Error("Priority requires a value.");
  }
  return normalizePriority(raw);
}

function parseFlagBoolean(raw: FlagBucket | undefined, label: string) {
  if (raw === undefined) {
    return false;
  }
  if (Array.isArray(raw)) {
    if (raw.some((value) => value !== true)) {
      throw new Error(`${label} does not take a value.`);
    }
    return true;
  }
  if (raw === true) {
    return true;
  }
  throw new Error(`${label} does not take a value.`);
}

function collectFlagValues(bucket: FlagBucket | undefined) {
  if (bucket === undefined) {
    return [];
  }
  return Array.isArray(bucket) ? bucket : [bucket];
}

function parseFilterTimestamp(raw: FlagValue, label: string) {
  const value = parseStringFlag(raw, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid ISO 8601 timestamp.`);
  }
  return parsed.toISOString();
}

function normalizeTimestampFilterValues(values: string[]) {
  return values.map((value) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Timestamp filters must be valid ISO 8601 strings.");
    }
    return parsed.toISOString();
  });
}

function parseFilterPriority(raw: FlagValue) {
  const priority = parseFlagPriority(raw);
  if (priority === undefined) {
    throw new Error("Priority requires a value.");
  }
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Error("Priority must be an integer from 0 to 4.");
  }
  return priority;
}

function parseLongFlag(token: string, next: string | undefined) {
  const eqIndex = token.indexOf("=");
  const name = token.slice(2, eqIndex === -1 ? undefined : eqIndex);
  if (!name) {
    throw new Error(`Invalid flag: "${token}"`);
  }
  if (eqIndex !== -1) {
    return {
      name,
      value: token.slice(eqIndex + 1),
      consumedNext: false,
    };
  }
  if (next && !next.startsWith("-")) {
    return { name, value: next, consumedNext: true };
  }
  return { name, value: true, consumedNext: false };
}

function parseShortFlag(token: string, next: string | undefined) {
  const body = token.slice(1);
  if (!body) {
    throw new Error('Invalid flag: "-"');
  }
  if (body.includes("=")) {
    const [name, value] = body.split("=");
    if (!name) {
      throw new Error(`Invalid flag: "${token}"`);
    }
    return {
      names: [name],
      value: value ?? "",
      consumedNext: false,
      multi: false,
    };
  }
  if (body.length === 1) {
    if (next && !next.startsWith("-")) {
      return { names: [body], value: next, consumedNext: true, multi: false };
    }
    return { names: [body], value: true, consumedNext: false, multi: false };
  }
  return { names: [...body], value: true, consumedNext: false, multi: true };
}

export function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, FlagBucket> = {};
  const positionals: string[] = [];
  let command: string | null = null;
  let i = 0;

  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }

    if (command === "git") {
      positionals.push(token, ...args.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const parsed = parseLongFlag(token, args[i + 1]);
      if (parsed.name) {
        addFlag(flags, parsed.name, parsed.value);
      }
      if (parsed.consumedNext) {
        i += 1;
      }
      i += 1;
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const parsed = parseShortFlag(token, args[i + 1]);
      if (parsed.multi) {
        for (const name of parsed.names) {
          addFlag(flags, name, true);
        }
      } else {
        addFlag(flags, parsed.names[0] ?? "", parsed.value);
      }
      if (parsed.consumedNext) {
        i += 1;
      }
      i += 1;
      continue;
    }

    if (!command) {
      command = token;
    } else {
      positionals.push(token);
    }
    i += 1;
  }

  return { command, flags, positionals };
}

function isHelpRequest(
  command: string | null,
  flags: Record<string, FlagBucket>,
) {
  return command === "help" || flags.help === true || flags.h === true;
}

function isVersionRequest(flags: Record<string, FlagBucket>) {
  const bucket = flags.version ?? flags.v;
  if (bucket === undefined) {
    return false;
  }
  return parseFlagBoolean(bucket, "Version");
}

function resolveHelpTopic(parsed: ParsedArgs) {
  if (parsed.command === "help") {
    return parsed.positionals[0]?.trim() ?? "";
  }
  if (parsed.flags.help === true || parsed.flags.h === true) {
    return parsed.command ?? "";
  }
  return "";
}

function fail(message: string, includeHelp: boolean) {
  console.error(`Error: ${message}`);
  if (includeHelp) {
    console.error("");
    console.error(helpText.trimEnd());
  }
  return 1;
}

function parseInitMode(flags: Record<string, FlagBucket>): WorkspaceMode {
  if (flags.mode !== undefined || flags.m !== undefined) {
    throw new Error('Init no longer supports --mode. Use "tq init --stealth" for stealth storage.');
  }
  const stealth = parseFlagBoolean(flags.stealth, "Stealth");
  return stealth ? "stealth" : "local";
}

async function handleInitCommand(parsed: ParsedArgs) {
  if (parsed.positionals.length > 0) {
    return fail("init does not accept positional arguments.", true);
  }
  let mode: WorkspaceMode;
  try {
    mode = parseInitMode(parsed.flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }
  try {
    const resolved = await initWorkspace({ mode });
    const modeLabel = resolved.mode === "stealth" ? "stealth " : "";
    console.log(
      `Initialized ${modeLabel}workspace with tasks at ${resolved.tasksDir}.`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

function parseStatusValue(raw: string | undefined): TaskStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("Status cannot be empty.");
  }
  if (!taskStatusSet.has(normalized as TaskStatus)) {
    throw new Error(`Status "${raw}" is not supported.`);
  }
  return normalized as TaskStatus;
}

function parseCreateFlags(parsed: ParsedArgs) {
  const blockedFlags = [
    "created_at",
    "created_by",
    "created-by",
    "claimed_at",
    "claimed-at",
    "updated_at",
    "claimed_by",
    "name",
    "n",
  ];
  for (const flag of blockedFlags) {
    if (flag in parsed.flags) {
      if (flag === "name" || flag === "n") {
        throw new Error("create requires a positional name; --name is not supported.");
      }
      throw new Error(`Flag "${flag}" is not allowed for create.`);
    }
  }
  const positionalName = parsed.positionals.join(" ").trim();
  if (!positionalName) {
    throw new Error("Name is required for create.");
  }
  const description = parseStringFlag(
    readFlagValue(parsed.flags.description ?? parsed.flags.d),
    "Description",
    { allowUndefined: true, allowEmpty: true, trim: false },
  );
  const statusRaw = parseStringFlag(
    readFlagValue(parsed.flags.status ?? parsed.flags.s),
    "Status",
    { allowUndefined: true, allowEmpty: true, trim: false },
  );
  const priority = parseFlagPriority(
    readFlagValue(parsed.flags.priority ?? parsed.flags.p),
  );

  return {
    name: positionalName,
    description,
    status: parseStatusValue(statusRaw),
    priority,
  };
}

async function handleCreateCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseCreateFlags>;
  try {
    input = parseCreateFlags(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const created = await createTask({
      tasksDir: resolved.tasksDir,
      name: input.name,
      description: input.description,
      status: input.status,
      priority: input.priority,
    });
    console.log(created.id);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

function parseUpdateFlags(parsed: ParsedArgs) {
  if (parsed.positionals.length === 0) {
    throw new Error("update requires a task id.");
  }
  if (parsed.positionals.length > 1) {
    throw new Error("update accepts only one task id.");
  }
  const blockedFlags = [
    "created_at",
    "created_by",
    "created-by",
    "claimed_at",
    "claimed-at",
    "updated_at",
    "claimed_by",
  ];
  for (const flag of blockedFlags) {
    if (flag in parsed.flags) {
      throw new Error(`Flag "${flag}" is not allowed for update.`);
    }
  }

  const name = parseStringFlag(
    readFlagValue(parsed.flags.name ?? parsed.flags.n),
    "Name",
    { allowUndefined: true, allowEmpty: true, trim: false },
  );
  const description = parseStringFlag(
    readFlagValue(parsed.flags.description ?? parsed.flags.d),
    "Description",
    { allowUndefined: true, allowEmpty: true, trim: false },
  );
  const statusRaw = parseStringFlag(
    readFlagValue(parsed.flags.status ?? parsed.flags.s),
    "Status",
    { allowUndefined: true, allowEmpty: true, trim: false },
  );
  const priority = parseFlagPriority(
    readFlagValue(parsed.flags.priority ?? parsed.flags.p),
  );

  if (
    name === undefined &&
    description === undefined &&
    statusRaw === undefined &&
    priority === undefined
  ) {
    throw new Error("update requires at least one field to change.");
  }

  return {
    id: parsed.positionals[0] ?? "",
    name,
    description,
    status: parseStatusValue(statusRaw),
    priority,
  };
}

async function handleUpdateCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseUpdateFlags>;
  try {
    input = parseUpdateFlags(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const updated = await updateTask({
      tasksDir: resolved.tasksDir,
      id: input.id,
      name: input.name,
      description: input.description,
      status: input.status,
      priority: input.priority,
    });
    console.log(updated.id);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

function parseListFlags(parsed: ParsedArgs) {
  if (parsed.positionals.length > 0) {
    throw new Error("list does not accept positional arguments.");
  }
  const nameValues = collectFlagValues(parsed.flags.n ?? parsed.flags.name);
  const statusValues = collectFlagValues(parsed.flags.s ?? parsed.flags.status);
  const priorityValues = collectFlagValues(
    parsed.flags.p ?? parsed.flags.priority,
  );
  const claimedValues = collectFlagValues(
    parsed.flags.c ?? parsed.flags["claimed-by"] ?? parsed.flags.claimed_by,
  );
  const createdValues = collectFlagValues(
    parsed.flags.C ?? parsed.flags.created,
  );
  const updatedValues = collectFlagValues(
    parsed.flags.U ?? parsed.flags.updated,
  );
  const json = parseFlagBoolean(parsed.flags.json, "JSON output");
  const all = parseFlagBoolean(parsed.flags.all, "All statuses");
  const mine = parseFlagBoolean(parsed.flags.mine, "Mine");

  const names = nameValues.map((value) => parseStringFlag(value, "Name"));
  const statuses = statusValues.map((value) =>
    parseStatusValue(parseStringFlag(value, "Status")),
  );
  const priorities = priorityValues.map((value) => parseFilterPriority(value));
  const claimedBy = claimedValues.map((value) =>
    parseStringFlag(value, "Claimed by", { allowEmpty: true }),
  );
  const createdAt = createdValues.map((value) =>
    parseFilterTimestamp(value, "Created at"),
  );
  const updatedAt = updatedValues.map((value) =>
    parseFilterTimestamp(value, "Updated at"),
  );
  const createdBy: string[] = [];

  return {
    json,
    all,
    mine,
    filters: {
      names,
      statuses: statuses.filter(
        (value): value is TaskStatus => value !== undefined,
      ),
      priorities,
      createdBy,
      claimedBy,
      createdAt,
      updatedAt,
    },
  };
}

function hasNonStatusFilters(filters: TaskListFilters) {
  return (
    filters.names.length > 0 ||
    filters.priorities.length > 0 ||
    filters.createdBy.length > 0 ||
    filters.claimedBy.length > 0 ||
    filters.createdAt.length > 0 ||
    filters.updatedAt.length > 0
  );
}

function formatEmptyListMessage(input: ReturnType<typeof parseListFlags>) {
  const statuses = input.filters.statuses;
  const defaultOpen = statuses.length === 0 && !input.all;
  const onlyOpen = statuses.length === 1 && statuses[0] === "open";
  const hasExtraFilters = hasNonStatusFilters(input.filters);
  if (!hasExtraFilters && (defaultOpen || onlyOpen)) {
    return "No open tasks.";
  }
  if (hasExtraFilters) {
    return "No tasks match the provided filters.";
  }
  return "No tasks found.";
}

async function handleListCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseListFlags>;
  try {
    input = parseListFlags(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const filters = input.mine
      ? {
          ...input.filters,
          createdBy: [resolveMachineName(await loadConfig(), process.env)],
        }
      : input.filters;
    const tasks = await listTasks({
      tasksDir: resolved.tasksDir,
      filters,
      includeAllStatuses: input.all,
    });
    const entries = tasks.map(toTaskListEntry);
    if (input.json) {
      console.log(formatTaskListJson(entries).trimEnd());
    } else if (entries.length > 0) {
      console.log(entries.map(formatTaskSummary).join("\n"));
    } else {
      console.log(formatEmptyListMessage({ ...input, filters }));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

function parseShowFlags(parsed: ParsedArgs) {
  if (parsed.positionals.length === 0) {
    throw new Error("show requires a task id.");
  }
  if (parsed.positionals.length > 1) {
    throw new Error("show accepts only one task id.");
  }
  const json = parseFlagBoolean(parsed.flags.json, "JSON output");
  return {
    id: parsed.positionals[0] ?? "",
    json,
  };
}

function parseSingleIdCommand(parsed: ParsedArgs, label: string) {
  if (parsed.positionals.length === 0) {
    throw new Error(`${label} requires a task id.`);
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`${label} accepts only one task id.`);
  }
  return {
    id: parsed.positionals[0] ?? "",
  };
}

function parseEditorCommand(value: string) {
  const input = value.trim();
  if (!input) {
    throw new Error("EDITOR is not set.");
  }
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (quote) {
    throw new Error("EDITOR contains an unterminated quote.");
  }
  if (current) {
    args.push(current);
  }
  if (args.length === 0) {
    throw new Error("EDITOR is not set.");
  }
  return args;
}

async function handleShowCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseShowFlags>;
  try {
    input = parseShowFlags(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const entry = await showTask({
      tasksDir: resolved.tasksDir,
      id: input.id,
    });
    if (input.json) {
      console.log(formatTaskShowJson(entry).trimEnd());
    } else {
      console.log(formatTaskDetails(entry));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

async function handleEditCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseSingleIdCommand>;
  try {
    input = parseSingleIdCommand(parsed, "edit");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  if (!(await isDirectory(resolved.tasksDir))) {
    return fail(
      `Tasks directory not initialized at ${resolved.tasksDir}. Run "tq init" first.`,
      false,
    );
  }

  let taskPath: string;
  try {
    taskPath = await resolveTaskPath(resolved.tasksDir, input.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  let editorArgs: string[];
  try {
    editorArgs = parseEditorCommand(process.env.EDITOR ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const processResult = Bun.spawn([...editorArgs, taskPath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await processResult.exited;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

async function handleWhereCommand(parsed: ParsedArgs) {
  if (parsed.positionals.length > 0) {
    return fail("where does not accept positional arguments.", true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  if (!(await isDirectory(resolved.tasksDir))) {
    return fail(
      `Tasks directory not initialized at ${resolved.tasksDir}. Run "tq init" first.`,
      false,
    );
  }

  console.log(resolved.tasksDir);
  return 0;
}

async function handleClaimCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseSingleIdCommand>;
  try {
    input = parseSingleIdCommand(parsed, "claim");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const claimed = await claimTask({
      tasksDir: resolved.tasksDir,
      id: input.id,
    });
    console.log(claimed.id);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

async function handleCloseCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseSingleIdCommand>;
  try {
    input = parseSingleIdCommand(parsed, "close");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const closed = await closeTask({
      tasksDir: resolved.tasksDir,
      id: input.id,
    });
    console.log(closed.id);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

async function handleCancelCommand(parsed: ParsedArgs) {
  let input: ReturnType<typeof parseSingleIdCommand>;
  try {
    input = parseSingleIdCommand(parsed, "cancel");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  try {
    const cancelled = await cancelTask({
      tasksDir: resolved.tasksDir,
      id: input.id,
    });
    console.log(cancelled.id);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

async function handleGitCommand(parsed: ParsedArgs) {
  if (parsed.positionals.length === 0) {
    return fail("git requires a command to run.", true);
  }

  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveTasksDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }

  if (!(await isDirectory(resolved.tasksDir))) {
    return fail(
      `Tasks directory not initialized at ${resolved.tasksDir}. Run "tq init" first.`,
      false,
    );
  }

  const gitCheck = await runGitCommand(
    resolved.tasksDir,
    ["rev-parse", "--git-dir"],
    {
      allowFailure: true,
    },
  );
  if (gitCheck.exitCode !== 0) {
    return fail(
      `Tasks directory at ${resolved.tasksDir} is not a git repository. Run "tq init" first.`,
      false,
    );
  }

  try {
    const result = await runGitCommandPassthrough(
      resolved.tasksDir,
      parsed.positionals,
    );
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

async function routeCommand(parsed: ParsedArgs) {
  if (isVersionRequest(parsed.flags)) {
    console.log(buildVersion);
    return 0;
  }
  if (isHelpRequest(parsed.command, parsed.flags)) {
    const topic = resolveHelpTopic(parsed);
    if (topic) {
      const commandHelp = helpByCommand[topic];
      if (!commandHelp) {
        return fail(`Unknown help topic "${topic}".`, true);
      }
      console.log(commandHelp.trimEnd());
      return 0;
    }
    console.log(helpText.trimEnd());
    return 0;
  }
  if (!parsed.command) {
    console.log(helpText.trimEnd());
    return 0;
  }
  if (!knownCommands.has(parsed.command)) {
    return fail(`Unknown command "${parsed.command}".`, true);
  }
  if (parsed.command === "init") {
    return handleInitCommand(parsed);
  }
  if (parsed.command === "create") {
    return handleCreateCommand(parsed);
  }
  if (parsed.command === "update") {
    return handleUpdateCommand(parsed);
  }
  if (parsed.command === "list") {
    return handleListCommand(parsed);
  }
  if (parsed.command === "show") {
    return handleShowCommand(parsed);
  }
  if (parsed.command === "edit") {
    return handleEditCommand(parsed);
  }
  if (parsed.command === "where") {
    return handleWhereCommand(parsed);
  }
  if (parsed.command === "claim") {
    return handleClaimCommand(parsed);
  }
  if (parsed.command === "close") {
    return handleCloseCommand(parsed);
  }
  if (parsed.command === "cancel") {
    return handleCancelCommand(parsed);
  }
  if (parsed.command === "git") {
    return handleGitCommand(parsed);
  }
  return fail(`Command "${parsed.command}" not implemented yet.`, false);
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    return await routeCommand(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }
}

if (import.meta.main) {
  runCli().then((exitCode) => {
    process.exit(exitCode);
  });
}
