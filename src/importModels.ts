import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import fetch from 'node-fetch';

/* ======================= YANG Import (独立模块) ======================= */
const MODELS_CHANNEL = vscode.window.createOutputChannel('YANG Models');
const MODELS_CACHE_KEY = 'yang.models.cache.v1';
const DEFAULT_IMPORT_DIR = 'imported';

/** 固定的 Catalog（不可增删） */
const FIXED_CATALOG = {
  name: 'YANG Catalog',
  baseUrl: 'https://www.yangcatalog.org'
} as const;

type LocalSource = { type: 'local'; path: string; name?: string };
// catalog 源不从配置读取，固定为上面的 FIXED_CATALOG
type YangSource = LocalSource;

type ModelsCache = { [key: string]: { ts: number; data: any } };

type CatalogModule = { name: string; revision: string; organization?: string; schema?: string; };

type ManifestEntry = {
  name: string;
  revision: string;
  organization?: string;
  source: { type: 'catalog' | 'local'; ref: string };
  destRel: string;
  sha256?: string;
  importedAt: string;
};
type ManifestFile = { $schema?: string; items: ManifestEntry[] };

function modelsConfig() {
  const cfg = vscode.workspace.getConfiguration('yang.models');
  const sources = (cfg.get('sources') as any[]) ?? []; // 只取本地 local 条目
  const defaultImportDir = String(cfg.get('defaultImportDir', DEFAULT_IMPORT_DIR)).trim() || DEFAULT_IMPORT_DIR;
  const cacheTtlHours = Number(cfg.get('cacheTtlHours', 1));
  return { sources, defaultImportDir, cacheTtlHours };
}
function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined { return vscode.workspace.workspaceFolders?.[0]; }
function manifestFsPath(): string | undefined { const ws = getWorkspaceFolder(); if (!ws) return undefined; return path.join(ws.uri.fsPath, '.yang-models.json'); }
async function readManifest(): Promise<ManifestFile> {
  const f = manifestFsPath(); if (!f) return { items: [] };
  try { const buf = await fs.promises.readFile(f, 'utf8'); const j = JSON.parse(buf); if (Array.isArray(j?.items)) return j as ManifestFile; } catch {}
  return { items: [] };
}
async function writeManifest(m: ManifestFile): Promise<void> { const f = manifestFsPath(); if (!f) return; await fs.promises.writeFile(f, JSON.stringify({ $schema: undefined, ...m }, null, 2), 'utf8'); }
async function ensureDir(p: string) { await fs.promises.mkdir(p, { recursive: true }); }
function sha256Of(text: string): string { return crypto.createHash('sha256').update(text).digest('hex'); }
function joinWs(...p: string[]): string { const ws = getWorkspaceFolder(); if (!ws) throw new Error('No workspace open'); return path.join(ws.uri.fsPath, ...p); }
function calcDefaultImportDirAbs(): string { const { defaultImportDir } = modelsConfig(); return joinWs(defaultImportDir); }

function cacheGet(context: vscode.ExtensionContext, key: string): any | undefined {
  const all = (context.globalState.get(MODELS_CACHE_KEY) as ModelsCache) || {};
  return all[key] && typeof all[key].ts === 'number' ? all[key] : undefined;
}
async function cacheSet(context: vscode.ExtensionContext, key: string, data: any) {
  const all = (context.globalState.get(MODELS_CACHE_KEY) as ModelsCache) || {};
  all[key] = { ts: Date.now(), data };
  await context.globalState.update(MODELS_CACHE_KEY, all);
}
function isCacheFresh(entry: { ts: number } | undefined, ttlHours: number): boolean {
  if (!entry) return false; return (Date.now() - entry.ts) < ttlHours * 3600 * 1000;
}

/* ---- Catalog 搜索（多端点 fallback） ---- */
function parseModules(j: any): CatalogModule[] {
  const list1 = j?.['yang-catalog:modules']?.module;
  if (Array.isArray(list1)) return list1.map((m:any)=>({ name:m.name, revision:m.revision, organization:m.organization, schema:m.schema }));
  if (j && typeof j==='object' && j.name && j.revision) return [{ name:j.name, revision:j.revision, organization:j.organization, schema:j.schema }];
  if (Array.isArray(j)) return j.map((m:any)=>({ name:m.name, revision:m.revision, organization:m.organization, schema:m.schema }));
  return [];
}
async function safeBody(res: any) { try { return await res.text(); } catch { return ''; } }

