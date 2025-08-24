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

// Defaults (overridable via settings)
const DEFAULT_IMAGE = 'yang-watcher:latest';
const DEFAULT_CONTAINER_BASE = 'yang-watcher';

// Preview debounce
const PREVIEW_DEBOUNCE_MS = 800;

// workspaceState keys
const WS_KEYS = {
  lastHostDir: 'yang.oas.lastHostDir',
  lastAnnotation: 'yang.oas.lastAnnotation', // boolean
};

// models keys & defaults
const MODELS_CACHE_KEY = 'yang.models.cache.v1';
const DEFAULT_IMPORT_DIR = 'imported'; // << 第一阶段要求：默认导入到工作区下的 "imported"

/* -------------------------------------------------
 * globals
 * ------------------------------------------------- */
let client: LanguageClient;

let previewPanel: vscode.WebviewPanel | null = null;
let previewWatcher: vscode.FileSystemWatcher | null = null;
let previewPath: string | null = null;
let previewDebounceTimer: NodeJS.Timeout | undefined;

let statusItem: vscode.StatusBarItem;
let statusLogItem: vscode.StatusBarItem;
let statusTimer: NodeJS.Timeout | undefined;

// hold ExtensionContext for deactivate cleanup
let extCtx: vscode.ExtensionContext | null = null;

/* -------------------------------------------------
 * utils
 * ------------------------------------------------- */

// spawn and stream into output
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------
 * settings / image / build
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

/* -------------------------------------------------
 * container naming & labels
 * ------------------------------------------------- */
function shortHash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);
}

function computeWsHashFromContext(context: vscode.ExtensionContext): string | null {
  const fromState = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  const base = fromState || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return base ? shortHash(path.resolve(base)) : null;
}

function getExtVersion(context: vscode.ExtensionContext): string {
  try {
    const anyCtx: any = context as any;
    const v = anyCtx?.extension?.packageJSON?.version;
    return typeof v === 'string' ? v : 'unknown';
  } catch { return 'unknown'; }
}

/* -------------------------------------------------
 * path hygiene
 * ------------------------------------------------- */
function detectPathIssues(p: string): string[] {
  const issues: string[] = [];
  if (/ {2,}/.test(p)) issues.push('contains consecutive spaces');
  if (/\s$/.test(p)) issues.push('has a trailing space');
  if (/[\u0000-\u001F\u007F]/.test(p)) issues.push('contains invisible/control characters (e.g., tab/CR/LF)');
  if (/[^\x00-\x7F]/.test(p)) issues.push('contains non-ASCII characters');
  return issues;
}

async function promptHostModulesDirWithValidation(defaultPath: string): Promise<string | undefined> {
  let last = defaultPath;
  for (;;) {
    const input = await vscode.window.showInputBox({
      title: 'HOST_MODULES_DIR (absolute host path to mount)',
      value: last,
      ignoreFocusOut: true
    });
    if (!input) return undefined;

    const issues = detectPathIssues(input);
    if (issues.length === 0) return input;

    const msg =
      `The selected path has the following issues: ${issues.join(', ')}.\n` +
      `Path: ${input}\n\n` +
      `Click "Continue" to use it anyway, or press "Cancel" to re-enter the path.`;

    const choice = await vscode.window.showWarningMessage(msg, { modal: true }, 'Continue');
    if (choice === 'Continue') return input;

    last = input; // go back to re-enter
  }
}

/* -------------------------------------------------
 * file stability (mtime + size)
 * ------------------------------------------------- */
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
    } catch {
      // not exists yet
    }
    await sleep(pollMs);
  }
  return false;
}

/* -------------------------------------------------
 * preview (A: theme-aware UI, action bar, wrap toggle, spinner, empty states)
 * ------------------------------------------------- */
function disposePreviewWatcher() {
  try { previewWatcher?.dispose(); } catch {}
  previewWatcher = null;
}

function debounced(fn: () => void, ms: number) {
  if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(fn, ms);
}

function setPreviewWatcher(filePath: string, render: () => void) {
  disposePreviewWatcher();
  previewWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))
  );
  const trigger = () => debounced(render, PREVIEW_DEBOUNCE_MS);
  previewWatcher.onDidChange(trigger);
  previewWatcher.onDidCreate(trigger);
  previewWatcher.onDidDelete(trigger);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB','MB','GB','TB']; let i = -1; let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
function fmtMtime(ms: number): string {
  try {
    const d = new Date(ms);
    return `${d.toLocaleString()}`;
  } catch { return `${ms}`; }
}

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

