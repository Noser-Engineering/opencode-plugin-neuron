$ErrorActionPreference = "Stop"

$Repo = "Noser-Engineering/opencode-plugin-neuron"

$archRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($archRaw) {
    "AMD64" { $arch = "x64" }
    "ARM64" { $arch = "arm64" }
    default {
        Write-Error "Unsupported architecture '$archRaw'. Use 'npx @noser-engineering/opencode-plugin-neuron setup' instead."
        exit 1
    }
}

$asset = "opencode-neuron-windows-$arch.exe"
$url = "https://github.com/$Repo/releases/latest/download/$asset"
$installDir = if ($env:OPENCODE_NEURON_INSTALL_DIR) { $env:OPENCODE_NEURON_INSTALL_DIR } else { "$env:LOCALAPPDATA\opencode-neuron" }
$targetPath = Join-Path $installDir "opencode-neuron.exe"

Write-Host "==> downloading $asset"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$tmpPath = "$targetPath.tmp"
Invoke-WebRequest -Uri $url -OutFile $tmpPath
Move-Item -Force -Path $tmpPath -Destination $targetPath

Write-Host "==> installed to $targetPath"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" -contains $installDir)) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
    Write-Host "==> added $installDir to your User PATH — restart your terminal for it to take effect"
}

Write-Host "==> run: opencode-neuron setup"