async function catalogSearch(baseUrl: string, field: string, value: string, latestOnly: boolean, context: vscode.ExtensionContext): Promise<CatalogModule[]> {
  const { cacheTtlHours } = modelsConfig();
  const key = `${baseUrl}|${field}|${value}|${latestOnly}`;
  const hit = cacheGet(context, key); if (isCacheFresh(hit, cacheTtlHours)) return hit.data as CatalogModule[];

  const bu = baseUrl.replace(/\/+$/,'');
  const lrQ = latestOnly ? 'latest-revision=true' : '';
  const attempts: Array<() => Promise<CatalogModule[]>> = [];

  attempts.push(async ()=>{ // A
    const url = `${bu}/api/search/${encodeURIComponent(field)}/${encodeURIComponent(value)}${lrQ?`?${lrQ}`:''}`;
    MODELS_CHANNEL.appendLine(`Catalog search A: ${url}`);
    const res = await fetch(url, { headers:{'Accept':'application/json'} as any });
    if (!res.ok) throw new Error(`A HTTP ${res.status} ${await safeBody(res)}`);
    return parseModules(await res.json());
  });
  attempts.push(async ()=>{ // B
    const url = `${bu}/api/search/${encodeURIComponent(field)}:${encodeURIComponent(value)}${lrQ?`?${lrQ}`:''}`;
    MODELS_CHANNEL.appendLine(`Catalog search B: ${url}`);
    const res = await fetch(url, { headers:{'Accept':'application/json'} as any });
    if (!res.ok) throw new Error(`B HTTP ${res.status} ${await safeBody(res)}`);
    return parseModules(await res.json());
  });
  if (field==='name') {
    attempts.push(async ()=>{ // C
      const url = `${bu}/api/search/modules?name=${encodeURIComponent(value)}${lrQ?`&${lrQ}`:''}`;
      MODELS_CHANNEL.appendLine(`Catalog search C: ${url}`);
      const res = await fetch(url, { headers:{'Accept':'application/json'} as any });
      if (!res.ok) throw new Error(`C HTTP ${res.status} ${await safeBody(res)}`);
      return parseModules(await res.json());
    });
    attempts.push(async ()=>{ // D
      const url = `${bu}/api/search/module/${encodeURIComponent(value)}${lrQ?`?${lrQ}`:''}`;
      MODELS_CHANNEL.appendLine(`Catalog search D: ${url}`);
      const res = await fetch(url, { headers:{'Accept':'application/json'} as any });
      if (!res.ok) throw new Error(`D HTTP ${res.status} ${await safeBody(res)}`);
      return parseModules(await res.json());
    });
  }
  attempts.push(async ()=>{ // E
    const body = { 'latest-revision': latestOnly, input: { [field]: value } };
    const url = `${bu}/api/search-filter`;
    MODELS_CHANNEL.appendLine(`Catalog search E: ${url} body=${JSON.stringify(body)}`);
    const res = await fetch(url, { method:'POST', headers:{'Accept':'application/json','Content-Type':'application/json'} as any, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`E HTTP ${res.status} ${await safeBody(res)}`);
    return parseModules(await res.json());
  });

  const errors: string[] = [];
  for (const fn of attempts) {
    try {
      const out = await fn();
      if (out && out.length) { await cacheSet(context, key, out); return out; }
    } catch (e:any) { errors.push(String(e?.message || e)); }
  }
  throw new Error(`Catalog search failed across fallbacks: ${errors.join(' | ')}`);
}

/* ---- Catalog 下载（/reference + HTML 去壳） ---- */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
async function catalogDownload(baseUrl: string, name: string, revision: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/,'')}/api/services/reference/${encodeURIComponent(name)}@${encodeURIComponent(revision)}.yang`;
  MODELS_CHANNEL.appendLine(`Catalog download: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  let text = await res.text();
  const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (pre) text = pre[1];
  return decodeHtmlEntities(text);
}

