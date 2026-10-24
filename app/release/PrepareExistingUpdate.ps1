<#
Nexus Ark: prepare an existing Windows installation for the normal updater.

This small GUI is intentionally only a preflight and launcher.  It does not
copy an application, migrate an updater, change update_url, or create a
backup.  The user selects an already extracted installation, confirms that it
is stopped and backed up, and then this package repairs uv before starting the
selected installation's own Start.bat.

The script is normally run from app/release in a complete package.  Internal
parameters on the functions below exist for isolated tests after dot-sourcing;
the product entry point exposes no target-path or repair-bypass switches.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:IsDotSourced = ($MyInvocation.InvocationName -eq '.')
$script:PreparationProgress = $null

function Open-PreparationProgress {
    param([Parameter(Mandatory = $true)][string]$TargetRoot)

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $form = New-Object System.Windows.Forms.Form
    try {
        $form.Text = 'Nexus Ark — 更新の準備中'
        $form.ClientSize = New-Object System.Drawing.Size(600, 220)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.ControlBox = $false
        $form.AutoScaleMode = 'Dpi'

        $target = New-Object System.Windows.Forms.Label
        $target.SetBounds(20, 16, 560, 42)
        $target.Text = "今まで使っているフォルダー：`r`n$TargetRoot"
        $target.AutoEllipsis = $true

        $stage = New-Object System.Windows.Forms.Label
        $stage.SetBounds(20, 68, 560, 38)
        $stage.Text = '選択したフォルダーを確認しています…'

        $bar = New-Object System.Windows.Forms.ProgressBar
        $bar.SetBounds(20, 116, 560, 18)
        $bar.Style = 'Marquee'
        $bar.MarqueeAnimationSpeed = 30

        $elapsed = New-Object System.Windows.Forms.Label
        $elapsed.SetBounds(20, 144, 560, 22)
        $elapsed.Text = '準備を開始しています…'

        $note = New-Object System.Windows.Forms.Label
        $note.SetBounds(20, 174, 560, 38)
        $note.Text = "準備には数分かかることがあります。このままお待ちください。`r`n完了すると、選択したフォルダーのStart.batを起動します。"

        $form.Controls.AddRange(@($target, $stage, $bar, $elapsed, $note))
        $script:PreparationProgress = @{
            Form = $form
            StageLabel = $stage
            ElapsedLabel = $elapsed
            ProgressBar = $bar
            NoteLabel = $note
            Started = [Diagnostics.Stopwatch]::StartNew()
        }
        $form.Show()
        Update-PreparationProgress
    }
    catch {
        $form.Dispose()
        $script:PreparationProgress = $null
        throw
    }
}

function Update-PreparationProgress {
    if ($null -eq $script:PreparationProgress) { return }
    $progress = $script:PreparationProgress
    if ($progress.Form.IsDisposed) { return }
    $progress.ElapsedLabel.Text = '準備開始から {0} 秒' -f [int]$progress.Started.Elapsed.TotalSeconds
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-PreparationStatus {
    param([Parameter(Mandatory = $true)][string]$Text)

    Write-Host ('[Nexus Ark] {0}' -f $Text)
    if ($null -ne $script:PreparationProgress -and -not $script:PreparationProgress.Form.IsDisposed) {
        $script:PreparationProgress.StageLabel.Text = $Text
        Update-PreparationProgress
    }
}

function Close-PreparationProgress {
    if ($null -eq $script:PreparationProgress) { return }
    $progress = $script:PreparationProgress
    $script:PreparationProgress = $null
    $progress.Started.Stop()
    $progress.Form.Dispose()
}

function Wait-PreparationProcess {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $nextNotice = 5
    try {
        while (-not $Process.WaitForExit(250)) {
            Update-PreparationProgress
            if ($watch.Elapsed.TotalSeconds -ge $nextNotice) {
                Write-Host ('[Nexus Ark] 更新用ツールを準備中です。このままお待ちください（{0} 秒経過）。' -f [int]$watch.Elapsed.TotalSeconds)
                $nextNotice += 5
            }
        }
        $Process.WaitForExit()
        Update-PreparationProgress
    }
    finally {
        $watch.Stop()
    }
}

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'パスが空です。'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) {
        $full = $full.TrimEnd([char[]]@('\', '/'))
    }
    return $full
}

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)]$Item)
    return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-SafePathOrAbsent {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = Get-NormalizedPath $Path
    $root = [IO.Path]::GetPathRoot($full)
    $tail = $full.Substring($root.Length)
    $parts = @($tail -split '[\\/]' | Where-Object { $_ })
    $cursor = $root
    foreach ($part in $parts) {
        $cursor = Join-Path $cursor $part
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            return $false
        }
        if (Test-ReparsePoint $item) {
            throw ('リンクまたは再解析ポイントを含むため停止します: {0}' -f $cursor)
        }
    }
    return $true
}