function loadingHtml(filePath: string) {
  // Loading skeleton with updatable status via postMessage
  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
      :root{
        --fg: var(--vscode-editor-foreground);
        --bg: var(--vscode-editor-background);
        --muted: var(--vscode-descriptionForeground);
        --border: var(--vscode-editorWidget-border);
        --badge-bg: var(--vscode-badge-background);
        --badge-fg: var(--vscode-badge-foreground);
        --link: var(--vscode-textLink-foreground);
      }
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
      .top{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border)}
      .meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .badge{padding:2px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:12px}
      .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
      .dot.up{background:#2ea043} .dot.exited{background:#d22}
      .actions{display:flex;gap:6px}
      button{border:1px solid var(--border);background:transparent;color:var(--fg);padding:4px 8px;border-radius:6px}
      .content{padding:10px}
      .center{display:flex;align-items:center;justify-content:center;min-height:120px;color:var(--muted);gap:10px}
      .spin{width:16px;height:16px;border:2px solid var(--muted);border-top-color:transparent;border-radius:50%;animation:sp 1s linear infinite}
      @keyframes sp{to{transform:rotate(1turn)}}
      .path{color:var(--muted);word-break:break-all}
    </style>
  </head>
  <body>
    <div class="top">
      <div class="meta">
        <span class="badge">Loading…</span>
        <span class="badge">Preview</span>
        <span class="path">${escapeHtml(filePath)}</span>
        <span class="badge"><span id="dot" class="dot up"></span><span id="cstat">Up</span></span>
      </div>
      <div class="actions">
        <button disabled>Open in Explorer</button>
        <button disabled>Open Log</button>
        <button disabled>Switch Target</button>
        <button disabled>Wrap</button>
      </div>
    </div>
    <div class="content">
      <div class="center"><span class="spin"></span> Waiting for stable output…</div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (m && m.type === 'containerStatus') {
          const s = m.status === 'Up' ? 'Up' : 'Exited';
          const dot = document.getElementById('dot');
          const txt = document.getElementById('cstat');
          if (dot && txt) {
            dot.className = 'dot ' + (s === 'Up' ? 'up' : 'exited');
            txt.textContent = s;
          }
        }
      });
    </script>
  </body>
  </html>`;
}

async function renderPreview(filePath: string, title: string, context: vscode.ExtensionContext) {
  // stat for size/mtime; read file
  let size = 0;
  let mtime = 0;
  try {
    const s = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    size = s.size;
    mtime = s.mtime;
  } catch { /* ignore */ }

  let text = '';
  let parseOk = true;
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    text = new TextDecoder('utf-8').decode(buf);
    if (text.trim().length === 0) parseOk = false;
    else JSON.parse(text); // validate JSON
  } catch {
    parseOk = false;
  }

  const containerStatus = await getContainerStatus(context);
  const statusDotClass = containerStatus === 'Up' ? 'dot up' : 'dot exited';

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
      :root{
        --fg: var(--vscode-editor-foreground);
        --bg: var(--vscode-editor-background);
        --muted: var(--vscode-descriptionForeground);
        --border: var(--vscode-editorWidget-border);
        --badge-bg: var(--vscode-badge-background);
        --badge-fg: var(--vscode-badge-foreground);
        --link: var(--vscode-textLink-foreground);
      }
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
      .top{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border)}
      .meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .badge{padding:2px 6px;border-radius:10px;background:var(--badge-bg);color:var(--badge-fg);font-size:12px}
      .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
      .dot.up{background:#2ea043} .dot.exited{background:#d22}
      .path{color:var(--muted);word-break:break-all}
      .actions{display:flex;gap:6px;flex-wrap:wrap}
      button{border:1px solid var(--border);background:transparent;color:var(--fg);padding:4px 8px;border-radius:6px;cursor:pointer}
      button:hover{background:rgba(255,255,255,0.06)}
      .content{padding:10px}
      pre{white-space:pre;overflow:auto}
      .wrap pre{white-space:pre-wrap}
      .empty{padding:24px;border:1px dashed var(--border);border-radius:12px;color:var(--muted);text-align:center}
      .empty b{color:var(--fg)}
      .kv{display:inline-flex;gap:6px;align-items:center}
    </style>
  </head>
  <body>
    <div class="top">
      <div class="meta">
        <span class="kv"><span id="dot" class="${statusDotClass}"></span><span id="cstat">${escapeHtml(containerStatus)}</span></span>
        <span class="badge">${escapeHtml(path.basename(filePath))}</span>
        <span class="badge">${fmtBytes(size)}</span>
        <span class="badge">${fmtMtime(mtime)}</span>
        <span class="path">${escapeHtml(filePath)}</span>
      </div>
      <div class="actions">
        <button id="openExp">Open in Explorer</button>
        <button id="openLog">Open Log</button>
        <button id="switch">Switch Target</button>
        <button id="wrap">Wrap</button>
      </div>
    </div>
    <div id="root" class="content">
      ${
        parseOk
          ? `<pre>${escapeHtml(text)}</pre>`
          : `<div class="empty">
               <b>No valid output to display.</b><br/>
               The file is empty or not yet ready. Edit your YANG files or check the watcher.<br/><br/>
               <span class="kv"><span id="dot2" class="${statusDotClass}"></span><span id="cstat2">${escapeHtml(containerStatus)}</span></span>
             </div>`
      }
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      // state: { wrap: boolean }
      const init = vscode.getState() || { wrap: true };
      const setWrap = (w) => {
        if (w) document.body.classList.add('wrap'); else document.body.classList.remove('wrap');
        const btn = document.getElementById('wrap');
        btn.textContent = w ? 'No Wrap' : 'Wrap';
        vscode.setState({ wrap: w });
      };
      setWrap(!!init.wrap);

      // actions
      document.getElementById('openExp').addEventListener('click', () => vscode.postMessage({ type: 'reveal', path: '${escapeHtml(filePath)}' }));
      document.getElementById('openLog').addEventListener('click', () => vscode.postMessage({ type: 'openLog' }));
      document.getElementById('switch').addEventListener('click', () => vscode.postMessage({ type: 'switchTarget' }));
      document.getElementById('wrap').addEventListener('click', () => setWrap(!(vscode.getState()||{}).wrap));

      // live container status updates from extension
      function applyStatus(elDot, elTxt, s){
        if (!elDot || !elTxt) return;
        elDot.className = 'dot ' + (s === 'Up' ? 'up' : 'exited');
        elTxt.textContent = s;
      }
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (m && m.type === 'containerStatus') {
          const s = m.status === 'Up' ? 'Up' : 'Exited';
          applyStatus(document.getElementById('dot'), document.getElementById('cstat'), s);
          // empty-state mirrored indicators if present
          applyStatus(document.getElementById('dot2'), document.getElementById('cstat2'), s);
        }
      });
    </script>
  </body>
  </html>`;

  previewPanel!.webview.html = html;
  previewPanel!.title = title;
}