/* ---- Local 源扫描 ---- */
function* walkDirSync(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkDirSync(p);
    else if (e.isFile() && /\.yang$/i.test(e.name)) yield p;
  }
}
function parseYangHead(content: string): { name?: string; revision?: string } {
  const nameMatch = content.match(/^\s*module\s+([A-Za-z0-9\-_\.]+)/m);
  const revMatch = content.match(/^\s*revision\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\s*;/m) ||
                   content.match(/^\s*revision\s+"([0-9]{4}-[0-9]{2}-[0-9]{2})"\s*;/m);
  return { name: nameMatch?.[1], revision: revMatch?.[1] };
}
async function scanLocalSource(sourcePath: string): Promise<Array<CatalogModule & { filePath: string }>> {
  const out: Array<CatalogModule & { filePath: string }> = [];
  try {
    for (const p of walkDirSync(sourcePath)) {
      try {
        const buf = await fs.promises.readFile(p, 'utf8');
        const head = buf.slice(0, 4000);
        const meta = parseYangHead(head);
        if (meta.name) out.push({ name: meta.name, revision: meta.revision ?? 'unknown', organization: undefined, schema: undefined, filePath: p });
      } catch {}
    }
  } catch {}
  return out;
}

async function materializeTo(destDir: string, fileName: string, content: string): Promise<string> {
  await ensureDir(destDir);
  const dest = path.join(destDir, fileName);
  await fs.promises.writeFile(dest, content, 'utf8');
  return dest;
}
async function copyFileTo(destDir: string, srcPath: string, fileName: string): Promise<string> {
  await ensureDir(destDir);
  const dest = path.join(destDir, fileName);
  await fs.promises.copyFile(srcPath, dest);
  return dest;
}
async function upsertManifest(entry: ManifestEntry): Promise<void> {
  const m = await readManifest();
  const key = `${entry.name}@${entry.revision}|${entry.source.type}|${entry.source.ref}`;
  const filtered = m.items.filter(it => `${it.name}@${it.revision}|${it.source.type}|${it.source.ref}` !== key && it.destRel !== entry.destRel);
  m.items = [...filtered, entry];
  await writeManifest(m);
}
async function getManifestSummary(): Promise<{count:number,lastUpdated?:string}> {
  const f = manifestFsPath(); if (!f) return {count:0};
  try { const txt = await fs.promises.readFile(f,'utf8'); const j = JSON.parse(txt) as ManifestFile; const st = await fs.promises.stat(f); return { count: (j.items||[]).length, lastUpdated: new Date(st.mtime).toLocaleString() }; } catch { return {count:0}; }
}

