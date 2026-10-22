use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

pub type Cancel = Arc<AtomicBool>;
pub const CANCELLED: &str = "已取消，未完成的文件已清理。";
pub const EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "mpg", "mpeg", "mts", "m2ts", "ts", "wmv", "flv",
    "3gp", "ogv",
];

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    #[default]
    Compact,
    Balanced,
    Compatible,
}
impl Preset {
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Compact => "av1_47",
            Self::Balanced => "av1_35",
            Self::Compatible => "h264_28",
        }
    }
    fn args(self) -> Vec<String> {
        let args = match self {
            Self::Compatible => vec![
                "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p",
                "-threads", "8",
            ],
            _ => vec![
                "-c:v",
                "libsvtav1",
                "-preset",
                "6",
                "-crf",
                if self == Self::Compact { "47" } else { "35" },
                "-pix_fmt",
                "yuv420p10le",
                "-svtav1-params",
                "lp=6",
            ],
        };
        args.into_iter().map(str::to_owned).collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaInfo {
    pub duration: f64,
    pub width: u64,
    pub height: u64,
    pub fps: f64,
    pub video_index: u64,
    pub audio: Vec<String>,
    pub hdr: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Progress {
    pub fraction: f64,
    pub seconds: f64,
    pub speed: f64,
    pub remaining: Option<f64>,
}
impl Progress {
    pub fn parse(&mut self, line: &str, duration: f64) -> bool {
        if let Some((key, value)) = line.trim().split_once('=') {
            let number = value
                .trim()
                .trim_end_matches('x')
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .unwrap_or(0.0);
            match key {
                "out_time_us" => self.seconds = number / 1_000_000.0,
                "speed" => self.speed = number,
                "progress" => {
                    self.fraction = (self.seconds / duration).clamp(0.0, 0.99);
                    self.remaining =
                        (self.speed > 0.0).then(|| (duration - self.seconds).max(0.0) / self.speed);
                    return true;
                }
                _ => {}
            }
        }
        false
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Output {
    pub path: PathBuf,
    pub bytes: u64,
    pub elapsed: f64,
    pub log: PathBuf,
}
#[derive(Clone)]
pub struct Engine {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

pub async fn cancelled(cancel: &Cancel) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}
fn check_cancel(cancel: &Cancel) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}
fn command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}
async fn capture(path: &Path, args: &[String], cancel: &Cancel) -> Result<Vec<u8>, String> {
    check_cancel(cancel)?;
    let mut cmd = command(path);
    cmd.args(args).stderr(Stdio::null());
    tokio::select! {
        _ = cancelled(cancel) => Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(30), cmd.output()) => {
            let output = result.map_err(|_| "读取视频超时，请检查文件是否完整或磁盘是否可访问。")?
                .map_err(|e| format!("无法启动视频引擎：{e}"))?;
            if !output.status.success() { return Err("无法读取视频，请检查文件是否完整、格式是否受支持。".into()); }
            Ok(output.stdout)
        }
    }
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}

pub fn parse_info(root: &Value) -> Result<MediaInfo, String> {
    let streams = root["streams"].as_array().ok_or("无法读取视频流。")?;
    let v = streams
        .iter()
        .find(|s| {
            s["codec_type"] == "video"
                && s["disposition"]["attached_pic"].as_u64().unwrap_or(0) == 0
        })
        .ok_or("文件中没有可压缩的视频画面。")?;
    let duration = number(&v["duration"])
        .filter(|d| *d > 0.0)
        .or_else(|| number(&root["format"]["duration"]))
        .unwrap_or(0.0);
    let mut width = v["width"].as_u64().unwrap_or(0);
    let mut height = v["height"].as_u64().unwrap_or(0);
    if duration <= 0.0 || width == 0 || height == 0 {
        return Err("无法确定视频时长或尺寸。".into());
    }
    let side = v["side_data_list"].as_array().cloned().unwrap_or_default();
    let rotation = side
        .iter()
        .find_map(|s| number(&s["rotation"]))
        .or_else(|| number(&v["tags"]["rotate"]))
        .unwrap_or(0.0);
    if (rotation.round() as i64).abs() % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let rate = v["avg_frame_rate"].as_str().unwrap_or("0/1");
    let fps = rate
        .split_once('/')
        .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(0.0);
    let transfer = v["color_transfer"].as_str().unwrap_or("");
    let hdr = ["smpte2084", "arib-std-b67"].contains(&transfer)
        || side.iter().any(|s| {
            let kind = s["side_data_type"].as_str().unwrap_or("").to_lowercase();
            kind.contains("dovi")
                || kind.contains("dolby vision")
                || kind.contains("mastering display")
                || kind.contains("content light")
                || kind.contains("hdr")
        });
    Ok(MediaInfo {
        duration,
        width,
        height,
        fps,
        video_index: v["index"].as_u64().unwrap_or(0),
        hdr,
        audio: streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .map(|s| s["codec_name"].as_str().unwrap_or("unknown").to_owned())
            .collect(),
    })
}

pub fn encode_args(input: &Path, temp: &Path, info: &MediaInfo, preset: Preset) -> Vec<String> {
    let mut args = strings(&[
        "-hide_banner",
        "-nostdin",
        "-n",
        "-threads",
        "4",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
    ]);
    args.push(input.to_string_lossy().into_owned());
    args.extend(strings(&[
        "-map",
        &format!("0:{}", info.video_index),
        "-map",
        "0:a?",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-sn",
        "-dn",
    ]));
    args.extend(preset.args());
    if info.width % 2 != 0 || info.height % 2 != 0 {
        args.extend(strings(&["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"]));
    }
    for (index, codec) in info.audio.iter().enumerate() {
        args.extend(strings(&[
            &format!("-c:a:{index}"),
            if codec == "aac" { "copy" } else { "aac" },
        ]));
        if codec != "aac" {
            args.extend(strings(&[&format!("-b:a:{index}"), "192k"]));
        }
    }
    args.extend(strings(&[
        "-fps_mode",
        "passthrough",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
    ]));
    args.push(temp.to_string_lossy().into_owned());
    args
}

pub struct TempFile(pub PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Engine {
    pub async fn check(&self) -> Result<(), String> {
        let cancel = Arc::new(AtomicBool::new(false));
        let bytes = capture(
            &self.ffmpeg,
            &strings(&["-hide_banner", "-encoders"]),
            &cancel,
        )
        .await?;
        let encoders = String::from_utf8_lossy(&bytes);
        if !encoders.contains("libsvtav1") || !encoders.contains("libx264") {
            return Err("FFmpeg 缺少 libsvtav1 或 libx264 编码器，请使用完整的视频引擎。".into());
        }
        capture(&self.ffprobe, &strings(&["-version"]), &cancel).await?;
        Ok(())
    }
    pub async fn inspect(&self, path: &Path, cancel: &Cancel) -> Result<MediaInfo, String> {
        if !path.is_file() {
            return Err("视频不存在或不是本机文件。".into());
        }
        let mut args = strings(&[
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ]);
        args.push(path.to_string_lossy().into_owned());
        let data = capture(&self.ffprobe, &args, cancel).await?;
        parse_info(&serde_json::from_slice(&data).map_err(|e| e.to_string())?)
    }
    pub async fn thumbnail(
        &self,
        path: &Path,
        info: &MediaInfo,
        output: &Path,
        cancel: &Cancel,
    ) -> Result<(), String> {
        let mut args = strings(&[
            "-hide_banner",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ]);
        args.push(path.to_string_lossy().into_owned());
        args.extend(strings(&[
            "-map",
            &format!("0:{}", info.video_index),
            "-frames:v",
            "1",
            "-vf",
            "scale=320:240:force_original_aspect_ratio=decrease",
            "-update",
            "1",
        ]));
        args.push(output.to_string_lossy().into_owned());
        capture(&self.ffmpeg, &args, cancel).await.map(|_| ())
    }
    pub async fn compress(
        &self,
        input: &Path,
        directory: &Path,
        logs: &Path,
        id: &str,
        preset: Preset,
        cancel: &Cancel,
        progress: impl Fn(Progress),
    ) -> Result<Output, String> {
        let info = self.inspect(input, cancel).await?;
        if info.hdr {
            return Err(
                "此视频是 HDR。当前仅处理 SDR，请先导出 SDR 版本，以避免亮度或颜色失真。".into(),
            );
        }
        if preset != Preset::Compatible && info.width.min(info.height) < 64 {
            return Err("AV1 不支持此视频的小尺寸，请选择「广泛兼容」后重试。".into());
        }
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(logs).map_err(|e| e.to_string())?;
        let temp = TempFile(directory.join(format!(".picsharp-video-{id}.mp4")));
        let log = logs.join(format!("{id}.log"));
        let args = encode_args(input, &temp.0, &info, preset);
        let mut err = std::fs::File::create(&log).map_err(|e| e.to_string())?;
        use std::io::Write;
        writeln!(
            err,
            "{}",
            serde_json::json!({"executable": self.ffmpeg, "arguments": args})
        )
        .map_err(|e| e.to_string())?;
        check_cancel(cancel)?;
        let start = std::time::Instant::now();
        let mut child = command(&self.ffmpeg)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::from(err))
            .spawn()
            .map_err(|e| format!("无法启动 FFmpeg：{e}"))?;
        let stdout = child.stdout.take().ok_or("无法读取编码进度。")?;
        let mut lines = BufReader::new(stdout).lines();
        let mut state = Progress::default();
        loop {
            tokio::select! {
                _ = cancelled(cancel) => { let _ = child.kill().await; return Err(CANCELLED.into()); }
                line = lines.next_line() => match line {
                    Ok(Some(line)) => if state.parse(&line, info.duration) { progress(state.clone()); },
                    Ok(None) => break,
                    Err(e) => { let _ = child.kill().await; return Err(e.to_string()); }
                }
            }
        }
        let status = tokio::select! {
            _ = cancelled(cancel) => { let _ = child.kill().await; return Err(CANCELLED.into()); }
            status = child.wait() => status.map_err(|e| e.to_string())?
        };
        check_cancel(cancel)?;
        if !status.success() {
            return Err(format!(
                "压缩失败（{status}），请检查磁盘空间、权限或更换预设。日志：{}",
                log.display()
            ));
        }
        let output_info = self.inspect(&temp.0, cancel).await?;
        let bytes = std::fs::metadata(&temp.0).map_err(|e| e.to_string())?.len();
        if bytes == 0
            || (output_info.duration - info.duration).abs() >= 1.0_f64.max(info.duration * 0.01)
            || output_info.audio.len() != info.audio.len()
        {
            return Err("输出完整性检查未通过，未保存成品；原视频未改动。".into());
        }
        check_cancel(cancel)?;
        let path = publish(
            &temp.0,
            directory,
            input
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("video"),
            preset,
        )?;
        Ok(Output {
            path,
            bytes,
            elapsed: start.elapsed().as_secs_f64(),
            log,
        })
    }
}

pub fn publish(
    temp: &Path,
    directory: &Path,
    stem: &str,
    preset: Preset,
) -> Result<PathBuf, String> {
    for index in 0..10000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("_{}", index + 1)
        };
        let path = directory.join(format!("{stem}_picsharp_{}{suffix}.mp4", preset.suffix()));
        match std::fs::hard_link(temp, &path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(format!(
                    "无法安全保存成品：{e}。请选择支持硬链接的本机输出文件夹。"
                ))
            }
        }
    }
    Err("同名输出过多，请更换输出文件夹。".into())
}