async function showOrUpdatePreview(filePath: string, title: string, context: vscode.ExtensionContext) {
  const doRenderStable = async () => {
    const ok = await waitForStableFile(vscode.Uri.file(filePath), 5000, 200);
    await renderPreview(filePath, title, context);
    if (!ok) {
      // already rendered; watcher will re-trigger if needed
    }
  };

  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel(
      'oasPreview',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    // message channel for action bar
    previewPanel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.type === 'reveal' && typeof msg.path === 'string') {
          await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.path));
        } else if (msg?.type === 'openLog') {
          await openWatcherLogCommand(extCtx!);
        } else if (msg?.type === 'switchTarget') {
          await switchAnnotationCommand(extCtx!);
        }
      } catch { /* ignore */ }
    });
    previewPanel.onDidDispose(() => {
      disposePreviewWatcher();
      previewPanel = null;
      previewPath = null;
    });
  }
  previewPath = filePath;

  // first show loading skeleton
  previewPanel.webview.html = loadingHtml(filePath);

  setPreviewWatcher(filePath, () => { doRenderStable().catch(() => {}); });
  await doRenderStable();
}

/* -------------------------------------------------
 * status bar (label-scoped) + push status into webview
 * ------------------------------------------------- */
async function updateStatusBar(context: vscode.ExtensionContext) {
  const wsHash = computeWsHashFromContext(context);
  let status: 'Up' | 'Exited' = 'Exited';
  if (wsHash) {
    try {
      const psRes = await spawnAsync('docker', [
        'ps',
        '--filter', 'label=app=yang-oas',
        '--filter', `label=ws=${wsHash}`,
        '--format', '{{.Names}}\t{{.Status}}'
      ]);
      const up = psRes.stdout.split('\n').some(line => /\tUp\b/.test(line));
      status = up ? 'Up' : 'Exited';
    } catch { status = 'Exited'; }
  }

  const annotation = !!context.workspaceState.get<boolean>(WS_KEYS.lastAnnotation, false);
  const fileLabel = annotation ? 'filtered-oas3.json' : 'oas3.json';

  statusItem.text = `$(container) OAS: ${status} | ${fileLabel}`;
  statusItem.tooltip = 'Click to switch preview (oas3.json / filtered-oas3.json)';
  statusItem.command = 'oas.switchAnnotation';
  statusItem.show();

  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  const logPath = hostDir ? path.join(hostDir, 'watch-yang.log') : undefined;
  statusLogItem.text = '$(output) OAS Log';
  statusLogItem.tooltip = logPath ? `Open ${logPath}` : 'Log path unknown (run generator first)';
  statusLogItem.command = 'oas.openWatcherLog';
  statusLogItem.show();

  // NEW: also update the webview's status light, if open
  try {
    previewPanel?.webview.postMessage({ type: 'containerStatus', status });
  } catch { /* ignore */ }
}

function startStatusPolling(context: vscode.ExtensionContext) {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => { updateStatusBar(context).catch(() => {}); }, 5000);
}

/* -------------------------------------------------
 * main command (unchanged core, still hash + labels)
 * ------------------------------------------------- */
