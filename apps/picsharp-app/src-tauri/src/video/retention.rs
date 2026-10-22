use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const HISTORY_LIMIT: usize = 500;

pub struct CachePolicy {
    pub extension: &'static str,
    pub count: usize,
    pub bytes: u64,
    pub age: Duration,
}

pub const THUMBNAILS: CachePolicy = CachePolicy {
    extension: "jpg",
    count: 500,
    bytes: 64 * 1024 * 1024,
    age: Duration::from_secs(30 * 86400),
};
pub const LOGS: CachePolicy = CachePolicy {
    extension: "log",
    count: 200,
    bytes: 32 * 1024 * 1024,
    age: Duration::from_secs(14 * 86400),
};

// Only regular files directly inside our cache are eligible. Never follow symlinks.
pub fn clean_cache(directory: &Path, policy: &CachePolicy, protected: &HashSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some(policy.extension) {
                return None;
            }
            let metadata = fs::symlink_metadata(&path).ok()?;
            metadata.is_file().then(|| {
                (
                    path,
                    metadata.len(),
                    metadata.modified().unwrap_or(UNIX_EPOCH),
                )
            })
        })
        .collect();
    files.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
    let now = SystemTime::now();
    let mut count = 0;
    let mut bytes: u64 = 0;
    for (path, size, modified) in files {
        let expired = now.duration_since(modified).unwrap_or_default() > policy.age;
        if !protected.contains(&path)
            && (expired || count >= policy.count || bytes.saturating_add(size) > policy.bytes)
        {
            if fs::remove_file(&path).is_ok() {
                continue;
            }
        }
        count += 1;
        bytes = bytes.saturating_add(size);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputStamp {
    pub path: String,
    bytes: u64,
    modified_ns: u128,
    #[serde(default)]
    pub version: Option<String>,
}

impl OutputStamp {
    pub fn unchanged(&self, path: &Path) -> bool {
        stamp(path).is_ok_and(|current| current == *self)
    }

    fn changed_ns(&self) -> Option<u128> {
        self.version.as_ref()?.rsplit(':').next()?.parse().ok()
    }
}

// Match the sidecar's metadata signature; no video bytes are read.
#[cfg(unix)]
fn file_version(_path: &Path, metadata: &fs::Metadata) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let modified = i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec());
    let changed = i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec());
    Ok(format!(
        "{}:{}:{}:{modified}:{changed}",
        metadata.dev(),
        metadata.ino(),
        metadata.len()
    ))
}

#[cfg(windows)]
fn file_version(path: &Path, metadata: &fs::Metadata) -> Result<String, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO,
    };
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    // Both structures are fully initialized by the successful Windows calls.
    let mut identity: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandle(file.as_raw_handle(), &mut identity) != 0
            && GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            ) != 0
    };
    if !ok {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let inode = (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow);
    let unix_ns = |ticks: i64| (i128::from(ticks) - 116_444_736_000_000_000) * 100;
    Ok(format!(
        "{}:{inode}:{}:{}:{}",
        identity.dwVolumeSerialNumber,
        metadata.len(),
        unix_ns(basic.LastWriteTime),
        unix_ns(basic.ChangeTime)
    ))
}

pub fn stamp(path: &Path) -> Result<OutputStamp, String> {
    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("不是普通文件".into());
    }
    let version = file_version(&path, &metadata)?;
    let mut key = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    Ok(OutputStamp {
        path: key,
        bytes: metadata.len(),
        modified_ns: metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        version: Some(version),
    })
}

fn stamp_path(root: &Path, key: &str) -> PathBuf {
    // Stable FNV-1a filename, with the full path checked on reads to detect collisions.
    let hash = key.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    root.join("outputs").join(format!("{hash:016x}.json"))
}

// Output provenance is not a cache: retain it on disk independently of the bounded
// history so an old generated video can never re-enter a watched compression queue.
// Lookup reads one small file, never the complete history or an unbounded RAM index.
pub fn remember_output(root: &Path, path: &Path) -> Result<OutputStamp, String> {
    let stamp = stamp(path)?;
    save_stamp(root, &stamp)?;
    Ok(stamp)
}

pub fn save_stamp(root: &Path, stamp: &OutputStamp) -> Result<(), String> {
    let target = stamp_path(root, &stamp.path);
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = target.with_extension(format!("{}.tmp", nanoid::nanoid!()));
    let guard = super::engine::TempFile(temporary);
    fs::write(
        &guard.0,
        serde_json::to_vec(&stamp).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&guard.0, target).map_err(|e| e.to_string())
}

pub fn is_output(root: &Path, path: &Path) -> bool {
    let Ok(current) = stamp(path) else {
        return false;
    };
    is_output_stamp(root, &current)
}

pub fn is_output_stamp(root: &Path, current: &OutputStamp) -> bool {
    let target = stamp_path(root, &current.path);
    let stored = fs::read(&target)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<OutputStamp>(&bytes).ok());
    match stored {
        Some(stored) if stored == *current => true,
        // Old records did not store ctime/inode. Only migrate unchanged files whose
        // change time predates the record; never bless a replacement at startup.
        Some(stored)
            if stored.version.is_none()
                && stored.path == current.path
                && stored.bytes == current.bytes
                && stored.modified_ns == current.modified_ns =>
        {
            modified_ns(&target)
                .zip(current.changed_ns())
                .is_some_and(|(saved, changed)| changed <= saved)
        }
        _ => false,
    }
}

fn modified_ns(path: &Path) -> Option<u128> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_nanos())
}

pub fn restore_output(
    root: &Path,
    path: &Path,
    bytes: u64,
    expected: Option<&OutputStamp>,
    allow_legacy: bool,
) -> Option<OutputStamp> {
    let current = stamp(path).ok()?;
    let known = match expected {
        Some(expected) => *expected == current,
        None => {
            is_output_stamp(root, &current)
                || (allow_legacy
                    && !stamp_path(root, &current.path).exists()
                    && current.bytes == bytes
                    && modified_ns(&root.join("jobs.json"))
                        .zip(current.changed_ns())
                        .is_some_and(|(saved, changed)| changed <= saved))
        }
    };
    if !known {
        return None;
    }
    if let Err(error) = save_stamp(root, &current) {
        log::warn!("Video output record: {error}");
    }
    Some(current)
}
