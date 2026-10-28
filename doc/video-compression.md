# 视频压缩

批量压缩和文件监听都可以混合导入图片、视频，继续使用原有文件卡片和工具栏。

- 设置 → **图片压缩设置**：原有图片选项，行为不变。
- 设置 → **视频压缩设置**：三档预设、保存文件夹、引擎状态。
- 视频卡片：缩略图、尺寸、帧率、时长；编码时显示百分比、速度、预计剩余时间。支持单项取消、整批取消视频和重试。
- 默认另存到原片旁的 `PicSharp Videos` 文件夹。指定其他文件夹后同样保留原片。
- 批量导入页的“视频记录”恢复上次导入的任务和结果。异常退出时，未完成任务显示为已取消，允许重试。

设置 → **图片压缩设置 → 忽略 .9 图片** 默认开启：监听时跳过 `button.9.png` 这类图片，只匹配图片文件名，不影响同名目录下的普通图片或视频。开关自动保存，每批待处理文件使用当前设置，无需重新启动监听；关闭后，新发生的文件变动会正常进入压缩。

## 编码规则

| 预设             | 编码  | 参数                                                                     |
| ---------------- | ----- | ------------------------------------------------------------------------ |
| 更小体积（默认） | AV1   | libsvtav1 / preset 6 / CRF 47 / yuv420p10le / lp=3（高于 1080p 时 lp=2） |
| 画质均衡         | AV1   | libsvtav1 / preset 6 / CRF 35 / yuv420p10le / lp=3（高于 1080p 时 lp=2） |
| 广泛兼容         | H.264 | libx264 / preset slow / CRF 28 / yuv420p / threads=8                     |

CRF 是同一编码器内的画质与大小取舍，数值越高压缩越强；不同编码器的数值不能直接对比。全部在本机使用 CPU，视频不会送往 TinyPNG。

支持导入 MP4、MOV、M4V、MKV、WebM、AVI、MPG、MPEG、MTS、M2TS、TS、WMV、FLV、3GP、OGV。后缀只是初筛，实际文件必须包含当前 FFmpeg 能解码的视频流；损坏文件或不支持的编码会显示错误。

不主动缩放或降帧。奇数宽高通过补边最多增加一行、一列。保留全部音轨：AAC 复制，其他音轨转 AAC 192 kbps。输出统一 MP4 + faststart，移除原元数据和章节，丢弃字幕和数据流。PQ、HLG、Dolby Vision 或 HDR 附加信息会拒绝处理。AV1 的短边小于 64 像素时提示改用 H.264。

先写同一目标文件夹内的 `.picsharp-video-<id>.mp4`，再验证文件非空、时长误差小于 max(1 秒, 1%)、音轨数量一致。校验成功后使用硬链接原子发布，避免覆盖已有文件；不支持硬链接的文件系统会明确报错，建议选择本机 APFS、NTFS、ext4 等目录。成品保留原文件名，统一使用 `.mp4` 扩展名，不添加编码参数等后缀；只有目标文件夹内重名时追加 `_2`、`_3`。取消会结束 FFmpeg 并清理临时文件。监听导入会按视频任务记录排除压缩成品，避免成品再次进入队列；旧版本带编码后缀的成品仍会过滤。

## 模块

- `src-tauri/src/video/engine.rs`：探测、缩略图、编码参数、进度和安全保存。
- `src-tauri/src/video/mod.rs`：应用级串行队列、取消、任务事件和 JSON 记录。多个窗口也共用同一个编码队列。
- `src/utils/video.ts`：连接后台任务与现有卡片；监听导入按任务记录过滤视频成品。图片仍走原有图片处理服务。
- `packages/picsharp-sidecar/src/controllers/watch/files.ts`：统一监听图片和视频，只读取变化路径的文件属性；启动时建立属性快照，移入目录时增量扫描，不读取媒体内容。
- `packages/picsharp-sidecar/src/controllers/watch/media.ts`：视频版本连续稳定 3 秒、图片稳定 500 毫秒后导入；同一版本去重；跳过临时文件和已登记的图片成品。
- `packages/picsharp-sidecar/src/services/output-records.ts`：图片覆盖、另存、TinyPNG 和格式转换共用的成品登记与发布逻辑。

