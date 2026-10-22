# 视频压缩

批量压缩和文件监听都可以混合导入图片、视频，继续使用原有文件卡片和工具栏。

- 设置 → **图片压缩设置**：原有图片选项，行为不变。
- 设置 → **视频压缩设置**：三档预设、保存文件夹、引擎状态。
- 视频卡片：缩略图、尺寸、帧率、时长；编码时显示百分比、速度、预计剩余时间。支持单项取消、整批取消视频和重试。
- 默认另存到原片旁的 `PicSharp Videos` 文件夹。指定其他文件夹后同样保留原片。
- 批量导入页的“视频记录”恢复上次导入的任务和结果。异常退出时，未完成任务显示为已取消，允许重试。

## 编码规则

| 预设 | 编码 | 参数 |
| --- | --- | --- |
| 更小体积（默认） | AV1 | libsvtav1 / preset 6 / CRF 47 / yuv420p10le / lp=6 |
| 画质均衡 | AV1 | libsvtav1 / preset 6 / CRF 35 / yuv420p10le / lp=6 |
| 广泛兼容 | H.264 | libx264 / preset slow / CRF 28 / yuv420p / threads=8 |

CRF 是同一编码器内的画质与大小取舍，数值越高压缩越强；不同编码器的数值不能直接对比。全部在本机使用 CPU，视频不会送往 TinyPNG。

支持导入 MP4、MOV、M4V、MKV、WebM、AVI、MPG、MPEG、MTS、M2TS、TS、WMV、FLV、3GP、OGV。后缀只是初筛，实际文件必须包含当前 FFmpeg 能解码的视频流；损坏文件或不支持的编码会显示错误。

不主动缩放或降帧。奇数宽高通过补边最多增加一行、一列。保留全部音轨：AAC 复制，其他音轨转 AAC 192 kbps。输出统一 MP4 + faststart，移除原元数据和章节，丢弃字幕和数据流。PQ、HLG、Dolby Vision 或 HDR 附加信息会拒绝处理。AV1 的短边小于 64 像素时提示改用 H.264。

先写同一目标文件夹内的 `.picsharp-video-<id>.mp4`，再验证文件非空、时长误差小于 max(1 秒, 1%)、音轨数量一致。校验成功后使用硬链接原子发布，避免覆盖已有文件；不支持硬链接的文件系统会明确报错，建议选择本机 APFS、NTFS、ext4 等目录。成品名为 `<原名>_picsharp_av1_47.mp4` 等，同名追加 `_2`、`_3`。取消会结束 FFmpeg 并清理临时文件。

## 模块

- `src-tauri/src/video/engine.rs`：探测、缩略图、编码参数、进度和安全保存。
- `src-tauri/src/video/mod.rs`：应用级串行队列、取消、任务事件和 JSON 记录。多个窗口也共用同一个编码队列。
- `src/utils/video.ts`：连接后台任务与现有卡片。图片仍走原有图片处理服务。
- `packages/picsharp-sidecar/src/controllers/watch/media.ts`：视频文件大小和修改时间连续稳定 3 秒后导入；同一版本去重；跳过临时文件、自动生成的视频。

任务和日志保存在应用数据目录的 `video/jobs.json`、`video/logs`；缩略图在 `video/thumbnails`。视频输出设置独立于图片的覆盖、格式转换、缩放、水印设置。监听启动不再被图片专用设置阻止；图片配置错误由对应文件任务报告。

本机服务固定使用 **43127**，开发界面仍使用 **1420**。不使用 3000。若 43127 被占用，先停止占用它的服务，不自动切换端口。

## 引擎打包

正式版本只从应用资源 `resources/video` 读取 FFmpeg 和 ffprobe，不依赖 Homebrew 或用户 PATH。开发版可使用该资源、`PICSHARP_VIDEO_BIN_DIR` 或 PATH。

针对每个目标系统和架构准备同时包含 `libsvtav1`、`libx264` 的可移植 FFmpeg 分发包，在本机或对应 CI 构建机执行：

```sh
python3 scripts/prepare-video-engine.py --source /path/to/ffmpeg-bin --target aarch64-apple-darwin
```

脚本验证两个编码器和 ffprobe，生成目标架构清单，再放入 Tauri 已配置的资源目录。macOS 会递归复制动态库、重写成相对路径并签名；`--sign 'Developer ID Application: …'` 可指定发布签名，默认临时签名只用于本机测试。Windows 复制分发包同目录的 DLL；Linux 请提供静态构建或已经使用 `$ORIGIN` 的自包含分发包。保留所用 FFmpeg、x264、SVT-AV1 和其他依赖的许可证、对应源码及分发要求；源目录中的 LICENSE / COPYING / NOTICE 文件会复制进包。

本地发行打包前，还需按项目原有流程重新构建图片 / 监听服务，不能继续使用旧的 sidecar 二进制。例如当前 Apple Silicon Mac：

```sh
pnpm --filter @picsharp/picsharp-sidecar build-sea:macos-arm64
cp packages/picsharp-sidecar/bin/picsharp-sidecar-aarch64-apple-darwin apps/picsharp-app/src-tauri/binaries/
```

生成的二进制目录已加入 gitignore。发布构建缺少引擎或架构清单不匹配时会明确失败；现有发布流水线需在 Tauri 打包前执行同一准备步骤。当前已在这台 Apple Silicon Mac 生成并运行该资源包；Windows/Linux 仍需对应架构的引擎包与实机验收。

## 验证

在仓库根目录：

```sh
pnpm --filter @picsharp/picsharp-app build
pnpm --filter @picsharp/picsharp-sidecar build
cargo test -p PicSharp --lib video:: -- --include-ignored
```

真实 FFmpeg 测试使用自动生成的素材，验证三档预设、奇数补边、多音轨、帧率、缩略图、取消、HDR 拒绝、原片和重名保护。需要 PATH 中有完整 FFmpeg。

在 `packages/picsharp-sidecar`：

```sh
node --import tsx --test tests/video-watch.test.ts
# 启动本机服务后，再验证真实文件监听
PICSHARP_TEST_SIDECAR_URL=http://localhost:43127 node --import tsx --test tests/video-watch-integration.test.ts
```

监听测试覆盖新子文件夹、大写后缀、持续写入、重复事件、文件修改、停止监听、图片导入和成品过滤。

实现参考：[FFmpeg 官方文档](https://ffmpeg.org/ffmpeg.html)、[Tauri 资源打包文档](https://v2.tauri.app/develop/resources/)，以及用户提供的 FrameFold Engine.swift / Model.swift。
