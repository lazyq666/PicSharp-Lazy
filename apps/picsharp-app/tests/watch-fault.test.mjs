import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(resolve('packages/picsharp-sidecar/node_modules/tsx/package.json'));
const { build } = require('esbuild');
const source = resolve('apps/picsharp-app/src/pages/compression/watch.tsx');

test('a partial watch fault reaches a persistent visible warning without stopping healthy work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picsharp-watch-fault-'));
  const g = { effects: [], states: [], tree: null, nav: [], connection: null };
  globalThis.__watchFaultTest = g;
  const mock = `
    const g = globalThis.__watchFaultTest;
    export const useEffect=fn=>g.effects.push(fn);
    export const useRef=current=>({current});
    export const useState=initial=>{const index=g.states.length;g.states.push(initial);return [initial,value=>{g.states[index]=typeof value==='function'?value(g.states[index]):value}];};
    export const useContext=()=>({progressRef:{current:{done(){}}}});
    export const useI18n=()=>key=>key;
    export const useNavigate=()=>path=>g.nav.push(path);
    export const useReport=()=>()=>{};
    export const captureError=()=>{};
    export const sendTextNotification=()=>{};
    export const message={error(){}};
    export const fetchEventSource=(_url,options)=>{g.connection=options;return Promise.resolve()};
    export const getCurrentWebviewWindow=()=>({show(){},setFocus(){}});
    export const AppContext={}; export const CompressionContext={};
    export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;
    export const WatchQueue=class {clear(){}};
    export const filterWatchInputs=()=>{};
    export const debounce=(_options,fn)=>Object.assign(fn,{cancel(){}});
    export const isString=v=>typeof v==='string';
    export const parsePaths=()=>{}; export const humanSize=String;
    export const isValidArray=Array.isArray; export const correctFloat=v=>v;
    export const CompressionMode={}; export const CompressionOutputMode={};
    export const SettingsKey={}; export const VALID_MEDIA_EXTS=[];
    export const ICompressor={Status:{}}; export const exists=()=>true;
    export const convertFileSrc=v=>v; export const excludeVideoOutputs=v=>v;
    export default Object.assign(()=>null,{getState:()=>({watchingFolder:'/own-fixture/watch',sidecar:{origin:'http://localhost'},reset(){g.nav.push('reset')}})});
  `;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { visibilityState: 'visible' };
  const cleanups = [];
  try {
    const outfile = join(directory, 'watch.mjs');
    await build({ entryPoints: [source], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'native-shell-only', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.importer ? { path: args.path, namespace: 'shell' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'shell' }, () => ({ contents: mock, loader: 'js' }));
    } }] });
    const Component = (await import(pathToFileURL(outfile).href)).default;
    Component();
    for (const effect of g.effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    await g.connection.onmessage({ event: 'fault', data: JSON.stringify({ path: '/own-fixture/watch/denied', code: 'EACCES', message: 'Permission denied' }) });
    assert.match(JSON.stringify(g.states), /\/own-fixture\/watch\/denied/, 'fault must be retained for visible rendering');
    assert.deepEqual(g.nav, [], 'healthy neighbours must remain connected');
  } finally {
    for (const cleanup of cleanups) cleanup();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    delete globalThis.__watchFaultTest;
    await rm(directory, { recursive: true, force: true });
  }
});
