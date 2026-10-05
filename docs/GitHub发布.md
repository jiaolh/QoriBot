# GitHub 上传与源码安装指南

这份指南使用 Windows PowerShell。上传操作由你执行；整理文件不会自动创建 GitHub 仓库或推送代码。

## 1. 整理后的提交范围

源码仓库应包含：

```text
src/                     机器人与本地管理服务
ui/                      本地管理界面
scripts/                 启动、依赖安装与维护脚本
test/                    自动测试
docs/                    使用、设计与发布文档
README.md、TODO.md
package.json、pnpm-lock.yaml、pnpm-workspace.yaml
.npmrc、.gitignore、.gitattributes、.env.example
start.cmd、console.cmd、check-config.cmd、list-models.cmd、test-chat.cmd
```

以下内容保留在本机，由 `.gitignore` 排除：

| 内容 | 原因 |
|---|---|
| `.env`、其他真实 `.env.*` | 本机凭证；只有空白示例 `.env.example` 提交 |
| `data/` | API Key、QQ AppSecret、数据库、聊天记忆和日志 |
| `backups/` | 历史配置和用户资料恢复点，可能含密钥 |
| `exports/` | 本机导出的聊天资料 |
| `runtime/` | 便携运行环境，源码用户自行安装 Node |
| `node_modules/` | 依据锁文件重新安装的依赖 |
| `.cache/`、`.pnpm-store/` | 缓存和临时验证文件 |

复制到其他目录的数据库、私钥、日志和临时文件也会被忽略。不要使用 `git add -f` 绕过这些规则。不要直接把整个本机 QQBot 文件夹拖到 GitHub 网页上传；网页上传不替你应用本机 `.gitignore`。

首次启动提示词放在 `src/prompts.js`；其他用户不需要你的 `data/settings.json`。`package.json` 的 `private: true` 只阻止误发布到 npm，不影响上传 GitHub。

## 2. 准备 Git 和空仓库

