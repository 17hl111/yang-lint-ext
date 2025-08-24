import {
  CodeAction, CodeActionKind, Connection, Diagnostic,
  TextEdit, Range
} from 'vscode-languageserver/node';
import { documents } from '../index';
import { deviationMap } from '../ruleEngine';

/* ---------- 注册 ---------- */
export function register(connection: Connection) {
  connection.onCodeAction(params => {
    const uri = params.textDocument.uri;
    const doc = documents.get(uri);
    if (!doc) return [];

    const fixes: CodeAction[] = [];

    for (const diag of params.context.diagnostics) {
      if (diag.source === 'yang-lint:deviation-unique-target' && diag.data?.groupId) {
        const fix = buildDeviationFix(diag, uri, doc.getText());
        if (fix) fixes.push(fix);
      }
    }
    return fixes;
  });
}

/* ---------- deviation Quick Fix ---------- */
function buildDeviationFix(diag: Diagnostic, uri: string, text: string): CodeAction | null {
  const target = String(diag.data.groupId);
  const ranges = deviationMap.get(target);
  if (!ranges || ranges.length < 2) return null;

  /* 文内顺序 */
  const sorted = [...ranges].sort((a, b) =>
    (a.start.line - b.start.line) || (a.start.character - b.start.character));

  /* ----------- 缩进计算 ----------- */
  const lineStartOff = offsetAt(text, { line: sorted[0].start.line, character: 0 });
  const lineEndOff   = text.indexOf('\n', lineStartOff) === -1
                     ? text.length : text.indexOf('\n', lineStartOff);
  const firstLine    = text.slice(lineStartOff, lineEndOff);
  const baseIndent   = firstLine.match(/^[ \t]*/)?.[0] ?? '';
  const innerIndent  = baseIndent + '  ';          // 相对多两空格

  /* ----------- 合并块体 ----------- */
  const bodies = sorted.map(r => {
    const raw = textSlice(text, r);
    const open = raw.indexOf('{'), close = raw.lastIndexOf('}');
    const body = raw.slice(open + 1, close);                   // 内部含换行
    const lines = body.replace(/^\n+|\s+$/g, '').split('\n');

    /* 求最小公共缩进 */
    const minIndent = Math.min(...lines
      .filter(l => l.trim() !== '')
      .map(l => l.match(/^[ \t]*/)?.[0].length ?? 0));

    return lines
      .map(l => innerIndent + l.slice(minIndent))
      .join('\n');
  });

  const merged = `${baseIndent}deviation ${target} {\n` +
                 bodies.join('\n\n') +
                 `\n${baseIndent}}`;

  /* ----------- TextEdits ----------- */
  const edits: TextEdit[] = [];
  edits.push(TextEdit.replace(sorted[0], merged));
  sorted.slice(1).forEach(r => edits.push({ range: r, newText: '' }));

  return {
    title: 'Merge duplicate deviations',
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: { changes: { [uri]: edits } },
  };
}

/* ---------- helpers ---------- */
function offsetAt(text: string, pos: { line: number; character: number }): number {
  const lines = text.split('\n'); let off = 0;
  for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
  return off + pos.character;
}

function textSlice(text: string, r: Range): string {
  return text.slice(offsetAt(text, r.start), offsetAt(text, r.end));
}