function Assert-RegularDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-SafePathOrAbsent $Path)) {
        throw ('{0} が見つかりません。' -f $Label)
    }
    $item = Get-Item -LiteralPath (Get-NormalizedPath $Path) -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or (Test-ReparsePoint $item)) {
        throw ('{0} が通常のフォルダーではありません。' -f $Label)
    }
    return (Get-NormalizedPath $item.FullName)
}

function Assert-RegularFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-SafePathOrAbsent $Path)) {
        throw ('{0} が見つかりません。' -f $Label)
    }
    $item = Get-Item -LiteralPath (Get-NormalizedPath $Path) -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (Test-ReparsePoint $item)) {
        throw ('{0} が通常のファイルではありません。' -f $Label)
    }
    return $item
}

function Test-SameOrNestedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftFull = Get-NormalizedPath $Left
    $rightFull = Get-NormalizedPath $Right
    if ([StringComparer]::OrdinalIgnoreCase.Equals($leftFull, $rightFull)) {
        return $true
    }
    $leftPrefix = $leftFull.TrimEnd([char[]]@('\', '/')) + '\'
    $rightPrefix = $rightFull.TrimEnd([char[]]@('\', '/')) + '\'
    return (
        $leftFull.StartsWith($rightPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $rightFull.StartsWith($leftPrefix, [StringComparison]::OrdinalIgnoreCase)
    )
}

function Read-VersionValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-RegularFile $Path $Label | Out-Null
    try {
        $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw ('{0} の JSON を読み取れません。' -f $Label)
    }
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value.version)) {
        throw ('{0} に version がありません。' -f $Label)
    }
    return [string]$value.version
}

function Get-PackageSource {
    param([string]$PackageRoot = '')

    if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
        # PSScriptRoot is app/release in the final package.  Resolving from it
        # keeps this tool independent of the caller's current directory.
        $release = Get-NormalizedPath $PSScriptRoot
        $app = Get-NormalizedPath (Join-Path $release '..')
        $PackageRoot = Get-NormalizedPath (Join-Path $app '..')
    }
    $root = Assert-RegularDirectory $PackageRoot '配布パッケージのルート'
    $app = Assert-RegularDirectory (Join-Path $root 'app') '配布パッケージの app'
    $release = Assert-RegularDirectory (Join-Path $app 'release') '配布パッケージの app/release'
    $start = (Assert-RegularFile (Join-Path $root 'Start.bat') '配布パッケージの Start.bat').FullName
    $repair = (Assert-RegularFile (Join-Path $release 'RepairUpdateCertificates.ps1') '配布パッケージの修復スクリプト').FullName
    $secureLauncher = (Assert-RegularFile (Join-Path $release 'RefreshSecureLauncher.ps1') '配布パッケージの起動設定準備スクリプト').FullName
    Assert-RegularFile (Join-Path $release 'EnsureSecurePython.ps1') '配布パッケージのPython準備スクリプト' | Out-Null
    Assert-RegularFile (Join-Path $release 'PrepareExistingUpdate.ps1') '配布パッケージの準備スクリプト' | Out-Null
    Assert-RegularFile (Join-Path $app 'release_manifest.json') '配布パッケージの release_manifest.json' | Out-Null
    $version = Read-VersionValue (Join-Path $app 'version.json') '配布パッケージの app/version.json'

    $hostDirectory = Assert-RegularDirectory (Join-Path $root 'updater\current\update_host') '配布パッケージの保護host'
    foreach ($name in @('__init__.py', 'contracts.py', 'transaction.py', 'trial.py', 'supervisor.py')) {
        Assert-RegularFile (Join-Path $hostDirectory $name) ('配布パッケージの保護host/{0}' -f $name) | Out-Null
    }
    $startText = Get-Content -LiteralPath $start -Raw -Encoding UTF8
    if ($startText -notmatch 'update_host\.supervisor') {
        throw '配布パッケージの Start.bat が保護された更新hostを起動しません。'
    }
    if ($startText -match '(?i)robocopy') {
        throw '配布パッケージの Start.bat に旧式の robocopy 更新が含まれています。'
    }
    return @{
        Root = $root
        App = $app
        Release = $release
        Start = $start
        Repair = $repair
        SecureLauncher = $secureLauncher
        Version = $version
    }
}

