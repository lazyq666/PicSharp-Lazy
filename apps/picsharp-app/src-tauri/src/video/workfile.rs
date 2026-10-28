use std::{
    fs,
    path::{Path, PathBuf},
};

// A task owns one freshly-created directory, never an existing file or namespace.
// On Unix, open directory handles continue to identify it when any ancestor moves.
pub struct WorkFile {
    pub path: PathBuf,
    directory: PathBuf,
    #[cfg(unix)]
    parent: fs::File,
    #[cfg(unix)]
    handle: fs::File,
}

impl WorkFile {
    pub fn new(parent: &Path, id: &str) -> Result<Self, String> {
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("无效的视频任务编号。".into());
        }
        #[cfg(unix)]
        let parent_handle = fs::File::open(parent).map_err(|e| e.to_string())?;
        let directory = parent.join(format!(".picsharp-video-{id}"));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let handle = match fs::File::open(&directory) {
            Ok(handle) => handle,
            Err(error) => {
                let _ = fs::remove_dir(&directory);
                return Err(error.to_string());
            }
        };
        Ok(Self {
            path: directory.join("output.mp4"),
            directory,
            #[cfg(unix)]
            parent: parent_handle,
            #[cfg(unix)]
            handle,
        })
    }
}

impl Drop for WorkFile {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::{fd::AsRawFd, unix::ffi::OsStrExt},
            };
            let file = CString::new("output.mp4").unwrap();
            let name = CString::new(self.directory.file_name().unwrap().as_bytes()).unwrap();
            // Both names are inside directory handles opened for this task. No
            // recursive scan, symlink following, or deletion through the old path.
            unsafe {
                libc::unlinkat(self.handle.as_raw_fd(), file.as_ptr(), 0);
                libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}
