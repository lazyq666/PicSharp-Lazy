import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(app, '../..');
const require = createRequire(join(app, 'package.json'));
const { build } = require('esbuild');
const React = require('react');
const { create, act } = require('react-test-renderer');
const files = [
  'pages/compression/classic-guide.tsx',
  'pages/compression/classic-layout.tsx',
  'pages/compression/classic.tsx',
  'pages/compression/classic-file-manager.tsx',
  'pages/compression/index.tsx',
  'store/compression.ts',
  'utils/fs.ts',
  'constants.ts',
  'hooks/useNavigate.ts',
];

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function createClassicHarness({
  sourceRoot = process.env.CLASSIC_DROP_SOURCE_ROOT,
  revision = process.env.CLASSIC_DROP_REVISION,
  mutate,
  deferredSubscription = false,
} = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-classic-drop-')));
  const sources = new Set();
  async function source(file) {
    if (revision) {
      try {
        return execFileSync('git', ['show', `${revision}:apps/picsharp-app/src/${file}`], {
          cwd: repo,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
      } catch {
        return null;
      }
    }
    try {
      return await readFile(join(sourceRoot || join(app, 'src'), file), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  for (const file of files) {
    let contents = await source(file);
    if (contents === null) continue;
    if (mutate) contents = mutate(file, contents);
    const target = join(base, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    sources.add(target);
  }
  const routes = await source('routes.tsx');
  assert.match(routes, /path='guide' element=\{<ClassicCompressionGuide \/>\}/);
  assert.match(routes, /path='workspace' element=\{<CompressionClassic \/>\}/);
  const hasLayout = sources.has(join(base, 'pages/compression/classic-layout.tsx'));
  if (hasLayout) assert.match(routes, /path='classic' element=\{<ClassicCompressionLayout \/>\}/);
  const entry = join(base, 'entry.tsx');
  await writeFile(
    entry,
    `
    import React from 'react';
    import {MemoryRouter, Routes, Route, useLocation, useNavigate} from 'react-router';
    import Guide from './pages/compression/classic-guide';
    import Classic from './pages/compression/classic';
    import Compression from './pages/compression';
    import store from './store/compression';
    ${hasLayout ? "import ClassicCompressionLayout, {ClassicImportContext} from './pages/compression/classic-layout';" : ''}
    function Location() { const f=globalThis.__classicDropFixture; f.location=useLocation().pathname; f.navigate=useNavigate(); return null; }
    function CaptureImport() { ${hasLayout ? 'globalThis.__classicDropFixture.importFiles=React.useContext(ClassicImportContext).importFiles;' : ''} return null; }
    export {store};
    export function Harness(){return <MemoryRouter initialEntries={['/compression/classic/guide']}><Location/><Routes><Route path='/compression' element={<Compression/>}><Route path='classic' ${hasLayout ? 'element={<ClassicCompressionLayout/>}' : ''}><Route path='guide' element={<><CaptureImport/><Guide/></>}/><Route path='workspace' element={<Classic/>}/></Route><Route path='watch/guide' element={<div>watch</div>}/></Route><Route path='/outside' element={<div>outside</div>}/></Routes></MemoryRouter>;}
  `,
  );
  const fixture = {
    listeners: new Set(),
    nativeCalls: [],
    errors: [],
    messages: [],
    pendingSubscriptions: [],
    parseHooks: new Map(),
    directoryEntries: new Map(),
    subscribed: 0,
    unsubscribed: 0,
    subscribe(callback) {
      const finish = () => {
        fixture.subscribed++;
        fixture.listeners.add(callback);
        return () => {
          fixture.unsubscribed++;
          fixture.listeners.delete(callback);
        };
      };
      return deferredSubscription
        ? new Promise((done) => fixture.pendingSubscriptions.push(() => done(finish())))
        : Promise.resolve(finish());
    },
    async invoke(command, args) {
      fixture.nativeCalls.push({ command, args });
      if (command === 'ipc_register_videos') return [];
      if (command !== 'ipc_parse_paths') throw new Error(`Unexpected native command: ${command}`);
      for (const path of args.paths)
        if (fixture.parseHooks.has(path)) await fixture.parseHooks.get(path)();
      return args.paths
        .flatMap((path) => fixture.directoryEntries.get(path) || [path])
        .filter((path) => args.validExts.includes(path.split('.').at(-1)))
        .map((path) => ({
          id: path,
          path,
          name: path.split('/').at(-1),
          base_dir: '/fixture',
          bytes_size: 100,
          disk_size: 100,
          ext: path.split('.').at(-1),
          mime_type: path.endsWith('.mp4') ? 'video/mp4' : 'image/png',
        }));
    },
  };
  const mockApp =
    'export default {getState:()=>({clearImageCache:()=>{},sidecar:{origin:"http://fixture.invalid"}})};';
  const mocks = {
    '@tauri-apps/api/webview':
      'export const getCurrentWebview=()=>({onDragDropEvent:cb=>globalThis.__classicDropFixture.subscribe(cb)});',
    '@tauri-apps/api/core':
      'export const convertFileSrc=x=>x;export const invoke=(...args)=>globalThis.__classicDropFixture.invoke(...args);',
    '@tauri-apps/plugin-dialog': 'export const open=async()=>null;',
    '@tauri-apps/api/path': "export const downloadDir=async()=>'/fixture';",
    '@tauri-apps/plugin-fs':
      'export const exists=async()=>false;export const copyFile=async()=>{};export const remove=async()=>{};',
    '@/i18n': 'export const useI18n=()=>x=>x;',
    '@/routes': `import {createContext} from 'react';export const AppContext=createContext({messageApi:{error:x=>globalThis.__classicDropFixture.errors.push(String(x)),info:()=>{},loading:()=>{},destroy:()=>{}}});`,
    '@/utils':
      'export const isValidArray=a=>Array.isArray(a)&&a.length>0;export const sleep=async()=>{};export const preventDefault=()=>{};export const isMac=true;export const isLinux=false;',
    '.': 'export const isValidArray=a=>Array.isArray(a)&&a.length>0;export const isMac=true;export const isLinux=false;',
    '@/hooks/useReport': 'export const useReport=()=>()=>{};',
    '@/hooks/useSelector': 'export default ()=>state=>state;',
    '@/utils/clipboard': 'export const parseClipboardImages=async()=>({success:true,paths:[]});',
    '@/utils/video':
      'export const restoreVideoHistory=async()=>[];export const listenVideoJobs=async()=>()=>{};',
    '@/utils/watch-history': 'export const trimWatchHistory=x=>x;',
    '@/store/settings':
      "export default {getState:()=>({video_preset:'balanced',video_output_folder:''})};",
    '@/store/app': mockApp,
    './app': mockApp,
    '@/components/image-viewer/cache': 'export const clearImageViewerCache=()=>{};',
    './compressor':
      "export const ICompressor={Status:{Pending:'pending',Processing:'processing',Completed:'completed'}};",
    '@/utils/window': 'export const openSettingsWindow=()=>{};',
    '@/components/message':
      'export default {info:x=>globalThis.__classicDropFixture.messages.push(x),warning:()=>{},confirm:async()=>true};',
    '@/components/fullscreen-progress':
      "import React,{forwardRef,useImperativeHandle} from 'react';export const PageProgress=forwardRef((p,r)=>{useImperativeHandle(r,()=>({show:()=>{},done:()=>{}}));return null;});",
    ahooks: 'export const useUpdateEffect=()=>{};',
    '@/lib/utils': 'export const cn=(...x)=>x.join(" ");',
    'lucide-react':
      "export const Folder='folder';export const Upload='upload';export const History='history';",
    antd: "export const Empty='empty';",
    '@/components/ui/button': "export const Button='button';",
    '@/components/ui/scroll-area':
      "import React,{forwardRef} from 'react';export const ScrollArea=forwardRef((p,r)=>React.createElement('scroll-area',{...p,ref:r}));",
    './file-card': 'export default ()=>null;',
    './toolbar': 'export default ()=>null;',
    './toolbar-pagination': 'export default ()=>null;',
    '@/components/animated-icon/upload-widget': 'export default ()=>null;',
    './formats-tips': 'export default ()=>null;',
  };
  function resolveReal(specifier, importer) {
    const candidate = specifier.startsWith('@/')
      ? join(base, specifier.slice(2))
      : resolve(dirname(importer), specifier);
    return [candidate, candidate + '.ts', candidate + '.tsx', join(candidate, 'index.tsx')].find(
      (target) => sources.has(target),
    );
  }
  const output = join(base, 'bundle.cjs');
  try {
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      nodePaths: [join(app, 'node_modules')],
      plugins: [
        {
          name: 'native-and-leaf-adapters',
          setup(b) {
            b.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, ({ path }) => ({
              path: require.resolve(path),
              external: true,
            }));
            b.onResolve({ filter: /.*/ }, (args) => {
              if (!sources.has(args.importer)) return;
              const target = resolveReal(args.path, args.importer);
              if (target) return { path: target };
              if (['react-router', 'radash', 'zustand', 'eventemitter3'].includes(args.path))
                return;
              if (args.path in mocks) return { path: args.path, namespace: 'adapter' };
              throw new Error(`Unhandled adapter ${args.path} from ${args.importer}`);
            });
            b.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({
              contents: mocks[path],
              loader: 'js',
              resolveDir: app,
            }));
          },
        },
      ],
    });
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.__classicDropFixture = fixture;
  const { Harness, store } = require(output);
  let renderer;
  const settle = async () =>
    act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done));
    });
  await act(async () => {
    renderer = create(React.createElement(Harness), {
      createNodeMock: () => ({ classList: { add() {}, remove() {} }, scrollToTop() {} }),
    });
  });
  const emit = async (paths, type = 'drop') => {
    await act(async () => {
      for (const callback of [...fixture.listeners])
        Promise.resolve(callback({ payload: { type, paths } })).catch((error) =>
          fixture.errors.push(String(error)),
        );
      for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done));
    });
  };
  const navigate = async (path) => {
    await act(async () => fixture.navigate(path));
    await settle();
  };
  const unmount = async () => {
    if (renderer) {
      await act(async () => renderer.unmount());
      renderer = null;
    }
  };
  return {
    fixture,
    store,
    settle,
    emit,
    navigate,
    unmount,
    paths: () => store.getState().files.map((file) => file.path),
    parseCalls: () => fixture.nativeCalls.filter((call) => call.command === 'ipc_parse_paths'),
    registerCalls: () =>
      fixture.nativeCalls.filter((call) => call.command === 'ipc_register_videos'),
    async resolveSubscriptions() {
      await act(async () => fixture.pendingSubscriptions.splice(0).forEach((finish) => finish()));
      await settle();
    },
    async close() {
      await unmount();
      globalThis.document = previousDocument;
      delete globalThis.__classicDropFixture;
      delete require.cache[output];
      await rm(base, { recursive: true, force: true });
    },
  };
}
