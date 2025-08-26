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
import { activateImportModels } from './importModels.js';

/* -------------------------------------------------
 * constants
 * ------------------------------------------------- */
const OAS_CHANNEL = vscode.window.createOutputChannel('OAS Generator');

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
 * preview (A: theme-aware UI, action bar, wrap toggle, skeleton)
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
      .badge{padding:2px 6px;border-radius:10px;background:var(--badge-bg);color:var(--badge-fg);font-size:12px}
      .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
      .dot.up{background:#2ea043} .dot.exited{background:#d22}
      .actions{display:flex;gap:6px}
      button{border:1px solid var(--border);background:transparent;color:var(--fg);padding:4px 8px;border-radius:6px}
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
      const init = vscode.getState() || { wrap: true };
      const setWrap = (w) => {
        if (w) document.body.classList.add('wrap'); else document.body.classList.remove('wrap');
        const btn = document.getElementById('wrap');
        btn.textContent = w ? 'No Wrap' : 'Wrap';
        vscode.setState({ wrap: w });
      };
      setWrap(!!init.wrap);

      document.getElementById('openExp').addEventListener('click', () => vscode.postMessage({ type: 'reveal', path: '${escapeHtml(filePath)}' }));
      document.getElementById('openLog').addEventListener('click', () => vscode.postMessage({ type: 'openLog' }));
      document.getElementById('switch').addEventListener('click', () => vscode.postMessage({ type: 'switchTarget' }));
      document.getElementById('wrap').addEventListener('click', () => setWrap(!(vscode.getState()||{}).wrap));

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

  previewPanel.webview.html = loadingHtml(filePath);

  setPreviewWatcher(filePath, () => { doRenderStable().catch(() => {}); });
  await doRenderStable();
}

/* -------------------------------------------------
 * status bar + webview status push
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

  try {
    previewPanel?.webview.postMessage({ type: 'containerStatus', status });
  } catch { /* ignore */ }
}

function startStatusPolling(context: vscode.ExtensionContext) {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => { updateStatusBar(context).catch(() => {}); }, 5000);
}

/* -------------------------------------------------
 * main command (OAS watcher)
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

    await context.workspaceState.update(WS_KEYS.lastHostDir, hostModulesDir);
    await context.workspaceState.update(WS_KEYS.lastAnnotation, annotationVal === 'true');

    const wsHash = shortHash(path.resolve(hostModulesDir));
    const effectiveContainerName = `${DEFAULT_CONTAINER_BASE}-${wsHash}`;
    OAS_CHANNEL.appendLine(`==> Effective container name: ${effectiveContainerName}`);
    const extVersion = getExtVersion(context);

    await spawnAsync('docker', ['ps', '-aq',
      '--filter', 'label=app=yang-oas',
      '--filter', `label=ws=${wsHash}`
    ]).then(async ({ stdout }) => {
      const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (ids.length) await spawnAsync('docker', ['rm', '-f', ...ids], {});
    }).catch(() => {});
    await spawnAsync('docker', ['rm', '-f', effectiveContainerName], {});

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
      '--label', `image=${getOasNames().imageName}`,
      '--label', `container_base=${getOasNames().containerBase}`,
    ];
    const runArgs = [
      'run', '-d',
      '--name', effectiveContainerName,
      ...labels,
      '-v', `${volHost}:/workdir:rw`,
      '-w', '/workdir',
      ...envs,
      getOasNames().imageName
    ];

    OAS_CHANNEL.appendLine(`==> Starting container: docker ${runArgs.join(' ')}`);
    const runRes = await spawnAsync('docker', runArgs, {});
    if (runRes.code !== 0) {
      vscode.window.showErrorMessage('Failed to start container.');
      return;
    }

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
    await updateStatusBar(context);
  } catch (err: any) {
    OAS_CHANNEL.appendLine(String(err?.stack || err));
    vscode.window.showErrorMessage('Error running OAS generator command.');
  }
}

/* -------------------------------------------------
 * extra commands
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

  // OAS & preview commands
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
    vscode.commands.registerCommand('oas.openWatcherLog', () => openWatcherLogCommand(context))
  );

  // Import Models 子模块（注册 Open_YANG_import_UI）
  activateImportModels(context);

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
  if (previewWatcher) try { previewWatcher.dispose(); } catch {}
  if (previewPanel) try { previewPanel.dispose(); } catch {}
  // 不自动清理容器（保持你原有策略）
}
