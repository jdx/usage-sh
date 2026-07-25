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

/**
 * Inflate one zlib stream, returning the data and how many bytes it consumed.
 *
 * Output is accumulated chunk by chunk and abandoned the moment it passes the
 * cap. Checking `inflator.result` afterwards is too late: by then pako has
 * already materialised the entire decompressed object, so a small pack holding
 * one enormously compressible blob would exhaust the Worker before any guard
 * ran.
 */
function inflateAt(data: Uint8Array, offset: number): {
  out: Uint8Array;
  consumed: number;
} {
  const inflator = new Inflate();

  const parts: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  inflator.onData = (chunk: Uint8Array) => {
    size += chunk.length;
    if (size > MAX_OBJECT_BYTES) {
      overflowed = true;
      parts.length = 0;
      return;
    }
    parts.push(chunk);
  };

  // Input is fed in slices rather than in one call. `push` inflates everything
  // it is given before returning, so handing it the whole remainder would
  // decompress a zip-bomb in full — dropping the output in `onData` bounds
  // memory but not the CPU spent producing it. Feeding slices lets the overflow
  // check run between them and abandon the rest of the stream.
  const input = data.subarray(offset);
  let consumed = 0;
  for (let at = 0; at < input.length; at += INFLATE_CHUNK) {
    const slice = input.subarray(at, Math.min(at + INFLATE_CHUNK, input.length));
    inflator.push(slice);
    if (inflator.err) {
      throw new Error(`inflate failed at ${offset}: ${inflator.msg}`);
    }
    // `next_in` is an offset within the slice just pushed, so it accumulates.
    consumed += (inflator as unknown as { strm: { next_in: number } }).strm.next_in;
    if (overflowed) {
      throw new Error(`object inflates past ${MAX_OBJECT_BYTES} bytes`);
    }
    // Set once the zlib trailer is reached; the next object starts here.
    if (inflator.ended) break;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return { out, consumed };
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

  // The target size is attacker-controlled and is allocated up front, so it is
  // checked before the allocation rather than after.
  if (targetSize > MAX_OBJECT_BYTES) {
    throw new Error(`delta target is ${targetSize} bytes, over the limit`);
  }
  const out = new Uint8Array(targetSize);
  let outPos = 0;

  // Every read is bounds-checked. `Uint8Array.subarray` clamps out-of-range
  // indices rather than throwing, and an out-of-bounds `delta[pos++]` yields
  // undefined which the bitwise ops coerce to 0 — so without these a corrupt
  // delta produces silently zero-filled output that still satisfies the
  // `outPos === targetSize` check at the end. Wrong data that looks valid is
  // the one outcome this file exists to avoid.
  const byteAt = (i: number): number => {
    if (i >= delta.length) throw new Error("delta ended mid-instruction");
    return delta[i];
  };

  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= byteAt(pos++);
      if (op & 0x02) copyOffset |= byteAt(pos++) << 8;
      if (op & 0x04) copyOffset |= byteAt(pos++) << 16;
      if (op & 0x08) copyOffset |= byteAt(pos++) << 24;
      if (op & 0x10) copySize |= byteAt(pos++);
      if (op & 0x20) copySize |= byteAt(pos++) << 8;
      if (op & 0x40) copySize |= byteAt(pos++) << 16;
      // A zero size means 0x10000, an encoding quirk that is easy to miss.
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) {
        throw new Error("delta copies past the end of its base");
      }
      if (outPos + copySize > targetSize) {
        throw new Error("delta writes past its declared target size");
      }
      out.set(base.subarray(copyOffset, copyOffset + copySize), outPos);
      outPos += copySize;
    } else if (op !== 0) {
      if (pos + op > delta.length) {
        throw new Error("delta insert runs past the end of the delta");
      }
      if (outPos + op > targetSize) {
        throw new Error("delta writes past its declared target size");
      }
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
/** Sideband framing adds a little over the pack itself. */
const MAX_RESPONSE_BYTES = MAX_PACK_BYTES + 1024 * 1024;
/**
 * How much compressed input to hand pako at a time.
 *
 * Small enough that a pathological object is abandoned quickly, large enough
 * that a normal pack costs only a handful of iterations.
 */
const INFLATE_CHUNK = 64 * 1024;
/** Notes fan out two levels; anything deeper is not a notes tree. */
const MAX_TREE_DEPTH = 4;
/** Ceiling on notes collected from one repository. */
const MAX_NOTES = 50_000;
/** Ceiling on tree nodes walked, which `MAX_NOTES` does not bound. */
const MAX_TREE_VISITS = 100_000;
/** Upper bound on how long one repository may hold the request open. */
const FETCH_TIMEOUT_MS = 10_000;
/** A single object big enough to blow the budget on its own. */
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
/**
 * Every decoded object is retained until parsing finishes, so the per-object
 * cap is not enough on its own: many individually-legal objects still add up.
 */
const MAX_TOTAL_DECODED_BYTES = 32 * 1024 * 1024;

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

  let decoded = 0;
  const account = (n: number) => {
    decoded += n;
    if (decoded > MAX_TOTAL_DECODED_BYTES) {
      throw new Error(`decoded data exceeded ${MAX_TOTAL_DECODED_BYTES} bytes`);
    }
  };

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
    // Per-object size is enforced inside `inflateAt`, before the bytes are
    // ever accumulated; this tracks the running total across all of them.
    account(out.length);

    if (baseRef === null) {
      const obj: GitObject = { type, data: out };
      byOffset.set(objOffset, obj);
      byId.set(await objectId(type, out), obj);
    } else {
      pending.push({ offset: objOffset, baseRef, delta: out });
    }
  }

  // Resolve deltas by following dependencies forward rather than rescanning.
  //
  // The obvious loop — sweep the pending list, retry whatever is still stuck —
  // is quadratic, and a reverse-ordered delta chain drives it to its worst
  // case: within the 20k object cap that is ~200M checks, which exhausts the
  // CPU budget before any graceful degradation runs. Indexing each delta under
  // the base it waits on makes resolution linear: settling an object wakes
  // exactly the deltas that were blocked on it.
  const waiting = new Map<string | number, Pending[]>();
  for (const p of pending) {
    const list = waiting.get(p.baseRef);
    if (list) list.push(p);
    else waiting.set(p.baseRef, [p]);
  }

  const settle = async (key: string | number, obj: GitObject): Promise<void> => {
    const queue = waiting.get(key);
    if (!queue) return;
    waiting.delete(key);
    for (const p of queue) {
      const data = applyDelta(obj.data, p.delta);
      account(data.length);
      const resolved: GitObject = { type: obj.type, data };
      byOffset.set(p.offset, resolved);
      const id = await objectId(resolved.type, resolved.data);
      byId.set(id, resolved);
      // A delta can itself be the base for another, so cascade both ways it
      // may have been referenced.
      await settle(p.offset, resolved);
      await settle(id, resolved);
    }
  };

  for (const [offset, obj] of [...byOffset]) await settle(offset, obj);
  for (const [id, obj] of [...byId]) await settle(id, obj);

  if (waiting.size) {
    const orphans = [...waiting.values()].reduce((n, v) => n + v.length, 0);
    throw new Error(`${orphans} delta(s) reference a missing base`);
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

  // Git trees form a DAG: identical subtrees are stored once and referenced
  // from several parents, so a naive walk revisits a shared child once per path
  // reaching it and the work grows exponentially in the depth of the layering.
  //
  // The guard is keyed on *(prefix, id)*, not id alone. Output keys carry the
  // parent prefix, so the same subtree reached by two different paths yields
  // two different sets of commit ids — deduplicating on id would silently drop
  // every note under the second path. What must not repeat is the same subtree
  // at the same prefix, which is the only genuinely redundant case.
  //
  // A DAG can still have exponentially many distinct paths, so depth and total
  // entries are capped as well. Notes fan out at most two levels in practice,
  // but the pack comes from an arbitrary public repository and is not obliged
  // to be well behaved.
  const visited = new Set<string>();
  // `MAX_NOTES` bounds what is *emitted*, not what is walked: a DAG with many
  // distinct prefixes over shared, entry-heavy subtrees reparses those subtrees
  // once per prefix while emitting almost nothing. The traversal needs its own
  // ceiling.
  let visits = 0;

  const walk = (id: string, prefix: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH || out.size >= MAX_NOTES) return;
    if (++visits > MAX_TREE_VISITS) return;
    const key = `${prefix}\u0000${id}`;
    if (visited.has(key)) return;
    visited.add(key);

    const tree = objects.get(id);
    if (!tree || tree.type !== OBJ_TREE) return;
    for (const e of parseTree(tree.data)) {
      const child = objects.get(e.id);
      if (!child) continue;
      if (child.type === OBJ_TREE) {
        walk(e.id, prefix + e.name, depth + 1);
      } else if (child.type === OBJ_BLOB) {
        if (out.size >= MAX_NOTES) return;
        out.set(prefix + e.name, dec.decode(child.data));
      }
    }
  };

  walk(treeId, "", 0);
  return out;
}