任务和日志保存在应用数据目录的 `video/jobs.json`、`video/logs`；缩略图在 `video/thumbnails`。视频输出设置独立于图片的覆盖、格式转换、缩放、水印设置。监听启动不再被图片专用设置阻止；图片配置错误由对应文件任务报告。

本机服务固定使用 **43127**，开发界面仍使用 **1420**。不使用 3000。若 43127 被占用，先停止占用它的服务，不自动切换端口。

## 资源与内存

- 编码仍为应用级单任务；编码时暂停缩略图进程，空闲时最多同时生成两个预览。只有接近可视区域的卡片请求预览，滚出区域、切页、窗口隐藏或退出时取消正在排队/执行的预览。取消探测时会等待子进程退出，临时缩略图成功生成后才原子替换缓存。
- AV1 使用并行等级 3，像素总数高于 1920 × 1080 时使用等级 2。当前 SVT-AV1 中 `lp` 表示并行等级，6 是最高档，并非 6 个线程。降低并行度不改变 CRF、编码预设、位深、分辨率、帧率或前瞻分析设置，但可能增加耗时。H.264 保留原有 8 编码线程；输入解码和画面滤镜各限制为 2 线程，缩略图限制为 1 线程。
- 视频历史保留最近 500 条非活动记录，正在执行和排队的任务始终保留。连续监听页面同样保留最新 500 个完成/失败/取消结果及全部活动任务；普通批量导入页面不裁剪当前批次。稳定检测的近期版本记录最多 4096 项；监听属性快照按目录中的媒体文件数量增长，只保存路径与版本字符串。待处理队列每个路径只保留最新版本，每次最多取 256 项。
- 缩略图缓存：最多 500 张、64 MiB、30 天未使用即过期；日志：最多 200 份、32 MiB、14 天。启动时及运行期间每分钟清理，当前正在写入的日志受保护。清理仅涉及应用缓存，不删除源文件或压缩成品。
- 成品识别记录单独持久化在 `video/outputs`，同时按路径和系统文件标识索引（`outputs/identities`）。每次按待导入文件读取至多两条记录，不把全量输出路径保留在内存。裁剪历史不影响旧成品的监听排除；已有历史会自动迁移。这些小型识别记录不是临时缓存，会随对应成品长期保留。
- 图片和视频监听统一使用系统文件事件与文件属性检测，不再通过 `dirspy` 读取整张图片或整段视频；视频持续写入也不会让同目录图片反复读取。已登记的图片成品版本变化时，才按需核对该图片的内容指纹，不扫描其他图片或视频。停止监听、连接失败或目录消失时关闭监听器、计时器和待处理集合。空文件等待下一次写入事件，不持续轮询。
- 所有视频任务共用一个界面事件订阅，避免每个排队文件增加一个独立监听器。

### 替换文件与防止循环压缩