function Get-PidState {
    param([Parameter(Mandatory = $true)][int]$ProcessIdValue)

    if ($ProcessIdValue -le 0) { return 'unknown' }
    try {
        $process = Get-Process -Id $ProcessIdValue -ErrorAction Stop
        if ($null -eq $process) { return 'stale' }
        $details = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f $ProcessIdValue) -ErrorAction Stop
        if ($null -eq $details) { return 'stale' }
        $commandLine = [string]$details.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { return 'unknown' }
        if ($commandLine -notmatch '(?i)nexus_ark(\.py|\.exe)') { return 'unknown' }
        return 'running'
    }
    catch {
        # Windows PowerShell has emitted several exception types for a PID
        # that has already exited (including ProcessCommandException and
        # ArgumentException).  Distinguish those from access/query failures.
        $typeName = [string]$_.Exception.GetType().FullName
        $message = [string]$_.Exception.Message
        if ($typeName -match '(?i)(ProcessCommandException|ItemNotFoundException)' -or $message -match '(?i)(cannot find a process|no process with the process identifier|process identifier .* was not found|process .* not found)') {
            return 'stale'
        }
        return 'unknown'
    }
}

function Assert-NexusLockClear {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-SafePathOrAbsent $Path)) { return }
    Assert-RegularFile $Path 'app/nexus_ark.lock' | Out-Null
    try {
        $payload = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $processIdValue = 0
        if ($null -eq $payload.pid -or -not [int]::TryParse([string]$payload.pid, [ref]$processIdValue)) {
            throw 'PID がありません。'
        }
        $state = Get-PidState -ProcessIdValue $processIdValue
    }
    catch {
        throw 'app/nexus_ark.lock の形式または状態を確認できないため停止します。'
    }
    if ($state -eq 'running') {
        throw 'Nexus Ark が起動中です。終了してから再実行してください。'
    }
    if ($state -eq 'unknown') {
        throw 'app/nexus_ark.lock のPIDを安全に確認できないため停止します。'
    }
    # stale PID は旧アプリ自身が次回起動時に整理できるため削除しない。
}

