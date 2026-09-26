# Regenerates the Windows icon and the renderer logo from the 1024px master
# at build/icon.png. Requires ImageMagick 7 (`magick`) on PATH.
$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repositoryRoot
try {
  if (-not (Get-Command magick -ErrorAction SilentlyContinue)) {
    throw "ImageMagick 7 (magick) is required to build icons."
  }
  $master = "build/icon.png"
  if (-not (Test-Path $master)) {
    throw "Missing master icon $master."
  }

  magick $master -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to write build/icon.ico."
  }

  New-Item -ItemType Directory -Force -Path "src/renderer/assets" | Out-Null
  magick $master -resize 128x128 -strip src/renderer/assets/logo.png
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to write src/renderer/assets/logo.png."
  }

  Write-Output "Icons written: build/icon.ico, src/renderer/assets/logo.png"
}
finally {
  Pop-Location
}