- 版本由设备号、文件标识、大小、修改时间和状态变更时间（ctime）组成。即使替换文件保留了大小和修改时间，通常的覆盖写入与原子替换也会得到新版本。Node 与原生视频服务使用相同的版本格式。
- 监听队列保留路径与版本，执行前重新核对当前文件及成品记录。图片在工作线程开始处理前、视频在真正获得编码队列后再核对一次。文件在等待期间被替换时跳过旧任务，处理新版本。
- 图片先写入 `.picsharp-image-*.扩展名`，再保护目标路径、发布并登记最终版本及 SHA-256 内容指纹。登记前核对发布后的内容与临时成品一致，防止发布期间新导出的原图被误记为成品。原图临时备份也使用此命名，避免临时目录在监听范围内时再次入队。另存、覆盖、TinyPNG 和额外转换格式都经过这套流程；监听任务因压缩收益不足而保留原图时，也登记该已处理版本。
- 图片使用“已压缩记录 + 内容指纹”识别：版本没变时直接跳过；仅权限、预览附加属性等导致版本变化时，内容指纹相同仍跳过。原地重写或原子替换后，内容不同才重新压缩，即使大小与修改时间相同也能识别。指纹以流式读取计算，前后版本不一致则等待文件稳定后重试，不将读取中的混合内容标记为成品。
- 图片成品记录保存在应用数据目录的 `image-outputs`，不随临时图片清理。独立开发服务可通过 `PICSHARP_IMAGE_OUTPUTS_DIR` 指定位置，默认使用用户目录下的 `.picsharp/image-outputs`。记录由工作线程和监听服务共享，应用重启后仍生效。
- 旧版记录没有内容指纹，只能继续识别完全匹配的旧版本；版本变化后会按新输入处理，成功处理后写入新记录。不会把无法核实内容的旧记录直接升级，以免漏掉用户重新导出的图片。
- 视频历史的兜底排除也核对成品版本，不再永久排除某个路径。历史迁移只接受仍匹配旧记录的文件，不会在重启时把替换进去的新原片重新标记成旧成品。
- 视频成品在发布前记录 SHA-256 内容指纹，改名或在同一磁盘内移动后，先按系统文件标识找回记录，再核对内容。内容一致则跳过并更新记录，连续改名、重启和历史淘汰后仍有效；原地改写或替换成新文件仍可导入。指纹使用 64 KiB 缓冲分块计算，压缩时支持取消；普通监听扫描和版本未变化的成品不读取视频内容。旧历史仅在原路径及版本仍能核实的情况下补记指纹，升级前已改名且无法核实的旧成品不会被冒认。
- 已识别的输出不会自动再次压缩；用户后来把该路径替换为新原片，会按新版本重新处理。旧版保留的 `_picsharp_av1_47`、`_picsharp_av1_35`、`_picsharp_h264_28` 成品命名仍作为保留名称过滤。

### 本机对比（2026-10-22）

使用同一台 Mac、应用内置 FFmpeg / SVT-AV1 4.1.0，单独测量对应进程；结果不代表整个应用或所有视频的固定占用。

| 场景                                        | 调整前峰值 | 调整后峰值 | 说明                                   |
| ------------------------------------------- | ---------- | ---------- | -------------------------------------- |
| 1080p / 30 fps / 2 秒测试视频，AV1 更小体积 | 1882 MiB   | 1256 MiB   | 约降低 33%；耗时约 4.05 → 5.35 秒      |
| 监听 24 个各 16 MiB 的测试视频              | 210 MiB    | 90 MiB     | 约降低 57%；完整视频读取量 384 → 0 MiB |

实际调用修改后的压缩引擎复核三档预设，样本成品大小和解码画面 SHA-256 均完全一致。H.264 仅减少解码/滤镜线程。继续保留 H.264 原有编码线程，避免额外改变编码结果。完整应用长时间运行及其他系统仍需实际素材验证。