async function runOasGeneratorCommand(context: vscode.ExtensionContext) {
  try {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage('No workspace is open. Please open a workspace that contains YANG files.');
      return;
    }

    const dockerContextFsPath = path.join(context.extensionPath, 'oas_generator');
    OAS_CHANNEL.clear();
    OAS_CHANNEL.show(true);

    const { imageName, containerBase } = getOasNames();
    OAS_CHANNEL.appendLine(`==> Using image name: ${imageName}`);
    OAS_CHANNEL.appendLine(`==> Container base name: ${containerBase}`);

    const exists = await imageExists(imageName);
    if (exists) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Use existing image (${imageName})`, action: 'use' as const },
          { label: `rebuild OAS GENERATOR image (${imageName})`, action: 'rebuild' as const }
        ],
        { placeHolder: `Image ${imageName} already exists` }
      );
      if (!choice) return;
      if (choice.action === 'rebuild') {
        const ok = await buildImage(imageName, dockerContextFsPath);
        if (!ok) return;
      } else {
        OAS_CHANNEL.appendLine(`==> Skipping build; using existing image: ${imageName}`);
      }
    } else {
      const ok = await buildImage(imageName, dockerContextFsPath);
      if (!ok) return;
    }

    // four params
    const defaultHostModulesDir = wsFolder.uri.fsPath;
    const hostModulesDir = await promptHostModulesDirWithValidation(defaultHostModulesDir);
    if (!hostModulesDir) return;

    const modulesSubdir = await vscode.window.showInputBox({
      title: 'MODULES_SUBDIR (relative path under /workdir that contains .yang files, e.g., arp)',
      value: 'arp',
      ignoreFocusOut: true
    });
    if (!modulesSubdir) return;

    const modelFileName = await vscode.window.showInputBox({
      title: 'MODEL_FILE_NAME (main .yang file name, e.g., ipNetToMediaTable.yang)',
      placeHolder: 'e.g. ipNetToMediaTable.yang',
      ignoreFocusOut: true,
      validateInput: (v) => v.trim().endsWith('.yang') ? null : 'A .yang file is required'
    });
    if (!modelFileName) return;

    const annotationPick = await vscode.window.showQuickPick(
      [{ label: 'true' }, { label: 'false' }],
      { title: 'ANNOTATION (turn on annotation-driven filter? filtered-oas3.json will be updated)', placeHolder: 'true or false', ignoreFocusOut: true }
    );
    if (!annotationPick) return;
    const annotationVal = annotationPick.label as 'true' | 'false';

    // remember
    await context.workspaceState.update(WS_KEYS.lastHostDir, hostModulesDir);
    await context.workspaceState.update(WS_KEYS.lastAnnotation, annotationVal === 'true');

    // naming + labels
    const wsHash = shortHash(path.resolve(hostModulesDir));
    const effectiveContainerName = `${containerBase}-${wsHash}`;
    OAS_CHANNEL.appendLine(`==> Effective container name: ${effectiveContainerName}`);
    const extVersion = getExtVersion(context);

    // cleanup by labels, then fallback by name (for old versions)
    await spawnAsync('docker', ['ps', '-aq',
      '--filter', 'label=app=yang-oas',
      '--filter', `label=ws=${wsHash}`
    ]).then(async ({ stdout }) => {
      const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (ids.length) await spawnAsync('docker', ['rm', '-f', ...ids], {});
    }).catch(() => {});
    await spawnAsync('docker', ['rm', '-f', effectiveContainerName], {});

    // run
    const volHost = toPosix(path.resolve(hostModulesDir));
    const envs = [
      '-e', 'WATCH_DIR=/workdir',
      '-e', `MODULES=/workdir/${modulesSubdir}`,
      '-e', `MODEL_FILE=/workdir/${modulesSubdir}/${modelFileName}`,
      '-e', `MODEL_FILE_NAME=${modelFileName}`,
      '-e', 'OUTPUT=/workdir/output/swagger.json',
      '-e', 'OAS_OUTPUT=/workdir/output/oas3.json',
      '-e', `ANNOTATION=${annotationVal}`,
    ];
    const labels = [
      '--label', 'app=yang-oas',
      '--label', `ws=${wsHash}`,
      '--label', 'ext=yang-lint-ext',
      '--label', `ext_version=${extVersion}`,
      '--label', `image=${imageName}`,
      '--label', `container_base=${containerBase}`,
    ];
    const runArgs = [
      'run', '-d',
      '--name', effectiveContainerName,
      ...labels,
      '-v', `${volHost}:/workdir:rw`,
      '-w', '/workdir',
      ...envs,
      imageName
    ];

    OAS_CHANNEL.appendLine(`==> Starting container: docker ${runArgs.join(' ')}`);
    const runRes = await spawnAsync('docker', runArgs, {});
    if (runRes.code !== 0) {
      vscode.window.showErrorMessage('Failed to start container.');
      return;
    }

    // health
    const psRes = await spawnAsync('docker', [
      'ps',
      '--filter', 'label=app=yang-oas',
      '--filter', `label=ws=${wsHash}`,
      '--format', '{{.Names}}\t{{.Status}}'
    ]);
    const up = psRes.stdout.split('\n').some(line => /\tUp\b/.test(line));
    if (!up) {
      vscode.window.showWarningMessage('Container is not running.');
      return;
    }
    vscode.window.showInformationMessage('OAS watcher container started successfully. You can start modifying YANG files.');

    // preview target
    const targetFileName = annotationVal === 'true' ? 'filtered-oas3.json' : 'oas3.json';
    const targetFsPath = path.join(hostModulesDir, 'output', targetFileName);
    const targetUri = vscode.Uri.file(targetFsPath);

    OAS_CHANNEL.appendLine(`==> Waiting for ${targetFileName} to appear and stabilize...`);
    const appeared = await waitForStableFile(targetUri, 20_000, 200);
    if (!appeared) {
      vscode.window.showWarningMessage(`Unable to detect a stable ${targetFileName}.`);
      return;
    }

    await showOrUpdatePreview(targetFsPath, `OAS Preview · ${targetFileName}`, context);
    await updateStatusBar(context); // also pushes status to webview
  } catch (err: any) {
    OAS_CHANNEL.appendLine(String(err?.stack || err));
    vscode.window.showErrorMessage('Error running OAS generator command.');
  }
}

/* -------------------------------------------------
 * extra commands (unchanged)
 * ------------------------------------------------- */
async function rebuildGeneratorImageCommand(context: vscode.ExtensionContext) {
  try {
    const dockerContextFsPath = path.join(context.extensionPath, 'oas_generator');
    OAS_CHANNEL.clear();
    OAS_CHANNEL.show(true);

    const { imageName } = getOasNames();
    const ok = await buildImage(imageName, dockerContextFsPath);
    if (!ok) return;

    await updateStatusBar(context);
  } catch (err: any) {
    OAS_CHANNEL.appendLine(String(err?.stack || err));
    vscode.window.showErrorMessage('Error rebuilding image.');
  }
}

async function stopContainerCommand(context: vscode.ExtensionContext) {
  const wsHash = computeWsHashFromContext(context);
  if (!wsHash) {
    vscode.window.showWarningMessage('No known workspace path. Run the generator first.');
    return;
  }
  OAS_CHANNEL.show(true);
  OAS_CHANNEL.appendLine(`==> Stopping containers with labels: app=yang-oas, ws=${wsHash}`);
  const listRes = await spawnAsync('docker', [
    'ps', '-aq',
    '--filter', 'label=app=yang-oas',
    '--filter', `label=ws=${wsHash}`
  ]);
  const ids = listRes.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (!ids.length) {
    vscode.window.showInformationMessage('No matching OAS containers found to stop.');
  } else {
    await spawnAsync('docker', ['rm', '-f', ...ids], {});
    vscode.window.showInformationMessage(`Removed ${ids.length} OAS container(s).`);
  }
  await updateStatusBar(context);
}

async function openOutputFolderCommand(context: vscode.ExtensionContext) {
  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  if (!hostDir) {
    vscode.window.showWarningMessage('Output path is unknown. Run "OAS Generator: Build & Run Watcher" first.');
    return;
  }
  const outputDir = path.join(hostDir, 'output');
  const uri = vscode.Uri.file(outputDir);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    vscode.window.showWarningMessage(`Output folder does not exist: ${outputDir}`);
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', uri);
}

async function switchAnnotationCommand(context: vscode.ExtensionContext) {
  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  if (!hostDir) {
    vscode.window.showWarningMessage('Preview path is unknown. Run "OAS Generator: Build & Run Watcher" first.');
    return;
  }

  const current = !!context.workspaceState.get<boolean>(WS_KEYS.lastAnnotation, false);
  const pick = await vscode.window.showQuickPick(
    [{ label: 'true' }, { label: 'false' }],
    { title: `ANNOTATION (current: ${current ? 'true' : 'false'})`, placeHolder: 'true or false', ignoreFocusOut: true }
  );
  if (!pick) return;

  const newVal = pick.label === 'true';
  await context.workspaceState.update(WS_KEYS.lastAnnotation, newVal);

  const targetFileName = newVal ? 'filtered-oas3.json' : 'oas3.json';
  const targetFsPath = path.join(hostDir, 'output', targetFileName);
  const ok = await waitForStableFile(vscode.Uri.file(targetFsPath), 10_000, 200);
  if (!ok) {
    vscode.window.showWarningMessage(`Target preview file not found yet: ${targetFileName}`);
  }
  await showOrUpdatePreview(targetFsPath, `OAS Preview · ${targetFileName}`, context);
  await updateStatusBar(context);
}

async function openWatcherLogCommand(context: vscode.ExtensionContext) {
  const hostDir = context.workspaceState.get<string>(WS_KEYS.lastHostDir);
  if (!hostDir) {
    vscode.window.showWarningMessage('Log path is unknown. Run "OAS Generator: Build & Run Watcher" first.');
    return;
  }
  const logPath = path.join(hostDir, 'watch-yang.log');
  const uri = vscode.Uri.file(logPath);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    vscode.window.showWarningMessage(`Log file does not exist: ${logPath}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
}

