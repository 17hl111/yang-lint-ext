import { Range } from 'vscode-languageserver';

/* ---------- util ---------- */
function idxToPos(text: string, idx: number) {
  const lines = text.slice(0, idx).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

/* ---------- FSM 找同级 '}' ---------- */
enum S { CODE, LINE_COMMENT, BLOCK_COMMENT, DQ_STRING, SQ_STRING }
function findMatchingBrace(text: string, openIdx: number): number {
  let state = S.CODE, depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i], nxt = text[i + 1];
    switch (state) {
      case S.CODE:
        if (ch === '{') depth++;
        else if (ch === '}') {
          if (--depth === 0) return i;
        } else if (ch === '/' && nxt === '/') { state = S.LINE_COMMENT; i++; }
        else if (ch === '/' && nxt === '*')   { state = S.BLOCK_COMMENT; i++; }
        else if (ch === '"')  state = S.DQ_STRING;
        else if (ch === '\'') state = S.SQ_STRING;
        break;
      case S.LINE_COMMENT: if (ch === '\n') state = S.CODE; break;
      case S.BLOCK_COMMENT: if (ch === '*' && nxt === '/') { state = S.CODE; i++; } break;
      case S.DQ_STRING: if (ch === '"'  && text[i - 1] !== '\\') state = S.CODE; break;
      case S.SQ_STRING: if (ch === '\'' && text[i - 1] !== '\\') state = S.CODE; break;
    }
  }
  return text.length - 1;
}

/* ---------- node types ---------- */
export interface ModuleHeader { moduleName?: string; namespace?: string; range: Range; rawLine: string; }
export interface ImportNode   { name: string; range: Range; rawLine: string; }
export interface TypedefNode  { name: string; range: Range; rawLine: string; afterLines: string; }
export interface StatusNode   { value: 'current'|'deprecated'|'obsolete'; range: Range; rawLine: string; afterLines: string; }
export interface ListNode     { line: number; range: Range; key: string[]; children: string[]; afterLines: string; }
export interface BlockNode    { keyword: string; name: string; range: Range; rawLine: string; afterLines: string; }
export interface DeviationNode{ target: string; range: Range; duplicate: boolean; }
export interface ConstraintNode { keyword: string; name: string; range: Range; hasMust: boolean; hasWhen: boolean; hasDesc: boolean; }

export interface Ast {
  moduleHeader?: ModuleHeader;
  imports?:  ImportNode[];
  typedefs?: TypedefNode[];
  statuses?: StatusNode[];
  lists?:    ListNode[];
  blocks?:   BlockNode[];
  deviations?: DeviationNode[];
  constraintNodes?: ConstraintNode[];
}

/* ---------- regex ---------- */
const MODULE_RE  = /^[ \t]*module[ \t]+([A-Za-z0-9._-]+)[^\n]*$/m;
const NS_RE      = /^[ \t]*namespace[ \t]+"([^"]+)"[^\n]*$/m;
const IMPORT_RE  = /^[ \t]*import[ \t]+([0-9A-Za-z._-]+)[^\n]*$/gm;
const STATUS_RE  = /^[ \t]*status[ \t]+(current|deprecated|obsolete)[^\n]*$/gm;

