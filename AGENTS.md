# About

`tq` is a Bun-based CLI for managing an agent-first task queue stored as Markdown files. It supports local mode
(a .tasks folder inside the workspace) and global mode (tasks stored under an XDG data directory with a per-workspace id),
with configuration in a TOML file under XDG config. Each task file uses frontmatter for metadata (name, timestamps,
status, claimed_by, priority) and the body as the description. The CLI supports creating, listing, showing, updating,
claiming, closing, and cancelling tasks; list/show can emit concise text or JSON for automation. Task changes are tracked
in a git repo inside the tasks directory, with optional pull/push to a remote, and a tq git <command> passthrough for
repo management.

Work in a single index.ts file, do not create additional files except for testing.

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Tasks

Use `tq` itself for task tracking.
Claim a task before starting to work on it using `tq claim <task-id>`
Close the task once you're done working using `tq close <task-id>`
Sometimes it might be necessary to edit or read the raw task file, you can find those in the `./.tasks` folder in this repo.

### Essential `tq` commands

```bash
# Create a new task
tq create "Add user authentication" --description="<description about what needs to be done and why>"

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

# Update task
tq update <issue-id> --status in_progress
tq update <issue-id> --p 1
```

<!-- ## Frontend -->
<!---->
<!-- Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind. -->
<!---->
<!-- Server: -->
<!---->
<!-- ```ts#index.ts -->
<!-- import index from "./index.html" -->
<!---->
<!-- Bun.serve({ -->
<!--   routes: { -->
<!--     "/": index, -->
<!--     "/api/users/:id": { -->
<!--       GET: (req) => { -->
<!--         return new Response(JSON.stringify({ id: req.params.id })); -->
<!--       }, -->
<!--     }, -->
<!--   }, -->
<!--   // optional websocket support -->
<!--   websocket: { -->
<!--     open: (ws) => { -->
<!--       ws.send("Hello, world!"); -->
<!--     }, -->
<!--     message: (ws, message) => { -->
<!--       ws.send(message); -->
<!--     }, -->
<!--     close: (ws) => { -->
<!--       // handle close -->
<!--     } -->
<!--   }, -->
<!--   development: { -->
<!--     hmr: true, -->
<!--     console: true, -->
<!--   } -->
<!-- }) -->
<!-- ``` -->
<!---->
<!-- HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle. -->
<!---->
<!-- ```html#index.html -->
<!-- <html> -->
<!--   <body> -->
<!--     <h1>Hello, world!</h1> -->
<!--     <script type="module" src="./frontend.tsx"></script> -->
<!--   </body> -->
<!-- </html> -->
<!-- ``` -->
<!---->
<!-- With the following `frontend.tsx`: -->
<!---->
<!-- ```tsx#frontend.tsx -->
<!-- import React from "react"; -->
<!-- import { createRoot } from "react-dom/client"; -->
<!---->
<!-- // import .css files directly and it works -->
<!-- import './index.css'; -->
<!---->
<!-- const root = createRoot(document.body); -->
<!---->
<!-- export default function Frontend() { -->
<!--   return <h1>Hello, world!</h1>; -->
<!-- } -->
<!---->
<!-- root.render(<Frontend />); -->
<!-- ``` -->
<!---->
<!-- Then, run index.ts -->
<!---->
<!-- ```sh -->
<!-- bun --hot ./index.ts -->
<!-- ``` -->

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
