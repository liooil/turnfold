[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Programs\Turnfold"),
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA "Turnfold"),
    [string]$Listen = "127.0.0.1:3000",
    [string]$VaultKeyring = "default",
    [string]$TaskName = "Turnfold"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($VaultKeyring -notmatch '^[A-Za-z0-9._:-]{1,120}$') {
    throw "VaultKeyring contains unsupported characters."
}
foreach ($value in @($Listen, $InstallDirectory, $DataDirectory, $TaskName)) {
    if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) {
        throw "Arguments cannot contain quotes or newlines."
    }
}
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

$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourceExecutable = Join-Path $packageRoot "turnfold.exe"
$sourceStatic = Join-Path $packageRoot "dist"
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf)) {
    throw "turnfold.exe is missing from the package root."
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceStatic "index.html") -PathType Leaf)) {
    throw "dist/index.html is missing from the package root."
}

$InstallDirectory = Resolve-SafeDirectory -Path $InstallDirectory -Label "InstallDirectory"
$DataDirectory = Resolve-SafeDirectory -Path $DataDirectory -Label "DataDirectory"
if ($InstallDirectory -eq $DataDirectory -or
    (Test-NestedDirectory -Child $InstallDirectory -Parent $DataDirectory) -or
    (Test-NestedDirectory -Child $DataDirectory -Parent $InstallDirectory)) {
    throw "InstallDirectory and DataDirectory must not overlap."
}
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

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
    throw "The existing Turnfold process did not stop; application files were not replaced."
}

Copy-Item -LiteralPath $sourceExecutable -Destination $installedExecutable -Force
$installedStatic = Join-Path $InstallDirectory "dist"
if (Test-Path -LiteralPath $installedStatic) {
    Remove-Item -LiteralPath $installedStatic -Recurse -Force
}
Copy-Item -LiteralPath $sourceStatic -Destination $installedStatic -Recurse

$database = Join-Path $DataDirectory "turnfold.db"
$arguments = 'serve --listen "{0}" --database "{1}" --vault-keyring "{2}"' -f $Listen, $database, $VaultKeyring
$action = New-ScheduledTaskAction `
    -Execute $installedExecutable `
    -Argument $arguments `
    -WorkingDirectory $InstallDirectory
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Turnfold local-first runtime" `
    -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Turnfold was installed for $currentUser and started at http://$Listen/."
Write-Output "Database: $database"
Write-Output "Vault keyring entry: $VaultKeyring"
