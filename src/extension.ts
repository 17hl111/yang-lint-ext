/* -------------------------------------------------
 * imports
 * ------------------------------------------------- */
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

/* -------------------------------------------------
 * constants
 * ------------------------------------------------- */
const OAS_CHANNEL = vscode.window.createOutputChannel('OAS Generator');
const MODELS_CHANNEL = vscode.window.createOutputChannel('YANG Models');

const DEFAULT_IMAGE = 'yang-watcher:latest';
const DEFAULT_CONTAINER_BASE = 'yang-watcher';

const PREVIEW_DEBOUNCE_MS = 800;

const WS_KEYS = {
  lastHostDir: 'yang.oas.lastHostDir',
  lastAnnotation: 'yang.oas.lastAnnotation',
};

const MODELS_CACHE_KEY = 'yang.models.cache.v1';
const DEFAULT_IMPORT_DIR = 'imported';

/* -------------------------------------------------
 * globals
 * ------------------------------------------------- */
let client: LanguageClient;

let previewPanel: vscode.WebviewPanel | null = null;
let previewWatcher: vscode.FileSystemWatcher | null = null;
let previewDebounceTimer: NodeJS.Timeout | undefined;

let statusItem: vscode.StatusBarItem;
let statusLogItem: vscode.StatusBarItem;
let statusTimer: NodeJS.Timeout | undefined;

let extCtx: vscode.ExtensionContext | null = null;

/* -------------------------------------------------
 * utils (spawn, paths, etc.)
 * ------------------------------------------------- */
function spawnAsync(
  cmd: string,
  args: string[],
  options: cp.SpawnOptions & { cwd?: string } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { const s = d.toString(); stdout += s; OAS_CHANNEL.append(s); });
    child.stderr?.on('data', d => { const s = d.toString(); stderr += s; OAS_CHANNEL.append(s); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Windows path -> /c/... for docker -v
function toPosix(p: string): string {
  if (os.platform() !== 'win32') return p;
  const abs = path.resolve(p);
  const drive = abs.slice(0, 2); // "C:"
  const rest = abs.slice(2).replace(/\\/g, '/');
  return `/${drive[0].toLowerCase()}${rest}`;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function shortHash(s: string): string { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 6); }

function getExtVersion(context: vscode.ExtensionContext): string {
  try {
    const anyCtx: any = context as any;
    const v = anyCtx?.extension?.packageJSON?.version;
    return typeof v === 'string' ? v : 'unknown';
  } catch { return 'unknown'; }
}

/* -------------------------------------------------
 * OAS generator (保持不变)
 * ------------------------------------------------- */
function getOasNames(): { imageName: string; containerBase: string } {
  const cfg = vscode.workspace.getConfiguration('yang.oas');
  const imageName = String(cfg.get('imageName', '')).trim() || DEFAULT_IMAGE;
  const containerBase = String(cfg.get('containerName', '')).trim() || DEFAULT_CONTAINER_BASE;
  return { imageName, containerBase };
}

async function imageExists(imageName: string): Promise<boolean> {
  const res = await spawnAsync('docker', ['image', 'inspect', imageName]);
  return res.code === 0;
}

async function buildImage(imageName: string, dockerContextFsPath: string): Promise<boolean> {
  OAS_CHANNEL.appendLine(`==> Building image: ${imageName}`);
  OAS_CHANNEL.appendLine(`cwd: ${dockerContextFsPath}`);
  const buildRes = await spawnAsync('docker', ['build', '-t', imageName, '.'], { cwd: dockerContextFsPath });
  if (buildRes.code !== 0) {
    vscode.window.showErrorMessage('Build image failed. See "OAS Generator" output for details.');
    return false;
  }
  vscode.window.showInformationMessage(`Image built successfully: ${imageName}`);
  return true;
}

function computeWsHashFromContext(context: vscode.ExtensionContext): string | null {
  const fromState = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  const base = fromState || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return base ? shortHash(path.resolve(base)) : null;
}

async function waitForStableFile(uri: vscode.Uri, timeoutMs = 20_000, pollMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s1 = await vscode.workspace.fs.stat(uri);
      if (s1.size > 0) {
        await sleep(pollMs);
        const s2 = await vscode.workspace.fs.stat(uri);
        if (s1.mtime === s2.mtime && s1.size === s2.size) return true;
      }
    } catch {}
    await sleep(pollMs);
  }
  return false;
}

