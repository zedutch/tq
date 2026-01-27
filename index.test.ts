import { expect, test } from "bun:test";
import { formatHelp, parseArgs } from "./index.ts";

test("parseArgs handles command, flags, and positionals", () => {
  const parsed = parseArgs(["list", "-s", "open", "--json", "--", "--raw"]);

  expect(parsed.command).toBe("list");
  expect(parsed.flags.s).toBe("open");
  expect(parsed.flags.json).toBe(true);
  expect(parsed.positionals).toEqual(["--raw"]);
});

test("parseArgs supports combined short flags", () => {
  const parsed = parseArgs(["list", "-abc"]);

  expect(parsed.flags.a).toBe(true);
  expect(parsed.flags.b).toBe(true);
  expect(parsed.flags.c).toBe(true);
});

test("parseArgs throws on invalid long flag", () => {
  expect(() => parseArgs(["--=bad"])).toThrow();
});

test("formatHelp includes usage", () => {
  expect(formatHelp()).toContain("Usage:");
  expect(formatHelp()).toContain("tq <command>");
});
