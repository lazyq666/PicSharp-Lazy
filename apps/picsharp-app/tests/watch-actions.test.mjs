import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, readFile, writeFile, rm, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(
  await realpath(join(root, 'packages/picsharp-sidecar/node_modules/tsx/package.json')),
);
const { build } = require('esbuild');
const base = await mkdtemp(join(tmpdir(), 'picsharp-watch-actions-'));
const source = (path) => join(root, 'apps/picsharp-app/src', path);
const hookMock = `
export const memo=f=>f; export const forwardRef=f=>f;
export const useRef=current=>({current});
export const useState=current=>[globalThis.__stateOverride !== undefined ? globalThis.__stateOverride : typeof current==='function'?current():current,()=>{}];
export const useEffect=()=>{}; export const useUpdateEffect=()=>{};export const useImperativeHandle=()=>{};
export const useCallback=f=>f;export const useTransition=()=>[false,f=>f()];
export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='fragment';
export const convertFileSrc=v=>v;export const cn=(...v)=>v.join(' ');
export const getImageViewerCacheKey=()=>'';export const putCache=()=>{};export const readCache=()=>null;
export const useI18n=()=>key=>key;
export const Badge='badge';export const Button='button';export const ScrollArea='scroll';
export const Tooltip='tooltip';export const TooltipContent='tooltipcontent';export const TooltipTrigger='tooltiptrigger';
export const Dialog='dialog';export const DialogContent='dialogcontent';export const DialogHeader='dialogheader';export const DialogTitle='dialogtitle';export const Maximize2='maximize';
export default ()=>globalThis.__appStore;
`;
async function bundleComponent(path, name) {
  const out = join(base, name + '.mjs');
  await build({
    entryPoints: [source(path)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [
      {
        name: 'component-shell',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            args.importer ? { path: args.path, namespace: 'mock' } : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents: hookMock,
            loader: 'js',
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(out));
}
const { default: ImageViewer } = await bundleComponent(
  'components/image-viewer/index.tsx',
  'viewer',
);
const { PathTagsInput } = await bundleComponent('components/path-tags-input.tsx', 'tags');
function allElements(tree, result = []) {
  if (!tree || typeof tree !== 'object') return result;
  if (Array.isArray(tree)) {
    tree.forEach((v) => allElements(v, result));
    return result;
  }
  if (tree.props) {
    result.push(tree);
    allElements(tree.props.children, result);
  }
  return result;
}
const fsSource = source('utils/fs.ts');
const compressor = source('utils/compressor.ts');
const constants = source('constants.ts');
const utilities = await readFile(source('utils/index.ts'), 'utf8');
const actualIsValidArray = utilities.match(
  /export function isValidArray\(arr: unknown\) \{[\s\S]*?\n\}/,
)[0];
await build({
  stdin: {
    contents: `export { undoSave } from ${JSON.stringify(fsSource)};`,
    resolveDir: root,
    sourcefile: 'undo-entry.ts',
    loader: 'ts',
  },
  outfile: join(base, 'undo.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'native-shell',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.importer === fsSource) {
            if (args.path === './compressor') return { path: compressor };
            if (args.path === '@/constants') return { path: constants };
            return { path: args.path, namespace: 'adapter' };
          }
          if (args.importer === compressor) {
            if (args.path === '../constants') return { path: constants };
            return { path: args.path, namespace: 'unused' };
          }
        });
        b.onLoad({ filter: /.*/, namespace: 'unused' }, () => ({
          contents:
            'export default class Unused {} export const compressVideo=()=>{};export const draw=()=>{};export const isFunction=v=>typeof v==="function";export const t=k=>k;',
          loader: 'js',
        }));
        b.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({
          loader: 'ts',
          contents:
            path === '.'
              ? actualIsValidArray + '\nexport const isMac=true;export const isLinux=false;'
              : path === '@tauri-apps/plugin-fs'
                ? 'export const exists=p=>globalThis.__ownedFs.exists(p);export const copyFile=(...v)=>globalThis.__ownedFs.copyFile(...v);export const remove=p=>globalThis.__ownedFs.remove(p);'
                : path === '@/store/app'
                  ? 'export default {getState:()=>globalThis.__appStore};'
                  : path === '@/store/settings'
                    ? 'export default {getState:()=>({})};'
                    : 'export const convertFileSrc=v=>v;export const invoke=()=>{throw new Error("unexpected native call")};',
        }));
      },
    },
  ],
});
const { undoSave } = await import(pathToFileURL(join(base, 'undo.mjs')));
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
globalThis.__ownedFs = { exists, copyFile, remove: (p) => rm(p) };