const TYPEDEF_START_RE  = /^[ \t]*typedef[ \t]+([A-Za-z0-9._-]+)[ \t]*{/gm;
const LIST_START_RE     = /^[ \t]*list[ \t]+(\w+)[ \t]*{/gm;
const DEVIATION_START_RE= /^[ \t]*deviation[ \t]+([^ \t{]+)[ \t]*{/gm;

const KEY_RE  = /key[ \t]+"([^"]+)"/;
const LEAF_RE = /leaf[ \t]+(\w+)/g;

const DESC_BLOCK_RE = /^[ \t]*(anyxml|augment|choice|container|extension|feature|notification|rpc)[ \t]+(\w+)[^\n]*{/gm;
const CONSTRAINT_START_RE = /^[ \t]*(container|list|leaf-list|leaf|choice|case|anyxml|anydata|grouping|uses|typedef|augment)[ \t]+(\w+)[^\n]*{/gm;

/* ---------- parse ---------- */
export function parseYang(text: string): Ast {
  /* --- module header --- */
  const mh = MODULE_RE.exec(text);
  const ns = NS_RE.exec(text);
  const moduleHeader = mh
    ? { moduleName: mh[1], namespace: ns?.[1], rawLine: mh[0],
        range:{ start: idxToPos(text,mh.index), end: idxToPos(text,mh.index+mh[0].length)}} : undefined;

  /* --- imports --- */
  const imports: ImportNode[] = [];
  for(const m of text.matchAll(IMPORT_RE)){
    imports.push({ name:m[1], rawLine:m[0],
      range:{ start: idxToPos(text,m.index!), end: idxToPos(text,m.index!+m[0].length)}});
  }

  /* --- typedefs --- */
  const typedefs: TypedefNode[]=[];
  let tm:RegExpExecArray|null;
  while((tm=TYPEDEF_START_RE.exec(text))){
    const open=text.indexOf('{',tm.index), close=findMatchingBrace(text,open);
    const body=text.slice(open+1,close);
    typedefs.push({ name:tm[1], rawLine:tm[0],
      afterLines:body.split('\n').slice(0,10).join('\n'),
      range:{ start: idxToPos(text,tm.index), end: idxToPos(text,close+1)}});
  }

  /* --- statuses --- */
  const statuses: StatusNode[]=[];
  for(const m of text.matchAll(STATUS_RE)){
    statuses.push({ value:m[1] as any, rawLine:m[0],
      afterLines:text.slice(m.index!+m[0].length).split('\n').slice(0,10).join('\n'),
      range:{ start: idxToPos(text,m.index!), end: idxToPos(text,m.index!+m[0].length)}});
  }

  /* --- lists --- */
  const lists: ListNode[]=[];
  let lm:RegExpExecArray|null;
  while((lm=LIST_START_RE.exec(text))){
    const open=text.indexOf('{',lm.index), close=findMatchingBrace(text,open);
    const body=text.slice(open+1,close);
    const keys=KEY_RE.exec(body)?.[1].trim().split(/\s+/)||[];
    const children=[...body.matchAll(LEAF_RE)].map(m=>m[1]);
    lists.push({ line: idxToPos(text,lm.index).line,
      range:{ start: idxToPos(text,lm.index), end: idxToPos(text,close+1)},
      key:keys, children,
      afterLines:body.split('\n').slice(0,10).join('\n')});
  }

  /* --- deviation detection & duplicate flag --- */
  const deviationMap=new Map<string,DeviationNode[]>();
  let dm:RegExpExecArray|null;
  while((dm=DEVIATION_START_RE.exec(text))){
    const target=dm[1];
    const open=text.indexOf('{',dm.index), close=findMatchingBrace(text,open);
    const node:DeviationNode={
      target, range:{ start: idxToPos(text,dm.index), end: idxToPos(text,close+1)},
      duplicate:false
    };
    const arr=deviationMap.get(target)||[];
    arr.push(node);
    deviationMap.set(target,arr);
  }
  /* 标记 duplicates */
  for(const arr of deviationMap.values()){
    if(arr.length>1) arr.slice(1).forEach(n=>n.duplicate=true);
  }
  const deviations=[...deviationMap.values()].flat();

  /* --- description blocks --- */
  const blocks: BlockNode[]=[];
  let bm:RegExpExecArray|null;
  while((bm=DESC_BLOCK_RE.exec(text))){
    const open=text.indexOf('{',bm.index), close=findMatchingBrace(text,open);
    const body=text.slice(open+1,close);
    blocks.push({ keyword:bm[1], name:bm[2], rawLine:bm[0],
      afterLines:body.split('\n').slice(0,10).join('\n'),
      range:{ start: idxToPos(text,bm.index), end: idxToPos(text,close+1)}});
  }

  /* --- constraint nodes --- */
  const constraintNodes: ConstraintNode[]=[];
  let cm:RegExpExecArray|null;
  while((cm=CONSTRAINT_START_RE.exec(text))){
    const open=text.indexOf('{',cm.index), close=findMatchingBrace(text,open);
    const body=text.slice(open+1,close);
    constraintNodes.push({ keyword:cm[1], name:cm[2],
      range:{ start: idxToPos(text,cm.index), end: idxToPos(text,close+1)},
      hasMust:/[\s\n]must[\s\n]/.test(body),
      hasWhen:/[\s\n]when[\s\n]/.test(body),
      hasDesc:/[\s\n]description[\s\n]/.test(body)});
  }

  return { moduleHeader,
    imports:imports.length?imports:undefined,
    typedefs:typedefs.length?typedefs:undefined,
    statuses:statuses.length?statuses:undefined,
    lists:lists.length?lists:undefined,
    blocks:blocks.length?blocks:undefined,
    deviations:deviations.length?deviations:undefined,
    constraintNodes:constraintNodes.length?constraintNodes:undefined };
}
