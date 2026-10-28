# 文件监控修复与验证

2026-10-27。本轮修复覆盖 12 项已确认缺陷。成品识别同时核对文件对象、版本和内容；保存与 Undo 操作核对本任务拥有的对象，防止后来导出的新稿被旧任务覆盖或删除。

## 修复行为

| 编号 | 当前行为 | 主要回归 |
| --- | --- | --- |
| WATCH-001 | 已登记成品改名或同卷移动后继续识别；独立复制和真正新稿仍可处理。 | [成品与发布](../packages/picsharp-sidecar/tests/image-repair.test.ts)、[旧记录迁移](../packages/picsharp-sidecar/tests/image-legacy-records.test.ts) |
| WATCH-002 | `*.png`、`**/draft/**` 等忽略规则生效，字面路径规则保持兼容。 | [忽略与故障](../packages/picsharp-sidecar/tests/watch-ignore-fault.test.ts) |
| WATCH-003 | 局部目录不可访问时显示具体路径警告，健康邻居继续处理。 | [服务流](../packages/picsharp-sidecar/tests/watch-ignore-fault.test.ts)、[界面警告](../apps/picsharp-app/tests/watch-fault.test.mjs) |
| WATCH-005 | 最后保存间隙重新导出的新稿受到保护；发布不替换后来占名的对象。 | [精确发布窗口](../packages/picsharp-sidecar/tests/image-repair.test.ts) |
| WATCH-006 | 父目录移动后清理本任务工作文件；工作目录及后代不作为新素材入队。 | [临时路径](../packages/picsharp-sidecar/tests/watch-temporary-paths.test.ts)、[原生视频](../apps/picsharp-app/src-tauri/src/video/tests.rs) |
| WATCH-008 | 坏内部记录仅暂停对应文件，健康同批继续；记录修复后可重查恢复。 | [服务隔离](../packages/picsharp-sidecar/tests/image-repair.test.ts)、[界面队列](../apps/picsharp-app/tests/watch-diagnostics.test.ts) |
| WATCH-009 | 有图片卡片时助手退出，界面返回监控引导并提示中断。 | [卡片与动作](../apps/picsharp-app/tests/watch-actions.test.mjs) |
| WATCH-010 | 编辑忽略标签并清空确认时删除该项，空白规则不匹配全部文件。 | [卡片与动作](../apps/picsharp-app/tests/watch-actions.test.mjs)、[忽略规则](../packages/picsharp-sidecar/tests/watch-ignore-fault.test.ts) |
| WATCH-011 | 同卷短工作目录避免因内部临时文件名增长而破坏合法深路径。 | [1022 字节路径](../packages/picsharp-sidecar/tests/image-repair.test.ts) |
| WATCH-012 | 原始硬链接伙伴的元数据改变后，自动提供当前版本候选；旧候选仍拒绝。 | [硬链接消费](../packages/picsharp-sidecar/tests/image-repair.test.ts) |
| WATCH-013 | Undo 恢复原稿后保持该状态，之后真正重新导出的新稿仍可压缩。 | [真实监听与 Undo](../packages/picsharp-sidecar/tests/undo-image.test.ts) |
| WATCH-014 | 旧卡 Undo 不删除占据原输出路径的新对象，多对象操作冲突时保留并报告恢复文件。 | [Undo 保护](../packages/picsharp-sidecar/tests/undo-image.test.ts)、[前端动作](../apps/picsharp-app/tests/watch-actions.test.mjs) |

共享实现见 [图片登记与发布](../packages/picsharp-sidecar/src/services/output-records.ts)、[目录锚点](../packages/picsharp-sidecar/src/services/directory-anchor.ts)、[Undo 服务](../packages/picsharp-sidecar/src/services/undo-image.ts)、[监控入口](../packages/picsharp-sidecar/src/controllers/watch/index.ts)、[监控界面](../apps/picsharp-app/src/pages/compression/watch.tsx) 和 [视频工作文件](../apps/picsharp-app/src-tauri/src/video/workfile.rs)。目录锚点让改名后的操作仍指向原目录，而不是后来重建的同名路径。

## 已执行验证

- Node v20.20.2 最终串行自动回归：**82 项，81 通过、0 失败、1 跳过**。跳过项需要真实服务 URL，随后连接最终隔离应用单独补跑，**1/1 通过**；保留分次执行口径。
- Rust 视频回归：**20/20 通过**，通过 `--include-ignored` 实际执行 FFmpeg 三预设、音轨/尺寸、取消/HDR 和编码中父目录移动。
- macOS 原生界面已验图片整理与新稿、忽略规则、局部权限提示、坏记录隔离、深路径、硬链接、两类 Undo 及助手退出。图片成品整理与新稿使用最终包三组素材；视频在三个非零编码窗口移动父目录，原片保持、成品完整解码且本任务工作文件无残留。覆盖原图 Undo 的三个原生按钮使用较早构建，最终构建验证了后续真正重导，两个构建的证据分开判定。
- 最终应用有三次完整退出、启动、重连会话：首轮在同一路径新建绿色 V3，后两轮分别覆盖导出红色 V1、蓝色 V2。重连基线无旧成品卡片，各轮新稿均完成压缩并逐轮核对解码、颜色、哈希、文件身份与处理记录；最终为蓝色 V2。最后正常停止监控、退出应用，测试进程和端口为空。

以下命令从仓库根运行，需要 Node 20、已安装的锁定依赖；系统文件事件测试使用允许递归监听的本地目录和非 root 用户。Rust 真实编码测试还需要可用的 FFmpeg/ffprobe。

```sh
node --require ./packages/picsharp-sidecar/node_modules/tsx/dist/cjs/index.cjs \
  --test --test-concurrency=1 \
  apps/picsharp-app/tests/*.test.* \
  packages/picsharp-sidecar/tests/*.test.ts

# 启动当前本机服务后，单独补跑需要真实 URL 的测试。
PICSHARP_TEST_SIDECAR_URL=http://127.0.0.1:43127 \
  node --require ./packages/picsharp-sidecar/node_modules/tsx/dist/cjs/index.cjs \
  --test packages/picsharp-sidecar/tests/video-watch-integration.test.ts

cargo test -p PicSharp --lib video::tests -- --include-ignored
```

## 保留边界

- **WATCH-004** 普通同名输出策略仍待产品决定；**WATCH-007** 是历史内部心跳观察，未作为已确认用户缺陷处理。
- 旧记录在首次核验前已经搬走时，无法可靠反推文件身份，保守作为输入。已完成身份迁移的成品才适用改名保护。
- 极窄目录移动窗口中，实际文件和发布位置可保持安全，但结果返回阶段仍可能读取旧名义路径，出现 ENOENT 或旧卡路径失效；没有声称卡片路径迁移全部解决。
- 既有死进程或过期 `.pending` 标记可能在新发布建立标记时造成 EEXIST，此恢复边界未扩展修复。
- 图片目录锚点需要支持 `node -e` 的独立运行时及硬链接等文件系统能力。当前 macOS 独立 Node 运行时已验；pkg/SEA 分发入口、其他平台和不支持硬链接的文件系统未验。
- 外部程序持有旧文件描述符并在最后核对后继续写入，是更宽的并发模型；本轮保护覆盖按路径重导和受控保存/Undo 窗口。Windows/Linux、物理外置盘、SMB/云同步、整机睡眠、付费压缩及长期负载没有执行。