并行度依据：[SVT-AV1 并行等级定义](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2315)、[SVT-AV1 并行与画质说明](https://github.com/AOMediaCodec/SVT-AV1/blob/main/Docs/CommonQuestions.md)。

## 引擎打包

正式版本只从应用资源 `resources/video` 读取 FFmpeg 和 ffprobe，不依赖 Homebrew 或用户 PATH。开发版可使用该资源、`PICSHARP_VIDEO_BIN_DIR` 或 PATH。

针对每个目标系统和架构准备同时包含 `libsvtav1`、`libx264` 的可移植 FFmpeg 分发包，在本机或对应 CI 构建机执行：

```sh
python3 scripts/prepare-video-engine.py --source /path/to/ffmpeg-bin --target aarch64-apple-darwin
```

脚本验证两个编码器和 ffprobe，生成目标架构清单，再放入 Tauri 已配置的资源目录。macOS 会递归复制动态库、重写成相对路径并签名；`--sign 'Developer ID Application: …'` 可指定发布签名，默认临时签名只用于本机测试。Windows 复制分发包同目录的 DLL；Linux 请提供静态构建或已经使用 `$ORIGIN` 的自包含分发包。保留所用 FFmpeg、x264、SVT-AV1 和其他依赖的许可证、对应源码及分发要求；源目录中的 LICENSE / COPYING / NOTICE 文件会复制进包。

本地发行打包前，还需准备图片 / 监听服务，不能继续使用旧的 sidecar 二进制。macOS 采用内置 Node.js 和真实依赖目录，避免 Sharp、libvips 等原生库在单文件虚拟目录中无法加载。使用官方 macOS Node.js 分发包中的可执行文件，例如当前 Apple Silicon Mac：

```sh
python3 scripts/prepare-macos-sidecar.py --node /path/to/node-v20.20.2-darwin-arm64/bin/node
```

脚本编译服务代码、安装锁定的生产依赖并生成固定入口的本机助手。助手只启动应用资源内的服务入口，运行组件、原生图片库和文件监听依赖都保存在 `.app` 内，便于整体搬移。生成的资源目录已加入 gitignore。发布构建缺少视频引擎或架构清单不匹配时会明确失败；现有发布流水线需在 Tauri 打包前执行同一准备步骤。Windows/Linux 仍需对应架构的引擎包与实机验收。

### 本机 macOS 安装包

当前 Homebrew 视频引擎及动态库要求 macOS 26.0。`tauri.macos.local.conf.json` 为这套 Apple 芯片资源设置对应的系统要求，使用本机临时签名，并关闭需要更新签名密钥的自动更新分发产物。此配置不包含 Apple 公证。

完成上面的引擎准备和 sidecar 构建后，在仓库根目录打包：

```sh
pnpm --filter @picsharp/picsharp-app exec tauri build --bundles app,dmg --config src-tauri/tauri.macos.local.conf.json --ci
```

产物在 `target/release/bundle/macos/PicSharp.app` 和 `target/release/bundle/dmg/`。应用内置图片助手、FFmpeg、ffprobe 及动态库，运行时不需要安装 Node.js、Homebrew 或启动开发服务。若需支持更早的 macOS，应替换成对应最低系统版本的视频引擎和动态库后再调整此配置。

## 验证

在仓库根目录：

```sh
pnpm --filter @picsharp/picsharp-app build
pnpm --filter @picsharp/picsharp-sidecar build
cargo test -p PicSharp --lib video:: -- --include-ignored
```

监听页面记录上限测试（仓库根目录，复用 sidecar 的 tsx）：

```sh
node --import ./packages/picsharp-sidecar/node_modules/tsx/dist/loader.mjs --test apps/picsharp-app/tests/watch-history.test.ts
node --import ./packages/picsharp-sidecar/node_modules/tsx/dist/loader.mjs --test apps/picsharp-app/tests/watch-queue.test.ts
```

真实 FFmpeg 测试使用自动生成的素材，验证三档预设、奇数补边、多音轨、帧率、缩略图、取消、HDR 拒绝、原片和重名保护。需要 PATH 中有完整 FFmpeg。

在 `packages/picsharp-sidecar`：

```sh
node --import tsx --test --test-concurrency=1 tests/video-watch.test.ts tests/video-watcher.test.ts tests/video-watch-route.test.ts tests/image-watch.test.ts
# 启动本机服务后，再验证真实文件监听
PICSHARP_TEST_SIDECAR_URL=http://localhost:43127 node --import tsx --test tests/video-watch-integration.test.ts
```

监听测试覆盖新子文件夹、目录移动、大写后缀、持续写入、重复事件、同大小同修改时间的替换、停止监听、图片另存/覆盖/转换、成品登记延迟与执行前复核。属性检测场景断言图片和视频内容读取量均为零；指纹回归另覆盖预览属性连续变化、两种重新导出覆盖、重启与旧记录、校验期间替换、发布期间替换，以及收益不足时的原图登记。TinyPNG 使用模拟响应，不访问账号或消耗额度。Rust 测试另覆盖视频版本格式、成品连续改名与目录移动、改扩展名、无历史及历史兜底、改名后同大小同修改时间改写、真实编码成品改名、指纹读取中修改与取消、近期成品替换、重启与旧历史迁移、预览取消、进程退出、历史淘汰、活动任务保护和磁盘缓存清理。

实现参考：[FFmpeg 官方文档](https://ffmpeg.org/ffmpeg.html)、[Tauri 资源打包文档](https://v2.tauri.app/develop/resources/)，以及用户提供的 FrameFold Engine.swift / Model.swift。