function Assert-TargetProcessesStopped {
    param([Parameter(Mandatory = $true)][string]$Root)

    try {
        $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    }
    catch {
        throw '実行中プロセスを確認できないため停止します。'
    }
    $rootPrefix = (Get-NormalizedPath $Root).TrimEnd([char[]]@('\', '/'))
    # A supervisor command normally quotes --root when the path has spaces.
    # Treat that closing quote as a boundary while keeping `foo` distinct
    # from a sibling such as `foobar`.
    $rootPattern = [regex]::Escape($rootPrefix) + '(?:[\\/"'']|$)'
    $modulePattern = '(?i)(?:nexus_ark\.py|nexus_ark\.exe|update_host\.supervisor)'
    foreach ($process in $processes) {
        $name = [string]$process.Name
        $commandLine = [string]$process.CommandLine
        $executablePath = [string]$process.ExecutablePath
        $isNexusName = $name -match '(?i)^nexus_ark(\.exe)?$'
        if ($isNexusName -and [string]::IsNullOrWhiteSpace($commandLine)) {
            throw 'Nexus Ark の実行状態を確認できないため停止します。'
        }
        $commandTargetsRoot = $commandLine -match $rootPattern
        $executableTargetsRoot = $executablePath -match $rootPattern
        if (($commandTargetsRoot -or $executableTargetsRoot) -and [string]::IsNullOrWhiteSpace($commandLine)) {
            throw '選択したルートのプロセス詳細を確認できないため停止します。'
        }
        $isNexusModule = $commandLine -match $modulePattern
        if ($isNexusModule -and [string]::IsNullOrWhiteSpace($executablePath) -and -not $commandTargetsRoot) {
            throw 'Nexus Arkの実行元を確認できないため停止します。'
        }
        # Python launched from the selected root commonly receives a relative
        # `nexus_ark.py` command line.  Its executable path (for example
        # root/.venv/Scripts/python.exe) supplies the root boundary.  A
        # process from another root is ignored unless its command line names
        # this root explicitly.
        if (($commandTargetsRoot -or $executableTargetsRoot) -and $isNexusModule) {
            throw '選択したNexus Arkが起動中です。終了してから再実行してください。'
        }
    }
}

function Assert-TargetRoot {
    param([Parameter(Mandatory = $true)][string]$Root)

    $root = Assert-RegularDirectory $Root '選択したNexus Arkのルート'
    $app = Assert-RegularDirectory (Join-Path $root 'app') '選択したルートの app'
    $start = (Assert-RegularFile (Join-Path $root 'Start.bat') '選択したルートの Start.bat').FullName
    Assert-RegularFile (Join-Path $app 'version.json') '選択したルートの app/version.json' | Out-Null
    Assert-RegularFile (Join-Path $app 'nexus_ark.py') '選択したルートの app/nexus_ark.py' | Out-Null
    Assert-RegularFile (Join-Path $app 'pyproject.toml') '選択したルートの app/pyproject.toml' | Out-Null
    # July's public package has app/pyproject.toml but no uv.lock.  The
    # protected host can work with the package's existing dependency files;
    # uv.lock is therefore optional for this preflight.
    if (Test-SafePathOrAbsent (Join-Path $app 'uv.lock')) {
        Assert-RegularFile (Join-Path $app 'uv.lock') '選択したルートの app/uv.lock' | Out-Null
    }

    $startText = Get-Content -LiteralPath $start -Raw -Encoding UTF8
    $hasModernHost = $startText -match 'update_host\.supervisor' -and $startText -notmatch '(?i)robocopy'
    $current = Join-Path $root 'updater\current'
    if (Test-SafePathOrAbsent $current) {
        $hostDirectory = Assert-RegularDirectory (Join-Path $current 'update_host') '選択したルートの保護host'
        Assert-RegularFile (Join-Path $hostDirectory 'supervisor.py') '選択したルートの保護host/supervisor.py' | Out-Null
        if (-not $hasModernHost) {
            throw '保護hostがあるのに旧式のStart.batです。部分更新を推測せず停止します。'
        }
    }
    elseif ($hasModernHost) {
        throw '新版Start.batに必要な保護hostがありません。完全な配布物を確認してください。'
    }

    foreach ($optional in @(
        (Join-Path $root 'updater.next'),
        (Join-Path $root 'updater'),
        (Join-Path $root 'runtime'),
        (Join-Path $root 'metadata'),
        (Join-Path $root 'update_recovery'),
        (Join-Path $app 'config.json')
    )) {
        Test-SafePathOrAbsent $optional | Out-Null
    }
    foreach ($optionalDirectory in @(
        (Join-Path $root 'updater'),
        (Join-Path $root 'runtime'),
        (Join-Path $root 'metadata'),
        (Join-Path $root 'update_recovery')
    )) {
        if (Test-SafePathOrAbsent $optionalDirectory) {
            $optionalItem = Get-Item -LiteralPath $optionalDirectory -Force -ErrorAction Stop
            if (-not $optionalItem.PSIsContainer) {
                throw ('{0} がフォルダーではないため停止します。' -f $optionalDirectory)
            }
        }
    }
    $optionalConfig = Join-Path $app 'config.json'
    if (Test-SafePathOrAbsent $optionalConfig) {
        $optionalConfigItem = Get-Item -LiteralPath $optionalConfig -Force -ErrorAction Stop
        if ($optionalConfigItem.PSIsContainer) {
            throw '選択したルートの app/config.json がファイルではないため停止します。'
        }
    }
    if (Test-SafePathOrAbsent (Join-Path $root 'updater.next')) {
        throw 'updater.next が残っているため停止します。中断した更新を確認してください。'
    }
    if (Test-SafePathOrAbsent (Join-Path $root 'update_recovery\transaction.lock')) {
        throw '更新トランザクションが残っているため停止します。手動確認後に再実行してください。'
    }
    if (Test-SafePathOrAbsent (Join-Path $root 'update_recovery\bridge.lock')) {
        throw '更新bridgeが残っているため停止します。手動確認後に再実行してください。'
    }
    Assert-NexusLockClear (Join-Path $app 'nexus_ark.lock')
    Assert-TargetProcessesStopped $root
    return @{
        Root = $root
        App = $app
        Start = $start
        Version = Read-VersionValue (Join-Path $app 'version.json') '選択したルートの app/version.json'
    }
}

function Show-PreparationMessage {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [ValidateSet('Information', 'Warning', 'Error')][string]$Kind = 'Information',
        [ValidateSet('OK', 'YesNo')][string]$Buttons = 'OK'
    )

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $icon = [System.Windows.Forms.MessageBoxIcon]::$Kind
    $buttonValue = [System.Windows.Forms.MessageBoxButtons]::$Buttons
    $defaultButton = [System.Windows.Forms.MessageBoxDefaultButton]::Button1
    if ($Buttons -eq 'YesNo') { $defaultButton = [System.Windows.Forms.MessageBoxDefaultButton]::Button2 }
    if ($null -ne $script:PreparationProgress -and -not $script:PreparationProgress.Form.IsDisposed) {
        return [System.Windows.Forms.MessageBox]::Show($script:PreparationProgress.Form, $Text, 'Nexus Ark', $buttonValue, $icon, $defaultButton)
    }
    return [System.Windows.Forms.MessageBox]::Show($Text, 'Nexus Ark', $buttonValue, $icon, $defaultButton)
}

function Select-TargetRoot {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '更新する既存のNexus Arkフォルダーを選択してください。'
    $dialog.ShowNewFolderButton = $false
    try {
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
            return $null
        }
        return (Get-NormalizedPath $dialog.SelectedPath)
    }
    finally {
        $dialog.Dispose()
    }
}

