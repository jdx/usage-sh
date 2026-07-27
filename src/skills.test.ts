/**
 * SKILL.md files come from other people's repositories, so the reader has to
 * cope with the forms the spec allows and degrade on the ones it does not.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseSkill } from "./skills.ts";

test("reads the required fields", () => {
  const s = parseSkill(
    "pdf-processing",
    `---
name: pdf-processing
description: Extract PDF text and fill forms. Use when handling PDFs.
---

# PDF processing

Body text.
`,
  )!;
  assert.equal(s.dir, "pdf-processing");
  assert.equal(s.name, "pdf-processing");
  assert.match(s.description, /Extract PDF text/);
  assert.match(s.body, /^# PDF processing/);
});

test("reads the optional fields the spec defines", () => {
  const s = parseSkill(
    "x",
    `---
name: x
description: does a thing
license: Apache-2.0
compatibility: Requires git and jq
allowed-tools: Bash(git:*) Read
---
body
`,
  )!;
  assert.equal(s.license, "Apache-2.0");
  assert.equal(s.compatibility, "Requires git and jq");
  assert.equal(s.allowedTools, "Bash(git:*) Read");
});

test("handles quoted values", () => {
  const s = parseSkill(
    "x",
    `---
name: "x"
description: 'Uses: colons, and commas'
---
`,
  )!;
  assert.equal(s.name, "x");
  assert.equal(s.description, "Uses: colons, and commas");
});

test("handles a folded description", () => {
  const s = parseSkill(
    "x",
    `---
name: x
description: >
  One long sentence that the author
  wrapped over several lines.
---
`,
  )!;
  assert.equal(
    s.description,
    "One long sentence that the author wrapped over several lines.",
  );
});

test("handles a literal block, keeping its newlines", () => {
  const s = parseSkill(
    "x",
    `---
name: x
description: |
  line one
  line two
---
`,
  )!;
  assert.equal(s.description, "line one\nline two");
});

test("skips nested structures it does not model", () => {
  // `metadata` is an arbitrary map; its keys must not leak into the fields.
  const s = parseSkill(
    "x",
    `---
name: x
metadata:
  author: someone
  version: "1.0"
description: after the nested block
---
`,
  )!;
  assert.equal(s.description, "after the nested block");
  assert.equal(s.name, "x");
});

test("falls back to the directory name when name is absent", () => {
  const s = parseSkill("from-dir", `---\ndescription: d\n---\n`)!;
  assert.equal(s.name, "from-dir");
});

test("rejects a file with no description", () => {
  // The spec requires it, and without one there is nothing worth listing.
  assert.equal(parseSkill("x", `---\nname: x\n---\nbody`), null);
});

test("rejects a file with no frontmatter", () => {
  assert.equal(parseSkill("x", "# Just markdown\n"), null);
});

test("rejects an unterminated frontmatter block", () => {
  assert.equal(parseSkill("x", "---\nname: x\ndescription: d\n"), null);
});

test("tolerates CRLF line endings", () => {
  const s = parseSkill("x", "---\r\nname: x\r\ndescription: d\r\n---\r\nbody\r\n")!;
  assert.equal(s.description, "d");
  assert.equal(s.body, "body");
});
