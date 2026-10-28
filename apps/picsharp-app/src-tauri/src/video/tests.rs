use super::engine::*;
use super::*;
use serde_json::json;

fn info() -> MediaInfo {
    parse_info(&json!({"format":{"duration":"2"}, "streams":[{"codec_type":"video","index":2,"width":321,"height":241,"avg_frame_rate":"30000/1001"}, {"codec_type":"audio","codec_name":"aac"},{"codec_type":"audio","codec_name":"pcm_s16le"}]})).unwrap()
}

#[test]
fn presets_keep_audio_dimensions_and_frame_rate() {
    for preset in [Preset::Compact, Preset::Balanced, Preset::Compatible] {
        let args = encode_args(
            Path::new("/in/test.mov"),
            Path::new("/out/test.mp4"),
            &info(),
            preset,
        );
        let pairs: Vec<(&str, &str)> = args
            .windows(2)
            .map(|p| (p[0].as_str(), p[1].as_str()))
            .collect();
        assert!(pairs.contains(&("-map", "0:2")));
        assert!(pairs.contains(&("-map", "0:a?")));
        assert!(pairs.contains(&("-c:a:0", "copy")));
        assert!(pairs.contains(&("-c:a:1", "aac")));
        assert!(pairs.contains(&("-b:a:1", "192k")));
        assert!(pairs.contains(&("-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2")));
        assert!(pairs.contains(&("-fps_mode", "passthrough")));
        assert!(pairs.contains(&("-map_metadata", "-1")));
        assert!(pairs.contains(&("-map_chapters", "-1")));
        assert!(pairs.contains(&("-movflags", "+faststart")));
        assert!(!args.iter().any(|v| v == "-r" || v == "-s"));
        match preset {
            Preset::Compact => assert!(pairs.contains(&("-crf", "47"))),
            Preset::Balanced => assert!(pairs.contains(&("-crf", "35"))),
            Preset::Compatible => assert!(pairs.contains(&("-crf", "28"))),
        }
        assert!(pairs.contains(&(
            "-preset",
            if preset == Preset::Compatible {
                "slow"
            } else {
                "6"
            }
        )));
    }
}

#[test]
fn probe_handles_rotation_hdr_cover_art_and_bad_duration() {
    let mut data = json!({"format":{"duration":"4"}, "streams":[
        {"codec_type":"video","disposition":{"attached_pic":1},"width":20,"height":20},
        {"codec_type":"video","index":1,"width":1920,"height":1080,"duration":"N/A", "avg_frame_rate":"0/0", "side_data_list":[{"rotation":-90}]}]});
    let parsed = parse_info(&data).unwrap();
    assert_eq!(
        (parsed.width, parsed.height, parsed.video_index),
        (1080, 1920, 1)
    );
    assert_eq!(parsed.fps, 0.0);
    assert!(!parsed.hdr);
    for transfer in ["smpte2084", "arib-std-b67"] {
        data["streams"][1]["color_transfer"] = json!(transfer);
        assert!(parse_info(&data).unwrap().hdr);
    }
    data["streams"][1]["color_transfer"] = json!("bt709");
    data["streams"][1]["side_data_list"] = json!([{"side_data_type":"DOVI configuration record"}]);
    assert!(parse_info(&data).unwrap().hdr);
    data["format"]["duration"] = json!("NaN");
    assert!(parse_info(&data).is_err());
}

#[test]
fn progress_handles_unknown_speed_and_microseconds() {
    let mut p = Progress::default();
    p.parse("out_time_us=2500000", 10.0);
    p.parse("speed= 2.0x", 10.0);
    assert!(p.parse("progress=continue", 10.0));
    assert_eq!(p.fraction, 0.25);
    assert_eq!(p.remaining, Some(3.75));
    p.parse("speed=N/A", 10.0);
    p.parse("progress=end", 10.0);
    assert_eq!(p.remaining, None);
}

