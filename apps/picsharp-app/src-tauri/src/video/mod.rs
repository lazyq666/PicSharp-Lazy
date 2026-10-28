mod engine;
mod previews;
mod retention;
#[cfg(test)]
mod tests;
use engine::{Cancel, Engine, MediaInfo, Output, Preset, Progress};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
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
    media_slots: tokio::sync::Semaphore,
    previews: previews::Previews,
    last_cleanup: Mutex<Option<Instant>>,
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
        // Migrate existing output protection before bounding the visible history.
        for job in &mut jobs {
            if let Some(output) = &mut job.output {
                output.stamp = retention::restore_output(
                    &root,
                    &output.path,
                    output.bytes,
                    output.stamp.as_ref(),
                    !output.protection_checked,
                );
                output.protection_checked = true;
            }
        }
        let service = Self {
            root,
            data: Mutex::new(Data {
                jobs,
                controls: HashMap::new(),
            }),
            queue: tokio::sync::Mutex::new(()),
            media_slots: tokio::sync::Semaphore::new(2),
            previews: previews::Previews::default(),
            last_cleanup: Mutex::new(None),
            exiting: AtomicBool::new(false),
        };
        if let Err(error) = service.save(&mut service.data.lock().unwrap()) {
            log::warn!("Video history: {error}");
        }
        // Partial previews from an interrupted previous run have no live owner.
        retention::clean_cache(
            &service.root.join("thumbnails"),
            &retention::CachePolicy {
                extension: "part",
                count: 0,
                bytes: 0,
                age: Duration::ZERO,
            },
            &HashSet::new(),
        );
        service.clean_cache();
        service
    }
    fn prune_history(&self, data: &mut Data) {
        let mut retained = Vec::new();
        let mut recent = 0;
        for job in std::mem::take(&mut data.jobs).into_iter().rev() {
            if data.controls.contains_key(&job.id) {
                retained.push(job);
            } else if recent < retention::HISTORY_LIMIT {
                recent += 1;
                retained.push(job);
            } else if let Some(output) = &job.output {
                // If persistence failed, keep the fallback record rather than allowing
                // a generated output to be imported again after history eviction.
                if let Some(stamp) = &output.stamp {
                    if stamp.unchanged(&output.path)
                        && !retention::is_output_stamp(&self.root, stamp)
                        && retention::save_stamp(&self.root, stamp).is_err()
                    {
                        retained.push(job);
                    }
                }
            }
        }
        retained.reverse();
        data.jobs = retained;
    }
    fn save(&self, data: &mut Data) -> Result<(), String> {
        self.prune_history(data);
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let temp = self.root.join("jobs.json.tmp");
        let bytes = serde_json::to_vec(&data.jobs).map_err(|e| e.to_string())?;
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
                if let Err(e) = self.save(&mut data) {
                    log::error!("Video history: {e}");
                }
            }
        }
    }
    pub fn cancel_all(&self) {
        for cancel in self.data.lock().unwrap().controls.values() {
            cancel.store(true, Ordering::SeqCst);
        }
        self.previews.cancel_all();
    }
    pub fn idle(&self) -> bool {
        self.data.lock().unwrap().controls.is_empty() && self.previews.idle()
    }
    async fn media_permit(
        &self,
        count: u32,
        cancel: &Cancel,
    ) -> Result<tokio::sync::SemaphorePermit<'_>, String> {
        tokio::select! {
            _ = engine::cancelled(cancel) => Err(engine::CANCELLED.into()),
            permit = self.media_slots.acquire_many(count) => permit.map_err(|e| e.to_string()),
        }
    }
    fn clean_cache(&self) {
        self.previews.clean_unused();
        let mut last = self.last_cleanup.lock().unwrap();
        if last.is_some_and(|time| time.elapsed() < Duration::from_secs(60)) {
            return;
        }
        *last = Some(Instant::now());
        let protected: HashSet<_> = self
            .data
            .lock()
            .unwrap()
            .controls
            .keys()
            .map(|id| self.root.join("logs").join(format!("{id}.log")))
            .collect();
        retention::clean_cache(&self.root.join("logs"), &retention::LOGS, &protected);
        retention::clean_cache(
            &self.root.join("thumbnails"),
            &retention::THUMBNAILS,
            &HashSet::new(),
        );
    }
    pub fn start_maintenance(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(service) = weak.upgrade() else { break };
                if service.exiting.load(Ordering::SeqCst) {
                    break;
                }
                let _ = tokio::task::spawn_blocking(move || service.clean_cache()).await;
            }
        });
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
pub fn ipc_prepare_video_preview(
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<String, String> {
    if state.exiting.load(Ordering::SeqCst) {
        return Err(engine::CANCELLED.into());
    }
    Ok(state.previews.prepare())
}
#[tauri::command]
pub fn ipc_cancel_video_preview(request_id: String, state: tauri::State<'_, Arc<VideoService>>) {
    state.previews.cancel(&request_id);
}
#[tauri::command]
pub async fn ipc_video_preview(
    app: tauri::AppHandle,
    path: String,
    request_id: String,
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<Preview, String> {
    let request = state.previews.start(&request_id)?;
    let cancel = &request.cancel;
    let _permit = state.media_permit(1, cancel).await?;
    let engine = discover(&app)?;
    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    validate_extension(&path)?;
    let info = engine.inspect(&path, cancel).await?;
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
    let temporary = engine::TempFile(cache.join(format!(".preview-{request_id}.part")));
    let cached = std::fs::OpenOptions::new()
        .write(true)
        .open(&thumbnail)
        .and_then(|file| file.set_modified(std::time::SystemTime::now()))
        .is_ok();
    let thumbnail = if info.hdr {
        None
    } else if cached {
        Some(thumbnail)
    } else if engine
        .thumbnail(&path, &info, &temporary.0, cancel)
        .await
        .is_ok()
        && !cancel.load(Ordering::SeqCst)
    {
        std::fs::rename(&temporary.0, &thumbnail).map_err(|e| e.to_string())?;
        Some(thumbnail)
    } else {
        None
    };
    if cancel.load(Ordering::SeqCst) {
        return Err(engine::CANCELLED.into());
    }
    state.clean_cache();
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
    watch_version: Option<String>,
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<Output, String> {
    if state.exiting.load(Ordering::SeqCst) {
        return Err(engine::CANCELLED.into());
    }
    let path = dunce::canonicalize(path).map_err(|e| format!("无法读取视频：{e}"))?;
    validate_extension(&path)?;
    check_watch_input_async(&state, &path, watch_version.as_deref()).await?;
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
            .save(&mut data)
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
        // Encoding takes both slots; previews may run two at a time only while no
        // encoder is running. Cancelled waiters leave the semaphore queue immediately.
        let _media = state.media_permit(2, &cancel).await?;
        // A job may have waited behind a long encode. Recheck its exact version
        // here, not just when its file-system event first arrived.
        check_watch_input_async(&state, &path, watch_version.as_deref()).await?;
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
    if let Ok(output) = &result {
        if let Some(stamp) = &output.stamp {
            if let Err(error) = retention::save_stamp(&state.root, stamp) {
                log::warn!("Video output record: {error}");
            }
        }
    }
    state.update(&app, &id, false, |j| match &result {
        Ok(output) => {
            j.status = "completed".into();
            j.output = Some(output.clone());
            j.progress.fraction = 1.0;
            j.progress.remaining = Some(0.0);
        }
        Err(error) => {
            j.status = if cancel.load(Ordering::SeqCst) || error == WATCH_INPUT_CHANGED {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            j.error = Some(error.clone());
            j.progress = Progress::default();
        }
    });
    {
        let mut data = state.data.lock().unwrap();
        data.controls.remove(&id);
        if let Err(error) = state.save(&mut data) {
            log::error!("Video history: {error}");
        }
    }
    state.clean_cache();
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

#[tauri::command]
pub async fn ipc_filter_video_inputs(
    paths: Vec<String>,
    state: tauri::State<'_, Arc<VideoService>>,
) -> Result<Vec<String>, String> {
    let root = state.root.clone();
    let fallback: Vec<_> = state
        .data
        .lock()
        .unwrap()
        .jobs
        .iter()
        .filter_map(|job| job.output.as_ref().and_then(|output| output.stamp.clone()))
        .collect();
    tokio::task::spawn_blocking(move || filter_video_inputs(paths, &root, &fallback))
        .await
        .map_err(|error| error.to_string())
}

fn filter_video_inputs(
    paths: Vec<String>,
    root: &Path,
    fallback: &[retention::OutputStamp],
) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| {
            let path = Path::new(path);
            if !path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(is_video_extension)
            {
                return true;
            }
            let Ok(current) = retention::stamp(path) else {
                return false;
            };
            !retention::is_output_stamp(root, &current)
                && !fallback.iter().any(|saved| saved.matches(&current))
        })
        .collect()
}

const WATCH_INPUT_CHANGED: &str = "PICSHARP_WATCH_INPUT_CHANGED";
async fn check_watch_input_async(
    state: &Arc<VideoService>,
    path: &Path,
    version: Option<&str>,
) -> Result<(), String> {
    let Some(version) = version else {
        return Ok(());
    };
    let state = state.clone();
    let path = path.to_owned();
    let version = version.to_owned();
    tokio::task::spawn_blocking(move || check_watch_input(&state, &path, Some(&version)))
        .await
        .map_err(|error| error.to_string())?
}

fn check_watch_input(
    state: &VideoService,
    path: &Path,
    version: Option<&str>,
) -> Result<(), String> {
    let Some(version) = version else {
        return Ok(());
    };
    let current = retention::stamp(path).map_err(|_| WATCH_INPUT_CHANGED.to_string())?;
    if current.version.as_deref() != Some(version) {
        return Err(WATCH_INPUT_CHANGED.into());
    }
    if retention::is_output_stamp(&state.root, &current) {
        return Err(WATCH_INPUT_CHANGED.into());
    }
    // Clone the bounded fallback before any content verification; don't hold the
    // job lock while reading a potentially large video.
    let fallback: Vec<_> = state
        .data
        .lock()
        .unwrap()
        .jobs
        .iter()
        .filter_map(|job| job.output.as_ref().and_then(|output| output.stamp.clone()))
        .collect();
    if fallback.iter().any(|saved| saved.matches(&current)) || !current.unchanged(path) {
        return Err(WATCH_INPUT_CHANGED.into());
    }
    Ok(())
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
    state.save(&mut data)
}
