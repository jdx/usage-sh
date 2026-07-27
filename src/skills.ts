/**
 * Agent Skills published alongside a CLI.
 *
 * Follows the layout at https://agentskills.io/specification — a repo puts
 * `skills/<name>/SKILL.md` at its root, each file being YAML frontmatter and a
 * Markdown body. Detecting the convention that already exists means a repo
 * shipping skills for Claude Code, Cursor or Copilot gets a usage.sh page for
 * free, with no second path to publish to.
 *
 * usage.sh serves these; it does not rank, recommend or merge them. They are
 * someone else's prose, so provenance stays attached and the reader decides.
 */

/** The frontmatter fields the spec defines. `metadata` is deliberately not read. */
export interface Skill {
  /** Directory name, which the spec requires to match the `name` field. */
  dir: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Space-separated pre-approved tools. Experimental in the spec. */
  allowedTools?: string;
  /** Markdown after the frontmatter. */
  body: string;
}

/**
 * Read the frontmatter fields this needs.
 *
 * Not a YAML parser, and not trying to be: the spec's fields are all scalars,
 * so this handles plain, quoted, folded (`>`) and literal (`|`) values and
 * ignores everything else. A field it cannot read is dropped rather than
 * guessed at — the cost of that is a missing subtitle, where a general parser
 * would cost far more bundle than the four fields justify.
 */
function parseFrontmatter(src: string): {
  fields: Record<string, string>;
  body: string;
} {
  const normalised = src.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return { fields: {}, body: normalised };

  const end = normalised.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: normalised };

  const head = normalised.slice(4, end);
  const body = normalised.slice(end + 4).replace(/^\n/, "");

  const fields: Record<string, string> = {};
  const lines = head.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only top-level keys; anything indented belongs to a structure this
    // does not model (`metadata:`), and is skipped with its block.
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (value === "|" || value === ">" || /^[|>][-+]?$/.test(value)) {
      // Block scalar: take the indented lines that follow.
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) {
        block.push(lines[++i].replace(/^\s{1,4}/, ""));
      }
      value = folded
        ? block.join(" ").replace(/\s+/g, " ").trim()
        : block.join("\n").trimEnd();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
      if (line.includes('"')) value = value.replace(/\\"/g, '"');
    }

    value = value.trim();
    if (value) fields[key] = value;
  }

  return { fields, body };
}

/**
 * Build a Skill from one `SKILL.md`, or null when it is not usable.
 *
 * `name` and `description` are the spec's only required fields, and without a
 * description there is nothing worth listing, so both are required here too.
 */
export function parseSkill(dir: string, source: string): Skill | null {
  const { fields, body } = parseFrontmatter(source);
  const name = fields.name ?? dir;
  const description = fields.description;
  if (!description) return null;

  return {
    dir,
    name,
    description,
    license: fields.license,
    compatibility: fields.compatibility,
    allowedTools: fields["allowed-tools"],
    body: body.trim(),
  };
}