#[test]
fn publication_never_overwrites_and_history_recovers_interrupted_jobs() {
    let root = std::env::temp_dir().join(format!("picsharp-video-test-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    let temp = root.join("source.mp4");
    std::fs::write(&temp, b"original").unwrap();
    let output_dir = root.join("output");
    std::fs::create_dir_all(&output_dir).unwrap();
    let named = publish(&temp, &output_dir, "原片.name").unwrap();
    assert_eq!(named, output_dir.join("原片.name.mp4"));
    let first = publish(&temp, &root, "source").unwrap();
    let second = publish(&temp, &root, "source").unwrap();
    assert_eq!(first, root.join("source_2.mp4"));
    assert_eq!(second, root.join("source_3.mp4"));
    assert_eq!(std::fs::read(&temp).unwrap(), b"original");
    let service = VideoService::new(root.clone());
    let job = Job {
        id: "test".into(),
        path: temp.clone(),
        preset: Preset::Compact,
        directory: root.clone(),
        status: "processing".into(),
        input_bytes: 8,
        info: None,
        thumbnail: None,
        progress: Progress::default(),
        output: None,
        error: None,
    };
    std::fs::write(root.join(".picsharp-video-test.mp4"), b"partial").unwrap();
    service
        .save(&mut Data {
            jobs: vec![job],
            controls: HashMap::new(),
        })
        .unwrap();
    let restored = VideoService::new(root.clone());
    assert_eq!(restored.data.lock().unwrap().jobs[0].status, "cancelled");
    assert!(!root.join(".picsharp-video-test.mp4").exists());
    assert!(temp.exists() && first.exists() && second.exists());
    std::fs::remove_dir_all(root).unwrap();
}

// Run explicitly with a local FFmpeg containing both encoders. All files are synthetic.
#[tokio::test]
#[ignore]
async fn real_ffmpeg_presets_audio_padding_cancellation_and_hdr() {
    let root =
        std::env::temp_dir().join(format!("picsharp-video-integration-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    let engine = Engine {
        ffmpeg: "ffmpeg".into(),
        ffprobe: "ffprobe".into(),
    };
    engine.check().await.unwrap();
    let source = root.join("odd input 中文.mkv");
    let status = tokio::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=321x241:rate=12",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-t",
            "1",
            "-c:v",
            "ffv1",
            "-c:a:0",
            "aac",
            "-c:a:1",
            "pcm_s16le",
        ])
        .arg(&source)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let original = std::fs::read(&source).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    for preset in [Preset::Compact, Preset::Balanced, Preset::Compatible] {
        let output = engine
            .compress(
                &source,
                &root,
                &root.join("logs"),
                &nanoid::nanoid!(),
                preset,
                &cancel,
                |_| {},
            )
            .await
            .unwrap();
        let result = engine.inspect(&output.path, &cancel).await.unwrap();
        assert_eq!((result.width, result.height), (322, 242));
        assert_eq!(result.audio, vec!["aac", "aac"]);
        assert_eq!(result.fps, 12.0);
        assert!((result.duration - 1.0).abs() < 0.2);
        assert!(output.bytes > 0);
        assert!(output.stamp.as_ref().unwrap().unchanged(&output.path));
        retention::save_stamp(&root, output.stamp.as_ref().unwrap()).unwrap();
        assert!(
            filter_video_inputs(vec![output.path.to_string_lossy().into_owned()], &root, &[])
                .is_empty()
        );
        let renamed = root.join(format!("renamed-{}.mp4", nanoid::nanoid!()));
        std::fs::rename(&output.path, &renamed).unwrap();
        assert!(
            filter_video_inputs(vec![renamed.to_string_lossy().into_owned()], &root, &[])
                .is_empty(),
            "a real encoded output remains protected after renaming"
        );
    }
    assert_eq!(std::fs::read(&source).unwrap(), original);
    let thumb = root.join("preview.jpg");
    engine
        .thumbnail(
            &source,
            &engine.inspect(&source, &cancel).await.unwrap(),
            &thumb,
            &cancel,
        )
        .await
        .unwrap();
    assert!(thumb.metadata().unwrap().len() > 0);
    let stop = cancel.clone();
    // Cancellation during encoding is triggered by the first real progress event.
    let result = engine
        .compress(
            &source,
            &root,
            &root.join("logs"),
            "cancel-test",
            Preset::Balanced,
            &cancel,
            |_| {
                stop.store(true, Ordering::SeqCst);
            },
        )
        .await;
    assert!(result.is_err());
    assert!(!root.join(".picsharp-video-cancel-test.mp4").exists());
    cancel.store(false, Ordering::SeqCst);
    let hdr = root.join("hdr.mkv");
    assert!(tokio::process::Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&source).args(["-map", "0:v", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-color_trc", "smpte2084", "-color_primaries", "bt2020", "-colorspace", "bt2020nc"]).arg(&hdr).status().await.unwrap().success());
    assert!(engine.inspect(&hdr, &cancel).await.unwrap().hdr);
    assert!(engine
        .compress(
            &hdr,
            &root,
            &root.join("logs"),
            "hdr-test",
            Preset::Compact,
            &cancel,
            |_| {}
        )
        .await
        .unwrap_err()
        .contains("HDR"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_bounds_history_and_removes_expired_cache_without_touching_outputs() {
    let root = std::env::temp_dir().join(format!("picsharp-retention-test-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(root.join("thumbnails")).unwrap();
    std::fs::create_dir_all(root.join("logs")).unwrap();
    let output = root.join("keep.mp4");
    std::fs::write(&output, b"finished video").unwrap();
    let jobs: Vec<_> = (0..600).map(|n| serde_json::json!({
        "id": format!("job-{n}"), "path": root.join(format!("source-{n}.mov")),
        "preset": "compact", "directory": root, "status": "completed",
        "output": {"path": output, "bytes": 14, "elapsed": 1.0, "log": root.join("logs/old.log")}
    })).collect();
    std::fs::write(root.join("jobs.json"), serde_json::to_vec(&jobs).unwrap()).unwrap();
    for file in [root.join("thumbnails/old.jpg"), root.join("logs/old.log")] {
        std::fs::write(&file, b"old cache").unwrap();
        std::fs::File::options()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 86400))
            .unwrap();
    }
    let service = VideoService::new(root.clone());
    assert!(
        service.data.lock().unwrap().jobs.len() <= 500,
        "history grows without a bound"
    );
    assert!(
        !root.join("thumbnails/old.jpg").exists(),
        "expired thumbnails remain"
    );
    assert!(!root.join("logs/old.log").exists(), "expired logs remain");
    assert_eq!(std::fs::read(&output).unwrap(), b"finished video");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn preview_registration_cancellation_and_drop_release_controls() {
    let previews = previews::Previews::default();
    let early = previews.prepare();
    previews.cancel(&early);
    assert!(previews.start(&early).is_err());
    let id = previews.prepare();
    let request = previews.start(&id).unwrap();
    assert!(!previews.idle());
    previews.cancel(&id);
    assert!(request.cancel.load(Ordering::SeqCst));
    assert!(
        !previews.idle(),
        "shutdown must wait for the running process to finish"
    );
    drop(request);
    assert!(previews.idle());
    assert!(previews.start(&id).is_err());
    let prepared = previews.prepare();
    previews.cancel_all();
    assert!(previews.start(&prepared).is_err());
}

#[tokio::test]
async fn cancelled_preview_leaves_the_queue_before_a_slot_is_available() {
    let root = std::env::temp_dir().join(format!("picsharp-preview-test-{}", nanoid::nanoid!()));
    let service = VideoService::new(root.clone());
    let encoding_cancel = Arc::new(AtomicBool::new(false));
    let _encoding = service.media_permit(2, &encoding_cancel).await.unwrap();
    let id = service.previews.prepare();
    let request = service.previews.start(&id).unwrap();
    let queued = service.media_permit(1, &request.cancel);
    service.previews.cancel(&id);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), queued)
            .await
            .unwrap()
            .unwrap_err(),
        CANCELLED
    );
    drop(request);
    assert!(service.previews.idle());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn history_eviction_keeps_active_jobs_and_durable_output_protection() {
    let root = std::env::temp_dir().join(format!("picsharp-history-test-{}", nanoid::nanoid!()));
    let service = VideoService::new(root.clone());
    let output = root.join("old-output.mp4");
    std::fs::write(&output, b"output").unwrap();
    let mut data = service.data.lock().unwrap();
    for n in 0..520 {
        data.jobs.push(Job {
            id: n.to_string(),
            path: root.join(format!("source-{n}.mp4")),
            preset: Preset::Compact,
            directory: root.clone(),
            status: "completed".into(),
            input_bytes: 100,
            info: None,
            thumbnail: None,
            progress: Progress::default(),
            error: None,
            output: (n == 1).then(|| Output {
                path: output.clone(),
                bytes: 6,
                elapsed: 1.0,
                log: root.join("logs/1.log"),
                stamp: Some(retention::stamp(&output).unwrap()),
                protection_checked: true,
            }),
        });
    }
    data.jobs[0].status = "pending".into();
    data.controls
        .insert("0".into(), Arc::new(AtomicBool::new(false)));
    service.save(&mut data).unwrap();
    assert_eq!(data.jobs.len(), retention::HISTORY_LIMIT + 1);
    assert_eq!(data.jobs[0].id, "0");
    assert!(retention::is_output(&root, &output));
    data.controls.remove("0");
    service.save(&mut data).unwrap();
    assert_eq!(data.jobs.len(), retention::HISTORY_LIMIT);
    drop(data);
    drop(service);
    let _restored = VideoService::new(root.clone());
    assert!(retention::is_output(&root, &output));
    std::fs::write(&output, b"a replacement source").unwrap();
    assert!(!retention::is_output(&root, &output));
    std::fs::remove_dir_all(root).unwrap();
}

fn completed_watch_job(source: PathBuf, output: PathBuf) -> Job {
    Job {
        id: "watch-output".into(),
        path: source,
        preset: Preset::Compact,
        directory: output.parent().unwrap().to_owned(),
        status: "completed".into(),
        input_bytes: 100,
        info: None,
        thumbnail: None,
        progress: Progress::default(),
        error: None,
        output: Some(Output {
            bytes: std::fs::metadata(&output).unwrap().len(),
            stamp: Some(retention::stamp(&output).unwrap()),
            protection_checked: true,
            path: output,
            elapsed: 1.0,
            log: PathBuf::new(),
        }),
    }
}

#[test]
fn renamed_video_output_stays_excluded_from_watch_after_restart() {
    let root = std::env::temp_dir().join(format!("picsharp-output-rename-{}", nanoid::nanoid!()));
    let service = VideoService::new(root.clone());
    let output = root.join("A.mp4");
    let renamed = root.join("B.mp4");
    std::fs::write(&output, b"compressed video").unwrap();
    let saved = retention::remember_output(&root, &output).unwrap();
    let modified = std::fs::metadata(&output).unwrap().modified().unwrap();
    {
        let mut data = service.data.lock().unwrap();
        data.jobs
            .push(completed_watch_job(root.join("source.mov"), output.clone()));
        service.save(&mut data).unwrap();
    }
    std::fs::rename(&output, &renamed).unwrap();
    let current = retention::stamp(&renamed).unwrap();
    assert!(
        filter_video_inputs(
            vec![renamed.to_string_lossy().into_owned()],
            &root,
            &[saved.clone()],
        )
        .is_empty(),
        "renaming a compressed video must not enqueue it for compression again"
    );
    assert_eq!(
        check_watch_input(&service, &renamed, current.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    drop(service);
    let restored = VideoService::new(root.clone());
    assert_eq!(
        check_watch_input(&restored, &renamed, current.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    // The disk identity record, not the bounded job history, survives another move.
    restored.data.lock().unwrap().jobs.clear();
    let moved_folder = root.join("renamed-folder");
    std::fs::create_dir(&moved_folder).unwrap();
    let moved = moved_folder.join("C.MOV");
    std::fs::rename(&renamed, &moved).unwrap();
    assert!(filter_video_inputs(vec![moved.to_string_lossy().into_owned()], &root, &[]).is_empty());
    let current = retention::stamp(&moved).unwrap();
    assert_eq!(
        check_watch_input(&restored, &moved, current.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    // A different file at the original name is still a new input, even with the
    // same length and restored mtime. Neither path nor identity is a blanket ban.
    std::fs::write(&output, b"replacement file").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&output)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let paths = vec![output.to_string_lossy().into_owned()];
    assert_eq!(filter_video_inputs(paths.clone(), &root, &[]), paths);
    // An in-place edit of the renamed output must also remain eligible.
    std::fs::write(&moved, b"replacement file").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&moved)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let changed = retention::stamp(&moved).unwrap();
    assert!(check_watch_input(&restored, &moved, changed.version.as_deref()).is_ok());
    let paths = vec![moved.to_string_lossy().into_owned()];
    assert_eq!(filter_video_inputs(paths.clone(), &root, &[saved]), paths);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn video_output_identity_handles_restart_before_lookup_and_history_fallback() {
    let root = std::env::temp_dir().join(format!("picsharp-rename-restart-{}", nanoid::nanoid!()));
    let service = VideoService::new(root.clone());
    let output = root.join("A.mp4");
    let renamed = root.join("B.mp4");
    std::fs::write(&output, b"compressed video").unwrap();
    let saved = retention::remember_output(&root, &output).unwrap();
    drop(service);
    std::fs::rename(&output, &renamed).unwrap();
    let restored = VideoService::new(root.clone());
    let current = retention::stamp(&renamed).unwrap();
    assert_eq!(
        check_watch_input(&restored, &renamed, current.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    // A failed disk record still has the same rename-aware history fallback.
    let empty_records = root.join("unavailable-records");
    assert!(filter_video_inputs(
        vec![renamed.to_string_lossy().into_owned()],
        &empty_records,
        &[saved.clone()]
    )
    .is_empty());
    let fallback_service = VideoService::new(empty_records);
    let mut job = completed_watch_job(root.join("source.mov"), renamed.clone());
    job.output.as_mut().unwrap().stamp = Some(saved);
    fallback_service.data.lock().unwrap().jobs.push(job);
    assert_eq!(
        check_watch_input(&fallback_service, &renamed, current.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn video_output_metadata_changes_are_verified_and_legacy_outputs_upgrade_before_rename() {
    let root = std::env::temp_dir().join(format!("picsharp-rename-legacy-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    let output = root.join("A.mp4");
    std::fs::write(&output, b"AAAA").unwrap();
    let legacy = retention::stamp(&output).unwrap();
    retention::save_stamp(&root, &legacy).unwrap();
    // Startup migration may add fingerprints only to an unchanged legacy file.
    let upgraded = retention::restore_output(&root, &output, 4, Some(&legacy), false).unwrap();
    assert!(serde_json::to_value(&upgraded).unwrap()["fingerprint"].is_string());
    let changed_time = std::time::SystemTime::now() + Duration::from_secs(2);
    std::fs::File::options()
        .write(true)
        .open(&output)
        .unwrap()
        .set_modified(changed_time)
        .unwrap();
    assert!(
        retention::is_output(&root, &output),
        "timestamp-only changes preserve content"
    );
    let renamed = root.join("B.mp4");
    std::fs::rename(&output, &renamed).unwrap();
    assert!(retention::is_output(&root, &renamed));
    // An atomic replacement has a different identity even if its content is equal.
    std::fs::write(&output, b"AAAA").unwrap();
    std::fs::rename(&output, &renamed).unwrap();
    assert!(!retention::is_output(&root, &renamed));
    // Unverifiable old records cannot bless new bytes after a metadata change.
    let legacy = retention::stamp(&renamed).unwrap();
    retention::save_stamp(&root, &legacy).unwrap();
    std::fs::rename(&renamed, &output).unwrap();
    assert!(!retention::is_output(&root, &output));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn video_fingerprinting_rejects_cancellation_and_files_changed_during_read() {
    let root =
        std::env::temp_dir().join(format!("picsharp-fingerprint-race-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    let output = root.join("output.mp4");
    std::fs::write(&output, vec![b'A'; 128 * 1024]).unwrap();
    assert_eq!(
        retention::fingerprinted_stamp_cancellable(&output, || true),
        Err(engine::CANCELLED.into())
    );
    let changed = std::cell::Cell::new(false);
    assert_eq!(
        retention::fingerprinted_stamp_cancellable(&output, || {
            if !changed.replace(true) {
                std::fs::write(&output, b"replacement").unwrap();
            }
            false
        }),
        Err(WATCH_INPUT_CHANGED.into())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_recent_output_bypasses_both_disk_and_history_filters_after_restart() {
    let root = std::env::temp_dir().join(format!("picsharp-output-replace-{}", nanoid::nanoid!()));
    let service = VideoService::new(root.clone());
    let output = root.join("output.mp4");
    std::fs::write(&output, b"AAAA").unwrap();
    let saved = retention::remember_output(&root, &output).unwrap();
    let modified = std::fs::metadata(&output).unwrap().modified().unwrap();
    let paths = vec![output.to_string_lossy().into_owned()];
    let fallback = vec![saved.clone()];
    {
        let mut data = service.data.lock().unwrap();
        data.jobs
            .push(completed_watch_job(root.join("source.mov"), output.clone()));
        service.save(&mut data).unwrap();
    }
    assert!(filter_video_inputs(paths.clone(), &root, &fallback).is_empty());
    assert_eq!(
        check_watch_input(&service, &output, saved.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    std::thread::sleep(Duration::from_millis(10));
    // Same length and original mtime, but a different ctime/content.
    std::fs::write(&output, b"BBBB").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&output)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert!(!retention::is_output(&root, &output));
    assert_eq!(filter_video_inputs(paths.clone(), &root, &fallback), paths);
    let replacement = retention::stamp(&output).unwrap();
    assert!(check_watch_input(&service, &output, replacement.version.as_deref()).is_ok());
    drop(service);
    let restored = VideoService::new(root.clone());
    assert!(
        !retention::is_output(&root, &output),
        "startup must not register the replacement as an old output"
    );
    assert!(restored.data.lock().unwrap().jobs[0]
        .output
        .as_ref()
        .unwrap()
        .stamp
        .is_none());
    assert!(check_watch_input(&restored, &output, replacement.version.as_deref()).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn watched_video_versions_match_node_and_reject_replacements_while_queued() {
    let root = std::env::temp_dir().join(format!("picsharp-watch-version-{}", nanoid::nanoid!()));
    let service = VideoService::new(root.clone());
    let source = root.join("source.mp4");
    std::fs::write(&source, b"AAAA").unwrap();
    let original = retention::stamp(&source).unwrap();
    let node = std::process::Command::new("node")
        .arg("-e")
        .arg("const s=require('node:fs').statSync(process.argv[1],{bigint:true});process.stdout.write([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'))")
        .arg(&source).output().unwrap();
    assert!(node.status.success());
    assert_eq!(
        original.version.as_deref(),
        Some(String::from_utf8(node.stdout).unwrap().as_str())
    );
    assert!(check_watch_input(&service, &source, original.version.as_deref()).is_ok());
    let modified = std::fs::metadata(&source).unwrap().modified().unwrap();
    let incoming = root.join("incoming.mp4");
    std::fs::write(&incoming, b"BBBB").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&incoming)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    std::fs::rename(incoming, &source).unwrap();
    assert_eq!(
        check_watch_input(&service, &source, original.version.as_deref()),
        Err(WATCH_INPUT_CHANGED.into())
    );
    let replacement = retention::stamp(&source).unwrap();
    assert!(check_watch_input(&service, &source, replacement.version.as_deref()).is_ok());
    // Manual compression remains an explicit user action, outside watch filtering.
    retention::remember_output(&root, &source).unwrap();
    assert!(check_watch_input(&service, &source, None).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_history_migration_does_not_turn_a_replacement_into_an_output() {
    let root = std::env::temp_dir().join(format!("picsharp-legacy-output-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    let output = root.join("output.mp4");
    std::fs::write(&output, b"AAAA").unwrap();
    let modified = std::fs::metadata(&output).unwrap().modified().unwrap();
    let mut job = completed_watch_job(root.join("source.mov"), output.clone());
    job.output.as_mut().unwrap().stamp = None;
    job.output.as_mut().unwrap().protection_checked = false;
    std::fs::write(
        root.join("jobs.json"),
        serde_json::to_vec(&vec![job]).unwrap(),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(10));
    std::fs::write(&output, b"BBBB").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&output)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let _restored = VideoService::new(root.clone());
    assert!(!retention::is_output(&root, &output));
    drop(_restored);
    let _restored_again = VideoService::new(root.clone());
    assert!(
        !retention::is_output(&root, &output),
        "migration must stay invalid after jobs.json is saved again"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cache_cleanup_enforces_count_and_bytes_but_protects_active_logs() {
    let root = std::env::temp_dir().join(format!("picsharp-cache-test-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    for n in 0..5 {
        let path = root.join(format!("{n}.log"));
        std::fs::write(&path, b"four").unwrap();
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(10 - n))
            .unwrap();
    }
    let foreign = root.join("source.mp4");
    std::fs::write(&foreign, b"must not delete").unwrap();
    let policy = retention::CachePolicy {
        extension: "log",
        count: 3,
        bytes: 8,
        age: std::time::Duration::from_secs(3600),
    };
    retention::clean_cache(&root, &policy, &HashSet::from([root.join("0.log")]));
    assert!(root.join("0.log").exists());
    assert!(root.join("3.log").exists() && root.join("4.log").exists());
    assert!(!root.join("1.log").exists() && !root.join("2.log").exists());
    retention::clean_cache(&root, &policy, &HashSet::new());
    assert!(!root.join("0.log").exists());
    assert_eq!(std::fs::read(foreign).unwrap(), b"must not delete");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_a_probe_waits_for_the_process_to_exit() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("picsharp-probe-cancel-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&root).unwrap();
    let probe = root.join("probe");
    let pid_file = root.join("pid");
    // exec keeps the recorded PID and simulates a probe blocked on input.
    std::fs::write(
        &probe,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nexec /bin/sleep 30\n",
            pid_file.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let input = root.join("input.mp4");
    std::fs::write(&input, b"test").unwrap();
    let engine = Engine {
        ffmpeg: probe.clone(),
        ffprobe: probe,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let stopping = async {
        while !pid_file.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        cancel.store(true, Ordering::SeqCst);
    };
    let (result, _) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(engine.inspect(&input, &cancel), stopping)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), CANCELLED);
    let pid = std::fs::read_to_string(pid_file).unwrap();
    let alive = std::process::Command::new("/bin/kill")
        .args(["-0", pid.trim()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(
        !alive,
        "the cancellation returned while the child was still alive"
    );
    std::fs::remove_dir_all(root).unwrap();
}