/* -------------------------------------------------
 * ========== 第一阶段新增：数据源配置 / 侧边栏 / 搜索导入 / 清单缓存 ==========
 * ------------------------------------------------- */

type LocalSource = { type: 'local'; path: string; name?: string };
type CatalogSource = { type: 'catalog'; baseUrl: string; name?: string };
type YangSource = LocalSource | CatalogSource;

type ModelsCache = {
  [key: string]: { ts: number; data: any };
};

type CatalogModule = {
  name: string;
  revision: string;
  organization?: string;
  schema?: string;
};

type ManifestEntry = {
  name: string;
  revision: string;
  organization?: string;
  source: { type: 'catalog' | 'local'; ref: string }; // ref = baseUrl or local path
  destRel: string; // 相对工作区的保存路径
  sha256?: string;
  importedAt: string; // ISO
};

type ManifestFile = {
  $schema?: string;
  items: ManifestEntry[];
};

function modelsConfig() {
  const cfg = vscode.workspace.getConfiguration('yang.models');
  const sources = (cfg.get('sources') as any[]) ?? [];
  const defaultImportDir = String(cfg.get('defaultImportDir', DEFAULT_IMPORT_DIR)).trim() || DEFAULT_IMPORT_DIR;
  const cacheTtlHours = Number(cfg.get('cacheTtlHours', 1));
  return { sources, defaultImportDir, cacheTtlHours };
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function manifestFsPath(): string | undefined {
  const ws = getWorkspaceFolder();
  if (!ws) return undefined;
  return path.join(ws.uri.fsPath, '.yang-models.json');
}

async function readManifest(): Promise<ManifestFile> {
  const f = manifestFsPath();
  if (!f) return { items: [] };
  try {
    const buf = await fs.promises.readFile(f, 'utf8');
    const j = JSON.parse(buf);
    if (Array.isArray(j?.items)) return j as ManifestFile;
  } catch { /* ignore */ }
  return { items: [] };
}

async function writeManifest(m: ManifestFile): Promise<void> {
  const f = manifestFsPath();
  if (!f) return;
  const body = JSON.stringify({ $schema: undefined, ...m }, null, 2);
  await fs.promises.writeFile(f, body, 'utf8');
}

async function ensureDir(p: string) {
  await fs.promises.mkdir(p, { recursive: true });
}

function sha256Of(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function joinWs(...p: string[]): string {
  const ws = getWorkspaceFolder();
  if (!ws) throw new Error('No workspace open');
  return path.join(ws.uri.fsPath, ...p);
}

function calcDefaultImportDirAbs(): string {
  const { defaultImportDir } = modelsConfig();
  return joinWs(defaultImportDir);
}

async function chooseImportTargetDir(): Promise<string | undefined> {
  const def = calcDefaultImportDirAbs();
  const pick = await vscode.window.showQuickPick(
    [
      { label: `Use default: ${def}`, value: def },
      { label: 'Choose folder…', value: '__choose__' }
    ],
    { placeHolder: 'Select import destination directory' }
  );
  if (!pick) return undefined;
  if (pick.value === '__choose__') {
    const sel = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: 'Select folder for imported YANG modules'
    });
    return sel?.[0]?.fsPath;
  }
  return pick.value;
}

/* ---------- Catalog 搜索与下载（容错多端点） ---------- */

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
  if (!entry) return false;
  const ageMs = Date.now() - entry.ts;
  return ageMs < ttlHours * 3600 * 1000;
}

// —— 放到 extension.ts 中，替换原来的 catalogSearch() ——

// 统一解析几种返回结构
function parseModules(j: any): CatalogModule[] {
  // 1) 常见结构：{"yang-catalog:modules":{"module":[...]}}
  const list1 = j?.['yang-catalog:modules']?.module;
  if (Array.isArray(list1)) {
    return list1.map((m: any) => ({
      name: m.name, revision: m.revision, organization: m.organization, schema: m.schema
    }));
  }
  // 2) 单个对象
  if (j && typeof j === 'object' && j.name && j.revision) {
    return [{ name: j.name, revision: j.revision, organization: j.organization, schema: j.schema }];
  }
  // 3) 直接数组
  if (Array.isArray(j)) {
    return j.map((m: any) => ({
      name: m.name, revision: m.revision, organization: m.organization, schema: m.schema
    }));
  }
  return [];
}

async function safeBody(res: any) {
  try { return await res.text(); } catch { return ''; }
}