function disposePreviewWatcher() { try { previewWatcher?.dispose(); } catch {} previewWatcher = null; }
function debounced(fn: () => void, ms: number) { if (previewDebounceTimer) clearTimeout(previewDebounceTimer); previewDebounceTimer = setTimeout(fn, ms); }

async function getContainerStatus(context: vscode.ExtensionContext): Promise<'Up'|'Exited'> {
  const wsHash = computeWsHashFromContext(context);
  if (!wsHash) return 'Exited';
  try {
    const psRes = await spawnAsync('docker', [
      'ps',
      '--filter', 'label=app=yang-oas',
      '--filter', `label=ws=${wsHash}`,
      '--format', '{{.Names}}\t{{.Status}}'
    ]);
    const up = psRes.stdout.split('\n').some(line => /\tUp\b/.test(line));
    return up ? 'Up' : 'Exited';
  } catch { return 'Exited'; }
}

function escapeHtml(s: string) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
function fmtBytes(n: number): string { if (n < 1024) return `${n} B`; const u=['KB','MB','GB','TB'];let i=-1,v=n;do{v/=1024;i++;}while(v>=1024&&i<u.length-1);return `${v.toFixed(v>=10?0:1)} ${u[i]}`; }
function fmtMtime(ms: number): string { try { return new Date(ms).toLocaleString(); } catch { return `${ms}`; } }

function loadingHtml(filePath: string) {
  return `
  <!doctype html>
  <html><head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root{--fg:var(--vscode-editor-foreground);--bg:var(--vscode-editor-background);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-editorWidget-border);--badge-bg:var(--vscode-badge-background);--badge-fg:var(--vscode-badge-foreground)}
    body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,Consolas,"Courier New",monospace}
    .top{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border)}
    .badge{padding:2px 6px;border-radius:10px;background:var(--badge-bg);color:var(--badge-fg);font-size:12px}
    .content{padding:10px}
    .center{display:flex;align-items:center;justify-content:center;min-height:120px;color:var(--muted);gap:10px}
    .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}.dot.up{background:#2ea043}.dot.exited{background:#d22}
    .spin{width:16px;height:16px;border:2px solid var(--muted);border-top-color:transparent;border-radius:50%;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(1turn)}}
  </style></head>
  <body>
    <div class="top">
      <span class="badge">Loading…</span>
      <span>${escapeHtml(filePath)}</span>
      <span class="badge"><span id="dot" class="dot up"></span><span id="cstat">Up</span></span>
    </div>
    <div class="content"><div class="center"><span class="spin"></span> Waiting for stable output…</div></div>
    <script>
      const vscode = acquireVsCodeApi();
      window.addEventListener('message', (e) => {
        const m=e.data; if(m && m.type==='containerStatus'){ const s=m.status==='Up'?'Up':'Exited'; const dot=document.getElementById('dot'); const txt=document.getElementById('cstat'); if(dot&&txt){dot.className='dot '+(s==='Up'?'up':'exited'); txt.textContent=s;} }
      });
    </script>
  </body></html>`;
}

async function renderPreview(filePath: string, title: string, context: vscode.ExtensionContext) {
  let size=0, mtime=0;
  try { const s = await vscode.workspace.fs.stat(vscode.Uri.file(filePath)); size=s.size; mtime=s.mtime; } catch {}
  let text=''; let parseOk=true;
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    text = new TextDecoder('utf-8').decode(buf);
    if (text.trim().length===0) parseOk=false; else JSON.parse(text);
  } catch { parseOk=false; }
  const containerStatus = await getContainerStatus(context);
  const statusDotClass = containerStatus==='Up'?'dot up':'dot exited';

  const html = `
  <!doctype html>
  <html><head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root{--fg:var(--vscode-editor-foreground);--bg:var(--vscode-editor-background);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-editorWidget-border);--badge-bg:var(--vscode-badge-background);--badge-fg:var(--vscode-badge-foreground)}
    body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,Consolas,"Courier New",monospace}
    .top{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border)}
    .badge{padding:2px 6px;border-radius:10px;background:var(--badge-bg);color:var(--badge-fg);font-size:12px}
    .content{padding:10px}
    pre{white-space:pre;overflow:auto}
    .empty{padding:24px;border:1px dashed var(--border);border-radius:12px;color:var(--muted);text-align:center}
    .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}.dot.up{background:#2ea043}.dot.exited{background:#d22}
  </style></head>
  <body>
    <div class="top">
      <span class="badge">${escapeHtml(path.basename(filePath))}</span>
      <span class="badge">${fmtBytes(size)}</span>
      <span class="badge">${fmtMtime(mtime)}</span>
      <span class="badge"><span class="${statusDotClass}"></span>${escapeHtml(containerStatus)}</span>
    </div>
    <div class="content">${
      parseOk ? `<pre>${escapeHtml(text)}</pre>` :
      `<div class="empty">No valid output to display.</div>`
    }</div>
  </body></html>`;
  previewPanel!.webview.html = html;
  previewPanel!.title = title;
}

