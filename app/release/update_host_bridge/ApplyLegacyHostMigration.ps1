[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][int]$WaitPid
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Assert-RegularFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw ("必要な移行ファイルがありません: {0}" -f $Path)
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ("移行ファイルが通常ファイルではありません: {0}" -f $Path)
    }
}

function Replace-FileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    try {
        [IO.File]::Replace($Source, $Destination, $null, $true)
    }
    catch {
        if (-not ([System.Management.Automation.PSTypeName]"NexusArkLegacyBridgeNative").Type) {
            Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NexusArkLegacyBridgeNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string existingFileName, string newFileName, uint flags);
}
"@
        }
        if (-not [NexusArkLegacyBridgeNative]::MoveFileEx($Source, $Destination, [uint32]0x00000009)) {
            throw ("Start.bat の切替に失敗しました（Win32 error {0}）。" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
    }
}

$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$stagePath = [IO.Path]::GetFullPath($Stage).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
)
$allowedParent = [IO.Path]::GetFullPath(
    (Join-Path $rootPath "update_recovery\legacy-host-migration")
).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$allowedPrefix = $allowedParent + [IO.Path]::DirectorySeparatorChar
if (-not $stagePath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "移行stagingの場所を確認できません。"
}

$currentMoved = $false
$startReplaced = $false
$backup = $null
$current = Join-Path $rootPath "updater\current"

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(300)
    while ($null -ne (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Nexus Arkの終了を確認できませんでした。もう一度起動して移行をやり直してください。"
        }
        Start-Sleep -Seconds 1
    }
    # 旧Start.batがuv終了後の後片付けを読み終えるまで待つ。
    Start-Sleep -Seconds 5

    $recordPath = Join-Path $stagePath "record.json"
    Assert-RegularFile $recordPath
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$record.operation_id -ne (Split-Path -Leaf $stagePath)) {
        throw "移行記録を確認できません。"
    }
    foreach ($entry in $record.files) {
        $relative = [string]$entry.path
        if ([String]::IsNullOrWhiteSpace($relative) -or $relative.Contains("..") -or [IO.Path]::IsPathRooted($relative)) {
            throw "移行ファイル名を確認できません。"
        }
        $candidate = Join-Path $stagePath $relative
        Assert-RegularFile $candidate
        if ((Get-Sha256 $candidate) -ne [string]$entry.sha256) {
            throw ("移行ファイルの検証に失敗しました: {0}" -f $relative)
        }
    }

    $start = Join-Path $rootPath "Start.bat"
    Assert-RegularFile $start
    $next = Join-Path $rootPath "updater.next"
    if ((Test-Path -LiteralPath $current) -or (Test-Path -LiteralPath $next)) {
        throw "更新hostの配置が既にあります。上書きせず停止します。"
    }
    if (Test-Path -LiteralPath (Join-Path $rootPath "update_recovery\transaction.lock")) {
        throw "更新処理の記録があるため、上書きせず停止します。"
    }

    $backup = Join-Path $rootPath ("update_recovery\bridge-backups\{0}" -f $record.operation_id)
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $start -Destination (Join-Path $backup "Start.bat")
    if ((Get-Sha256 $start) -ne (Get-Sha256 (Join-Path $backup "Start.bat"))) {
        throw "旧Start.batのbackupを確認できません。"
    }

    foreach ($name in @("pyproject.toml", "uv.lock")) {
        $destination = Join-Path $rootPath $name
        if (-not (Test-Path -LiteralPath $destination)) {
            [IO.File]::Move((Join-Path $stagePath $name), $destination)
        }
    }

    [IO.Directory]::Move((Join-Path $stagePath "updater.current"), $next)
    New-Item -ItemType Directory -Path (Join-Path $rootPath "updater") -Force | Out-Null
    [IO.Directory]::Move($next, $current)
    $currentMoved = $true

    $temporaryStart = Join-Path $rootPath ("Start.bat.bridge-{0}.tmp" -f $record.operation_id)
    [IO.File]::Move((Join-Path $stagePath "Start.bat"), $temporaryStart)
    Replace-FileAtomic $temporaryStart $start
    $startReplaced = $true

    @{ state = "complete"; operation_id = [string]$record.operation_id } |
        ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $stagePath "result.json") -Encoding UTF8
}
catch {
    if ($currentMoved -and -not $startReplaced -and $null -ne $backup) {
        $failedHost = Join-Path $backup "updater-current"
        if ((Test-Path -LiteralPath $current -PathType Container) -and -not (Test-Path -LiteralPath $failedHost)) {
            try { [IO.Directory]::Move($current, $failedHost) } catch { }
        }
    }
    @{ state = "failed"; error_type = $_.Exception.GetType().Name } |
        ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $stagePath "result.json") -Encoding UTF8
    throw
}
