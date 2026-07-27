/**
 * Turn a `*.usage.kdl` document into a command tree.
 *
 * The spec is machine-generated (usage-lib, or one of its framework
 * integrations), so this reads the shape those emit rather than trying to be a
 * general KDL interpreter: unknown nodes and properties are ignored instead of
 * raising, because a spec written against a newer usage than this parser knows
 * about should still render everything it does understand.
 *
 * Spec reference: https://usage.jdx.dev/spec/
 */

import { parse, type Document, type Node } from "@bgotink/kdl";

/** What running a command does to the world. `usage` >= 3.6. */
export type Effect = "read" | "write" | "destructive";

export interface SpecArg {
  name: string;
  required: boolean;
  var: boolean;
  help?: string;
  /** Raises the command's effect when supplied. `usage` >= 4.0. */
  effect?: Effect;
  choices?: string[];
}

export interface SpecFlag {
  name: string;
  /** Short forms without the dash: `["v"]` for `-v`. */
  short: string[];
  /** Long forms without the dashes: `["verbose"]` for `--verbose`. */
  long: string[];
  help?: string;
  effect?: Effect;
  hide: boolean;
  global: boolean;
  /** Present when the flag takes a value. */
  arg?: SpecArg;
}

export interface SpecCommand {
  /** Path from the root, e.g. `["bootstrap", "packages", "apply"]`. */
  path: string[];
  name: string;
  help?: string;
  /** Long help, with the raw string block already unwrapped by the parser. */
  longHelp?: string;
  aliases: string[];
  hide: boolean;
  effect?: Effect;
  args: SpecArg[];
  flags: SpecFlag[];
  subcommands: SpecCommand[];
}

export interface Spec {
  name?: string;
  bin?: string;
  about?: string;
  version?: string;
  /** Minimum `usage` version the spec declares, if any. */
  minUsageVersion?: string;
  /** Root-level flags and args, which apply to every subcommand. */
  flags: SpecFlag[];
  args: SpecArg[];
  commands: SpecCommand[];
}