1. 打开 PowerShell，运行 `git --version`。能显示版本就说明已安装 Git；否则安装 [Git for Windows](https://git-scm.com/downloads/win)，安装时保留 Git Credential Manager，再重新打开 PowerShell。
2. 登录自己的 GitHub，打开 [创建仓库页面](https://github.com/new)。
3. Owner 选择自己的账号，Repository name 可以填写 `qq-official-ai-bot`。Public 表示公开源码，Private 表示仅授权的人可访问，按你的用途选择。
4. 不勾选 **Add a README file**，不添加 `.gitignore`，License 先选择 **None**，创建一个空仓库。本机已有 README 和忽略规则；项目许可证可按你的分享意愿另行确定。
5. 点击 **Create repository**，复制页面上 HTTPS 地址，例如 `https://github.com/YOUR_NAME/qq-official-ai-bot.git`。

## 3. 初始化本地仓库与作者信息

在 PowerShell 中执行：

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\Desktop\QQBot'
git init -b main
git config user.name "你的 Git 提交名称"
git config user.email "你的 Git 提交邮箱"
```

把名称和邮箱换成自己的信息。它们是提交作者信息，不是登录密码；上述配置只作用于当前项目。如果不想公开个人邮箱，可以在 GitHub 的 **Settings → Emails** 中复制自己的完整 `noreply` 邮箱。

已初始化过的项目无需重复 `git init`。本指南的首次上传步骤以本地尚未初始化、远程为空的情况为准。

## 4. 暂存并检查提交内容

```powershell
git add .
git -c core.quotepath=false status --short
git -c core.quotepath=false diff --cached --stat
git diff --cached -- .env.example
```

`git add .` 只放入本地暂存区，还没有上传。检查列表应只有第 1 节中的源码文件，`.env.example` 的 `QQ_APP_ID`、`QQ_APP_SECRET`、`LLM_API_KEY` 必须为空。查看完整暂存正文可运行 `git diff --cached`；如果进入翻页界面，按 `q` 退出。

核对忽略规则：

```powershell
git check-ignore -v .env data/settings.json backups/ exports/ runtime/ node_modules/ .cache/
```

输出应显示对应的 `.gitignore` 规则。无论仓库公开还是私有，都不要把本机密钥和聊天资料放进提交。

## 5. 提交并上传

检查通过后执行下面的命令，把 `YOUR_NAME` 和 `YOUR_REPO` 换成第 2 节中创建的真实账号和仓库名：

```powershell
git commit -m "Initial QQBot source"
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git remote -v
git push -u origin main
```

只有最后的 `git push` 会把提交上传到 GitHub。第一次使用 HTTPS 推送时，Git Credential Manager 通常会打开浏览器：登录自己的账号并完成授权；如果启用双重验证，按页面提示完成验证。不要把密码或访问令牌写进仓库地址或项目文件。

上传成功后刷新仓库页面，应能看到 README、源码和测试；不应看到 `.env`、`data/`、`backups/`、`runtime/` 或 `node_modules/`。本地再运行：

```powershell
git status
```

没有新修改时会显示 `working tree clean`，并提示当前分支跟踪 `origin/main`。

## 6. 以后更新代码

修改后仍在项目目录执行，每次提交前查看暂存列表：

```powershell
git add .
git -c core.quotepath=false diff --cached --stat
git commit -m "说明这次修改了什么"
git push
```

如果只改了本机 API Key、QQ 配置或聊天记忆，Git 不会发现需要提交的变化，这是正常的。`.gitignore` 不会自动移除已经跟踪的文件；误提交真实凭证后，即使删除文件，历史仍可能保留凭证，需要先更换凭证，再处理历史。

## 7. 常见问题

| 提示 | 处理 |
|---|---|
| `git` 无法识别 | 安装 Git for Windows 后重新打开 PowerShell |
| `Author identity unknown` | 按第 3 节设置 `user.name` 和 `user.email`，再提交 |
| `remote origin already exists` | 用 `git remote -v` 检查；地址错误时运行 `git remote set-url origin https://github.com/YOUR_NAME/YOUR_REPO.git` |
| `Repository not found` 或 403 | 核对账号、仓库拼写、登录账号及其写入权限 |
| `src refspec main does not match any` | 确认 `git commit` 已成功，并用 `git branch --show-current` 查看分支名 |
| `nothing to commit` | 没有新的源码修改；已提交的内容可以直接推送 |
| `LF will be replaced by CRLF` | 通常是换行提示；项目已通过 `.gitattributes` 指定换行 |
| `non-fast-forward` / `fetch first` | 远程已有提交，需要先合并远程内容；不要用强制推送覆盖 |

如果新仓库误勾选了 README 等文件，或者远程后来已有新提交，可以先合并：

```powershell
git pull --no-rebase --allow-unrelated-histories --no-edit origin main
```

若提示冲突，用 `git status` 查看冲突文件，编辑后保留所需内容并删除冲突标记；对处理好的文件运行 `git add 文件路径`，再运行 `git commit -m "Merge remote changes"`。只有合并成功后才运行 `git push -u origin main`。有其他协作者时，应先了解远程修改再解决冲突。

## 8. 别人从 GitHub 下载后如何运行

源码仓库不包含便携环境、依赖和你的数据。Windows 用户：

1. 安装包含 npm / npx 的 [Node.js 24 或更新版本](https://nodejs.org/en/download)，重新打开终端。
2. 在 GitHub 选择 **Code → Download ZIP** 并解压，或使用 `git clone` 下载仓库。
3. 在解压后的项目目录打开 PowerShell，安装依赖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dependencies.ps1
```

4. 运行本地测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1 test
```

5. 双击 `start.cmd`，打开 `http://127.0.0.1:17860`，在界面填写自己的 API Key、QQ AppID 和 AppSecret，然后启动机器人。

安装脚本优先使用内置 Node / pnpm；没有 `runtime/` 时使用系统 Node，并通过 `npx.cmd` 调用固定的 `pnpm@11.19.0`。依赖按 `pnpm-lock.yaml` 安装，安装脚本被禁用，缓存保存在 `.cache/` 中，首次安装需要联网。测试使用本地模拟服务与虚拟凭证。

不需要复制旧 `.env` 或旧 `data/`；首次启动会生成自己的配置。本项目主要提供 Windows 启动入口。

## 9. 本机为什么保留 runtime 和 node_modules

后台和 QQ SDK 使用 JavaScript，需要 Node。内置 Node 还提供 HTTP 与 SQLite，因此不需要单独安装 Python、数据库服务器或前端构建环境。

本机保留运行环境和依赖可以继续双击启动。源码用户通过安装 Node 和依赖获得相同功能；是否把 Node 放在项目内不会决定运行速度。发布便携包时，需要另行准备不含真实配置、聊天资料、日志和备份的干净副本，并保留第三方许可证。

官方参考：[上传本地项目](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github?platform=windows)、[HTTPS 登录与凭证管理](https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git?platform=windows)、[忽略文件](https://docs.github.com/en/get-started/git-basics/ignoring-files)。