async function showOrUpdatePreview(filePath: string, title: string, context: vscode.ExtensionContext) {
  const doRenderStable = async () => {
    const ok = await waitForStableFile(vscode.Uri.file(filePath), 5000, 200);
    await renderPreview(filePath, title, context);
    if (!ok) { /* watcher will retrigger */ }
  };

  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel(
      'oasPreview', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    previewPanel.onDidDispose(() => { disposePreviewWatcher(); previewPanel=null; });
  }

  previewPanel.webview.html = loadingHtml(filePath);

  disposePreviewWatcher();
  previewWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))
  );
  const trigger = () => { if (previewPanel) { if (previewDebounceTimer) clearTimeout(previewDebounceTimer); previewDebounceTimer=setTimeout(doRenderStable, PREVIEW_DEBOUNCE_MS);} };
  previewWatcher.onDidChange(trigger);
  previewWatcher.onDidCreate(trigger);
  previewWatcher.onDidDelete(trigger);

  await doRenderStable();
}

async function updateStatusBar(context: vscode.ExtensionContext) {
  let status: 'Up' | 'Exited' = 'Exited';
  const wsHash = computeWsHashFromContext(context);
  if (wsHash) {
    try {
      const psRes = await spawnAsync('docker', [
        'ps','--filter','label=app=yang-oas','--filter',`label=ws=${wsHash}`,'--format','{{.Names}}\t{{.Status}}'
      ]);
      status = psRes.stdout.split('\n').some(line => /\tUp\b/.test(line)) ? 'Up' : 'Exited';
    } catch {}
  }
  const annotation = !!context.workspaceState.get<boolean>(WS_KEYS.lastAnnotation, false);
  const fileLabel = annotation ? 'filtered-oas3.json' : 'oas3.json';

  statusItem.text = `$(container) OAS: ${status} | ${fileLabel}`;
  statusItem.tooltip = 'Click to switch preview (oas3.json / filtered-oas3.json)';
  statusItem.command = 'oas.switchAnnotation';
  statusItem.show();

  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  statusLogItem.text = '$(output) OAS Log';
  statusLogItem.tooltip = hostDir ? `Open ${path.join(hostDir,'watch-yang.log')}` : 'Log path unknown';
  statusLogItem.command = 'oas.openWatcherLog';
  statusLogItem.show();
}

function startStatusPolling(context: vscode.ExtensionContext) {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => { updateStatusBar(context).catch(()=>{}); }, 5000);
}

/* -------------------------------------------------
 * OAS commands (保持)
 * ------------------------------------------------- */
