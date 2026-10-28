import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';

// A separate Node process holds the kernel working directory. Relative file
// operations keep addressing that directory even if Finder moves its ancestors.
// This avoids relying on /dev/fd/dir/file, which macOS does not support.
const script = String.raw`
const fs=require('node:fs/promises'), {createReadStream}=require('node:fs'), {createHash}=require('node:crypto'), readline=require('node:readline'), path=require('node:path');
const [name,held,expected]=process.argv.slice(1);
const version=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
function location(){process.chdir('.');return path.join(process.cwd(),name);}
async function restore(){try{await fs.link(held,name);await fs.rm(held);return location();}catch(e){if(e.code==='ENOENT'&&!await fs.stat(held).then(()=>true,()=>false))return;throw e;}}
async function snapshot(){const before=await fs.stat(name,{bigint:true}),hash=createHash('sha256');for await(const chunk of createReadStream(name))hash.update(chunk);const after=await fs.stat(name,{bigint:true});if(version(before)!==version(after))throw Object.assign(new Error('File changed during publication'),{code:'ESTALE'});const m=await fs.stat(name);return {path:location(),version:version(after),fingerprint:'sha256:'+hash.digest('hex'),identity:[m.dev,m.ino,m.birthtimeMs].join(':')};}
(async()=>{const s=await fs.stat('.',{bigint:true});if([s.dev,s.ino].join(':')!==expected)throw new Error('Source directory changed before anchoring');process.stdout.write(JSON.stringify({ready:true})+'\n');let chain=Promise.resolve();const input=readline.createInterface({input:process.stdin});input.on('line',line=>{chain=chain.then(async()=>{let cmd;try{cmd=JSON.parse(line);let value;if(cmd.action==='claim')await fs.rename(name,held);else if(cmd.action==='publish'){await fs.link(cmd.temporary,name);await fs.rm(cmd.temporary);value=await snapshot();}else if(cmd.action==='restore')value=await restore();else if(cmd.action==='location')value=location();else throw new Error('Unknown directory operation');process.stdout.write(JSON.stringify({id:cmd.id,ok:true,value})+'\n');}catch(e){process.stdout.write(JSON.stringify({id:cmd&&cmd.id,ok:false,error:{message:e.message,code:e.code,recoveryPath:await fs.stat(held).then(()=>held,()=>undefined)}})+'\n');}});});input.on('close',()=>{chain.finally(async()=>{try{await restore();}catch{}process.exit();});});})().catch(e=>{process.stderr.write(e.message);process.exitCode=1;});
`;
export interface AnchoredSnapshot {
  path: string;
  version: string;
  fingerprint: string;
  identity: string;
}
export class DirectoryAnchor {
  private closing = false;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private closed: Promise<void>;
  private constructor(
    private child: ChildProcessWithoutNullStreams,
    readonly held: string,
  ) {
    this.closed = new Promise((resolve) => child.once('close', () => resolve()));
    child.stdin.on('error', (error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }
  static async open(path: string, held: string) {
    const metadata = await stat(dirname(path), { bigint: true });
    const child = spawn(
      process.execPath,
      ['-e', script, '--', basename(path), held, `${metadata.dev}:${metadata.ino}`],
      { cwd: dirname(path), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const anchor = new DirectoryAnchor(child, held);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString().slice(0, 512);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('图片文件夹保护助手未能启动。'));
      }, 5000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('close', () => {
        fail(new Error(stderr || '图片文件夹保护助手已退出。'));
        for (const request of anchor.pending.values())
          request.reject(
            Object.assign(new Error('图片文件夹保护助手已退出。'), { recoveryPath: held }),
          );
        anchor.pending.clear();
      });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let response: any;
        try {
          response = JSON.parse(line);
        } catch {
          return;
        }
        if (response.ready) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const request = anchor.pending.get(response.id);
        if (!request) return;
        anchor.pending.delete(response.id);
        if (response.ok) request.resolve(response.value);
        else request.reject(Object.assign(new Error(response.error.message), response.error));
      });
    });
    return anchor;
  }
  private request(action: string, extra: Record<string, unknown> = {}) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, action, ...extra }) + '\n', (error) => {
        if (error) {
          this.pending.delete(id);
          reject(Object.assign(error, { recoveryPath: this.held }));
        }
      });
    });
  }
  claim(): Promise<void> {
    return this.request('claim');
  }
  publish(temporary: string): Promise<AnchoredSnapshot> {
    return this.request('publish', { temporary });
  }
  restore(): Promise<string | undefined> {
    return this.request('restore');
  }
  location(): Promise<string> {
    return this.request('location');
  }
  async close() {
    if (!this.closing) {
      this.closing = true;
      this.child.stdin.end();
    }
    await this.closed;
  }
}
