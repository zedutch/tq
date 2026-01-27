import { mkdir, rename } from "node:fs/promises";
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

export async function loadConfig() {
  assertSupportedPlatform();
  const configPath = resolveConfigPath();
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

export async function saveConfig(config: TqConfig) {
  assertSupportedPlatform();
  const configPath = resolveConfigPath();
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

function routeCommand(parsed: ParsedArgs) {
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
  return fail(`Command "${parsed.command}" not implemented yet.`, false);
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv);
    return routeCommand(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, true);
  }
}

if (import.meta.main) {
  const exitCode = runCli();
  process.exit(exitCode);
}
