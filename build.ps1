<#
.SYNOPSIS
    一键构建 DeepSeek Harness 免安装便携版（Windows）。

.DESCRIPTION
    从官方渠道获取全部组件并组装出可独立运行的便携目录：
      1) 确定 Node.js 运行时：优先用本机已安装的 Node（-NodePath 指定，或自动检测 PATH），
         本机没有 Node 时才下载官方 Node.js
      2) 用 npm 安装官方发布包 @deepseek-ai/dsh（默认自动取最新版，可用 -DshVersion 固定版本；扁平 node_modules，零链接）
      3) 生成批处理启动器（启动 DeepSeek Harness.cmd，零编译、无 C# 依赖）
      4) 复制文档，组装为便携目录；可选打包 zip

    构建产物可直接拷贝到任意 64 位 Windows 10/11 电脑使用，
    双击「启动 DeepSeek Harness.cmd」即可运行（默认端口 3081）。

.PARAMETER NodeVersion
    下载 Node.js 时使用的版本，默认 v24.19.0（仅当本机没有 Node 时才下载）。

.PARAMETER NodePath
    本机 Node.js 路径（node.exe 文件，或含 node.exe 的目录）。
    指定后直接使用本机 Node，不再下载；不指定则自动检测 PATH 上的 node.exe，
    检测不到才回退为下载官方 Node.js。

.PARAMETER DshVersion
    官方 dsh 包版本。留空（默认）则构建时自动查询 npm 上的最新版；
    需要固定版本时指定，如 0.1.0-rc.6。

.PARAMETER Registry
    npm 镜像源。国内网络可传 https://registry.npmmirror.com/。

.PARAMETER NodeMirror
    Node.js 下载镜像。国内网络可传 https://npmmirror.com/mirrors/node/。

.PARAMETER OutDir
    输出目录，默认 <脚本目录>\dist。

.PARAMETER Zip
    组装完成后打包为 zip（使用系统自带 tar.exe）。

.EXAMPLE
    # 用本机 Node 构建（自动检测 PATH，不下载）
    powershell -ExecutionPolicy Bypass -File .\build2.ps1 -Zip

.EXAMPLE
    # 指定本机 Node 目录（不下载）
    powershell -ExecutionPolicy Bypass -File .\build2.ps1 -Zip `
        -NodePath "C:\Program Files\nodejs"

.EXAMPLE
    # 固定 dsh 版本（默认会自动取最新版）
    powershell -ExecutionPolicy Bypass -File .\build2.ps1 -Zip `
        -DshVersion "0.1.0-rc.6"

.EXAMPLE
    # 本机没有 Node 时回退下载（国内网络加速）
    powershell -ExecutionPolicy Bypass -File .\build2.ps1 -Zip `
        -Registry "https://registry.npmmirror.com/" `
        -NodeMirror "https://npmmirror.com/mirrors/node/"
#>
param(
    [string]$NodeVersion = "v24.19.0",
    [string]$NodePath = "",
    [string]$DshVersion = "",
    [string]$Registry = "https://registry.npmjs.org/",
    [string]$NodeMirror = "https://nodejs.org/dist/",
    [string]$OutDir = "",
    [switch]$Zip
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $scriptDir "dist" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$work = Join-Path $env:TEMP "dsh-build-work"

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "    $msg" -ForegroundColor Green }

# ── 1. 确定 Node.js 运行时（优先本机，找不到才下载）────────────────────────
# 优先级：-NodePath 指定 > PATH 上的 node.exe > 下载官方 Node.js
$nodeExeSrc = ""
if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = [System.IO.Path]::GetFullPath($NodePath)
    if (Test-Path $NodePath -PathType Leaf) { $nodeExeSrc = $NodePath }
    elseif (Test-Path (Join-Path $NodePath "node.exe")) { $nodeExeSrc = Join-Path $NodePath "node.exe" }
    else { Write-Host "指定的 -NodePath 不存在或不是 node.exe: $NodePath" -ForegroundColor Red; exit 1 }
    $nodeRoot = Split-Path $nodeExeSrc -Parent
    Step "使用本机 Node（-NodePath 指定）"
    Write-Host "    路径: $nodeExeSrc"
}
else {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeExeSrc = $nodeCmd.Source
        $nodeRoot = Split-Path $nodeExeSrc -Parent
        Step "使用本机 Node（PATH 自动检测）"
        Write-Host "    路径: $nodeExeSrc"
    }
}
if (-not $nodeExeSrc) {
    # 本机没有 Node → 回退：下载官方 Node.js
    Step "本机未检测到 Node，下载 Node.js $NodeVersion"
    $nodeZip = Join-Path $work "node.zip"
    $nodeRoot = Join-Path $work "node-root"
    if (-not (Test-Path (Join-Path $nodeRoot "node.exe"))) {
        $nodeUrl = "$NodeMirror$NodeVersion/node-$NodeVersion-win-x64.zip"
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        Write-Host "    下载: $nodeUrl"
        curl.exe -L --fail --retry 3 -o $nodeZip $nodeUrl
        if ($LASTEXITCODE -ne 0) { Write-Host "下载 Node.js 失败，请检查网络或 -NodeMirror 参数" -ForegroundColor Red; exit 1 }
        Expand-Archive -Path $nodeZip -DestinationPath $work -Force
        # zip 内是 node-vX.Y.Z-win-x64 子目录，整目录作为 Node 根（含 node.exe 与 npm）
        $inner = Get-ChildItem $work -Directory | Where-Object { $_.Name -like "node-v*-win-x64" } | Select-Object -First 1
        if (-not $inner) { Write-Host "Node.js 解压后未找到可执行文件" -ForegroundColor Red; exit 1 }
        Remove-Item $nodeRoot -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item $inner.FullName $nodeRoot
    }
    $nodeExeSrc = Join-Path $nodeRoot "node.exe"
}
Ok "Node.js: $(& $nodeExeSrc --version)（$nodeExeSrc）"

