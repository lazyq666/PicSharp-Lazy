import { create } from 'zustand';
import EventEmitter from 'eventemitter3';
import useAppStore from './app';
import { clearImageViewerCache } from '@/components/image-viewer/cache';
import { trimWatchHistory } from '@/utils/watch-history';

interface CompressionState {
  batchRevision: number;
  working: boolean;
  inCompressing: boolean;
  watchingFolder: string;
  eventEmitter: EventEmitter;
  files: FileInfo[];
  fileMap: Map<string, FileInfo>;
  selectedFiles: string[];
}

interface CompressionAction {
  setWorking: (value: boolean) => void;
  setInCompressing: (inCompressing: boolean) => void;
  setWatchingFolder: (path: string) => void;
  setFiles: (files: FileInfo[]) => void;
  appendFiles: (files: FileInfo[]) => void;
  removeFile: (path: string) => void;
  reset: () => void;
  trimWatchHistory: () => void;
}

const useCompressionStore = create<CompressionState & CompressionAction>((set, get) => ({
  batchRevision: 0,
  working: false,
  eventEmitter: new EventEmitter(),
  watchingFolder: '',
  files: [],
  fileMap: new Map(),
  selectedFiles: [],
  inCompressing: false,
  setWorking: (value: boolean) => {
    set({ working: value });
  },
  setInCompressing: (inCompressing: boolean) => {
    set({ inCompressing });
  },
  setWatchingFolder: (path) => {
    set({ watchingFolder: path });
  },
  setFiles: (files: FileInfo[]) => {
    if (get().watchingFolder) files = trimWatchHistory(files);
    set({
      batchRevision: get().batchRevision + 1,
      files,
      fileMap: new Map(files.map((file) => [file.path, file])),
      selectedFiles: files.map((file) => file.path),
    });
  },
  appendFiles: (incoming: FileInfo[]) => {
    const state = get();
    const fileMap = new Map(state.fileMap);
    const added = incoming.filter((file) => {
      if (fileMap.has(file.path)) return false;
      fileMap.set(file.path, file);
      return true;
    });
    if (!added.length) return;
    set({
      files: [...state.files, ...added],
      fileMap,
      selectedFiles: [...state.selectedFiles, ...added.map((file) => file.path)],
    });
  },
  trimWatchHistory: () => {
    if (!get().watchingFolder) return;
    const files = trimWatchHistory(get().files);
    if (files !== get().files) {
      const fileMap = new Map(files.map((file) => [file.path, file]));
      set({
        files,
        fileMap,
        selectedFiles: get().selectedFiles.filter((path) => fileMap.has(path)),
      });
    }
  },
  removeFile: (path: string) => {
    const targetIndex = get().files.findIndex((file) => file.path === path);
    if (targetIndex !== -1) {
      get().files.splice(targetIndex, 1);
      get().fileMap.delete(path);
      const selectedFiles = get().selectedFiles.filter((file) => file !== path);
      set({
        files: [...get().files],
        fileMap: new Map(get().fileMap),
        selectedFiles,
      });
    }
  },
  reset: () => {
    clearImageViewerCache();
    useAppStore.getState().clearImageCache();
    set({
      batchRevision: get().batchRevision + 1,
      working: false,
      inCompressing: false,
      watchingFolder: '',
      files: [],
      fileMap: new Map(),
      selectedFiles: [],
    });
  },
}));

export default useCompressionStore;
