import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type FlagValue = string | boolean;
type FlagBucket = FlagValue | FlagValue[];

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

export function resolveGlobalTasksBase(env: NodeJS.ProcessEnv = process.env) {
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

type WorkspaceMode = "local" | "global";

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
  updated_at: string;
  status: TaskStatus;
  claimed_by: string;
  priority: number;
};

const taskFieldOrder: Array<keyof TaskFrontmatter> = [
  "name",
  "created_at",
  "updated_at",
  "status",
  "claimed_by",
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

  const claimedBy = record.claimed_by;
  if (typeof claimedBy !== "string") {
    throw new Error("Invalid task: claimed_by must be a string.");
  }

  const priority = normalizePriority(record.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Error("Invalid task: priority must be an integer from 0 to 4.");
  }

  return {
    name: name.trim(),
    created_at: createdAt,
    updated_at: updatedAt,
    status: status as TaskStatus,
    claimed_by: claimedBy,
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
      `Workspace not registered for global mode: ${resolvedWorkspacePath}. Run "tq init --mode global" first.`,
    );
  }

  return {
    mode: "global",
    workspacePath: resolvedWorkspacePath,
    tasksDir: path.join(resolveGlobalTasksBase(env), workspaceId),
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
      `Workspace already has a local .tasks directory at ${localTasksDir}. Remove it or run "tq init" without --mode global.`,
    );
  }

  const config = await loadConfig(env);
  let workspaceId = config.workspaces[workspacePath];
  const baseDir = resolveGlobalTasksBase(env);
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
    mode: "global",
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

  if (!options.skipGit) {
    await prepareTasksRepository(options.tasksDir, env);
    const staged = await runGitCommand(
      options.tasksDir,
      ["diff", "--cached", "--name-only"],
      { env },
    );
    if (staged.stdout.trim()) {
      throw new Error(
        "Tasks repository has staged changes. Commit or unstage them before creating a task.",
      );
    }
  }

  const existingIds = await listTaskIds(options.tasksDir);
  const id = generateTaskId(existingIds);
  const timestamp = (options.now ?? new Date()).toISOString();
  const frontmatter = normalizeTaskFrontmatter({
    name,
    created_at: timestamp,
    updated_at: timestamp,
    status: options.status ?? "open",
    claimed_by: "",
    priority: options.priority ?? 2,
  });
  const description = options.description ?? "";
  const content = formatTaskMarkdown(frontmatter, description);
  const taskFileName = `${id}.md`;
  const taskPath = path.join(options.tasksDir, taskFileName);
  await Bun.write(taskPath, content);

  if (!options.skipGit) {
    await runGitCommand(options.tasksDir, ["add", "--", taskFileName], {
      env,
    });
    const staged = await runGitCommand(
      options.tasksDir,
      ["diff", "--cached", "--name-only"],
      { env },
    );
    if (!staged.stdout.trim()) {
      return { id, path: taskPath, frontmatter, description };
    }
    await runGitCommand(
      options.tasksDir,
      withGitCommitIdentity(["commit", "-m", `tq: create task ${id}`], env),
      { env },
    );
    await pushTasksRepository(options.tasksDir, env);
  }

  return { id, path: taskPath, frontmatter, description };
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
  "claim",
  "close",
  "cancel",
  "git",
  "help",
]);

const helpText = `tq - task queue CLI

Usage:
  tq <command> [options] [--] [args]

Commands:
  init      initialize a workspace
  create    create a task
  update    update a task
  list      list tasks
  show      show task details
  claim     claim a task
  close     close a task
  cancel    cancel a task
  git       run git in tasks repo
  help      show this help

Options:
  -h, --help  show help

Init options:
  --mode <local|global>  choose workspace mode (default: local)
  -m <local|global>      shorthand for --mode

Create options:
  --name <text>         task name (required)
  --description <text>  task description
  --status <status>     open, in_progress, done, cancelled
  --priority <0-4>      task priority (default: 2)
  -n <text>             shorthand for --name
  -d <text>             shorthand for --description
  -s <status>           shorthand for --status
  -p <0-4>              shorthand for --priority
`;

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

function parseFlagString(raw: FlagValue | undefined, label: string) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    throw new Error(`${label} requires a value.`);
  }
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return raw;
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

function parseLongFlag(token: string, next: string | undefined) {
  if (token === "--") {
    return { name: "", value: "", consumedNext: false };
  }
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

export function formatHelp() {
  return helpText;
}

function isHelpRequest(
  command: string | null,
  flags: Record<string, FlagBucket>,
) {
  return command === "help" || flags.help === true || flags.h === true;
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
  const raw = readFlagValue(flags.mode ?? flags.m);
  if (raw === undefined) {
    return "local";
  }
  if (raw === true) {
    throw new Error("Init mode requires a value: --mode local|global.");
  }
  if (typeof raw !== "string") {
    throw new Error("Init mode must be a string: local or global.");
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "local" || normalized === "global") {
    return normalized;
  }
  throw new Error(`Unsupported init mode "${raw}". Use local or global.`);
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
    console.log(
      `Initialized ${resolved.mode} workspace with tasks at ${resolved.tasksDir}.`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, false);
  }
}

function parseCreateStatus(raw: string | undefined): TaskStatus | undefined {
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
  if (parsed.positionals.length > 0) {
    throw new Error("create does not accept positional arguments.");
  }
  const blockedFlags = ["created_at", "updated_at", "claimed_by"];
  for (const flag of blockedFlags) {
    if (flag in parsed.flags) {
      throw new Error(`Flag "${flag}" is not allowed for create.`);
    }
  }

  const nameRaw = parseFlagString(
    readFlagValue(parsed.flags.name ?? parsed.flags.n),
    "Name",
  );
  if (!nameRaw || !nameRaw.trim()) {
    throw new Error("Name is required for create.");
  }
  const description = parseFlagString(
    readFlagValue(parsed.flags.description ?? parsed.flags.d),
    "Description",
  );
  const statusRaw = parseFlagString(
    readFlagValue(parsed.flags.status ?? parsed.flags.s),
    "Status",
  );
  const priority = parseFlagPriority(
    readFlagValue(parsed.flags.priority ?? parsed.flags.p),
  );

  return {
    name: nameRaw.trim(),
    description,
    status: parseCreateStatus(statusRaw),
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

async function routeCommand(parsed: ParsedArgs) {
  if (isHelpRequest(parsed.command, parsed.flags)) {
    console.log(helpText.trimEnd());
    return 0;
  }
  if (!parsed.command) {
    console.error(helpText.trimEnd());
    return 1;
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