/* ---- Webview UI ---- */
function importWebviewHtml(): string {
  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
      :root{--fg:var(--vscode-foreground);--bg:var(--vscode-editor-background);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-editorWidget-border);--accent:var(--vscode-textLink-foreground)}
      body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
      h2{margin:14px 0 8px;font-size:14px}
      .wrap{padding:12px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      .card{border:1px solid var(--border);border-radius:8px;padding:12px}
      .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
      input[type=text],select{flex:1 1 auto;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--fg)}
      button{padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}
      button.primary{border-color:var(--accent)}
      button[disabled]{opacity:.6;cursor:not-allowed}
      table{width:100%;border-collapse:collapse;font-family:ui-monospace,Consolas,monospace}
      th,td{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}
      .muted{color:var(--muted)}
      .pill{display:inline-block;padding:2px 6px;border-radius:999px;border:1px solid var(--border);margin-right:4px}
      .list{max-height:160px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px}
      .footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
      .small{font-size:12px}
      .danger{color:#e5534b}
      .ok{color:#2ea043}
      .section{margin-top:10px}
      .kbd{padding:1px 4px;border:1px solid var(--border);border-radius:4px;font-family:ui-monospace,Consolas,monospace}
      .spin{display:none;width:14px;height:14px;border:2px solid var(--muted);border-top-color:var(--accent);border-radius:50%;animation:sp 1s linear infinite;margin-left:6px;vertical-align:middle}
      @keyframes sp{to{transform:rotate(360deg)}}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="grid">

        <div class="card">
          <h2>Resources</h2>
          <div class="row">
            <button id="btnRefresh">Refresh</button>
            <button id="btnOpenSettings">Open Settings</button>
          </div>
          <div class="section">
            <div class="row"><b>Local sources</b> <button id="btnAddLocal">Add…</button></div>
            <div id="localList" class="list small muted">Loading…</div>
          </div>
          <div class="section">
            <div class="row"><b>Catalog source</b></div>
            <div id="catalogList" class="list small muted">Loading…</div>
          </div>
        </div>

        <div class="card">
          <h2>Destination</h2>
          <div class="row">
            <span>Target folder:</span>
            <span id="dest" class="muted small"></span>
          </div>
          <div class="row">
            <button id="btnUseDefault">Use Default</button>
            <button id="btnChooseFolder">Choose Folder…</button>
          </div>

          <h2 class="section">Manifest</h2>
          <div class="row small"><span>Items:</span><b id="mCount">-</b><span class="muted">Last updated:</span><span id="mTime" class="muted">-</span></div>
          <div class="row">
            <button id="btnOpenManifest">Open Manifest</button>
            <button id="btnClearCache">Clear Catalog Cache</button>
          </div>
        </div>

      </div>

      <div class="card section">
        <h2>Search</h2>
        <div class="grid">
          <div>
            <div class="row"><b>Local search</b></div>
            <div class="row">
              <input id="localTerm" type="text" placeholder="Module name contains…"/>
              <button id="btnSearchLocal" class="primary">Search Local</button>
            </div>
          </div>
          <div>
            <div class="row"><b>Catalog search</b></div>
            <div class="row">
              <select id="catField">
                <option value="name">name</option>
                <option value="organization">organization</option>
                <option value="prefix">prefix</option>
              </select>
              <input id="catTerm" type="text" placeholder="Search term"/>
              <button id="btnSearchCatalog" class="primary">Search Catalog</button>
              <span id="catSpin" class="spin" aria-label="Searching" title="Searching"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="card section">
        <h2>Results</h2>
        <div class="row">
          <button id="btnImportSelected" disabled>Import selected</button>
          <span id="selCount" class="muted small"></span>
        </div>
        <div class="row small muted" id="resultsHint">No results yet.</div>
        <div style="overflow:auto">
          <table id="resultsTable" style="display:none">
            <thead>
              <tr>
                <th><input id="selAll" type="checkbox"/></th>
                <th>Name</th><th>Revision</th><th>Org/From</th><th>Where</th><th>Action</th>
              </tr>
            </thead>
            <tbody id="resultsBody"></tbody>
          </table>
        </div>
      </div>

      <div class="footer small">
        <div>Tip: manage sources in <span class="kbd">Settings</span> – search <span class="kbd">yang.models.sources</span> (only local)</div>
        <div id="toast" class="muted"></div>
      </div>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const $ = (id)=>document.getElementById(id);
      const toast=(s,cls='')=>{ const t=$('toast'); t.textContent=s; t.className = cls; setTimeout(()=>{ if($('toast').textContent===s) $('toast').textContent=''; }, 4000); };

      let lastRows = [];
      let selected = new Set();
      let catalogInfo = { name: 'YANG Catalog', baseUrl: 'https://www.yangcatalog.org' };

      function renderSources(data){
        const {locals,catalog} = data;
        if (catalog && catalog.baseUrl) catalogInfo = catalog;

        const localList = $('localList'); const catList = $('catalogList');
        localList.innerHTML = ''; catList.innerHTML = '';

        if(!locals.length) localList.innerHTML = '<span class="muted">No local sources</span>';
        locals.forEach((s,i)=>{
          const div = document.createElement('div'); div.className='row';
          div.innerHTML = '<span class="pill">local</span><b>'+ (s.name||'(unnamed)') +'</b><span class="muted">'+s.path+'</span>';
          const del=document.createElement('button'); del.textContent='Delete'; del.className='danger small'; del.onclick=()=>vscode.postMessage({type:'deleteLocalSource', index:i});
          div.appendChild(del); localList.appendChild(div);
        });

        // 固定 Catalog：只展示，不可增删
        const cdiv = document.createElement('div'); cdiv.className='row';
        cdiv.innerHTML = '<span class="pill">catalog</span><b>'+ catalogInfo.name +'</b><span class="muted">'+catalogInfo.baseUrl+'</span>';
        catList.appendChild(cdiv);
      }
      function renderDest(s){ $('dest').textContent = s; }
      function renderManifest(m){ $('mCount').textContent = m.count; $('mTime').textContent = m.lastUpdated || '-'; }

      function renderResults(rows){
        lastRows = Array.isArray(rows) ? rows : [];
        selected = new Set();

        const tb=$('resultsBody'); tb.innerHTML='';
        const table=$('resultsTable'), hint=$('resultsHint');
        const selAll=$('selAll'), selCount=$('selCount'), btnBatch=$('btnImportSelected');

        const updateUI=()=>{
          const n = selected.size;
          btnBatch.disabled = n===0;
          selCount.textContent = n ? (n + ' selected') : '';
          if(selAll){
            selAll.indeterminate = n>0 && n<lastRows.length;
            selAll.checked = n>0 && n===lastRows.length;
          }
        };
        updateUI();

        if(!lastRows.length){ table.style.display='none'; hint.style.display='block'; hint.textContent='No results.'; return; }
        table.style.display='table'; hint.style.display='none';

        lastRows.forEach((r,idx)=>{
          const tr=document.createElement('tr');
          tr.innerHTML=
            '<td><input type="checkbox" class="rowSel" data-i="'+idx+'"/></td>'+
            '<td>'+r.name+'</td>'+
            '<td>'+r.revision+'</td>'+
            '<td>'+(r.organization||r.from||'')+'</td>'+
            '<td class="small muted">'+(r.where||'')+'</td>';
          const td=document.createElement('td'); const btn=document.createElement('button'); btn.textContent='Import';
          btn.onclick=()=>{ if(r.kind==='local'){ vscode.postMessage({type:'importLocal', item:r}); } else { vscode.postMessage({type:'importCatalog', item:r}); } };
          td.appendChild(btn); tr.appendChild(td); tb.appendChild(tr);
        });

        tb.addEventListener('change', (e)=>{
          const t=e.target;
          if(!(t && t.classList && t.classList.contains('rowSel'))) return;
          const i = Number(t.getAttribute('data-i'));
          if (t.checked) selected.add(i); else selected.delete(i);
          updateUI();
        });

        if(selAll){
          selAll.onchange = ()=>{
            if(selAll.checked){ selected = new Set(lastRows.map((_,i)=>i)); }
            else { selected = new Set(); }
            renderResults(lastRows);
          };
        }

        btnBatch.onclick = ()=>{
          const items = Array.from(selected).map(i=> lastRows[i]);
          const locals = items.filter(r=>r.kind==='local');
          const catalogs = items.filter(r=>r.kind==='catalog');
          btnBatch.disabled = true;
          if(catalogs.length) vscode.postMessage({type:'importCatalogBatch', items: catalogs});
          if(locals.length) vscode.postMessage({type:'importLocalBatch', items: locals});
        };
      }

      // Events
      $('btnRefresh').onclick=()=>vscode.postMessage({type:'refreshSources'});
      $('btnOpenSettings').onclick=()=>vscode.postMessage({type:'openSettings'});
      $('btnAddLocal').onclick=()=>vscode.postMessage({type:'addLocalSource'});

      $('btnUseDefault').onclick=()=>vscode.postMessage({type:'setDestDefault'});
      $('btnChooseFolder').onclick=()=>vscode.postMessage({type:'chooseDest'});

      $('btnOpenManifest').onclick=()=>vscode.postMessage({type:'openManifest'});
      $('btnClearCache').onclick=()=>vscode.postMessage({type:'clearCache'});

      $('btnSearchLocal').onclick=()=>{ const term=$('localTerm').value.trim(); vscode.postMessage({type:'searchLocal', term}); };
      $('btnSearchCatalog').onclick=()=>{ 
        const term=$('catTerm').value.trim(); const field=$('catField').value;
        $('btnSearchCatalog').disabled = true; const sp=$('catSpin'); if(sp) sp.style.display='inline-block';
        vscode.postMessage({type:'searchCatalog', field, term}); 
      };

      // Init
      vscode.postMessage({type:'init'});

      // Messages from extension
      window.addEventListener('message', (e)=>{
        const m=e.data;
        if(m.type==='initData'){ renderSources(m.sources); renderDest(m.destDir); renderManifest(m.manifest); }
        else if(m.type==='sourcesUpdated'){ renderSources(m.sources); }
        else if(m.type==='destChanged'){ renderDest(m.destDir); }
        else if(m.type==='manifestInfo'){ renderManifest(m.manifest); }
        else if(m.type==='toast'){ const {message,level} = m; const cls = level==='ok' ? 'ok' : (level==='error' ? 'danger' : ''); const t=$('toast'); t.textContent = message; t.className = cls; setTimeout(()=>{ if($('toast').textContent===message) $('toast').textContent=''; }, 4000); }
        else if(m.type==='localResults'){ renderResults(m.rows); $('btnImportSelected').disabled = true; }
        else if(m.type==='catalogResults'){ const sp=$('catSpin'); if(sp) sp.style.display='none'; $('btnSearchCatalog').disabled = false; renderResults(m.rows); $('btnImportSelected').disabled = true; }
        else if(m.type==='imported'){ const t=$('toast'); t.textContent = 'Imported: '+m.file; t.className='ok'; setTimeout(()=>{ if($('toast').textContent===t.textContent) $('toast').textContent=''; }, 3000); }
      });
    </script>
  </body>
  </html>`;
}

async function openImportUI(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'yangImportUI', 'YANG Import', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = importWebviewHtml();

  let destDirCurrent = calcDefaultImportDirAbs();

  const postInit = async () => {
    const { sources } = modelsConfig();
    const locals = (sources as any[]).filter(s => s?.type === 'local') as LocalSource[];
    const manifest = await getManifestSummary();
    panel.webview.postMessage({
      type: 'initData',
      sources: { locals, catalog: FIXED_CATALOG },
      destDir: destDirCurrent,
      manifest
    });
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      const cfg = vscode.workspace.getConfiguration('yang.models');
      const allSources = (cfg.get('sources') as any[]) ?? [];
      const ws = getWorkspaceFolder();
      if (!ws) { vscode.window.showErrorMessage('Open a workspace first', { modal: true }); return; }

      // 初始化 / 刷新 / 设置
      if (msg.type === 'init') { await postInit(); return; }
      if (msg.type === 'refreshSources') { await postInit(); return; }
      if (msg.type === 'openSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'yang.models.sources'); return; }

      // 仅允许新增/删除 Local 源
      if (msg.type === 'addLocalSource') {
        const sel = await vscode.window.showOpenDialog({ canSelectFiles:false, canSelectFolders:true, canSelectMany:false, openLabel:'Select local folder containing YANG modules' });
        if (!sel || !sel[0]) return;
        const name = await vscode.window.showInputBox({ prompt:'Optional display name for this source', value: path.basename(sel[0].fsPath) });
        allSources.push({ type: 'local', path: sel[0].fsPath, name: name || undefined });
        await cfg.update('sources', allSources, vscode.ConfigurationTarget.Workspace);
        const locals = (allSources as any[]).filter(s => s?.type === 'local') as LocalSource[];
        panel.webview.postMessage({ type: 'sourcesUpdated', sources: { locals, catalog: FIXED_CATALOG } });
        return;
      }

      if (msg.type === 'deleteLocalSource') {
        const idxLocal = Number(msg.index);
        const localIndices: number[] = [];
        allSources.forEach((s, i) => { if (s?.type === 'local') localIndices.push(i); });
        if (idxLocal >= 0 && idxLocal < localIndices.length) {
          allSources.splice(localIndices[idxLocal], 1);
          await cfg.update('sources', allSources, vscode.ConfigurationTarget.Workspace);
        }
        const locals = (allSources as any[]).filter(s => s?.type === 'local') as LocalSource[];
        panel.webview.postMessage({ type: 'sourcesUpdated', sources: { locals, catalog: FIXED_CATALOG } });
        return;
      }

      // 目标目录：默认/选择
      if (msg.type === 'setDestDefault') {
        destDirCurrent = calcDefaultImportDirAbs();
        panel.webview.postMessage({ type: 'destChanged', destDir: destDirCurrent });
        return;
      }
      if (msg.type === 'chooseDest') {
        const sel = await vscode.window.showOpenDialog({ canSelectFiles:false, canSelectFolders:true, canSelectMany:false, openLabel:'Select destination folder' });
        if (!sel || !sel[0]) return;
        destDirCurrent = sel[0].fsPath;
        panel.webview.postMessage({ type: 'destChanged', destDir: destDirCurrent });
        return;
      }

      // Manifest / 缓存
      if (msg.type === 'openManifest') {
        const f = manifestFsPath(); if (!f) return;
        try { await fs.promises.stat(f); } catch { await writeManifest({ items: [] }); }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      if (msg.type === 'clearCache') {
        await context.globalState.update(MODELS_CACHE_KEY, {});
        panel.webview.postMessage({ type: 'toast', message: 'Catalog cache cleared', level: 'ok' });
        const manifest = await getManifestSummary();
        panel.webview.postMessage({ type: 'manifestInfo', manifest });
        return;
      }

      // 搜索
      if (msg.type === 'searchLocal') {
        const term = String(msg.term || '').trim();
        const locals = (allSources as any[]).filter(s => s?.type === 'local') as LocalSource[];
        let mods: Array<CatalogModule & { filePath: string, sourceName?: string }> = [];
        for (const s of locals) {
          const list = await scanLocalSource(s.path);
          list.forEach(x => (x as any).sourceName = s.name || path.basename(s.path));
          mods = mods.concat(list);
        }
        const filtered = term ? mods.filter(m => m.name.toLowerCase().includes(term.toLowerCase())) : mods;
        const rows = filtered.map(m => ({
          kind: 'local', name: m.name, revision: m.revision, organization: m.organization,
          where: m.filePath, from: (m as any).sourceName, filePath: m.filePath
        }));
        panel.webview.postMessage({ type: 'localResults', rows });
        return;
      }

      if (msg.type === 'searchCatalog') {
        const field = String(msg.field || 'name');
        const term = String(msg.term || '').trim();
        try {
          const list = await catalogSearch(FIXED_CATALOG.baseUrl, field, term, true, context);
          const rows = list.map(m => ({ kind: 'catalog', name: m.name, revision: m.revision, organization: m.organization, where: FIXED_CATALOG.baseUrl, baseUrl: FIXED_CATALOG.baseUrl }));
          panel.webview.postMessage({ type: 'catalogResults', rows });
        } catch (e:any) {
          // 改为弹系统错误窗口（modal），并确保 spinner 收起
          vscode.window.showErrorMessage(`Catalog search failed: ${String(e?.message || e)}`, { modal: true });
          panel.webview.postMessage({ type: 'catalogResults', rows: [] });
        }
        return;
      }

      // 导入：Local（单条）
      if (msg.type === 'importLocal') {
        const item = msg.item;
        const sourceName = (item.from || 'local').replace(/[^\w.-]+/g, '_');
        const saveDir = path.join(destDirCurrent, 'local', sourceName);
        const fileName = `${item.name}@${item.revision}.yang`;
        const dest = await copyFileTo(saveDir, item.filePath, fileName);
        const rel = path.relative(ws.uri.fsPath, dest);
        const content = await fs.promises.readFile(dest, 'utf8');
        const entry: ManifestEntry = {
          name: item.name, revision: item.revision, organization: item.organization,
          source: { type: 'local', ref: item.filePath }, destRel: rel,
          sha256: sha256Of(content), importedAt: new Date().toISOString()
        };
        await upsertManifest(entry);
        panel.webview.postMessage({ type: 'imported', file: path.basename(dest) });
        const manifest = await getManifestSummary(); panel.webview.postMessage({ type: 'manifestInfo', manifest });
        return;
      }

      // 导入：Catalog（单条）
      if (msg.type === 'importCatalog') {
        const item = msg.item;
        try {
          const orgDir = (item.organization || 'catalog').replace(/[^\w.-]+/g, '_');
          const saveDir = path.join(destDirCurrent, 'catalog', orgDir);
          const fileName = `${item.name}@${item.revision}.yang`;
          const content = await catalogDownload(FIXED_CATALOG.baseUrl, item.name, item.revision);
          const dest = await materializeTo(saveDir, fileName, content);
          const rel = path.relative(ws.uri.fsPath, dest);
          const entry: ManifestEntry = {
            name: item.name, revision: item.revision, organization: item.organization,
            source: { type: 'catalog', ref: FIXED_CATALOG.baseUrl }, destRel: rel,
            sha256: sha256Of(content), importedAt: new Date().toISOString()
          };
          await upsertManifest(entry);
          panel.webview.postMessage({ type: 'imported', file: path.basename(dest) });
          const manifest = await getManifestSummary(); panel.webview.postMessage({ type: 'manifestInfo', manifest });
        } catch (e:any) {
          vscode.window.showErrorMessage(`Catalog import failed for ${item?.name}@${item?.revision}: ${String(e?.message || e)}`, { modal: true });
        }
        return;
      }

      // ====== 批量导入（Catalog）======
      if (msg.type === 'importCatalogBatch') {
        const items = Array.isArray(msg.items) ? msg.items : [];
        for (const item of items) {
          try {
            const orgDir = (item.organization || 'catalog').replace(/[^\w.-]+/g, '_');
            const saveDir = path.join(destDirCurrent, 'catalog', orgDir);
            const fileName = `${item.name}@${item.revision}.yang`;
            const content = await catalogDownload(FIXED_CATALOG.baseUrl, item.name, item.revision);
            const dest = await materializeTo(saveDir, fileName, content);
            const rel = path.relative(ws.uri.fsPath, dest);
            const entry: ManifestEntry = {
              name: item.name, revision: item.revision, organization: item.organization,
              source: { type: 'catalog', ref: FIXED_CATALOG.baseUrl }, destRel: rel,
              sha256: sha256Of(content), importedAt: new Date().toISOString()
            };
            await upsertManifest(entry);
            panel.webview.postMessage({ type: 'imported', file: path.basename(dest) });
          } catch (e:any) {
            vscode.window.showErrorMessage(`Catalog import failed for ${item?.name}@${item?.revision}: ${String(e?.message || e)}`, { modal: true });
          }
        }
        const manifest = await getManifestSummary(); panel.webview.postMessage({ type: 'manifestInfo', manifest });
        panel.webview.postMessage({ type: 'toast', message: `Imported ${items.length} catalog item(s)`, level: 'ok' });
        return;
      }

      // ====== 批量导入（Local）======
      if (msg.type === 'importLocalBatch') {
        const items = Array.isArray(msg.items) ? msg.items : [];
        for (const item of items) {
          try {
            const sourceName = (item.from || 'local').replace(/[^\w.-]+/g, '_');
            const saveDir = path.join(destDirCurrent, 'local', sourceName);
            const fileName = `${item.name}@${item.revision}.yang`;
            const dest = await copyFileTo(saveDir, item.filePath, fileName);
            const rel = path.relative(ws.uri.fsPath, dest);
            const content = await fs.promises.readFile(dest, 'utf8');
            const entry: ManifestEntry = {
              name: item.name, revision: item.revision, organization: item.organization,
              source: { type: 'local', ref: item.filePath }, destRel: rel,
              sha256: sha256Of(content), importedAt: new Date().toISOString()
            };
            await upsertManifest(entry);
            panel.webview.postMessage({ type: 'imported', file: path.basename(dest) });
          } catch (e:any) {
            vscode.window.showErrorMessage(`Local import failed for ${item?.name}@${item?.revision}: ${String(e?.message || e)}`, { modal: true });
          }
        }
        const manifest = await getManifestSummary(); panel.webview.postMessage({ type: 'manifestInfo', manifest });
        panel.webview.postMessage({ type: 'toast', message: `Imported ${items.length} local item(s)`, level: 'ok' });
        return;
      }

    } catch (e:any) {
      vscode.window.showErrorMessage(`Error: ${String(e?.message || e)}`, { modal: true });
    }
  });

  await postInit();
}

/** 在主扩展中调用，注册 “Open_YANG_import_UI” 命令 */
export function activateImportModels(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('Open_YANG_import_UI', () => openImportUI(context))
  );
}
