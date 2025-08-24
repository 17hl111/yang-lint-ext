import {
  createConnection, ProposedFeatures, TextDocuments,
  InitializeParams, TextDocumentSyncKind, Diagnostic
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath } from 'url';
import * as path from 'path';

import { RuleEngine } from './ruleEngine';
import { parseYang, Ast } from './yangParser';
import { register as registerQuickFix } from './providers/quickfix';

export const connection = createConnection(ProposedFeatures.all);
export const documents = new TextDocuments(TextDocument);

let engine: RuleEngine;

connection.onInitialize((params: InitializeParams) => {
  const root = params.workspaceFolders?.[0]?.uri
    ? fileURLToPath(params.workspaceFolders[0].uri)
    : process.cwd();
  engine = new RuleEngine(root, connection);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: true           // ★ 声明支持 CodeAction
    }
  };
});

/* ---------------- listeners ---------------- */
documents.onDidOpen(e => validate(e.document));
documents.onDidChangeContent(e => validate(e.document));
connection.onDidChangeConfiguration(() => {
  engine.reload();
  documents.all().forEach(validate);
});

function validate(doc: TextDocument) {
  const ast: Ast = parseYang(doc.getText());
  const diags: Diagnostic[] = engine.validate(doc.uri, ast);
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
}

/* ---------------- Quick Fix注册 ---------------- */
registerQuickFix(connection);

documents.listen(connection);
connection.listen();