function Confirm-BackupAndShutdown {
    param([string]$TargetRoot = '')
    $message = @"
対象: $TargetRoot

選択したNexus Arkを完全に終了し、起動中の更新処理がないことを確認してください。
また、選択したフォルダー全体のバックアップを別の場所へ取得済みであることを確認してください。

「はい」を押すと、公式ハッシュ固定のuv修復後に選択したフォルダーのStart.batを起動します。
このツールはバックアップを自動作成せず、既存フォルダーのファイルも書き換えません。
"@
    $result = Show-PreparationMessage -Text $message -Kind Warning -Buttons YesNo
    return ($result -eq [System.Windows.Forms.DialogResult]::Yes)
}

function ConvertTo-WindowsArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    # Windows paths cannot contain a double quote.  Always quote so Japanese,
    # spaces, and cmd metacharacters stay data for PowerShell's -File parser.
    return ('"{0}"' -f $Value.Replace('"', '\"'))
}

function Invoke-UvRepair {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Source,
        [Parameter(Mandatory = $false)][string]$LocalBin = (Join-Path $env:USERPROFILE '.local\bin')
    )

    $localBinFull = Get-NormalizedPath $LocalBin
    $powerShell = Join-Path $PSHOME 'powershell.exe'
    Assert-RegularFile $powerShell 'Windows PowerShell' | Out-Null
    Assert-RegularFile $Source.Repair 'uv修復スクリプト' | Out-Null
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (ConvertTo-WindowsArgument $Source.Repair),
        '-InstallDirectory', (ConvertTo-WindowsArgument $localBinFull)
    ) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $powerShell
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $Source.Root
    $oldPath = [string]$env:PATH
    $psi.EnvironmentVariables['PATH'] = $localBinFull + ';' + $oldPath
    $psi.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
    $process = [Diagnostics.Process]::Start($psi)
    if ($null -eq $process) { throw 'uv修復プロセスを起動できません。' }
    try {
        Wait-PreparationProcess -Process $process
        $exitCode = $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0) {
        throw ('uv修復が失敗しました（終了コード {0}）。' -f $exitCode)
    }

    # Verify the exact executable that the subsequent Start.bat will prefer;
    # do not resolve uv through the caller's PATH.
    $uv = Join-Path $localBinFull 'uv.exe'
    Assert-RegularFile $uv '修復後のlocalbin/uv.exe' | Out-Null
    $versionPsi = New-Object System.Diagnostics.ProcessStartInfo
    $versionPsi.FileName = $uv
    $versionPsi.Arguments = '--version'
    $versionPsi.UseShellExecute = $false
    $versionPsi.CreateNoWindow = $true
    $versionPsi.RedirectStandardOutput = $true
    $versionPsi.RedirectStandardError = $true
    $versionPsi.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
    $versionProcess = $null
    try {
        $versionProcess = [Diagnostics.Process]::Start($versionPsi)
        if ($null -eq $versionProcess) { throw 'uvのバージョン確認プロセスを起動できません。' }
        $versionStdout = $versionProcess.StandardOutput.ReadToEnd()
        $versionStderr = $versionProcess.StandardError.ReadToEnd()
        $versionProcess.WaitForExit()
        $versionExitCode = $versionProcess.ExitCode
    }
    finally {
        if ($null -ne $versionProcess) { $versionProcess.Dispose() }
    }
    $versionText = [string]$versionStdout + "`n" + [string]$versionStderr
    $uvVersionMatch = [regex]::Match($versionText, '(?m)^uv ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)')
    if ($versionExitCode -ne 0 -or -not $uvVersionMatch.Success -or [version]$uvVersionMatch.Groups[1].Value -lt [version]'0.13.4') {
        throw '修復後のlocalbin/uv.exeを検証できません。'
    }
    return $uv
}

