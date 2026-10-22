mod engine;
#[cfg(test)]
mod tests;
use engine::{Cancel, Engine, MediaInfo, Output, Preset, Progress};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    id: String,
    path: PathBuf,
    preset: Preset,
    directory: PathBuf,
    status: String,
    #[serde(default)]
    input_bytes: u64,
    #[serde(default)]
    info: Option<MediaInfo>,
    #[serde(default)]
    thumbnail: Option<PathBuf>,
    #[serde(default)]
    progress: Progress,
    #[serde(default)]
    output: Option<Output>,
    #[serde(default)]
    error: Option<String>,
}
struct Data {
    jobs: Vec<Job>,
    controls: HashMap<String, Cancel>,
}
pub struct VideoService {
    root: PathBuf,
    data: Mutex<Data>,
    queue: tokio::sync::Mutex<()>,
    probes: tokio::sync::Semaphore,
    pub exiting: AtomicBool,
}
impl VideoService {
    pub fn new(root: PathBuf) -> Self {
        let mut jobs: Vec<Job> = std::fs::read(root.join("jobs.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        for job in &mut jobs {
            if ["processing", "pending"].contains(&job.status.as_str()) {
                job.status = "cancelled".into();
                job.error = Some("上次任务中断，可重试。".into());
                job.progress = Progress::default();
                // Only remove the precise temporary path recorded by our own job.
                if job
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    let _ = std::fs::remove_file(
                        job.directory
                            .join(format!(".picsharp-video-{}.mp4", job.id)),
                    );
                }
            }
        }
        Self {
            root,
            data: Mutex::new(Data {
                jobs,
                controls: HashMap::new(),
            }),
            queue: tokio::sync::Mutex::new(()),
            probes: tokio::sync::Semaphore::new(2),
            exiting: AtomicBool::new(false),
        }
    }
    fn save(&self, data: &Data) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let temp = self.root.join("jobs.json.tmp");
        let bytes = serde_json::to_vec_pretty(&data.jobs).map_err(|e| e.to_string())?;
        std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(temp, self.root.join("jobs.json")).map_err(|e| e.to_string())
    }
    fn update(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        persist: bool,
        change: impl FnOnce(&mut Job),
    ) {
        let mut data = self.data.lock().unwrap();
        if let Some(job) = data.jobs.iter_mut().find(|j| j.id == id) {
            change(job);
            let _ = app.emit("video-job", job.clone());
            if persist {
                if let Err(e) = self.save(&data) {
                    log::error!("Video history: {e}");
                }
            }
        }
    }
    pub fn cancel_all(&self) {
        for cancel in self.data.lock().unwrap().controls.values() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    pub fn idle(&self) -> bool {
        self.data.lock().unwrap().controls.is_empty()
    }
}

fn discover(app: &tauri::AppHandle) -> Result<Engine, String> {
    let name = |base: &str| {
        if cfg!(windows) {
            format!("{base}.exe")
        } else {
            base.to_string()
        }
    };
    let mut dirs = vec![app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/video")];
    // Development may use PATH or an explicit local bundle. Release builds use packaged resources only.
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("PICSHARP_VIDEO_BIN_DIR") {
            dirs.push(PathBuf::from(dir));
        }
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/video"));
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
    }
    for dir in dirs {
        let engine = Engine {
            ffmpeg: dir.join(name("ffmpeg")),
            ffprobe: dir.join(name("ffprobe")),
        };
        if engine.ffmpeg.is_file() && engine.ffprobe.is_file() {
            return Ok(engine);
        }
    }
    Err("未找到视频引擎。请安装包含 FFmpeg 和 ffprobe 的完整版 PicSharp（需要 libsvtav1、libx264）。".into())
}

