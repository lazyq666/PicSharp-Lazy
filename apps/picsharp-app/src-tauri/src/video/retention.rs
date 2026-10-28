use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
}

impl OutputStamp {
    pub fn unchanged(&self, path: &Path) -> bool {
        stamp(path).is_ok_and(|current| self.same_version(&current))
    }

    fn same_version(&self, current: &Self) -> bool {
        self.path == current.path
            && self.version == current.version
            && self.bytes == current.bytes
            && self.modified_ns == current.modified_ns
    }

    fn identity(&self) -> Option<String> {
        let mut fields = self.version.as_deref()?.split(':');
        Some(format!("{}:{}", fields.next()?, fields.next()?))
    }

    // Rename changes path/ctime, so identity alone is only a lookup hint. Verify
    // the bytes before accepting it, including edits preserving size and mtime.
    pub fn matches(&self, current: &Self) -> bool {
        if self.same_version(current) {
            return true;
        }
        self.identity().is_some()
            && self.identity() == current.identity()
            && self.bytes == current.bytes
            && self.fingerprint.as_ref().is_some_and(|fingerprint| {
                fingerprinted_stamp(Path::new(&current.path)).is_ok_and(|verified| {
                    current.same_version(&verified)
                        && verified.fingerprint.as_ref() == Some(fingerprint)
                })
            })
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
        fingerprint: None,
    })
}

// Only read generated outputs, or a candidate whose identity has a known output
// record. Streaming keeps memory bounded even for multi-gigabyte videos.
pub fn fingerprinted_stamp(path: &Path) -> Result<OutputStamp, String> {
    fingerprinted_stamp_cancellable(path, || false)
}

pub fn fingerprinted_stamp_cancellable(
    path: &Path,
    cancelled: impl Fn() -> bool,
) -> Result<OutputStamp, String> {
    let mut snapshot = stamp(path)?;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err(super::engine::CANCELLED.into());
        }
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if !snapshot.unchanged(path) {
        return Err(super::WATCH_INPUT_CHANGED.into());
    }
    snapshot.fingerprint = Some(format!("sha256:{:x}", hash.finalize()));
    Ok(snapshot)
}

// Publishing/removing a hard link changes ctime. Carry the fingerprint of our
// private staging file only to the same published file identity and data version.
pub fn published_stamp(path: &Path, rendered: &OutputStamp) -> Result<OutputStamp, String> {
    let mut current = stamp(path)?;
    if rendered.identity() != current.identity()
        || rendered.bytes != current.bytes
        || rendered.modified_ns != current.modified_ns
    {
        return Err(super::WATCH_INPUT_CHANGED.into());
    }
    current.fingerprint = rendered.fingerprint.clone();
    Ok(current)
}

fn stamp_path(root: &Path, key: &str) -> PathBuf {
    record_path(&root.join("outputs"), key)
}

fn record_path(directory: &Path, key: &str) -> PathBuf {
    // Stable FNV-1a filename, with the full path checked on reads to detect collisions.
    let hash = key.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    directory.join(format!("{hash:016x}.json"))
}

fn identity_stamp_path(root: &Path, stamp: &OutputStamp) -> Option<PathBuf> {
    Some(record_path(
        &root.join("outputs/identities"),
        &stamp.identity()?,
    ))
}

fn read_stamp(target: &Path) -> Option<OutputStamp> {
    fs::read(target)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

// Output provenance is not a cache: retain it on disk independently of the bounded
// history so an old generated video can never re-enter a watched compression queue.
// Lookup reads at most two small records, without scanning all past outputs.
pub fn remember_output(root: &Path, path: &Path) -> Result<OutputStamp, String> {
    let stamp = fingerprinted_stamp(path)?;
    save_stamp(root, &stamp)?;
    Ok(stamp)
}

pub fn save_stamp(root: &Path, stamp: &OutputStamp) -> Result<(), String> {
    write_stamp(&stamp_path(root, &stamp.path), stamp)?;
    if let Some(target) = identity_stamp_path(root, stamp) {
        write_stamp(&target, stamp)?;
    }
    Ok(())
}

fn write_stamp(target: &Path, stamp: &OutputStamp) -> Result<(), String> {
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
    let stored = read_stamp(&target);
    let identity_record = identity_stamp_path(root, current)
        .and_then(|path| read_stamp(&path))
        .filter(|saved| Some(saved) != stored.as_ref());
    for saved in stored.iter().chain(identity_record.iter()) {
        if saved.matches(current) {
            // Remember the verified new name/version so repeated events don't
            // reread the video. The fingerprint still describes only these bytes.
            if !saved.same_version(current) {
                let mut verified = current.clone();
                verified.fingerprint = saved.fingerprint.clone();
                if let Err(error) = save_stamp(root, &verified) {
                    log::warn!("Video output record: {error}");
                }
            }
            return true;
        }
    }
    match stored {
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
    let mut current = stamp(path).ok()?;
    let known = match expected {
        Some(expected) => expected.matches(&current),
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
    // Upgrade only a still-verified output. Never fingerprint an unverified
    // replacement simply because its path appears in old history.
    current.fingerprint = expected.and_then(|saved| saved.fingerprint.clone());
    if current.fingerprint.is_none() {
        current.fingerprint = read_stamp(&stamp_path(root, &current.path))
            .filter(|saved| saved.same_version(&current))
            .and_then(|saved| saved.fingerprint);
    }
    if current.fingerprint.is_none() {
        let verified = fingerprinted_stamp(path).ok()?;
        if !current.same_version(&verified) {
            return None;
        }
        current = verified;
    }
    if let Err(error) = save_stamp(root, &current) {
        log::warn!("Video output record: {error}");
    }
    Some(current)
}
