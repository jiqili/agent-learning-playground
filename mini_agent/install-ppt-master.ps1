param(
    [string]$Destination = (Join-Path $PSScriptRoot "skill\ppt-master")
)

$ErrorActionPreference = "Stop"
$revision = "604ecdec8dd6a0405e1abdb49565430902373276"
$repository = "https://github.com/hugohe3/ppt-master.git"
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$requiredFiles = @("SKILL.md", "LICENSE", "requirements.txt", "scripts\svg_to_pptx.py")

function Assert-Package([string]$Directory) {
    foreach ($file in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $file) -PathType Leaf)) {
            throw "Incomplete PPT Master package: missing $file in $Directory. Move the incomplete directory aside and retry."
        }
    }
}

function Invoke-Git([string[]]$GitArguments) {
    & git @GitArguments
    if ($LASTEXITCODE -ne 0) {
        throw "PPT Master download failed: git $($GitArguments -join ' ') (exit $LASTEXITCODE)"
    }
}

if (Test-Path -LiteralPath $destinationPath) {
    Assert-Package $destinationPath
    Write-Output "[skills] Reusing local PPT Master: $destinationPath"
    exit 0
}

Get-Command git -ErrorAction Stop | Out-Null
$parent = Split-Path -Parent $destinationPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$temporary = Join-Path $parent (".ppt-master-download-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    Write-Output "[skills] Downloading official PPT Master at $revision..."
    Invoke-Git @("-C", $temporary, "init", "--quiet")
    Invoke-Git @("-C", $temporary, "remote", "add", "origin", $repository)
    Invoke-Git @("-C", $temporary, "-c", "core.longpaths=true", "fetch", "--depth=1", "origin", $revision)
    Invoke-Git @("-C", $temporary, "-c", "core.longpaths=true", "-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", "FETCH_HEAD")
    $actual = & git -C $temporary rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $actual -ne $revision) {
        throw "PPT Master revision verification failed"
    }
    $package = Join-Path $temporary "skills\ppt-master"
    Assert-Package $package
    if (Test-Path -LiteralPath $destinationPath) {
        throw "PPT Master destination appeared during download; refusing to overwrite $destinationPath"
    }
    Move-Item -LiteralPath $package -Destination $destinationPath
    Write-Output "[skills] Installed PPT Master 6.7.2: $destinationPath"
} finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
}
