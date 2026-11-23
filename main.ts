// main.ts is mend, the CLI SPEC.md specifies. It applies an edit an AI model
// wrote, in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A patch,
// JSON edits), to a tree of text files. Every format is read as SPEC.md says:
// lines are matched at the first of three tiers (exact, trailing whitespace,
// both-side whitespace), every file is changed or nothing is, and the output
// names what changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A move an edit performed, so the output can print one `R` line for it. */
interface Move {
  old: string;
  nu: string;
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at one tier. */
function findOccurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (exact, then trailing, then both sides) with an occurrence at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a one-line anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < lines.length; j++) {
      if (lineEq(lines[j]!, anchor, t)) return j;
    }
  }
  return -1;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One entry of a new-lines list: a context line (written as the file's own matched line) or an added line. */
interface NewEntry {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** The lines N writes: context lines as the file's own, other lines re-indented at tier 2. */
function buildNew(n: NewEntry[], fileLines: string[], at: number, o: string[], tier: number): string[] {
  const f = o.length > 0 && at < fileLines.length ? leadingWs(fileLines[at]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return n.map((e) => {
    if (e.ctx) return fileLines[at + e.oIdx]!;
    if (tier !== 2) return e.text;
    if (e.text === '' || /^[ \t]*$/.test(e.text)) return e.text;
    if (e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

function applyAt(lines: string[], at: number, k: number, replacement: string[]): string[] {
  return [...lines.slice(0, at), ...replacement, ...lines.slice(at + k)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its old start line, its old lines, and its new lines. */
interface Hunk {
  a: number;
  o: string[];
  n: NewEntry[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLastCtxOrPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusBackslash: boolean;
  hasPlus: boolean;
}

/** One unified section: where its paths came from, what kind it is, and its hunks. */
interface Section {
  diff: { old: string; nu: string } | null;
  pair: { old: string | null; nu: string | null } | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseUnifiedHeader(line: string): { x: string; y: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return { x, y };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string): { a: number } | null {
  const m = HUNK_RE.exec(line);
  if (!m) return null;
  return { a: Number(m[1]) };
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A `--- ` or `+++ ` path: text after the four characters, up to the first tab, trimmed; null for /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return stripPrefix(p);
}

/** The body lines after a hunk header: the hunk, and the index of the first line after the body. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  type Raw = { kind: 'ctx' | 'old' | 'add' | 'mark'; text: string };
  const raw: Raw[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      const nx = lines[j + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) break;
    }
    if (l === '') {
      raw.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0];
    if (c === ' ') {
      raw.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      raw.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      raw.push({ kind: 'add', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      raw.push({ kind: 'mark', text: l });
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') raw.pop();
    else break;
  }
  const o: string[] = [];
  const n: NewEntry[] = [];
  for (const r of raw) {
    if (r.kind === 'ctx') {
      const idx = o.length;
      o.push(r.text);
      n.push({ text: r.text, ctx: true, oIdx: idx });
    } else if (r.kind === 'old') {
      o.push(r.text);
    } else if (r.kind === 'add') {
      n.push({ text: r.text, ctx: false, oIdx: -1 });
    }
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  raw.forEach((r, idx) => {
    if (r.kind === 'ctx' || r.kind === 'add') lastCtxOrPlus = idx;
    if (r.kind === 'add') lastPlus = idx;
  });
  return {
    hunk: {
      a,
      o,
      n,
      backslashAfterLastCtxOrPlus: lastCtxOrPlus >= 0 && raw[lastCtxOrPlus + 1]?.kind === 'mark',
      lastPlusBackslash: lastPlus >= 0 && raw[lastPlus + 1]?.kind === 'mark',
      hasPlus: lastPlus >= 0,
    },
    next: j,
  };
}

/** A section's hunks, in order, on a file: each hunk works on the result of the ones before it. */
function applyHunks(file: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = file.lines;
  let fin = file.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const rep = h.n.map((e) => e.text);
      lines = applyAt(lines, at, 0, rep);
      if (atEnd) fin = !h.backslashAfterLastCtxOrPlus;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o, strict, 0);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const runsToEnd = at + h.o.length === lines.length;
    const rep = buildNew(h.n, lines, at, h.o, found.tier);
    lines = applyAt(lines, at, h.o.length, rep);
    if (runsToEnd) fin = !h.backslashAfterLastCtxOrPlus;
    d += h.n.length - h.o.length;
  }
  return { lines, br: file.br, final: fin };
}

function sectionEdit(s: Section, strict: boolean, moves: Move[]): Edit {
  const oldP = s.pair !== null ? s.pair.old : (s.renameFrom ?? s.diff?.old ?? null);
  const newP = s.pair !== null ? s.pair.nu : (s.renameTo ?? s.diff?.nu ?? null);
  const isCreate = s.isCreate || oldP === null;
  const isDelete = !isCreate && (s.isDelete || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const oldPath = oldP ?? '';
    const newPath = newP ?? '';
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const added: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        for (const e of h.n) if (!e.ctx) added.push(e.text);
        if (h.hasPlus) fin = !h.lastPlusBackslash;
      }
      tree.now.set(newPath, serializeFile({ lines: added, br: '\n', final: added.length > 0 ? fin : false }));
      return;
    }
    if (isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (isMove) {
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(parseFile(cur), s.hunks, strict, oldPath);
      tree.now.set(newPath, serializeFile(out));
      tree.now.set(oldPath, null);
      moves.push({ old: oldPath, nu: newPath });
      return;
    }
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    const out = applyHunks(parseFile(cur), s.hunks, strict, oldPath);
    tree.now.set(oldPath, serializeFile(out));
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const h = parseUnifiedHeader(line);
      if (!h) throw new Exit2(`error: parse ${i + 1}`);
      if (cur) sections.push(cur);
      cur = { diff: { old: h.x, nu: h.y }, pair: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const hh = parseHunkHeader(line);
      if (!hh) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i + 1, hh.a);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pair = { old: headerPath(line), nu: headerPath(nxt) };
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        if (cur) sections.push(cur);
        cur = { diff: null, pair: { old: headerPath(line), nu: headerPath(nxt) }, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (cur) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict, moves));
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serializeFile({ lines: [...newLines], br: '\n', final: true }));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildNew(
      newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      f.lines,
      at,
      oldLines,
      found.tier,
    );
    tree.now.set(path, serializeFile({ lines: applyAt(f.lines, at, oldLines.length, rep), br: f.br, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One V4A section as read, with the absolute line number of each content line. */
interface V4aRaw {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  content: Array<{ text: string; no: number }>;
}

/** One V4A update chunk: its anchor (null: none), whether it is end-of-file, and its old and new lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewEntry[];
}

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function v4aSectionPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
  return line.slice(prefix.length).trim();
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, serializeFile({ lines: fileLines, br: '\n', final: true }));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(raw: V4aRaw, content: Array<{ text: string; no: number }>, strict: boolean, moves: Move[]): Edit {
  let moveTo: string | null = null;
  let rest = content;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let seenChunk = false;
  const push = (): void => {
    if (cur) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (const c of rest) {
    const l = c.text;
    if (l.startsWith('@@')) {
      push();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${c.no}`);
      cur.eof = true;
      push();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!cur) {
        if (seenChunk) throw new Exit2(`error: parse ${c.no}`);
        cur = { anchor: null, eof: false, o: [], n: [] };
        seenChunk = true;
      }
      if (l === '') {
        const idx = cur.o.length;
        cur.o.push('');
        cur.n.push({ text: '', ctx: true, oIdx: idx });
      } else if (l[0] === ' ') {
        const idx = cur.o.length;
        const t = l.slice(1);
        cur.o.push(t);
        cur.n.push({ text: t, ctx: true, oIdx: idx });
      } else if (l[0] === '-') {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${c.no}`);
  }
  push();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${raw.lineNo}`);
  const path = raw.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(curText);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const j = findAnchor(lines, ch.anchor, strict, cursor);
        if (j < 0) throw new Fail('no-match', path);
        cursor = j + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const rep = ch.n.map((e) => e.text);
        lines = applyAt(lines, at, 0, rep);
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(lines, ch.o, strict, cursor);
      if (!found) throw new Fail('no-match', path);
      let at: number;
      if (ch.eof) {
        const want = lines.length - ch.o.length;
        if (!found.pos.includes(want)) throw new Fail('no-match', path);
        at = want;
      } else {
        at = found.pos[0]!;
      }
      const rep = buildNew(ch.n, lines, at, ch.o, found.tier);
      lines = applyAt(lines, at, ch.o.length, rep);
      cursor = at + rep.length;
    }
    const text = serializeFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push({ old: path, nu: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const raws: V4aRaw[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = v4aSectionKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const raw: V4aRaw = { kind, path: v4aSectionPath(line, kind), lineNo: i + 1, content: [] };
    i++;
    while (i < last && v4aSectionKind(lines[i]!) === null) {
      raw.content.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    raws.push(raw);
  }
  if (raws.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const raw of raws) {
    const content = [...raw.content];
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (raw.kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text === '') fileLines.push('');
        else if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else throw new Exit2(`error: parse ${c.no}`);
      }
      edits.push(v4aAddEdit(raw.path, fileLines));
    } else if (raw.kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
      edits.push(v4aDeleteEdit(raw.path));
    } else {
      edits.push(v4aUpdateEdit(raw, content, strict, moves));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nu);
    const nowNew = tree.get(m.nu);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nu, line: `R ${m.old} -> ${m.nu}` });
      suppressed.add(m.old);
      suppressed.add(m.nu);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