function Invoke-SecureLauncherRefresh {
    param([hashtable]$Source, [hashtable]$Target)
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (ConvertTo-WindowsArgument $Source.SecureLauncher),
        '-TargetRoot', (ConvertTo-WindowsArgument $Target.Root),
        '-TemplatePath', (ConvertTo-WindowsArgument $Source.Start)
    ) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $PSHOME 'powershell.exe'
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($psi)
    if ($null -eq $process) { throw '起動設定の準備プロセスを開始できません。' }
    try {
        Wait-PreparationProcess -Process $process
        if ($process.ExitCode -ne 0) {
            throw '起動設定の安全な更新を確認できません。既存フォルダーとbackupを残して、表示内容をお知らせください。'
        }
    }
    finally { $process.Dispose() }
}

function Start-SelectedRoot {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Target,
        [Parameter(Mandatory = $false)][string]$LocalBin = (Join-Path $env:USERPROFILE '.local\bin')
    )

    # Do not trust a caller-provided ComSpec.  Resolve cmd.exe from the
    # Windows system directory, then pass only the fixed /d /c Start.bat
    # command; the selected root is supplied as the working directory.
    $comSpec = [IO.Path]::Combine([Environment]::SystemDirectory, 'cmd.exe')
    Assert-RegularFile $comSpec 'Windows cmd.exe' | Out-Null
    $localBinFull = Get-NormalizedPath $LocalBin
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $comSpec
    $psi.Arguments = '/d /c Start.bat'
    $psi.WorkingDirectory = $Target.Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    $psi.EnvironmentVariables['PATH'] = $localBinFull + ';' + [string]$env:PATH
    $process = [Diagnostics.Process]::Start($psi)
    if ($null -eq $process) { throw '選択したNexus Arkを起動できません。' }
    return $process
}

function Enter-PreparationMutex {
    param([Parameter(Mandatory = $true)][string]$Root)

    $normalizedRoot = Get-NormalizedPath $Root
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($normalizedRoot.ToUpperInvariant())
        $digest = $sha.ComputeHash($bytes)
    }
    finally {
        $sha.Dispose()
    }
    $suffix = (-join ($digest | ForEach-Object { $_.ToString('x2') }))
    $name = 'Local\NexusArk.Prepare.' + $suffix
    $createdNew = $false
    $mutex = [System.Threading.Mutex]::new($false, $name, [ref]$createdNew)
    if (-not $createdNew) {
        $mutex.Dispose()
        throw '同じNexus Arkの準備処理がすでに実行中です。完了を待ってから再実行してください。'
    }
    return $mutex
}

