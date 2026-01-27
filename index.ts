type FlagValue = string | boolean;
type FlagBucket = FlagValue | FlagValue[];

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

function addFlag(flags: Record<string, FlagBucket>, name: string, value: FlagValue) {
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
    throw new Error("Invalid flag: \"-\"");
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

function isHelpRequest(command: string | null, flags: Record<string, FlagBucket>) {
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