# ── 2. npm 安装官方 dsh 运行时（扁平 node_modules）──────────────────────────
$nmDir = Join-Path $OutDir "node_modules"
$dshEntry = Join-Path $nmDir "@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $dshEntry)) {
    # 定位 npm（node 同目录，找不到再从 PATH 找）
    $npm = Join-Path $nodeRoot "npm.cmd"
    if (-not (Test-Path $npm)) {
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($npmCmd) { $npm = $npmCmd.Source }
        else { Write-Host "未找到 npm（$nodeRoot 下无 npm.cmd，且 PATH 上也没有）" -ForegroundColor Red; exit 1 }
    }
    # 未指定 -DshVersion → 自动查询 registry 上的最新版（/latest 端点，无需 npm 缓存）
    if ([string]::IsNullOrWhiteSpace($DshVersion)) {
        Step "查询 @deepseek-ai/dsh 最新版本（$Registry）"
        $registryBase = $Registry.TrimEnd("/")
        try {
            $DshVersion = (curl.exe -s -L --max-time 30 "$registryBase/@deepseek-ai/dsh/latest" | ConvertFrom-Json).version
        } catch { $DshVersion = "" }
        if (-not $DshVersion) {
            Write-Host "自动查询最新版本失败（网络问题？），请用 -DshVersion 手动指定版本" -ForegroundColor Red
            exit 1
        }
        Ok "最新版本: $DshVersion"
    }
    Step "安装官方包 @deepseek-ai/dsh@$DshVersion（npm，扁平安装，可能需要几分钟）"
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $manifest = @{
        name = "dsh-portable-runtime"
        private = $true
        dependencies = @{ "@deepseek-ai/dsh" = $DshVersion }
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText(
        (Join-Path $OutDir "package.json"),
        $manifest,
        (New-Object System.Text.UTF8Encoding $false)
    )
    # 用 Node 自带的 npm（node 目录加入 PATH）
    $env:PATH = "$nodeRoot;$env:PATH"
    $env:npm_config_registry = $Registry
    $oldCwd = (Get-Location).Path
    Set-Location $OutDir
    try {
        & $npm install --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Write-Host "npm install 失败，请检查网络或 -Registry 参数" -ForegroundColor Red; exit 1 }
    } finally { Set-Location $oldCwd }
    if (-not (Test-Path $dshEntry)) {
        Write-Host "安装后未找到 @deepseek-ai/dsh 入口，构建中止" -ForegroundColor Red
        exit 1
    }
}
else {
    # 已安装且未指定版本：读取已装版本（用于 zip 命名等）
    if ([string]::IsNullOrWhiteSpace($DshVersion)) {
        try {
            $installed = Get-Content (Join-Path $nmDir "@deepseek-ai\dsh\package.json") -Raw | ConvertFrom-Json
            $DshVersion = $installed.version
            Ok "已装版本: $DshVersion"
        } catch { $DshVersion = "installed" }
    }
}
Ok "运行时: $((Get-ChildItem $nmDir -Directory -Force | Measure-Object).Count) 个顶层包（扁平，零链接）"

# ── 3. 生成批处理启动器（零编译，不依赖 C#）────────────────────────────────
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$launcherCmd = Join-Path $OutDir "启动 DeepSeek Harness.cmd"
$launcherBody = @"
@echo off
setlocal
cd /d "%~dp0"
if not exist "data" mkdir "data"
set "DSH_HOME=%~dp0data"
set "PORT=3081"
if exist "port.txt" (
  for /f "usebackq delims=" %%p in ("port.txt") do set "PORT=%%p"
)
"%~dp0node.exe" "%~dp0node_modules\@deepseek-ai\dsh\lib\bin.js" web --port %PORT%
"@
[System.IO.File]::WriteAllText($launcherCmd, $launcherBody, (New-Object System.Text.UTF8Encoding $false))
Ok "启动器: $launcherCmd"

# ── 4. 组装 ────────────────────────────────────────────────────────────────
Step "组装便携目录"
Copy-Item $nodeExeSrc (Join-Path $OutDir "node.exe") -Force
Copy-Item (Join-Path $scriptDir "LICENSE") $OutDir -Force
Copy-Item (Join-Path $scriptDir "docs\使用说明.txt") $OutDir -Force
if (Test-Path (Join-Path $scriptDir "THIRD_PARTY_NOTICES.md")) {
    Copy-Item (Join-Path $scriptDir "THIRD_PARTY_NOTICES.md") $OutDir -Force
}
Ok "便携目录: $OutDir"
Ok "大小: $([math]::Round((Get-ChildItem $OutDir -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum / 1MB)) MB"

# ── 5. 可选：打包 zip ──────────────────────────────────────────────────────
if ($Zip) {
    Step "打包 zip"
    $zipPath = Join-Path $scriptDir "DeepSeek-Harness-Portable-$DshVersion.zip"
    $parent = Split-Path $OutDir -Parent
    $name = Split-Path $OutDir -Leaf
    tar.exe -a -c -f $zipPath -C $parent $name
    if ($LASTEXITCODE -ne 0) { Write-Host "打包失败" -ForegroundColor Red; exit 1 }
    Ok "zip: $zipPath ($([math]::Round((Get-Item $zipPath).Length / 1MB)) MB)"
}

Write-Host "`n构建完成。把整个输出目录拷贝到任意 64 位 Windows 10/11 电脑，双击「启动 DeepSeek Harness.cmd」即可使用（默认端口 3081）。" -ForegroundColor Green
