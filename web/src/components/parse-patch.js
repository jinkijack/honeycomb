/**
 * Unified diff parser.
 *
 * The previous view coloured line by line based on the first character, which is
 * fast but lies in three common cases: a content line starting with `-` inside a
 * context block reads as "removed", the `---`/`+++` headers get confused with
 * content, and there are no line numbers at all — you see what changed but not
 * where.
 *
 * Here the patch becomes structure (file → hunk → line), with numbering rebuilt
 * from the `@@` header, which is its only reliable source.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Path from `--- a/x` / `+++ b/x`, tolerating quotes and post-tab metadata. */
function pathFrom(line) {
  let p = line.slice(4).split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
      p = p.slice(1, -1);
    }
  }
  return p.replace(/^[ab]\//, '');
}

export function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;

  const raw = String(patch || '').split('\n');
  // the patch ends in a newline: the last split element is an artefact, not a
  // context line (a blank context line arrives as " ", with the sign's space)
  if (raw.length && raw[raw.length - 1] === '') raw.pop();

  for (const line of raw) {
    if (line.startsWith('diff --git ')) {
      file = { path: null, oldPath: null, status: 'M', hunks: [], additions: 0, deletions: 0, binary: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('new file mode')) { file.status = 'A'; continue; }
    if (line.startsWith('deleted file mode')) { file.status = 'D'; continue; }
    if (line.startsWith('rename from ')) { file.status = 'R'; file.oldPath = line.slice(12); continue; }
    if (line.startsWith('rename to ')) { file.path = line.slice(10); continue; }
    if (line.startsWith('Binary files')) { file.binary = true; continue; }

    // the ---/+++ headers are the reliable source of the path: `diff --git` is
    // ambiguous when the name contains a space
    if (line.startsWith('--- ')) { file.oldPath = pathFrom(line) ?? file.oldPath; continue; }
    if (line.startsWith('+++ ')) { file.path = pathFrom(line) ?? file.path; continue; }

    if (line.startsWith('index ') || line.startsWith('old mode ') ||
        line.startsWith('new mode ') || line.startsWith('similarity index ')) continue;

    const m = HUNK.exec(line);
    if (m) {
      // oldNo/newNo are counters and advance line by line; oldStart/newStart
      // hold where the hunk begins, which is what we show when git reports no
      // scope
      hunk = {
        context: m[5] || '',
        oldStart: Number(m[1]),
        newStart: Number(m[3]),
        oldNo: Number(m[1]),
        newNo: Number(m[3]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    switch (line[0]) {
      case '+':
        hunk.lines.push({ type: 'add', newNo: hunk.newNo++, text: line.slice(1) });
        file.additions++;
        break;
      case '-':
        hunk.lines.push({ type: 'del', oldNo: hunk.oldNo++, text: line.slice(1) });
        file.deletions++;
        break;
      case '\\':
        // "\ No newline at end of file" — consumes no line number
        hunk.lines.push({ type: 'meta', text: line.slice(2) });
        break;
      default:
        hunk.lines.push({ type: 'ctx', oldNo: hunk.oldNo++, newNo: hunk.newNo++, text: line.slice(1) });
    }
  }

  for (const f of files) {
    if (!f.path) f.path = f.oldPath || '(desconhecido)';
    f.lineCount = f.hunks.reduce((a, h) => a + h.lines.length, 0);
  }
  return files;
}
