# PicSharp-Lazy 自动更新与发布

本 fork 的更新源固定为 `https://github.com/lazyq666/PicSharp-Lazy/releases/latest/download/latest.json`，只信任本 fork 的更新签名公钥，不再使用原作者的更新地址或签名身份。

首次安装包使用保留 macOS 签名及资源信息的 ZIP：解压后将 `PicSharp.app` 拖入“应用程序”。应用内自动更新使用独立签名的 `.app.tar.gz`。CI 不依赖 Finder 或磁盘映像制作。

首批发布平台为 Apple Silicon（arm64）与 Intel（x64）Mac，要求 macOS 26 或更新系统。视频引擎采用对应构建机的 Homebrew FFmpeg，图片服务使用内置官方 Node.js 和锁定的生产依赖；用户安装后不需要自行安装这些组件。

## 首次迁移

已经安装的旧应用内仍然存放旧更新地址，修改仓库不会改变它。首次需要手动安装 2.2.8 或之后的 PicSharp-Lazy 包，然后才能通过本 fork 的渠道更新。迁移前可在旧版设置中关闭自动检查更新。

## 后续发版

1. 同步修改根目录、`apps/picsharp-app`、`packages/picsharp-sidecar` 三份 `package.json` 的版本号，以及相应 `package-lock.json` 的顶层和根包版本。使用递增的稳定版 `x.y.z`。
2. 在 `apps/picsharp-app/release-notes.json` 添加该版本的 `notes`。运行 `python3 scripts/release-metadata.py` 检查。
3. 将代码提交并推送到自己的 GitHub 仓库。
4. 在 GitHub Actions 中手动运行 **Release PicSharp-Lazy**，先构建草稿验收。两个 Mac 包、签名和 `latest.json` 验证通过后，草稿才会创建/更新；手动运行不会发布。
5. 准备正式发版时，对同一提交创建对应标签，例如 `git tag v2.2.9`，再执行 `git push origin v2.2.9`。标签必须与应用版本完全相同。标签触发的流程会重新构建两个架构，读回 GitHub 上传的文件并验签，全部通过后才将草稿转为正式最新版。

正式版本一经发布，流程拒绝覆盖该版本。失败或只完成一个架构时不发布；上一版正式更新源继续有效。串行发布可避免两个流程同时写更新清单。

## 签名与密钥

- **更新签名**：公钥在 `tauri.conf.json`；加密私钥和密码保存在仓库的 GitHub Actions Secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。每次构建生成 `.app.tar.gz.sig`，发布前用公钥验证两种架构的真实归档。
- **本机备份**：仓库根目录 `.secrets/picsharp-lazy-updater.key` 与 `.secrets/picsharp-lazy-updater.password`。目录权限 700，敏感文件权限 600，已加入 gitignore。请另行保存在密码管理器或离线安全备份中。GitHub 无法读回 Secret 原文，丢失匹配私钥会中断已安装客户端的更新链路。
- **macOS 应用签名**：当前没有配置 Apple Developer ID 证书，采用临时签名，尚无 Apple 公证。更新包验签不能替代 Apple 公证；首次安装可能出现系统来源确认或阻止提示。未来配置 Developer ID 时需要连同 Node、原生库、FFmpeg 依赖和应用外层一起签名并公证。

`tauri.macos.release.conf.json` 用于 CI，开启更新产物；`tauri.macos.local.conf.json` 仍可用于无需更新签名密钥的本地构建。关闭 `createUpdaterArtifacts` 只影响构建产物，不会关闭客户端检查更新。

## 验证

```sh
python3 scripts/release-metadata.py
python3 scripts/test-release.py  # 需要 minisign 和已安装的 Tauri CLI
```

测试用临时密钥签名夹具，覆盖两架构清单、归档篡改、错误签名、缺失架构、版本不一致、缺少安装包和收集产物。真实发布还会验证完整 App 的 macOS 代码签名，并在上传后重新下载两份归档验证更新签名。