/**
 * Read a response body, refusing to buffer more than the cap.
 *
 * `Content-Length` is not enough: a chunked reply omits it entirely, and
 * `arrayBuffer()` on an unbounded body is the one step no later limit can
 * rescue. Reading the stream and counting as it arrives bounds the allocation
 * whatever the sender declares.
 */
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new Error(`response declares ${declared} bytes, over the limit`);
  }
  if (!res.body) {
    // No stream to meter, so the only option is to buffer and then check —
    // but checking is still better than the unbounded return this used to be.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) {
      throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
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
    // Without this a slow or hanging remote holds the Worker until the runtime
    // kills it, losing the whole page rather than just this section.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // Deliberately uncached. The wanted sha travels in the *body*, while the
    // URL is identical for every request to a repo — so caching by URL would
    // serve one commit's pack for another sha's request, silently charting
    // stale measurements. The rendered page is cached instead, keyed on its own
    // URL, which is where caching belongs.
  } as RequestInit);
  if (!res.ok) throw new Error(`git-upload-pack returned ${res.status}`);

  const objects = await parsePack(extractPack(await readCapped(res)));
  const commit = objects.get(notesSha);
  if (!commit) throw new Error("notes commit missing from pack");
  return readNotesTree(objects, commitTree(commit.data));
}