async function runOasGeneratorCommand(context: vscode.ExtensionContext) {
  try {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { vscode.window.showErrorMessage('No workspace is open.'); return; }

    const dockerContextFsPath = path.join(context.extensionPath, 'oas_generator');
    OAS_CHANNEL.clear(); OAS_CHANNEL.show(true);

    const { imageName, containerBase } = getOasNames();
    const exists = await imageExists(imageName);
    if (exists) {
      const choice = await vscode.window.showQuickPick(
        [{label:`Use existing image (${imageName})`, action:'use' as const},{label:`rebuild OAS GENERATOR image (${imageName})`, action:'rebuild' as const}],
        { placeHolder:`Image ${imageName} already exists` }
      );
      if (!choice) return;
      if (choice.action==='rebuild') { if (!await buildImage(imageName, dockerContextFsPath)) return; }
    } else {
      if (!await buildImage(imageName, dockerContextFsPath)) return;
    }

    const defaultHostModulesDir = wsFolder.uri.fsPath;
    const hostModulesDir = await vscode.window.showInputBox({ title:'HOST_MODULES_DIR', value: defaultHostModulesDir, ignoreFocusOut:true });
    if (!hostModulesDir) return;

    const modulesSubdir = await vscode.window.showInputBox({ title:'MODULES_SUBDIR', value:'arp', ignoreFocusOut:true }); if (!modulesSubdir) return;
    const modelFileName = await vscode.window.showInputBox({ title:'MODEL_FILE_NAME', placeHolder:'ipNetToMediaTable.yang', ignoreFocusOut:true, validateInput:v=>v.trim().endsWith('.yang')?null:'Need a .yang file' });
    if (!modelFileName) return;

    const annotationPick = await vscode.window.showQuickPick([{label:'true'},{label:'false'}], { title:'ANNOTATION', ignoreFocusOut:true }); if (!annotationPick) return;
    const annotationVal = annotationPick.label as 'true'|'false';

    await context.workspaceState.update(WS_KEYS.lastHostDir, hostModulesDir);
    await context.workspaceState.update(WS_KEYS.lastAnnotation, annotationVal==='true');

    const wsHash = shortHash(path.resolve(hostModulesDir));
    const effectiveContainerName = `${DEFAULT_CONTAINER_BASE}-${wsHash}`;
    const extVersion = getExtVersion(context);

    await spawnAsync('docker', ['ps','-aq','--filter','label=app=yang-oas','--filter',`label=ws=${wsHash}`]).then(async ({stdout})=>{
      const ids=stdout.split('\n').map(s=>s.trim()).filter(Boolean); if(ids.length) await spawnAsync('docker',['rm','-f',...ids],{});
    }).catch(()=>{});
    await spawnAsync('docker', ['rm','-f', effectiveContainerName], {});

    const volHost = toPosix(path.resolve(hostModulesDir));
    const envs = [
      '-e','WATCH_DIR=/workdir',
      '-e',`MODULES=/workdir/${modulesSubdir}`,
      '-e',`MODEL_FILE=/workdir/${modulesSubdir}/${modelFileName}`,
      '-e',`MODEL_FILE_NAME=${modelFileName}`,
      '-e','OUTPUT=/workdir/output/swagger.json',
      '-e','OAS_OUTPUT=/workdir/output/oas3.json',
      '-e',`ANNOTATION=${annotationVal}`,
    ];
    const labels = [
      '--label','app=yang-oas','--label',`ws=${wsHash}`,
      '--label','ext=yang-lint-ext','--label',`ext_version=${extVersion}`,
      '--label',`image=${DEFAULT_IMAGE}`,'--label',`container_base=${DEFAULT_CONTAINER_BASE}`,
    ];
    const runArgs = ['run','-d','--name',effectiveContainerName, ...labels, '-v', `${volHost}:/workdir:rw`, '-w','/workdir', ...envs, DEFAULT_IMAGE];
    const runRes = await spawnAsync('docker', runArgs, {}); if (runRes.code!==0) { vscode.window.showErrorMessage('Failed to start container.'); return; }

    const psRes = await spawnAsync('docker', ['ps','--filter','label=app=yang-oas','--filter',`label=ws=${wsHash}`,'--format','{{.Names}}\t{{.Status}}']);
    if (!psRes.stdout.split('\n').some(line=>/\tUp\b/.test(line))) { vscode.window.showWarningMessage('Container is not running.'); return; }

    vscode.window.showInformationMessage('OAS watcher container started. Edit your YANG files to produce output.');
    const targetFileName = annotationVal==='true' ? 'filtered-oas3.json' : 'oas3.json';
    const targetFsPath = path.join(hostModulesDir,'output',targetFileName);
    const appeared = await waitForStableFile(vscode.Uri.file(targetFsPath), 20_000, 200);
    if (!appeared) { vscode.window.showWarningMessage(`Unable to detect a stable ${targetFileName}.`); return; }
    await showOrUpdatePreview(targetFsPath, `OAS Preview · ${targetFileName}`, context);
    await updateStatusBar(context);
  } catch (err: any) {
    OAS_CHANNEL.appendLine(String(err?.stack || err));
    vscode.window.showErrorMessage('Error running OAS generator command.');
  }
}

async function rebuildGeneratorImageCommand(context: vscode.ExtensionContext) {
  try {
    const dockerContextFsPath = path.join(context.extensionPath, 'oas_generator');
    OAS_CHANNEL.clear(); OAS_CHANNEL.show(true);
    const { imageName } = getOasNames();
    if (!await buildImage(imageName, dockerContextFsPath)) return;
    await updateStatusBar(context);
  } catch (err: any) {
    OAS_CHANNEL.appendLine(String(err?.stack || err));
    vscode.window.showErrorMessage('Error rebuilding image.');
  }
}

