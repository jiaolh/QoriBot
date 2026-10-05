param(
    [ValidateSet('ui', 'start', 'bot', 'check', 'models', 'chat', 'test')]
    [string]$Action = 'ui',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot

try {
    $taskPortableNode = Join-Path $taskRoot 'runtime\node\node.exe'
    if (Test-Path -LiteralPath $taskPortableNode) {
        $taskNode = $taskPortableNode
    } else {
        $taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $taskNodeCommand) { throw '请先安装 Node.js 24 或更新版本。安装与启动步骤见 README.md。' }
        $taskNode = $taskNodeCommand.Source
    }
    $taskVersion = & $taskNode -p 'parseInt(process.versions.node, 10)'
    if ($LASTEXITCODE -ne 0 -or [int]$taskVersion -lt 24) { throw '需要 Node.js 24 或更新版本。优先使用 runtime\node\node.exe。' }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\@tencent-connect\qqbot-nodejs\package.json'))) {
        throw '功能依赖缺失，请先运行 scripts\install-dependencies.ps1。'
    }
    switch ($Action) {
        'ui' {
            $taskAddress = 'http://127.0.0.1:17860'
            $taskAlreadyRunning = $false
            try {
                $taskStatus = Invoke-RestMethod -Uri ($taskAddress + '/api/status') -TimeoutSec 2
                $taskAlreadyRunning = $null -ne $taskStatus.bot
            } catch {}
            if (-not $taskAlreadyRunning) {
                $taskLogs = Join-Path $taskRoot 'data\logs'
                New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
                $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('"' + (Join-Path $taskRoot 'src\server.js') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs 'service.log') -RedirectStandardError (Join-Path $taskLogs 'error.log') -PassThru
                for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
                    Start-Sleep -Milliseconds 250
                    if ($taskProcess.HasExited) { throw '服务启动失败，请查看 data\logs\error.log。' }
                    try {
                        $taskStatus = Invoke-RestMethod -Uri ($taskAddress + '/api/status') -TimeoutSec 1
                        if ($null -ne $taskStatus.bot) { $taskAlreadyRunning = $true; break }
                    } catch {}
                }
                if (-not $taskAlreadyRunning) { throw '服务启动超时，请查看 data\logs 下的日志。' }
            }
            if (-not $NoBrowser) { Start-Process $taskAddress }
            Write-Host ('控制台地址：{0}。关闭网页后服务仍可运行；在界面左下角点击“退出程序”可完全退出。' -f $taskAddress)
        }
        'start' { & $taskNode (Join-Path $taskRoot 'src\server.js'); exit $LASTEXITCODE }
        'bot'   { & $taskNode (Join-Path $taskRoot 'src\index.js'); exit $LASTEXITCODE }
        'check' { & $taskNode (Join-Path $taskRoot 'scripts\check-config.js'); exit $LASTEXITCODE }
        'models'{ & $taskNode (Join-Path $taskRoot 'scripts\list-models.js'); exit $LASTEXITCODE }
        'chat'  { & $taskNode (Join-Path $taskRoot 'scripts\chat.js'); exit $LASTEXITCODE }
        'test'  { & $taskNode --test; exit $LASTEXITCODE }
    }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