const EFFECTS = new Set<Effect>(["read", "write", "destructive"]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean {
  // KDL v2 writes `#true`; older specs and some generators write the string.
  return v === true || v === "true" || v === "#true";
}

function effectOf(node: Node): Effect | undefined {
  const raw = asString(node.getProperty("effect"));
  return raw && EFFECTS.has(raw as Effect) ? (raw as Effect) : undefined;
}

/** First positional argument of a node, which is how usage names things. */
function firstArg(node: Node): string | undefined {
  const v = node.getArgument(0);
  return typeof v === "string" ? v : v == null ? undefined : String(v);
}

function children(node: Node, name: string): Node[] {
  return (node.children?.nodes ?? []).filter((n) => n.name.name === name);
}

/** `help "text"` as a child node, which usage uses for anything multi-line. */
function childText(node: Node, name: string): string | undefined {
  const n = children(node, name)[0];
  return n ? asString(n.getArgument(0)) : undefined;
}

/**
 * usage writes arg names with their required-ness baked into the token:
 * `<name>` required, `[name]` optional, and a trailing `…`/`...` for variadic.
 */
function parseArgToken(token: string): {
  name: string;
  required: boolean;
  var: boolean;
} {
  let t = token.trim();
  let isVar = false;
  if (t.endsWith("…")) {
    isVar = true;
    t = t.slice(0, -1);
  } else if (t.endsWith("...")) {
    isVar = true;
    t = t.slice(0, -3);
  }
  let required = false;
  if (t.startsWith("<") && t.endsWith(">")) {
    required = true;
    t = t.slice(1, -1);
  } else if (t.startsWith("[") && t.endsWith("]")) {
    t = t.slice(1, -1);
  }
  return { name: t.trim(), required, var: isVar };
}

function parseArg(node: Node): SpecArg | null {
  const token = firstArg(node);
  if (!token) return null;
  const { name, required, var: isVar } = parseArgToken(token);

  const choicesNode = children(node, "choices")[0];
  const choices = choicesNode
    ? choicesNode.getArguments().map((v) => String(v))
    : undefined;

  return {
    name,
    // An explicit `required=#false` overrides the `<>` form.
    required: node.hasProperty("required")
      ? asBool(node.getProperty("required"))
      : required,
    var: node.hasProperty("var") ? asBool(node.getProperty("var")) : isVar,
    help: asString(node.getProperty("help")) ?? childText(node, "help"),
    effect: effectOf(node),
    choices: choices?.length ? choices : undefined,
  };
}

/**
 * usage packs a flag's forms into one token: `"-v --verbose <value>"`. The
 * value, when present, is an arg token and may also appear as a child `arg`.
 */
function parseFlag(node: Node): SpecFlag | null {
  const token = firstArg(node);
  if (!token) return null;

  const short: string[] = [];
  const long: string[] = [];
  let inlineArg: string | undefined;

  for (const part of token.split(/\s+/).filter(Boolean)) {
    if (part.startsWith("--")) long.push(part.slice(2));
    else if (part.startsWith("-") && part.length > 1) short.push(part.slice(1));
    else inlineArg = part;
  }

  const childArgNode = children(node, "arg")[0];
  const arg = childArgNode
    ? (parseArg(childArgNode) ?? undefined)
    : inlineArg
      ? { ...parseArgToken(inlineArg), effect: undefined }
      : undefined;

  return {
    // usage derives the name from the first long, falling back to the short.
    name: long[0] ?? short[0] ?? token,
    short,
    long,
    help: asString(node.getProperty("help")) ?? childText(node, "help"),
    effect: effectOf(node),
    hide: asBool(node.getProperty("hide")),
    global: asBool(node.getProperty("global")),
    arg,
  };
}

function parseCommand(node: Node, parents: string[]): SpecCommand | null {
  const name = firstArg(node);
  if (!name) return null;
  const path = [...parents, name];

  // `alias "rm" "delete"` — one node may carry several, and a hidden alias
  // (`alias "x" hide=#true`) is still a real way to invoke the command.
  const aliases = children(node, "alias").flatMap((n) =>
    n.getArguments().map((v) => String(v)),
  );

  return {
    path,
    name,
    help: asString(node.getProperty("help")) ?? childText(node, "help"),
    longHelp: childText(node, "long_help") ?? childText(node, "help_long"),
    aliases,
    hide: asBool(node.getProperty("hide")),
    effect: effectOf(node),
    args: children(node, "arg")
      .map(parseArg)
      .filter((a): a is SpecArg => a !== null),
    flags: children(node, "flag")
      .map(parseFlag)
      .filter((f): f is SpecFlag => f !== null),
    subcommands: children(node, "cmd")
      .map((n) => parseCommand(n, path))
      .filter((c): c is SpecCommand => c !== null),
  };
}

function topText(doc: Document, name: string): string | undefined {
  const n = doc.nodes.find((x) => x.name.name === name);
  return n ? asString(n.getArgument(0)) : undefined;
}

/**
 * Parse a usage spec. Returns null when the document cannot be parsed at all —
 * a malformed spec should leave the page without a command tree rather than
 * failing the whole request.
 */
export function parseSpec(source: string): Spec | null {
  let doc: Document;
  try {
    doc = parse(source);
  } catch {
    return null;
  }

  const nodes = doc.nodes;
  return {
    name: topText(doc, "name"),
    bin: topText(doc, "bin"),
    about: topText(doc, "about"),
    version: topText(doc, "version"),
    minUsageVersion: topText(doc, "min_usage_version"),
    flags: nodes
      .filter((n) => n.name.name === "flag")
      .map(parseFlag)
      .filter((f): f is SpecFlag => f !== null),
    args: nodes
      .filter((n) => n.name.name === "arg")
      .map(parseArg)
      .filter((a): a is SpecArg => a !== null),
    commands: nodes
      .filter((n) => n.name.name === "cmd")
      .map((n) => parseCommand(n, []))
      .filter((c): c is SpecCommand => c !== null),
  };
}

/** Depth-first walk of every command, including nested ones. */
export function walkCommands(spec: Spec): SpecCommand[] {
  const out: SpecCommand[] = [];
  const visit = (c: SpecCommand) => {
    out.push(c);
    c.subcommands.forEach(visit);
  };
  spec.commands.forEach(visit);
  return out;
}

/** Look up a command by its path, e.g. `["bootstrap", "packages"]`. */
export function findCommand(
  spec: Spec,
  path: string[],
): SpecCommand | undefined {
  let level = spec.commands;
  let found: SpecCommand | undefined;
  for (const segment of path) {
    found = level.find(
      (c) => c.name === segment || c.aliases.includes(segment),
    );
    if (!found) return undefined;
    level = found.subcommands;
  }
  return found;
}