async function stopContainerCommand(context: vscode.ExtensionContext) {
  const wsHash = computeWsHashFromContext(context);
  if (!wsHash) { vscode.window.showWarningMessage('No known workspace path.'); return; }
  const listRes = await spawnAsync('docker', ['ps','-aq','--filter','label=app=yang-oas','--filter',`label=ws=${wsHash}`]);
  const ids = listRes.stdout.split('\n').map(s=>s.trim()).filter(Boolean);
  if (ids.length) { await spawnAsync('docker',['rm','-f',...ids],{}); vscode.window.showInformationMessage(`Removed ${ids.length} OAS container(s).`); }
  else vscode.window.showInformationMessage('No matching OAS containers found to stop.');
  await updateStatusBar(context);
}

async function openOutputFolderCommand(context: vscode.ExtensionContext) {
  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  if (!hostDir) { vscode.window.showWarningMessage('Output path unknown.'); return; }
  const uri = vscode.Uri.file(path.join(hostDir,'output'));
  try { await vscode.workspace.fs.stat(uri); } catch { vscode.window.showWarningMessage('Output folder does not exist.'); return; }
  await vscode.commands.executeCommand('revealInExplorer', uri);
}

async function switchAnnotationCommand(context: vscode.ExtensionContext) {
  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  if (!hostDir) { vscode.window.showWarningMessage('Preview path unknown.'); return; }
  const current = !!context.workspaceState.get<boolean>(WS_KEYS.lastAnnotation,false);
  const pick = await vscode.window.showQuickPick([{label:'true'},{label:'false'}], { title:`ANNOTATION (current: ${current?'true':'false'})` }); if (!pick) return;
  const newVal = pick.label==='true'; await context.workspaceState.update(WS_KEYS.lastAnnotation, newVal);
  const targetFileName = newVal ? 'filtered-oas3.json' : 'oas3.json';
  const targetFsPath = path.join(hostDir,'output',targetFileName);
  await showOrUpdatePreview(targetFsPath, `OAS Preview · ${targetFileName}`, context);
  await updateStatusBar(context);
}

async function openWatcherLogCommand(context: vscode.ExtensionContext) {
  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  if (!hostDir) { vscode.window.showWarningMessage('Log path unknown.'); return; }
  const uri = vscode.Uri.file(path.join(hostDir, 'watch-yang.log'));
  try { await vscode.workspace.fs.stat(uri); } catch { vscode.window.showWarningMessage('Log file does not exist.'); return; }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
}

/* -------------------------------------------------
 * ====== YANG Import: 配置 / 搜索 / 下载 / Manifest ======
 * ------------------------------------------------- */
type LocalSource = { type: 'local'; path: string; name?: string };
type CatalogSource = { type: 'catalog'; baseUrl: string; name?: string };
type YangSource = LocalSource | CatalogSource;

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
  const sources = (cfg.get('sources') as any[]) ?? [];
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
      if (out && out.length) { await cacheSet(extCtx!, key, out); return out; }
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

/* -------------------------------------------------
 * Webview: Open_YANG_import_UI
 * ------------------------------------------------- */
