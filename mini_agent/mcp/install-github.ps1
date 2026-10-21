$ErrorActionPreference = "Stop"
$version = "2.0.2"
$architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    "X64" { "x86_64" }
    "Arm64" { "arm64" }
    "X86" { "i386" }
    default { throw "Unsupported Windows architecture" }
}
$destination = Join-Path $PSScriptRoot "..\.local\github-mcp-server\v$version"
$asset = "github-mcp-server_Windows_$architecture.zip"
$archive = Join-Path $destination $asset
$checksums = Join-Path $destination "checksums.txt"
$baseUrl = "https://github.com/github/github-mcp-server/releases/download/v$version"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/github-mcp-server_${version}_checksums.txt" -OutFile $checksums
    $matching = @(Get-Content -LiteralPath $checksums | Where-Object { ($_ -split "\s+")[-1] -eq $asset })
    if ($matching.Count -ne 1) { throw "Official checksum entry missing or ambiguous for $asset" }
    $expected = ($matching[0] -split "\s+")[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw "SHA256 checksum mismatch for $asset"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
    $executable = Join-Path $destination "github-mcp-server.exe"
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Official server executable missing from archive" }
    & $executable --version
    if ($LASTEXITCODE -ne 0) { throw "Official server version check failed" }
    Write-Output "Installed checksum-verified official GitHub MCP server to $executable"
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    if (Test-Path -LiteralPath $checksums) { Remove-Item -LiteralPath $checksums }
}
