[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$OutputDirectory = "release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Target -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Target contains unsupported characters."
}
if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Version contains unsupported characters."
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory))
}
$packageName = "turnfold-$Version-$Target"
$staging = Join-Path $outputRoot $packageName
$executableName = if ($Target -like '*windows*') { "turnfold.exe" } else { "turnfold" }
$executable = Join-Path $repositoryRoot "target/$Target/release/$executableName"
$staticDirectory = Join-Path $repositoryRoot "dist"

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Built executable is missing: $executable"
}
if (-not (Test-Path -LiteralPath (Join-Path $staticDirectory "index.html") -PathType Leaf)) {
    throw "Built web application is missing: $staticDirectory"
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item -LiteralPath $executable -Destination (Join-Path $staging $executableName)
Copy-Item -LiteralPath $staticDirectory -Destination (Join-Path $staging "dist") -Recurse
Copy-Item -LiteralPath (Join-Path $repositoryRoot "LICENSE") -Destination $staging
Copy-Item -LiteralPath (Join-Path $repositoryRoot "README.md") -Destination $staging
Copy-Item -LiteralPath (Join-Path $repositoryRoot "README.zh-CN.md") -Destination $staging
Copy-Item -LiteralPath (Join-Path $repositoryRoot "docs/local-service.md") -Destination $staging

$serviceSource = if ($Target -like '*windows*') {
    Join-Path $repositoryRoot "packaging/windows"
} elseif ($Target -like '*linux*') {
    Join-Path $repositoryRoot "packaging/linux"
} elseif ($Target -like '*darwin*') {
    Join-Path $repositoryRoot "packaging/macos"
} else {
    throw "No service package is defined for target $Target"
}
Copy-Item -LiteralPath $serviceSource -Destination (Join-Path $staging "service") -Recurse

if ($Target -notlike '*windows*') {
    & chmod 755 (Join-Path $staging $executableName)
    Get-ChildItem -LiteralPath (Join-Path $staging "service") -Filter '*.sh' |
        ForEach-Object { & chmod 755 $_.FullName }
}

if ($Target -like '*windows*') {
    $archive = "$staging.zip"
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
    Compress-Archive -LiteralPath $staging -DestinationPath $archive -CompressionLevel Optimal
} else {
    $archive = "$staging.tar.gz"
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
    & tar -C $outputRoot -czf $archive $packageName
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed with exit code $LASTEXITCODE"
    }
}

$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$checksum = "$archive.sha256"
Set-Content `
    -LiteralPath $checksum `
    -Value "$archiveHash  $([System.IO.Path]::GetFileName($archive))" `
    -NoNewline
Remove-Item -LiteralPath $staging -Recurse -Force
Write-Output $archive
Write-Output $checksum
