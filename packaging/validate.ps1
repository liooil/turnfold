[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$failed = $false
Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -Filter '*.ps1' | ForEach-Object {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $_.FullName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    foreach ($errorRecord in $errors) {
        $failed = $true
        Write-Error -ErrorAction Continue "$($_.FullName):$($errorRecord.Extent.StartLineNumber): $($errorRecord.Message)"
    }
}

Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -Filter '*.plist' | ForEach-Object {
    [xml](Get-Content -LiteralPath $_.FullName -Raw) | Out-Null
}

$shell = Get-Command bash -ErrorAction SilentlyContinue
if ($null -ne $shell) {
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $scripts = Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -Filter '*.sh' |
        ForEach-Object {
            [System.IO.Path]::GetRelativePath($repositoryRoot, $_.FullName).Replace('\', '/')
        }
    if (@($scripts).Count -gt 0) {
        Push-Location $repositoryRoot
        try {
            & $shell.Source -n @scripts
            if ($LASTEXITCODE -ne 0) {
                $failed = $true
                Write-Error -ErrorAction Continue "bash syntax validation failed."
            }
        } finally {
            Pop-Location
        }
    }
}

if ($failed) {
    exit 1
}

Write-Output "Packaging scripts are syntactically valid."
