$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskNode = Join-Path $taskRoot 'runtime\node\node.exe'
$taskPnpm = Join-Path $taskRoot 'runtime\tools\pnpm\bin\pnpm.cjs'
if (-not (Test-Path -LiteralPath $taskNode)) {
    $taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $taskNodeCommand) { throw '请先安装 Node.js 24 或更新版本。依赖安装步骤见 README.md。' }
    $taskNode = $taskNodeCommand.Source
}
$taskVersion = & $taskNode -p 'parseInt(process.versions.node, 10)'
if ($LASTEXITCODE -ne 0 -or [int]$taskVersion -lt 24) { throw '需要 Node.js 24 或更新版本。' }
$taskState = Join-Path $taskRoot '.cache\state'
if (Test-Path -LiteralPath $taskPnpm) {
    & $taskNode $taskPnpm install --frozen-lockfile --ignore-scripts "--config.state-dir=$taskState"
} else {
    $taskNpx = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $taskNpx) { throw '缺少依赖安装工具，请安装包含 npm 的 Node.js，或恢复 runtime\tools\pnpm。' }
    # 源码版临时调用固定版本的 pnpm，无需全局安装 pnpm。
    & $taskNpx.Source --yes pnpm@11.19.0 install --frozen-lockfile --ignore-scripts "--config.state-dir=$taskState"
}
if ($LASTEXITCODE -ne 0) { throw '安装失败，请检查网络。' }
