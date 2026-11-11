# MCP 使用规则（shuncode-bridge）

本文档归档早期会话使用的 MCP 连接与规则。当前连接、工具权限和操作范围以本次会话的工具说明及用户指令为准；历史端点不随项目发布。

## 连接

- 端点：仅保存在使用者的本机会话配置中，公开仓库不包含可访问的桥接地址或会话密钥。
- 服务名与版本：`shuncode-bridge` 0.7.4，协议版本 `2025-03-26`
- 目标主机：Linux 主机 `lhx`（即运行 ShunCode 的同一台设备），不是 Web 或云端环境，也不是沙箱。
- 会话不能跨进程复用。每次调用都需要先 `initialize`，再发送 `notifications/initialized`，然后才发请求。
- 隧道（ngrok）偶发 `ERR_NGROK_3200` / `3004`，应重试整个“初始化 + 调用”流程。
- 辅助脚本：`mine_extension_research/mcp_call.py`（仅用于探测，不放在 docs/ 中）。

## 作用范围

- 默认范围是整台主机，但优先处理 ShunCode 当前打开的工作区文件夹。
- 访问工作区之外的路径时使用 `run_command`，工作区文件工具只限于工作区内。
- 目标路径不确定时，先做只读发现（`ls`、`find`、`rg`），确认后再操作。

## 工具（15 个）

| 工具 | 用途 |
|---|---|
| apply_patch | 修改工作区文件。带上 read_files 返回的 expected_versions。 |
| find_files | 按路径模式查找文件 |
| read_files | 读取 UTF-8 文件，大文件使用行范围 |
| read_image | 查看图片（PNG/JPEG/GIF/WebP/BMP/SVG/ICO） |
| search_files | 按文本或正则搜索内容 |
| list_directory | 列出目录（深度 1 或 2） |
| run_command | 在主机托管的 bash 中执行命令 |
| get_command_output | 按 command_id 读取输出，从 next_offset 续读 |
| cancel_command | 请求取消命令（不要用 Ctrl+C 文本，不要传 pid） |
| send_command_input | 向仍在运行的交互命令发送输入 |
| get_diagnostics | 读取语言服务诊断（空结果不代表无问题） |
| lsp | 符号跳转、引用、悬停信息 |
| set_todos | 发布完整有序的任务清单（用于多步骤工作） |
| update_plan | 与 set_todos 等价的 Codex 风格计划格式（仅此 MCP 调用会更新任务卡片） |
| report_progress | 发送临时进度说明（不修改文件，不替代任务清单） |

## run_command 规则

- 直接传入原生 bash 脚本，不要包 `bash -c "..."` 或 `bash -lc "..."`。
- 路径和变量要加引号，路径参数前使用 `--`。
- 使用 GNU bash：数组从 0 开始，未匹配的 glob 会原样保留（failglob 关闭）。不要用 zsh 语法（如 `$pipestatus`、`typeset -A`）。
- 需要管道的退出码时，立即读取 `$PIPESTATUS`，或使用 `set -o pipefail`。
- `background=true` 只用于常驻服务或监视进程。前台命令超时（最长 120000 ms）不会被杀掉，应改用 get_command_output 继续读取。
- 托管终端空闲 2 小时后关闭，不要依赖 shell 变量或工作目录长期保留。
- 编辑文件优先使用 apply_patch，不要用 run_command 做能用 apply_patch 完成的编辑。
- 构建、安装、测试、打包可以直接执行。只有不可逆或破坏性操作需要先征得用户确认。

## 写入安全

- apply_patch 的结果未知或被中断时，先重新读取受影响文件确认是否已提交，不要盲目重放补丁。
- 补丁失败（版本不匹配）后，重新读取文件再重试。
- 每次有意义的修改后，运行诊断与相关测试。

## 任务进度

- 多步骤工作使用 set_todos 维护完整快照，稳定 ID，同一时刻最多一个 in_progress。
- 任务卡片状态只由 set_todos 或 update_plan（本 MCP 的调用）更新。
- 给出最终回答前，必须提交终态快照（未完成的项保持真实状态），并等待确认后再宣称完成。
- report_progress 只用于说明当前动作，不作为持久状态。

## 文档同步

- 会话中产生的分析、审计、计划、评审，都写入仓库的 `docs/mcp-<topic>.md`。
- 文件使用 LF 换行，不留行尾空格，文内引用改为仓库内路径。
- 探针脚本、机器可读基线和日志放在 docs/ 之外，除非用户要求。
- 本次所在仓库：用户指定为宿主机扩展目录 `/home/lhx/bag-downloader-extension/docs/`。

## 项目相关约束（用户明确要求）

- 不占用真实桌面鼠标指针，不使用 pyautogui 或其他桌面自动化。
- 测试时不真实下载数据包（单个约 770–800 MB）。
- 给用户的回复使用中文。
