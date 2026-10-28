# 本地验证记录

日期：2026-10-28。平台：macOS，Node v22.18.0。实现基于 v1.1.12；尚未发布新版，也未替换任何真实用户的脚本或配置。

## 已完成

- `node --test test/*.test.js`：47/47 通过，0 失败、0 跳过。
- 对 cli、templates 和 test 共 17 个 JavaScript 文件执行 `node --check`：全部通过。
- `git diff --check`：通过。
- `npm pack --dry-run --json --cache /private/tmp/ai-otel-setup-npm-cache`：包含 14 个文件；确认 `templates/spool-storage.js` 入包，无日志状态、partial、lock 等运行产物。
- Claude/Codex 安装路径均下发共享模块，Codex 临时安装测试确认 512MiB 缓存默认值和共享 uploader 目录。
- 真实 Git 覆盖 HTTPS、ssh://（含端口）、scp 三种 remote；生成的 bundle 在独立克隆中恢复出工作区和未跟踪文件，原 HEAD、分支、暂存区字节保持不变。另覆盖无 HEAD 初始仓库。
- 小文件配合小阈值覆盖单文件/合计/路径数限额、生产配额预留、refs 上限与确认后回收、流式字节上限、超时、非零退出、伪成功但内容损坏、生产互斥和异常临时文件清理。
- 缓存回收覆盖旧 bundle.lock、活跃/已退出 PID、sent 优先、低空间恢复后停止、未知文件保留、待上传保留期、符号链接隔离、重叠目录去重、状态临时文件和历史状态上限。
- 仅监听本机 127.0.0.1 的上传协议测试覆盖成功确认、HTTP 200 但未确认、上传源被截断；Codex Hook 测试验证共享上传器唤醒及共同节流。

## 执行限制与后续验收

沙箱内的上传集成测试最初因 `listen EPERM: operation not permitted 127.0.0.1` 失败；获准使用本机临时端口后，相关用例及全量测试均成功。没有访问生产上传服务。

Windows 实机、不同 Node/Git 版本和生产 OSS 尚待发布环境验收；本地故障流测试不替代 Windows 实机验证。建议灰度安装后检查真实占用、旧锁回收、后台定时器及快照状态，再推广。

缓存阈值控制的是应用管理的 spool。Claude 原生 raw body 在两次调度之间可能使其短暂超过阈值；两个触发渠道均不运行时不能回收。上传成功前的数据在硬阈值、低空间或过期条件下可能被回收，此行为已写入 README 和排障说明。用户仓库 .git 不在 spool 配额内，回收隐藏 refs 不会强制执行 Git GC。
