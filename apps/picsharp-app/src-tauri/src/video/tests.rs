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
    let first = publish(&temp, &root, "source", Preset::Compact).unwrap();
    let second = publish(&temp, &root, "source", Preset::Compact).unwrap();
    assert_ne!(first, second);
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
        .save(&Data {
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
