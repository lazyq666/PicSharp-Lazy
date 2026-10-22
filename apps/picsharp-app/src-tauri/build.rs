fn main() {
    println!("cargo:rerun-if-changed=resources/video/manifest.json");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let target = std::env::var("TARGET").unwrap();
        let suffix = if target.contains("windows") {
            ".exe"
        } else {
            ""
        };
        for name in ["ffmpeg", "ffprobe"] {
            let path = format!("resources/video/{name}{suffix}");
            assert!(std::path::Path::new(&path).is_file(), "Missing bundled {name}. Run scripts/prepare-video-engine.py with a portable FFmpeg build for {target} before packaging.");
        }
        let manifest = std::fs::read_to_string("resources/video/manifest.json")
            .expect("Missing video bundle manifest; run scripts/prepare-video-engine.py");
        assert!(
            manifest.contains(&format!("\"{target}\"")),
            "Video bundle architecture does not match {target}"
        );
    }
    tauri_build::build()
}