// “多端点容错”搜索：按 field/value 搜索，失败自动换用其它等价端点，最终退到 search-filter
async function catalogSearch(
  baseUrl: string,
  field: string,
  value: string,
  latestOnly: boolean,
  context: vscode.ExtensionContext
): Promise<CatalogModule[]> {
  const { cacheTtlHours } = modelsConfig();
  const key = `${baseUrl}|${field}|${value}|${latestOnly}`;
  const bu = baseUrl.replace(/\/+$/,'');
  const lrQ = latestOnly ? 'latest-revision=true' : '';
  const hit = cacheGet(context, key);
  if (isCacheFresh(hit, cacheTtlHours)) return hit.data as CatalogModule[];

  // 每次尝试都会把 URL 打到 “YANG Models” Output，便于调试
  const attempts: Array<() => Promise<CatalogModule[]>> = [];

  // A. 路径式（有的部署是 /search/name/<value>）
  attempts.push(async () => {
    const url = `${bu}/api/search/${encodeURIComponent(field)}/${encodeURIComponent(value)}${lrQ ? `?${lrQ}` : ''}`;
    MODELS_CHANNEL.appendLine(`Catalog search A (path): ${url}`);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } as any });
    if (!res.ok) throw new Error(`A HTTP ${res.status} ${await safeBody(res)}`);
    return parseModules(await res.json());
  });

  // B. 冒号式（某些老写法）：/api/search/name:ietf-vbng
  attempts.push(async () => {
    const url = `${bu}/api/search/${encodeURIComponent(field)}:${encodeURIComponent(value)}${lrQ ? `?${lrQ}` : ''}`;
    MODELS_CHANNEL.appendLine(`Catalog search B (colon): ${url}`);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } as any });
    if (!res.ok) throw new Error(`B HTTP ${res.status} ${await safeBody(res)}`);
    return parseModules(await res.json());
  });

  // C. query 参数式：/api/search/modules?name=<value>（很多部署按这个支持“按名称”）
  if (field === 'name') {
    attempts.push(async () => {
      const url = `${bu}/api/search/modules?name=${encodeURIComponent(value)}${lrQ ? `&${lrQ}` : ''}`;
      MODELS_CHANNEL.appendLine(`Catalog search C (query): ${url}`);
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } as any });
      if (!res.ok) throw new Error(`C HTTP ${res.status} ${await safeBody(res)}`);
      return parseModules(await res.json());
    });

    // D. 另一种路径前缀：/api/search/module/<value>
    attempts.push(async () => {
      const url = `${bu}/api/search/module/${encodeURIComponent(value)}${lrQ ? `?${lrQ}` : ''}`;
      MODELS_CHANNEL.appendLine(`Catalog search D (module/<name>): ${url}`);
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } as any });
      if (!res.ok) throw new Error(`D HTTP ${res.status} ${await safeBody(res)}`);
      return parseModules(await res.json());
    });
  }

  // E. 兜底（最稳）：POST /api/search-filter
  //    统一把条件放 body 里（部分部署只开放了这个接口用于检索）
  attempts.push(async () => {
    // 构造一个最小过滤器：按字段精确匹配
    const body = {
      'latest-revision': latestOnly,
      input: { [field]: value }
    };
    const url = `${bu}/api/search-filter`;
    MODELS_CHANNEL.appendLine(`Catalog search E (search-filter): ${url} body=${JSON.stringify(body)}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' } as any,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`E HTTP ${res.status} ${await safeBody(res)}`);
    return parseModules(await res.json());
  });

  // 逐个尝试
  const errors: string[] = [];
  for (const fn of attempts) {
    try {
      const out = await fn();
      if (out && out.length) {
        await cacheSet(context, key, out);
        return out;
      }
    } catch (e: any) {
      errors.push(String(e?.message || e));
    }
  }
  throw new Error(`Catalog search failed across fallbacks: ${errors.join(' | ')}`);
}


async function catalogDownload(baseUrl: string, name: string, revision: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/,'')}/api/services/reference/${encodeURIComponent(name)}@${encodeURIComponent(revision)}.yang`;
  MODELS_CHANNEL.appendLine(`Catalog download: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return await res.text();
}

/* ---------- Local 源扫描 ---------- */

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
  // 找最近的 revision 语句（简化版）
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
        if (meta.name) {
          out.push({ name: meta.name, revision: meta.revision ?? 'unknown', organization: undefined, schema: undefined, filePath: p });
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return out;
}

/* ---------- 导入与清单写入 ---------- */

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

/* ---------- 侧边栏 TreeView ---------- */

class YangModelsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh() { this._onDidChangeTreeData.fire(); }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!el) {
      const roots: vscode.TreeItem[] = [];
      const sources = new vscode.TreeItem('Sources', vscode.TreeItemCollapsibleState.Expanded);
      sources.contextValue = 'root-sources';
      sources.iconPath = new vscode.ThemeIcon('plug');
      roots.push(sources);

      const search = new vscode.TreeItem('Search', vscode.TreeItemCollapsibleState.Expanded);
      search.contextValue = 'root-search';
      search.iconPath = new vscode.ThemeIcon('search');
      roots.push(search);

      const imported = new vscode.TreeItem('Imported', vscode.TreeItemCollapsibleState.Expanded);
      imported.contextValue = 'root-imported';
      imported.iconPath = new vscode.ThemeIcon('archive');
      roots.push(imported);

      return roots;
    }

    if (el.contextValue === 'root-sources') {
      const { sources } = modelsConfig();
      const items: vscode.TreeItem[] = [];
      for (const s of sources as YangSource[]) {
        if (s.type === 'local') {
          const it = new vscode.TreeItem(`Local: ${s.name ?? s.path}`, vscode.TreeItemCollapsibleState.None);
          it.description = s.path;
          it.tooltip = s.path;
          it.contextValue = 'source-local';
          it.iconPath = new vscode.ThemeIcon('folder-library');
          items.push(it);
        } else if (s.type === 'catalog') {
          const it = new vscode.TreeItem(`Catalog: ${s.name ?? 'YANG Catalog'}`, vscode.TreeItemCollapsibleState.None);
          it.description = (s as CatalogSource).baseUrl;
          it.tooltip = (s as CatalogSource).baseUrl;
          it.contextValue = 'source-catalog';
          it.iconPath = new vscode.ThemeIcon('globe');
          items.push(it);
        }
      }
      if (!items.length) {
        const hint = new vscode.TreeItem('No sources configured (open Settings → yang.models.sources)', vscode.TreeItemCollapsibleState.None);
        hint.iconPath = new vscode.ThemeIcon('gear');
        items.push(hint);
      }
      return items;
    }

    if (el.contextValue === 'root-search') {
      const cat = new vscode.TreeItem('Catalog: Search & Import…', vscode.TreeItemCollapsibleState.None);
      cat.command = { command: 'yangModels.searchImport', title: 'Search Catalog', arguments: ['catalog'] };
      cat.iconPath = new vscode.ThemeIcon('cloud-download');

      const loc = new vscode.TreeItem('Local: Search & Import…', vscode.TreeItemCollapsibleState.None);
      loc.command = { command: 'yangModels.searchImport', title: 'Search Local', arguments: ['local'] };
      loc.iconPath = new vscode.ThemeIcon('file-code');

      return [cat, loc];
    }

    if (el.contextValue === 'root-imported') {
      const m = await readManifest();
      if (!m.items.length) {
        const none = new vscode.TreeItem('No items yet. Use "Search & Import…" above.', vscode.TreeItemCollapsibleState.None);
        none.iconPath = new vscode.ThemeIcon('info');
        const open = new vscode.TreeItem('Open .yang-models.json', vscode.TreeItemCollapsibleState.None);
        open.command = { command: 'yangModels.openManifest', title: 'Open manifest' };
        open.iconPath = new vscode.ThemeIcon('json');
        return [none, open];
      }
      const items = m.items
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(it => {
          const label = `${it.name}@${it.revision}`;
          const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          node.description = `${it.source.type} • ${it.organization ?? 'unknown'} • ${it.destRel}`;
          node.tooltip = `Source: ${it.source.type} (${it.source.ref})\nPath: ${it.destRel}\nImported: ${it.importedAt}`;
          node.iconPath = new vscode.ThemeIcon(it.source.type === 'catalog' ? 'cloud' : 'file');
          node.resourceUri = vscode.Uri.file(joinWs(it.destRel));
          node.command = { command: 'revealInExplorer', title: 'Reveal', arguments: [node.resourceUri] };
          return node;
        });
      const open = new vscode.TreeItem('Open .yang-models.json', vscode.TreeItemCollapsibleState.None);
      open.command = { command: 'yangModels.openManifest', title: 'Open manifest' };
      open.iconPath = new vscode.ThemeIcon('json');
      return [...items, open];
    }

    return [];
  }
}

/* ---------- 搜索 & 导入 Command 实现 ---------- */

async function cmdSearchImport(kind: 'catalog' | 'local', context: vscode.ExtensionContext) {
  const ws = getWorkspaceFolder();
  if (!ws) { vscode.window.showErrorMessage('Please open a workspace first.'); return; }

  const importDir = await chooseImportTargetDir();
  if (!importDir) return;
  await ensureDir(importDir);

  if (kind === 'catalog') {
    const cfgSources = (modelsConfig().sources as YangSource[]).filter(s => s.type === 'catalog') as CatalogSource[];
    const baseUrl = (cfgSources[0]?.baseUrl) || 'https://www.yangcatalog.org';
    const field = await vscode.window.showQuickPick(['name', 'organization', 'prefix'], { placeHolder: 'Search field in catalog' });
    if (!field) return;
    const term = await vscode.window.showInputBox({ prompt: `Catalog: search ${field}` });
    if (!term) return;

    const latestOnly = true; // 与网页体验对齐
    let mods: CatalogModule[] = [];
    try {
      mods = await catalogSearch(baseUrl, field, term, latestOnly, context);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Catalog search error: ${String(e?.message || e)}`);
      return;
    }
    if (!mods.length) { vscode.window.showInformationMessage('No results.'); return; }

    const pick = await vscode.window.showQuickPick(
      mods.map(m => ({ label: `${m.name}@${m.revision}`, description: m.organization ?? 'unknown org', m })),
      { placeHolder: 'Select a module to import' }
    );
    if (!pick) return;

    let content = '';
    try {
      content = await catalogDownload(baseUrl, pick.m.name, pick.m.revision);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Download failed: ${String(e?.message || e)}`);
      return;
    }
    const fileName = `${pick.m.name}@${pick.m.revision}.yang`;
    const orgDir = pick.m.organization?.replace(/[^\w.-]+/g, '_') || 'catalog';
    const dest = await materializeTo(path.join(importDir, 'catalog', orgDir), fileName, content);
    const rel = path.relative(ws.uri.fsPath, dest);
    const entry: ManifestEntry = {
      name: pick.m.name,
      revision: pick.m.revision,
      organization: pick.m.organization,
      source: { type: 'catalog', ref: baseUrl },
      destRel: rel,
      sha256: sha256Of(content),
      importedAt: new Date().toISOString()
    };
    await upsertManifest(entry);
    vscode.window.showInformationMessage(`Imported: ${path.basename(dest)}`, 'Reveal').then(btn => {
      if (btn) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dest));
    });
    return;
  }

  // local
  const locals = (modelsConfig().sources as YangSource[]).filter(s => s.type === 'local') as LocalSource[];
  if (!locals.length) {
    vscode.window.showWarningMessage('No local sources configured. Add via Settings → yang.models.sources or run "YANG Models: Add Local Source".');
    return;
  }
  const sourcePick = await vscode.window.showQuickPick(
    locals.map(ls => ({ label: ls.name ?? path.basename(ls.path), description: ls.path, ls })),
    { placeHolder: 'Select a local source to search' }
  );
  if (!sourcePick) return;

  const term = await vscode.window.showInputBox({ prompt: `Local: search module name in ${sourcePick.description}` });
  if (!term) return;

  let mods: Array<CatalogModule & { filePath: string }> = [];
  try { mods = await scanLocalSource(sourcePick.ls.path); } catch { /* ignore */ }
  const filtered = mods.filter(m => m.name.toLowerCase().includes(term.toLowerCase()));
  if (!filtered.length) { vscode.window.showInformationMessage('No results.'); return; }

  const pick = await vscode.window.showQuickPick(
    filtered.map(m => ({ label: `${m.name}@${m.revision}`, description: m.filePath, m })),
    { placeHolder: 'Select a module to import' }
  );
  if (!pick) return;

  const fileName = `${pick.m.name}@${pick.m.revision}.yang`;
  const dest = await copyFileTo(path.join(importDir, 'local', (sourcePick.ls.name ?? 'local').replace(/[^\w.-]+/g, '_')), pick.m.filePath, fileName);
  const rel = path.relative(ws.uri.fsPath, dest);
  const content = await fs.promises.readFile(dest, 'utf8');
  const entry: ManifestEntry = {
    name: pick.m.name,
    revision: pick.m.revision,
    organization: pick.m.organization,
    source: { type: 'local', ref: sourcePick.ls.path },
    destRel: rel,
    sha256: sha256Of(content),
    importedAt: new Date().toISOString()
  };
  await upsertManifest(entry);
  vscode.window.showInformationMessage(`Imported: ${path.basename(dest)}`, 'Reveal').then(btn => {
    if (btn) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dest));
  });
}

async function cmdOpenManifest() {
  const f = manifestFsPath();
  if (!f) { vscode.window.showErrorMessage('No workspace open.'); return; }
  try {
    await fs.promises.stat(f);
  } catch {
    await writeManifest({ items: [] });
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function cmdRefreshModels(provider: YangModelsTreeProvider) {
  // 简单做法：清除缓存并刷新 Tree
  await extCtx?.globalState.update(MODELS_CACHE_KEY, {});
  provider.refresh();
  vscode.window.showInformationMessage('YANG Models cache cleared. Sources refreshed.');
}

async function cmdAddLocalSource() {
  const sel = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: 'Select local folder containing YANG modules'
  });
  if (!sel || !sel[0]) return;
  const name = await vscode.window.showInputBox({ prompt: 'Optional display name for this source', value: path.basename(sel[0].fsPath) });
  const cfg = vscode.workspace.getConfiguration('yang.models');
  const sources = (cfg.get('sources') as any[]) ?? [];
  sources.push({ type: 'local', path: sel[0].fsPath, name: name || undefined });
  await cfg.update('sources', sources, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('Local source added to settings.');
}

/* -------------------------------------------------
 * activate / deactivate
 * ------------------------------------------------- */
export function activate(context: vscode.ExtensionContext) {
  extCtx = context;

  // YANG LSP
  try {
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'index.js'));
    const serverOptions: ServerOptions = {
      run:   { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
    };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: 'file', language: 'yang' }],
      synchronize: {
        configurationSection: 'yangeditor',
        fileEvents: vscode.workspace.createFileSystemWatcher('**/ruleSets/*.{yaml,yml}')
      }
    };
    client = new LanguageClient('yangLint', 'YANG Lint Server', serverOptions, clientOptions);
    client.start();
  } catch {
    vscode.window.showWarningMessage('Failed to start YANG LSP. Please check the build artifacts and paths.');
  }

  // commands (existing)
  context.subscriptions.push(
    vscode.commands.registerCommand('yang.toggleRuleSet', async () => {
      const cfg  = vscode.workspace.getConfiguration('yangeditor');
      const curr = cfg.get<string>('ruleSet');
      const pick = await vscode.window.showQuickPick(['create', 'update'], { placeHolder: `Current: ${curr}` });
      if (pick && pick !== curr) {
        await cfg.update('ruleSet', pick, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Rule set switched to '${pick}'.`);
      }
    }),
    vscode.commands.registerCommand('oas.generator', () => runOasGeneratorCommand(context)),
    vscode.commands.registerCommand('oas.rebuildGeneratorImage', () => rebuildGeneratorImageCommand(context)),
    vscode.commands.registerCommand('oas.stopContainer', () => stopContainerCommand(context)),
    vscode.commands.registerCommand('oas.openOutputFolder', () => openOutputFolderCommand(context)),
    vscode.commands.registerCommand('oas.switchAnnotation', () => switchAnnotationCommand(context)),
    vscode.commands.registerCommand('oas.openWatcherLog', () => openWatcherLogCommand(context)),
  );

  // NEW: YANG Models Tree + Commands
  const modelsProvider = new YangModelsTreeProvider(context);
  const reg = vscode.window.registerTreeDataProvider('yangModelsView', modelsProvider);
  const treeView = vscode.window.createTreeView('yangModelsView', { treeDataProvider: modelsProvider, showCollapseAll: true });
  context.subscriptions.push(reg, treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('yangModels.searchImport', (kind?: 'catalog' | 'local') => cmdSearchImport(kind ?? 'catalog', context)),
    vscode.commands.registerCommand('yangModels.openManifest', () => cmdOpenManifest()),
    vscode.commands.registerCommand('yangModels.refresh', () => cmdRefreshModels(modelsProvider)),
    vscode.commands.registerCommand('yangModels.addLocalSource', () => cmdAddLocalSource()),
  );

  // status bar init + polling
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusLogItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(statusItem, statusLogItem);
  updateStatusBar(context).catch(() => {});
  startStatusPolling(context);
}

export async function deactivate() {
  try { await client?.stop(); } catch {}
  if (statusTimer) clearInterval(statusTimer);
  try { statusItem?.dispose(); statusLogItem?.dispose(); } catch {}
  disposePreviewWatcher();
  if (previewPanel) try { previewPanel.dispose(); } catch {}
  // container auto-clean intentionally not done here per your decision
}