function Invoke-PreparedTarget {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Source,
        [Parameter(Mandatory = $true)][string]$TargetRoot
    )

    if (Test-SameOrNestedPath $Source.Root $TargetRoot) {
        throw '配布パッケージと選択した既存フォルダーが同一または内包関係にあるため停止します。'
    }
    $mutex = Enter-PreparationMutex $TargetRoot
    try {
        Set-PreparationStatus -Text '選択したフォルダーと、Nexus Arkが終了していることを確認しています…'
        $target = Assert-TargetRoot $TargetRoot
        Set-PreparationStatus -Text '停止とバックアップの確認画面で、内容をご確認ください。'
        if (-not (Confirm-BackupAndShutdown -TargetRoot $target.Root)) {
            Set-PreparationStatus -Text '準備を中止しました。Nexus Arkは起動していません。'
            return $false
        }
        Set-PreparationStatus -Text '更新用ツールと修正済みPythonを確認・準備しています。取得が必要な場合は数分かかることがあります。'
        Invoke-UvRepair $Source | Out-Null
        Set-PreparationStatus -Text '修正済みPythonで起動するため、停止中の起動設定を確認しています…'
        Invoke-SecureLauncherRefresh -Source $Source -Target $target
        # The user may have started the old application while the repair was
        # running.  Recheck both process and lock state immediately before
        # handing control to cmd.exe.
        Set-PreparationStatus -Text 'ツールの準備が終わりました。起動前の最終確認をしています…'
        Assert-NexusLockClear (Join-Path $target.App 'nexus_ark.lock')
        Assert-TargetProcessesStopped $target.Root
        Set-PreparationStatus -Text '最終確認が終わりました。今までのフォルダーからNexus Arkを起動しています…'
        Start-SelectedRoot $target | Out-Null
        if ($null -ne $script:PreparationProgress) {
            $script:PreparationProgress.Form.Text = 'Nexus Ark — 準備完了'
            $script:PreparationProgress.ProgressBar.Style = 'Continuous'
            $script:PreparationProgress.ProgressBar.Value = 100
            $script:PreparationProgress.Started.Stop()
            $script:PreparationProgress.NoteLabel.Text = "準備ツールの処理は完了です。起動後は、通常の画面から自動更新してください。`r`n今後も、今まで使っているフォルダーのStart.batから起動します。"
        }
        Set-PreparationStatus -Text '準備が完了しました。選択したNexus Arkの起動を開始しました。'
        $completeMessage = "準備が完了しました。今まで使っているNexus Arkの起動を開始しました。`r`n`r`n起動するフォルダー：`r`n$($target.Root)`r`n`r`n起動後、通常の画面から自動更新を実行してください。今後もこのフォルダーのStart.batを使います。"
        Show-PreparationMessage -Text $completeMessage -Kind Information -Buttons OK | Out-Null
        return $true
    }
    finally {
        if ($null -ne $mutex) {
            $mutex.Dispose()
        }
    }
}

function Invoke-PreparationMain {
    param([string]$PackageRoot = '')

    try {
        Set-PreparationStatus -Text '準備ツールを確認しています…'
        $source = Get-PackageSource -PackageRoot $PackageRoot
        Set-PreparationStatus -Text 'フォルダー選択画面で、今まで使っているNexus Arkフォルダーを選んでください。'
        $targetRoot = Select-TargetRoot
        if ([string]::IsNullOrWhiteSpace([string]$targetRoot)) {
            return 0
        }
        Open-PreparationProgress -TargetRoot $targetRoot
        Invoke-PreparedTarget -Source $source -TargetRoot $targetRoot | Out-Null
        return 0
    }
    catch {
        try {
            if ($null -ne $script:PreparationProgress) {
                $script:PreparationProgress.Form.Text = 'Nexus Ark — 準備を完了できませんでした'
                $script:PreparationProgress.ProgressBar.Style = 'Continuous'
                $script:PreparationProgress.Started.Stop()
                $script:PreparationProgress.NoteLabel.Text = "準備ツールはここで停止しています。表示された案内をご確認ください。`r`n準備が完了するまでは、本体の自動更新へ進まないでください。"
            }
            Set-PreparationStatus -Text '準備を完了できませんでした。表示された案内をご確認ください。'
            Show-PreparationMessage -Text $_.Exception.Message -Kind Error -Buttons OK | Out-Null
        }
        catch {
            Write-Error $_.Exception.Message
        }
        return 1
    }
    finally {
        Close-PreparationProgress
    }
}

if (-not $script:IsDotSourced) {
    exit (Invoke-PreparationMain)
}