test('WATCH-009: displayed image renders when the sidecar disconnects', () => {
  for (const sidecar of [{ origin: 'http://fixture.invalid' }, null]) {
    globalThis.__appStore = { sidecar, imageTempDir: '/fixture/temp' };
    assert.doesNotThrow(() =>
      ImageViewer({ src: 'asset://fixture', path: '/fixture.png', ext: 'png', size: 300 }, null),
    );
  }
});
test('WATCH-010: confirming an empty edited tag with Return removes it', () => {
  let changed;
  const tree = PathTagsInput({
    value: ['.git', 'node_modules'],
    onChange: (v) => (changed = v),
    optimizeOnChange: false,
  });
  const tag = allElements(tree).find((v) => typeof v.type === 'function' && v.props.index === 1);
  assert.ok(tag, 'real EditableTag is present');
  globalThis.__stateOverride = '';
  const editing = tag.type({ ...tag.props, isEditing: true });
  delete globalThis.__stateOverride;
  const input = allElements(editing).find((v) => v.type === 'input');
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(changed, ['.git']);
});
test('WATCH-010: blank blur confirmation removes the tag; normal edit and remove remain available', () => {
  for (const next of ['   ', '*.png']) {
    let changed;
    const tree = PathTagsInput({
      value: ['.git', 'node_modules'],
      onChange: (v) => (changed = v),
      optimizeOnChange: false,
    });
    const tag = allElements(tree).find((v) => typeof v.type === 'function' && v.props.index === 1);
    globalThis.__stateOverride = next;
    const editing = tag.type({ ...tag.props, isEditing: true });
    delete globalThis.__stateOverride;
    allElements(editing)
      .find((v) => v.type === 'input')
      .props.onBlur();
    assert.deepEqual(changed, next.trim() ? ['.git', '*.png'] : ['.git']);
    tag.props.onRemove(1);
    assert.deepEqual(changed, ['.git']);
  }
});
test('WATCH-014: a stale card never removes a newer file at the old output path', async () => {
  const input = join(base, 'source.png'),
    output = join(base, 'output.png'),
    backup = join(base, 'backup.png');
  await writeFile(input, 'original');
  await writeFile(backup, 'original');
  await writeFile(output, 'NEW USER FILE');
  globalThis.__appStore = { sidecar: null };
  const file = {
    status: 'completed',
    path: input,
    outputPath: output,
    outputVersion: 'old-output-version',
    originalTempPath: backup,
    originalTempPathConverted: 'asset://backup',
    saveType: 'save_to_new_folder',
    convertResults: [],
  };
  const result = await undoSave(file);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await readFile(output, 'utf8'), 'NEW USER FILE');
  assert.equal(result.success, false, 'disconnected Undo must fail safely');
});
test('Undo forwards output identities and awaits the service before reporting success', async () => {
  const originalFetch = globalThis.fetch;
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const file = {
    status: 'completed',
    path: '/source.png',
    outputPath: '/output.png',
    outputVersion: 'main-v1',
    originalTempPath: '/backup.png',
    originalTempPathConverted: 'asset://backup',
    saveType: 'save_to_new_folder',
    convertResults: [
      { success: true, output_path: '/output.webp', output_version: 'converted-v1' },
      { success: false, output_path: '/failed.webp' },
    ],
  };
  globalThis.__appStore = { sidecar: { origin: 'http://local-fixture' } };
  let payload;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://local-fixture/stream/watch/undo-image');
    payload = JSON.parse(init.body);
    await pending;
    return Response.json({ success: true, message: 'undo.success' });
  };
  try {
    let settled = false;
    const undo = undoSave(file).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    assert.equal(payload.outputVersion, 'main-v1');
    assert.deepEqual(payload.convertResults, [
      { output_path: '/output.webp', output_version: 'converted-v1' },
    ]);
    release();
    assert.deepEqual(await undo, { success: true, message: 'undo.success' });
    globalThis.fetch = async () =>
      Response.json({
        success: false,
        message: 'undo.output_file_changed',
        recoveryPaths: ['/retained.png'],
      });
    assert.deepEqual(await undoSave(file), {
      success: false,
      message: 'undo.output_file_changed',
      recoveryPaths: ['/retained.png'],
    });
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
});
test.after(async () => {
  await rm(base, { recursive: true, force: true });
  delete globalThis.__ownedFs;
  delete globalThis.__appStore;
});
