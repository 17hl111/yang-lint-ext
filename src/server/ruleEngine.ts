import * as fs   from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import Ajv       from 'ajv';

import {
  Connection, Diagnostic, DiagnosticSeverity, Range,
} from 'vscode-languageserver/node';
import JexlLib = require('jexl');
import { Ast }  from './yangParser';

/* ------------- helpers ------------- */
JexlLib.addFunction('missing', (v:any)=>v===undefined||v===null||v==='');
JexlLib.addFunction('match',   (v:any,p:any)=>new RegExp(String(p)).test(String(v??'')));
JexlLib.addFunction('haswithin',(txt:string,kw:string,n:number)=>txt?.split('\n').slice(0,n)
  .some(l=>l.toLowerCase().includes(kw.toLowerCase()))||false);
JexlLib.addFunction('keyOrderInvalid',(lst:{key:string[];children:string[]})=>
  lst.key.some((k,i)=>lst.children[i]!==k));

/* ------------- types --------------- */
export interface RuleYaml{
  id:string;description:string;severity:'error'|'warning'|'info';
  scope:'module-header'|'import'|'typedef'|'status'|'list'
      |'anyxml'|'augment'|'choice'|'container'|'extension'
      |'feature'|'notification'|'rpc'|'constraint-node'|'deviation';
  when:string;
}
type Compiled={rule:RuleYaml;expr:ReturnType<typeof JexlLib.compile>};
const GENERIC_SCOPES=new Set(['anyxml','augment','choice','container','extension','feature','notification','rpc']);

/* ------------- exported deviationMap for quick fix ------------- */
export const deviationMap=new Map<string,Range[]>();

/* ------------- RuleEngine class ---------------- */
export class RuleEngine{
  private compiled:Compiled[]=[];
  constructor(private workspace:string,private conn:Connection){this.reload();}

  public reload(){
    try{
      const ruleFile=path.join(this.workspace,'ruleSets','create.yaml');
      const schemaFile=path.join(this.workspace,'ruleSets','rule-Schema.json');
      const validate=new Ajv({allErrors:true}).compile(JSON.parse(fs.readFileSync(schemaFile,'utf8')));
      const ruleDoc=yaml.load(fs.readFileSync(ruleFile,'utf8'));
      if(!validate(ruleDoc)){
        const msg='Rule schema error: '+(validate.errors??[]).map(e=>e.message).join('; ');
        this.conn.window.showErrorMessage(msg); this.compiled=[]; return;
      }
      const rules=(ruleDoc as any).rules as RuleYaml[];
      this.compiled=rules.map(r=>({rule:r,expr:JexlLib.compile(r.when)}));
      this.conn.window.showInformationMessage(`Loaded ${rules.length} rules from create.yaml`);
    }catch(e){this.conn.window.showErrorMessage(`Rule reload error: ${e}`); this.compiled=[];}
  }

  public validate(uri:string,ast:Ast):Diagnostic[]{
    deviationMap.clear();               // reset for this doc
    const ctx={...ast};
    const out:Diagnostic[]=[];

    /* helper to push diag */
    const push=(rule:RuleYaml,range:Range,extra?:any)=>out.push({
      range, message:rule.description,
      severity: rule.severity==='error'?DiagnosticSeverity.Error:
               rule.severity==='warning'?DiagnosticSeverity.Warning:
               DiagnosticSeverity.Information,
      source:`yang-lint:${rule.id}`,
      data:extra
    });

    /* pre-fill deviationMap for quick fix */
    ast.deviations?.forEach(d=>{
      const arr=deviationMap.get(d.target)||[];
      arr.push(d.range); deviationMap.set(d.target,arr);
    });

    for(const {rule,expr} of this.compiled){
      switch(rule.scope){
        case 'module-header':
          ast.moduleHeader && expr.evalSync(ctx) && push(rule,ast.moduleHeader.range); break;
        case 'import':
          ast.imports?.forEach(n=>expr.evalSync({...ctx,import:n})&&push(rule,n.range)); break;
        case 'typedef':
          ast.typedefs?.forEach(n=>expr.evalSync({...ctx,typedef:n})&&push(rule,n.range)); break;
        case 'status':
          ast.statuses?.forEach(n=>expr.evalSync({...ctx,status:n})&&push(rule,n.range)); break;
        case 'list':
          ast.lists?.forEach(n=>expr.evalSync({...ctx,list:n})&&push(rule,n.range)); break;
        case 'constraint-node':
          ast.constraintNodes?.forEach(n=>expr.evalSync({...ctx,node:n})&&push(rule,n.range)); break;
        case 'deviation':
          ast.deviations?.forEach(n=>{
            if(expr.evalSync({...ctx,deviation:n}))
              push(rule,n.range,{groupId:n.target});
          });
          break;
        default:
          if(GENERIC_SCOPES.has(rule.scope as string))
            ast.blocks?.filter(b=>b.keyword===rule.scope)
              .forEach(b=>expr.evalSync({...ctx,block:b})&&push(rule,b.range));
      }
    }
    return out;
  }
}