#[tauri::command]
pub async fn ipc_video_engine_status(app: tauri::AppHandle) -> Result<String, String> {
    discover(&app)?.check().await?;
    Ok("FFmpeg · AV1 / H.264 · CPU".into())
}
#[derive(Serialize)]
pub struct Preview {
    info: MediaInfo,
    thumbnail: Option<PathBuf>,
}
#[tauri::command]
pub async fn ipc_video_preview(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<Preview, String> {
    let _permit = state.probes.acquire().await.map_err(|e| e.to_string())?;
    let engine = discover(&app)?;
    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    validate_extension(&path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let info = engine.inspect(&path, &cancel).await?;
    let cache = state.root.join("thumbnails");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    // Stable key avoids accumulating another thumbnail every time history is opened.
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash);
    if let Ok(md) = path.metadata() {
        md.len().hash(&mut hash);
        md.modified().ok().hash(&mut hash);
    }
    let thumbnail = cache.join(format!("{:x}.jpg", hash.finish()));
    let thumbnail = if info.hdr {
        None
    } else if thumbnail.is_file()
        || engine
            .thumbnail(&path, &info, &thumbnail, &cancel)
            .await
            .is_ok()
    {
        Some(thumbnail)
    } else {
        None
    };
    Ok(Preview { info, thumbnail })
}
fn validate_extension(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !engine::EXTENSIONS.contains(&ext.as_str()) {
        return Err("不支持此视频容器格式。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ipc_compress_video(
    app: tauri::AppHandle,
    path: String,
    preset: Preset,
    directory: Option<String>,
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<Output, String> {
    if state.exiting.load(Ordering::SeqCst) {
        return Err(engine::CANCELLED.into());
    }
    let path = dunce::canonicalize(path).map_err(|e| format!("无法读取视频：{e}"))?;
    validate_extension(&path)?;
    let directory = directory
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| path.parent().unwrap().join("PicSharp Videos"));
    if !directory.is_absolute() {
        return Err("请选择完整的本机输出文件夹路径。".into());
    }
    let id = nanoid::nanoid!();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut data = state.data.lock().unwrap();
        if data
            .jobs
            .iter()
            .any(|j| j.path == path && data.controls.contains_key(&j.id))
        {
            return Err("此视频已经在压缩队列中。".into());
        }
        let job = Job {
            id: id.clone(),
            path: path.clone(),
            preset,
            directory: directory.clone(),
            status: "pending".into(),
            input_bytes: path.metadata().map(|m| m.len()).unwrap_or(0),
            info: None,
            thumbnail: None,
            progress: Progress::default(),
            output: None,
            error: None,
        };
        // One latest record per source; completed output files remain untouched.
        data.jobs.retain(|j| j.path != path);
        data.jobs.push(job.clone());
        state
            .save(&data)
            .map_err(|e| format!("无法保存视频任务记录：{e}"))?;
        data.controls.insert(id.clone(), cancel.clone());
        let _ = app.emit("video-job", job);
    }
    let result = async {
        let _guard = tokio::select! {
            _ = engine::cancelled(&cancel) => return Err(engine::CANCELLED.into()),
            guard = state.queue.lock() => guard,
        };
        if cancel.load(Ordering::SeqCst) {
            return Err(engine::CANCELLED.into());
        }
        state.update(&app, &id, true, |j| j.status = "processing".into());
        let engine = discover(&app)?;
        let info = engine.inspect(&path, &cancel).await?;
        state.update(&app, &id, false, |j| j.info = Some(info));
        engine
            .compress(
                &path,
                &directory,
                &state.root.join("logs"),
                &id,
                preset,
                &cancel,
                |progress| {
                    state.update(&app, &id, false, |j| j.progress = progress);
                },
            )
            .await
    }
    .await;
    state.update(&app, &id, true, |j| match &result {
        Ok(output) => {
            j.status = "completed".into();
            j.output = Some(output.clone());
            j.progress.fraction = 1.0;
            j.progress.remaining = Some(0.0);
        }
        Err(error) => {
            j.status = if cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            j.error = Some(error.clone());
            j.progress = Progress::default();
        }
    });
    state.data.lock().unwrap().controls.remove(&id);
    result
}
#[tauri::command]
pub fn ipc_cancel_video(path: String, state: tauri::State<'_, Arc<VideoService>>) {
    let path = dunce::canonicalize(&path).unwrap_or(PathBuf::from(path));
    let data = state.data.lock().unwrap();
    for job in data.jobs.iter().filter(|j| j.path == path) {
        if let Some(cancel) = data.controls.get(&job.id) {
            cancel.store(true, Ordering::SeqCst);
        }
    }
}
#[tauri::command]
pub fn ipc_video_history(state: tauri::State<'_, Arc<VideoService>>) -> Vec<Job> {
    state.data.lock().unwrap().jobs.clone()
}

pub fn is_video_extension(ext: &str) -> bool {
    engine::EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

#[tauri::command]
pub fn ipc_register_videos(
    paths: Vec<String>,
    preset: Preset,
    directory: Option<String>,
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<(), String> {
    let mut data = state.data.lock().unwrap();
    for path in paths {
        let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
        validate_extension(&path)?;
        if data
            .jobs
            .iter()
            .any(|j| j.path == path && data.controls.contains_key(&j.id))
        {
            continue;
        }
        let directory = directory
            .as_ref()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| path.parent().unwrap().join("PicSharp Videos"));
        data.jobs.retain(|j| j.path != path);
        data.jobs.push(Job {
            id: nanoid::nanoid!(),
            input_bytes: path.metadata().map(|m| m.len()).unwrap_or(0),
            path,
            preset,
            directory,
            status: "ready".into(),
            info: None,
            thumbnail: None,
            progress: Progress::default(),
            output: None,
            error: None,
        });
    }
    state.save(&data)
}
