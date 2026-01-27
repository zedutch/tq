# tq

To install dependencies:

```bash
bun install
```

To run the CLI:

```bash
bun run index.ts -- --help
```

The CLI entrypoint is `tq`, with subcommands like `init`, `list`, and `show`.

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

This project was created using `bun init` in bun v1.3.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
