/**
 * Just enough packfile reading to get tak's measurements out of a repository.
 *
 * The alternative was GitHub's tree and blob REST endpoints, which is far less
 * code but costs one request per note and only works on GitHub. This is one
 * request, returns everything, and speaks git's protocol rather than a forge's
 * API — the same reason ref detection lives in `git.ts`.
 *
 * Deltas are not optional: a real fetch of jdx/communique's notes ref returns
 * 21 objects of which 3 are `ref_delta`, so the resolver has to be here.
 *
 * `DecompressionStream` cannot be used. Pack objects are concatenated zlib
 * streams with no length prefix, and the Compression Streams API never reports
 * how much input it consumed, so there is no way to find where the next object
 * begins. pako exposes `strm.next_in`, which is exactly that number.
 */

import { Inflate } from "pako";

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

export interface GitObject {
  type: number;
  data: Uint8Array;
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Encode one pkt-line. */
function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

/**
 * Strip pkt-line framing and sideband multiplexing, returning the packfile.
 *
 * Band 1 is pack data, band 2 progress, band 3 a fatal error. Non-banded lines
 * are section headers (`shallow-info`, `packfile`) and are skipped.
 */
export function extractPack(raw: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let i = 0;

  while (i + 4 <= raw.length) {
    const len = parseInt(
      String.fromCharCode(raw[i], raw[i + 1], raw[i + 2], raw[i + 3]),
      16,
    );
    if (Number.isNaN(len)) break;
    if (len === 0 || len === 1) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > raw.length) break;

    const payload = raw.subarray(i + 4, i + len);
    i += len;

    if (payload[0] === 1) {
      const d = payload.subarray(1);
      chunks.push(d);
      total += d.length;
    } else if (payload[0] === 3) {
      throw new Error(
        `remote error: ${new TextDecoder().decode(payload.subarray(1)).trim()}`,
      );
    }
    // band 2 is progress, and unbanded lines are section headers.
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Inflate one zlib stream, returning the data and how many bytes it consumed. */
function inflateAt(data: Uint8Array, offset: number): {
  out: Uint8Array;
  consumed: number;
} {
  const inflator = new Inflate();
  inflator.push(data.subarray(offset));
  if (inflator.err) {
    throw new Error(`inflate failed at ${offset}: ${inflator.msg}`);
  }
  // `next_in` is where pako stopped reading — the only reliable way to locate
  // the following object in a stream of concatenated zlib blobs. It is marked
  // private in the typings but is load-bearing here.
  const { next_in: consumed } = (
    inflator as unknown as { strm: { next_in: number } }
  ).strm;
  return { out: inflator.result as Uint8Array, consumed };
}

/** Git's object id: sha1 of `"<type> <len>\0" + content`. */
async function objectId(type: number, data: Uint8Array): Promise<string> {
  const names = ["", "commit", "tree", "blob", "tag"];
  const header = new TextEncoder().encode(`${names[type]} ${data.length}\0`);
  const buf = new Uint8Array(header.length + data.length);
  buf.set(header);
  buf.set(data, header.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", buf)));
}

/** Read a git varint (7 bits per byte, MSB = continue). */
function varint(d: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  let b: number;
  do {
    b = d[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value, pos };
}

/**
 * Apply a git delta to its base.
 *
 * Instructions are either a copy from the base (high bit set, with a bitmask
 * selecting which offset and size bytes are present) or a literal insert whose
 * opcode *is* its length.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  ({ pos } = varint(delta, pos)); // source size, only useful as a check
  const { value: targetSize, pos: p2 } = varint(delta, pos);
  pos = p2;

  const out = new Uint8Array(targetSize);
  let outPos = 0;

  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[pos++];
      if (op & 0x02) copyOffset |= delta[pos++] << 8;
      if (op & 0x04) copyOffset |= delta[pos++] << 16;
      if (op & 0x08) copyOffset |= delta[pos++] << 24;
      if (op & 0x10) copySize |= delta[pos++];
      if (op & 0x20) copySize |= delta[pos++] << 8;
      if (op & 0x40) copySize |= delta[pos++] << 16;
      // A zero size means 0x10000, an encoding quirk that is easy to miss.
      if (copySize === 0) copySize = 0x10000;
      out.set(base.subarray(copyOffset, copyOffset + copySize), outPos);
      outPos += copySize;
    } else if (op !== 0) {
      out.set(delta.subarray(pos, pos + op), outPos);
      outPos += op;
      pos += op;
    } else {
      // Opcode 0 is reserved and not produced by git.
      throw new Error("invalid delta opcode 0");
    }
  }

  if (outPos !== targetSize) {
    throw new Error(`delta produced ${outPos} bytes, expected ${targetSize}`);
  }
  return out;
}

/**
 * Parse a packfile into objects keyed by git object id.
 *
 * Deltas may reference a base that appears later in the pack, so unresolved
 * ones are retried until a pass makes no progress.
 */
/**
 * Ceilings on what one repository may ask the Worker to do.
 *
 * Any public repo can point this at an arbitrarily large notes ref, and a
 * Worker that exceeds its CPU or memory budget is killed rather than degrading.
 * Refusing early turns that into the "detected, not read" state, which is a
 * page that still renders.
 */
const MAX_PACK_BYTES = 8 * 1024 * 1024;
const MAX_OBJECTS = 20_000;

export async function parsePack(pack: Uint8Array): Promise<Map<string, GitObject>> {
  if (String.fromCharCode(...pack.subarray(0, 4)) !== "PACK") {
    throw new Error("not a packfile");
  }
  if (pack.length > MAX_PACK_BYTES) {
    throw new Error(`packfile is ${pack.length} bytes, over the ${MAX_PACK_BYTES} limit`);
  }
  const view = new DataView(pack.buffer, pack.byteOffset);
  const count = view.getUint32(8);
  if (count > MAX_OBJECTS) {
    throw new Error(`packfile declares ${count} objects, over the ${MAX_OBJECTS} limit`);
  }

  const byId = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  type Pending = { offset: number; baseRef: string | number; delta: Uint8Array };
  const pending: Pending[] = [];

  let pos = 12;
  for (let n = 0; n < count; n++) {
    const objOffset = pos;

    let b = pack[pos++];
    const type = (b >> 4) & 7;
    let shift = 4;
    while (b & 0x80) {
      b = pack[pos++];
      shift += 7;
    }

    let baseRef: string | number | null = null;
    if (type === OBJ_OFS_DELTA) {
      // Negative offset relative to this object's start, in git's own encoding.
      b = pack[pos++];
      let off = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++];
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      baseRef = objOffset - off;
    } else if (type === OBJ_REF_DELTA) {
      baseRef = hex(pack.subarray(pos, pos + 20));
      pos += 20;
    }

    const { out, consumed } = inflateAt(pack, pos);
    pos += consumed;

    if (baseRef === null) {
      const obj: GitObject = { type, data: out };
      byOffset.set(objOffset, obj);
      byId.set(await objectId(type, out), obj);
    } else {
      pending.push({ offset: objOffset, baseRef, delta: out });
    }
  }

  // Resolve deltas, repeating while progress is being made.
  let remaining = pending;
  while (remaining.length) {
    const stuck: Pending[] = [];
    for (const p of remaining) {
      const base =
        typeof p.baseRef === "number"
          ? byOffset.get(p.baseRef)
          : byId.get(p.baseRef);
      if (!base) {
        stuck.push(p);
        continue;
      }
      const obj: GitObject = {
        type: base.type,
        data: applyDelta(base.data, p.delta),
      };
      byOffset.set(p.offset, obj);
      byId.set(await objectId(obj.type, obj.data), obj);
    }
    if (stuck.length === remaining.length) {
      throw new Error(`${stuck.length} delta(s) reference a missing base`);
    }
    remaining = stuck;
  }

  return byId;
}

/** One entry of a git tree. */
export interface TreeEntry {
  name: string;
  id: string;
}

/** Parse a tree object: repeated `<mode> <name>\0<20-byte id>`. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const dec = new TextDecoder();
  let pos = 0;

  // Every scan is bounded. Tree bytes come off the network, and an unterminated
  // entry would otherwise spin these loops past the end of the buffer forever,
  // hanging the request rather than failing it.
  while (pos < data.length) {
    let sp = pos;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    if (sp >= data.length) break;

    let nul = sp + 1;
    while (nul < data.length && data[nul] !== 0) nul++;
    if (nul + 20 >= data.length) break;

    entries.push({
      name: dec.decode(data.subarray(sp + 1, nul)),
      id: hex(data.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

/** The tree id a commit object points at. */
export function commitTree(data: Uint8Array): string {
  const first = new TextDecoder().decode(data.subarray(0, 46));
  const m = first.match(/^tree ([0-9a-f]{40})/);
  if (!m) throw new Error("commit has no tree");
  return m[1];
}

/**
 * Walk a notes tree into commit id -> note body.
 *
 * Notes trees fan out into subdirectories once they get large (`ab/cdef...`),
 * so path segments are joined back together to recover the commit id.
 */
export function readNotesTree(
  objects: Map<string, GitObject>,
  treeId: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const dec = new TextDecoder();

  const walk = (id: string, prefix: string) => {
    const tree = objects.get(id);
    if (!tree || tree.type !== OBJ_TREE) return;
    for (const e of parseTree(tree.data)) {
      const child = objects.get(e.id);
      if (!child) continue;
      if (child.type === OBJ_TREE) {
        walk(e.id, prefix + e.name);
      } else if (child.type === OBJ_BLOB) {
        out.set(prefix + e.name, dec.decode(child.data));
      }
    }
  };

  walk(treeId, "");
  return out;
}

/**
 * Fetch every note under `notesSha` as commit id -> note body.
 *
 * `deepen 1` keeps this to the tip commit's own tree: the history of the notes
 * ref is not interesting, only its current state.
 */
export async function fetchNotes(
  cloneUrl: string,
  notesSha: string,
): Promise<Map<string, string>> {
  const body =
    pkt("command=fetch\n") +
    pkt("object-format=sha1\n") +
    "0001" +
    pkt("no-progress\n") +
    pkt(`want ${notesSha}\n`) +
    pkt("deepen 1\n") +
    pkt("done\n") +
    "0000";

  const res = await fetch(`${cloneUrl}/git-upload-pack`, {
    method: "POST",
    headers: {
      "git-protocol": "version=2",
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "user-agent": "usage.sh",
    },
    body,
    // Keyed on the notes sha by the caller, so this only refetches when the
    // ref actually moves.
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) throw new Error(`git-upload-pack returned ${res.status}`);

  // Checked before buffering: `arrayBuffer()` on an unbounded body is the one
  // step that can exhaust memory before any limit inside parsePack applies.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_PACK_BYTES) {
    throw new Error(`response is ${declared} bytes, over the ${MAX_PACK_BYTES} limit`);
  }

  const objects = await parsePack(
    extractPack(new Uint8Array(await res.arrayBuffer())),
  );
  const commit = objects.get(notesSha);
  if (!commit) throw new Error("notes commit missing from pack");
  return readNotesTree(objects, commitTree(commit.data));
}
