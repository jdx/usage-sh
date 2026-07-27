/**
 * Specs come from other people's repositories, so the parser has to survive
 * whatever is there. These cover the shapes real generators emit, plus the
 * ones that would silently produce a wrong command tree rather than an error.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  findCommand,
  parseSpec,
  visibleCommands,
  walkCommands,
} from "./spec.ts";

test("reads the document header", () => {
  const spec = parseSpec(`
name "My CLI"
bin "mycli"
about "does things"
version "1.2.3"
min_usage_version "4.0"
`)!;
  assert.equal(spec.name, "My CLI");
  assert.equal(spec.bin, "mycli");
  assert.equal(spec.about, "does things");
  assert.equal(spec.version, "1.2.3");
  assert.equal(spec.minUsageVersion, "4.0");
});

test("nests subcommands and records their path", () => {
  const spec = parseSpec(`
bin "mycli"
cmd "config" help="Manage config" {
  cmd "set" help="Set a value" {
    cmd "deep"
  }
}
`)!;
  const all = walkCommands(spec);
  assert.deepEqual(
    all.map((c) => c.path.join(" ")),
    ["config", "config set", "config set deep"],
  );
  assert.equal(findCommand(spec, ["config", "set"])?.help, "Set a value");
});

test("reads effect on commands, flags and args", () => {
  const spec = parseSpec(`
bin "x"
cmd "logs" effect="read" {
  flag "-c --clear" effect="destructive" help="Delete logs"
  flag "-t --tail" help="Follow"
  arg "[value]" effect="write"
}
`)!;
  const logs = findCommand(spec, ["logs"])!;
  assert.equal(logs.effect, "read");
  assert.equal(logs.flags.find((f) => f.name === "clear")?.effect, "destructive");
  // A flag with no effect must stay undefined rather than inheriting one.
  assert.equal(logs.flags.find((f) => f.name === "tail")?.effect, undefined);
  assert.equal(logs.args[0]?.effect, "write");
});

test("ignores an effect value it does not recognise", () => {
  // A spec written against a newer usage should degrade, not throw.
  const spec = parseSpec(`bin "x"\ncmd "y" effect="teleport"`)!;
  assert.equal(findCommand(spec, ["y"])?.effect, undefined);
});

test("splits a flag's short, long and value forms", () => {
  const spec = parseSpec(`
bin "x"
cmd "y" {
  flag "-o --out --output <file>" help="Where to write"
  flag "--bare"
}
`)!;
  const [out, bare] = findCommand(spec, ["y"])!.flags;
  assert.deepEqual(out.short, ["o"]);
  assert.deepEqual(out.long, ["out", "output"]);
  assert.equal(out.name, "out");
  assert.equal(out.arg?.name, "file");
  assert.equal(out.arg?.required, true);
  assert.equal(bare.arg, undefined);
});

test("prefers a child arg node over the inline token", () => {
  const spec = parseSpec(`
bin "x"
cmd "y" {
  flag "--shell <shell>" {
    arg "<shell>" {
      choices "bash" "zsh" "fish"
    }
  }
}
`)!;
  const flag = findCommand(spec, ["y"])!.flags[0];
  assert.deepEqual(flag.arg?.choices, ["bash", "zsh", "fish"]);
});

test("reads required and variadic from the arg token", () => {
  const spec = parseSpec(`
bin "x"
cmd "y" {
  arg "<needed>"
  arg "[optional]"
  arg "[rest]…"
}
`)!;
  const args = findCommand(spec, ["y"])!.args;
  assert.deepEqual(
    args.map((a) => [a.name, a.required, a.var]),
    [
      ["needed", true, false],
      ["optional", false, false],
      ["rest", false, true],
    ],
  );
});

test("an explicit required property beats the token form", () => {
  // mise emits `arg "[-- TASK_ARGS]…" required=#false var=#true`.
  const spec = parseSpec(`bin "x"\ncmd "y" {\n  arg "<thing>" required=#false\n}`)!;
  assert.equal(findCommand(spec, ["y"])!.args[0].required, false);
});

test("collects aliases and resolves a command through them", () => {
  const spec = parseSpec(`
bin "x"
cmd "remove" {
  alias "rm"
  alias "delete" hide=#true
}
`)!;
  const cmd = findCommand(spec, ["remove"])!;
  assert.deepEqual(cmd.aliases, ["rm", "delete"]);
  // A hidden alias is still a real way to invoke the command.
  assert.equal(findCommand(spec, ["rm"])?.name, "remove");
  assert.equal(findCommand(spec, ["delete"])?.name, "remove");
});

test("reads hide and global", () => {
  const spec = parseSpec(`
bin "x"
cmd "internal" hide=#true {
  flag "-v --verbose" global=#true
  flag "--secret" hide=#true
}
`)!;
  const cmd = findCommand(spec, ["internal"])!;
  assert.equal(cmd.hide, true);
  assert.equal(cmd.flags.find((f) => f.name === "verbose")?.global, true);
  assert.equal(cmd.flags.find((f) => f.name === "secret")?.hide, true);
});

test("unwraps a raw multi-line help block", () => {
  const spec = parseSpec(`
bin "x"
cmd "y" help="Short" {
  long_help #"""
Line one

Line two with "quotes" and a \\ backslash
"""#
}
`)!;
  const cmd = findCommand(spec, ["y"])!;
  assert.equal(cmd.help, "Short");
  assert.match(cmd.longHelp ?? "", /Line one/);
  assert.match(cmd.longHelp ?? "", /"quotes"/);
});

test("ignores node types it does not model", () => {
  // `complete`, `mount` and `example` are real spec nodes this does not need.
  const spec = parseSpec(`
bin "x"
complete "file" run="ls"
cmd "y" {
  mount run="x plugin usage-spec"
  example "x y --now" header="Do it"
  flag "--real"
}
`)!;
  const cmd = findCommand(spec, ["y"])!;
  assert.equal(cmd.flags.length, 1);
  assert.equal(cmd.flags[0].name, "real");
});

test("visibleCommands prunes hidden subtrees, not just hidden commands", () => {
  // clap does not propagate `hide` to subcommands, so a hidden parent with
  // visible children is normal — mise ships six of them. Filtering a flat walk
  // on `hide` would surface the child and the hidden path it sits under.
  const spec = parseSpec(`
bin "x"
cmd "shown" {
  cmd "child"
}
cmd "internal" hide=#true {
  cmd "apply"
  cmd "status"
}
`)!;
  assert.deepEqual(
    walkCommands(spec).map((c) => c.path.join(" ")),
    ["shown", "shown child", "internal", "internal apply", "internal status"],
  );
  assert.deepEqual(
    visibleCommands(spec).map((c) => c.path.join(" ")),
    ["shown", "shown child"],
  );
});

test("returns null for a document that is not KDL", () => {
  assert.equal(parseSpec("{ not kdl at all ["), null);
});

test("findCommand returns undefined for an unknown path", () => {
  const spec = parseSpec(`bin "x"\ncmd "y"`)!;
  assert.equal(findCommand(spec, ["nope"]), undefined);
  assert.equal(findCommand(spec, ["y", "nope"]), undefined);
});