function webviewHtml(): string {
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
            <div class="row"><b>Catalog sources</b> <button id="btnAddCatalog">Add…</button></div>
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
            </div>
          </div>
        </div>
      </div>

      <div class="card section">
        <h2>Results</h2>
        <div class="row small muted" id="resultsHint">No results yet.</div>
        <div style="overflow:auto">
          <table id="resultsTable" style="display:none">
            <thead><tr><th>Name</th><th>Revision</th><th>Org/From</th><th>Where</th><th></th></tr></thead>
            <tbody id="resultsBody"></tbody>
          </table>
        </div>
      </div>

      <div class="footer small">
        <div>Tip: manage sources in <span class="kbd">Settings</span> – search <span class="kbd">yang.models.sources</span></div>
        <div id="toast" class="muted"></div>
      </div>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const $ = (id)=>document.getElementById(id);
      const toast=(s,cls='')=>{ const t=$('toast'); t.textContent=s; t.className = cls; setTimeout(()=>{ if($('toast').textContent===s) $('toast').textContent=''; }, 4000); };

      function renderSources(data){
        const {locals,catalogs} = data;
        const localList = $('localList'); const catList = $('catalogList');
        localList.innerHTML = ''; catList.innerHTML = '';
        if(!locals.length) localList.innerHTML = '<span class="muted">No local sources</span>';
        locals.forEach((s,i)=>{
          const div = document.createElement('div'); div.className='row';
          div.innerHTML = '<span class="pill">local</span><b>'+ (s.name||'(unnamed)') +'</b><span class="muted">'+s.path+'</span>';
          const del=document.createElement('button'); del.textContent='Delete'; del.className='danger small'; del.onclick=()=>vscode.postMessage({type:'deleteSource', index:i});
          div.appendChild(del); localList.appendChild(div);
        });
        if(!catalogs.length) catList.innerHTML = '<span class="muted">No catalog sources</span>';
        catalogs.forEach((s,i)=>{
          const div = document.createElement('div'); div.className='row';
          div.innerHTML = '<span class="pill">catalog</span><b>'+ (s.name||'(unnamed)') +'</b><span class="muted">'+s.baseUrl+'</span>';
          const del=document.createElement('button'); del.textContent='Delete'; del.className='danger small'; del.onclick=()=>vscode.postMessage({type:'deleteSource', index: locals.length + i});
          div.appendChild(del); catList.appendChild(div);
        });
      }
      function renderDest(s){ $('dest').textContent = s; }
      function renderManifest(m){ $('mCount').textContent = m.count; $('mTime').textContent = m.lastUpdated || '-'; }
      function renderResults(rows){
        const tb=$('resultsBody'); tb.innerHTML='';
        const table=$('resultsTable'), hint=$('resultsHint');
        if(!rows.length){ table.style.display='none'; hint.style.display='block'; hint.textContent='No results.'; return; }
        table.style.display='table'; hint.style.display='none';
        rows.forEach((r,idx)=>{
          const tr=document.createElement('tr');
          tr.innerHTML='<td>'+r.name+'</td><td>'+r.revision+'</td><td>'+(r.organization||r.from||'')+'</td><td class="small muted">'+(r.where||'')+'</td>';
          const td=document.createElement('td'); const btn=document.createElement('button'); btn.textContent='Import';
          btn.onclick=()=>{ if(r.kind==='local'){ vscode.postMessage({type:'importLocal', item:r}); } else { vscode.postMessage({type:'importCatalog', item:r}); } };
          td.appendChild(btn); tr.appendChild(td); tb.appendChild(tr);
        });
      }

      // Events
      $('btnRefresh').onclick=()=>vscode.postMessage({type:'refreshSources'});
      $('btnOpenSettings').onclick=()=>vscode.postMessage({type:'openSettings'});

      $('btnAddLocal').onclick=()=>vscode.postMessage({type:'addLocalSource'});
      $('btnAddCatalog').onclick=()=>{ const baseUrl=prompt('Catalog baseUrl (e.g. https://www.yangcatalog.org)'); if(!baseUrl) return; const name=prompt('Optional display name'); vscode.postMessage({type:'addCatalogSource', baseUrl, name}); };

      $('btnUseDefault').onclick=()=>vscode.postMessage({type:'setDestDefault'});
      $('btnChooseFolder').onclick=()=>vscode.postMessage({type:'chooseDest'});

      $('btnOpenManifest').onclick=()=>vscode.postMessage({type:'openManifest'});
      $('btnClearCache').onclick=()=>vscode.postMessage({type:'clearCache'});

      $('btnSearchLocal').onclick=()=>{ const term=$('localTerm').value.trim(); vscode.postMessage({type:'searchLocal', term}); };
      $('btnSearchCatalog').onclick=()=>{ const term=$('catTerm').value.trim(); const field=$('catField').value; vscode.postMessage({type:'searchCatalog', field, term}); };

      // Init
      vscode.postMessage({type:'init'});

      // Messages from extension
      window.addEventListener('message', (e)=>{
        const m=e.data;
        if(m.type==='initData'){ renderSources(m.sources); renderDest(m.destDir); renderManifest(m.manifest); }
        else if(m.type==='sourcesUpdated'){ renderSources(m.sources); toast('Sources updated','ok'); }
        else if(m.type==='destChanged'){ renderDest(m.destDir); toast('Destination changed','ok'); }
        else if(m.type==='manifestInfo'){ renderManifest(m.manifest); }
        else if(m.type==='toast'){ toast(m.message, m.level||''); }
        else if(m.type==='localResults'){ renderResults(m.rows); }
        else if(m.type==='catalogResults'){ renderResults(m.rows); }
        else if(m.type==='imported'){ toast('Imported: '+m.file,'ok'); }
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
  panel.webview.html = webviewHtml();

  // 当前 UI 会话中的“导入目标目录”，默认使用 settings 指定的默认目录
  let destDirCurrent = calcDefaultImportDirAbs();

  const postInit = async () => {
    const { sources } = modelsConfig();
    const locals = (sources as YangSource[]).filter(s => s.type === 'local') as LocalSource[];
    const catalogs = (sources as YangSource[]).filter(s => s.type === 'catalog') as CatalogSource[];
    const manifest = await getManifestSummary();
    panel.webview.postMessage({
      type: 'initData',
      sources: { locals, catalogs },
      destDir: destDirCurrent,
      manifest
    });
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      const cfg = vscode.workspace.getConfiguration('yang.models');
      const sources = (cfg.get('sources') as any[]) ?? [];
      const ws = getWorkspaceFolder();
      if (!ws) {
        panel.webview.postMessage({ type: 'toast', message: 'Open a workspace first' });
        return;
      }

      // 初始化 / 刷新 / 打开设置
      if (msg.type === 'init') { await postInit(); return; }
      if (msg.type === 'refreshSources') { await postInit(); return; }
      if (msg.type === 'openSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'yang.models.sources');
        return;
      }

      // 资源源管理：新增/删除
      if (msg.type === 'addLocalSource') {
        const sel = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Select local folder containing YANG modules'
        });
        if (!sel || !sel[0]) return;
        const name = await vscode.window.showInputBox({
          prompt: 'Optional display name for this source',
          value: path.basename(sel[0].fsPath)
        });
        sources.push({ type: 'local', path: sel[0].fsPath, name: name || undefined });
        await cfg.update('sources', sources, vscode.ConfigurationTarget.Workspace);
        const locals = (sources as YangSource[]).filter(s => s.type === 'local') as LocalSource[];
        const catalogs = (sources as YangSource[]).filter(s => s.type === 'catalog') as CatalogSource[];
        panel.webview.postMessage({ type: 'sourcesUpdated', sources: { locals, catalogs } });
        return;
      }

      if (msg.type === 'addCatalogSource') {
        const baseUrl = String(msg.baseUrl || '').trim();
        if (!baseUrl) return;
        const name = msg.name ? String(msg.name).trim() : undefined;
        sources.push({ type: 'catalog', baseUrl, name });
        await cfg.update('sources', sources, vscode.ConfigurationTarget.Workspace);
        const locals = (sources as YangSource[]).filter(s => s.type === 'local') as LocalSource[];
        const catalogs = (sources as YangSource[]).filter(s => s.type === 'catalog') as CatalogSource[];
        panel.webview.postMessage({ type: 'sourcesUpdated', sources: { locals, catalogs } });
        return;
      }

      if (msg.type === 'deleteSource') {
        const idx = Number(msg.index);
        if (idx >= 0 && idx < sources.length) {
          sources.splice(idx, 1);
          await cfg.update('sources', sources, vscode.ConfigurationTarget.Workspace);
          const locals = (sources as YangSource[]).filter(s => s.type === 'local') as LocalSource[];
          const catalogs = (sources as YangSource[]).filter(s => s.type === 'catalog') as CatalogSource[];
          panel.webview.postMessage({ type: 'sourcesUpdated', sources: { locals, catalogs } });
        }
        return;
      }

      // 目标目录：默认/选择
      if (msg.type === 'setDestDefault') {
        destDirCurrent = calcDefaultImportDirAbs();
        panel.webview.postMessage({ type: 'destChanged', destDir: destDirCurrent });
        return;
      }
      if (msg.type === 'chooseDest') {
        const sel = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Select destination folder'
        });
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
        const locals = (sources as YangSource[]).filter(s => s.type === 'local') as LocalSource[];
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
        const catalogs = (sources as YangSource[]).filter(s => s.type === 'catalog') as CatalogSource[];
        const baseUrl = (catalogs[0]?.baseUrl) || 'https://www.yangcatalog.org';
        try {
          const list = await catalogSearch(baseUrl, field, term, true, context);
          const rows = list.map(m => ({ kind: 'catalog', name: m.name, revision: m.revision, organization: m.organization, where: baseUrl, baseUrl }));
          panel.webview.postMessage({ type: 'catalogResults', rows });
        } catch (e: any) {
          panel.webview.postMessage({ type: 'toast', message: String(e?.message || e) });
          panel.webview.postMessage({ type: 'catalogResults', rows: [] });
        }
        return;
      }

      // 导入：Local
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

      // 导入：Catalog
      if (msg.type === 'importCatalog') {
        const item = msg.item;
        const baseUrl = String(item.baseUrl || 'https://www.yangcatalog.org');
        const orgDir = (item.organization || 'catalog').replace(/[^\w.-]+/g, '_');
        const saveDir = path.join(destDirCurrent, 'catalog', orgDir);
        const fileName = `${item.name}@${item.revision}.yang`;
        const content = await catalogDownload(baseUrl, item.name, item.revision);
        const dest = await materializeTo(saveDir, fileName, content);
        const rel = path.relative(ws.uri.fsPath, dest);
        const entry: ManifestEntry = {
          name: item.name, revision: item.revision, organization: item.organization,
          source: { type: 'catalog', ref: baseUrl }, destRel: rel,
          sha256: sha256Of(content), importedAt: new Date().toISOString()
        };
        await upsertManifest(entry);
        panel.webview.postMessage({ type: 'imported', file: path.basename(dest) });
        const manifest = await getManifestSummary(); panel.webview.postMessage({ type: 'manifestInfo', manifest });
        return;
      }

    } catch (e: any) {
      panel.webview.postMessage({ type: 'toast', message: `Error: ${String(e?.message || e)}` });
    }
  });

  await postInit();
}

