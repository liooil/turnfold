[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Programs\Turnfold"),
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA "Turnfold"),
    [string]$TaskName = "Turnfold",
    [switch]$RemoveApplication,
    [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,128}$') {
    throw "TaskName contains unsupported characters."
}

function Resolve-SafeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $root = [System.IO.Path]::GetPathRoot($resolved).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ([string]::IsNullOrWhiteSpace($resolved) -or $resolved -eq $root) {
        throw "$Label must not be a filesystem root."
    }
    return $resolved
}

function Test-NestedDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Child,
        [Parameter(Mandatory = $true)]
        [string]$Parent
    )

    $prefix = $Parent + [System.IO.Path]::DirectorySeparatorChar
    return $Child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

$InstallDirectory = Resolve-SafeDirectory -Path $InstallDirectory -Label "InstallDirectory"
$DataDirectory = Resolve-SafeDirectory -Path $DataDirectory -Label "DataDirectory"
if ($InstallDirectory -eq $DataDirectory -or
    (Test-NestedDirectory -Child $InstallDirectory -Parent $DataDirectory) -or
    (Test-NestedDirectory -Child $DataDirectory -Parent $InstallDirectory)) {
    throw "InstallDirectory and DataDirectory must not overlap."
}
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if ($RemoveApplication) {
    $installedExecutable = Join-Path $InstallDirectory "turnfold.exe"
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $running = Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and
            [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $installedExecutable
        }
        if ($null -eq $running) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -ne $running) {
        throw "The existing Turnfold process did not stop; application files were preserved."
    }
}
if ($RemoveApplication -and (Test-Path -LiteralPath $InstallDirectory)) {
    Remove-Item -LiteralPath $InstallDirectory -Recurse -Force
}
if ($RemoveData -and (Test-Path -LiteralPath $DataDirectory)) {
    Remove-Item -LiteralPath $DataDirectory -Recurse -Force
}

Write-Output "Turnfold scheduled task removed. The OS keyring entry was preserved; the database was preserved unless -RemoveData was supplied."