/* -------------------------------------------------
 * activate / deactivate
 * ------------------------------------------------- */
export function activate(context: vscode.ExtensionContext) {
  extCtx = context;

  // LSP (保持)
  try {
    const serverModule = context.asAbsolutePath(path.join('out','server','index.js'));
    const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv:['--nolazy','--inspect=6009'] } }
    };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme:'file', language:'yang' }],
      synchronize: { configurationSection:'yangeditor', fileEvents: vscode.workspace.createFileSystemWatcher('**/ruleSets/*.{yaml,yml}') }
    };
    client = new LanguageClient('yangLint','YANG Lint Server', serverOptions, clientOptions);
    client.start();
  } catch {
    vscode.window.showWarningMessage('Failed to start YANG LSP. Please check the build artifacts and paths.');
  }

  // OAS commands
  context.subscriptions.push(
    vscode.commands.registerCommand('yang.toggleRuleSet', async () => {
      const cfg  = vscode.workspace.getConfiguration('yangeditor');
      const curr = cfg.get<string>('ruleSet');
      const pick = await vscode.window.showQuickPick(['create','update'], { placeHolder:`Current: ${curr}` });
      if (pick && pick !== curr) { await cfg.update('ruleSet', pick, vscode.ConfigurationTarget.Workspace); vscode.window.showInformationMessage(`Rule set switched to '${pick}'.`); }
    }),
    vscode.commands.registerCommand('oas.generator', () => runOasGeneratorCommand(context)),
    vscode.commands.registerCommand('oas.rebuildGeneratorImage', () => rebuildGeneratorImageCommand(context)),
    vscode.commands.registerCommand('oas.stopContainer', () => stopContainerCommand(context)),
    vscode.commands.registerCommand('oas.openOutputFolder', () => openOutputFolderCommand(context)),
    vscode.commands.registerCommand('oas.switchAnnotation', () => switchAnnotationCommand(context)),
    vscode.commands.registerCommand('oas.openWatcherLog', () => openWatcherLogCommand(context)),
  );

  // NEW: 打开 Import UI
  context.subscriptions.push(
    vscode.commands.registerCommand('Open_YANG_import_UI', () => openImportUI(context))
  );

  // status bar
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusLogItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(statusItem, statusLogItem);
  updateStatusBar(context).catch(()=>{});
  startStatusPolling(context);
}

export async function deactivate() {
  try { await client?.stop(); } catch {}
  if (statusTimer) clearInterval(statusTimer);
  try { statusItem?.dispose(); statusLogItem?.dispose(); } catch {}
  try { previewWatcher?.dispose(); } catch {}
  try { previewPanel?.dispose(); } catch {}
}
