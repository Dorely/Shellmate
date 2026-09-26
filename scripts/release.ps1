param(
  [string]$ExpectedTag = ""
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repositoryRoot
try {
  $changes = @(git status --porcelain)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the Git working tree."
  }
  if ($changes.Count -gt 0) {
    throw "Release must start from a clean Git working tree. Commit or stash changes first."
  }

  $version = node -p "require('./package.json').version"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read the package version."
  }
  if ($ExpectedTag -and $ExpectedTag -ne "v$version") {
    throw "Tag $ExpectedTag does not match package version $version. Expected v$version."
  }

  npm run typecheck
  if ($LASTEXITCODE -ne 0) {
    throw "Typecheck failed."
  }

  # A running Shellmate (or Explorer preview) can lock release/win-unpacked/resources/app.asar.
  if (Test-Path "release") {
    try {
      Remove-Item -Recurse -Force "release"
    }
    catch {
      throw "Unable to clear release/. Close any running Shellmate from release/win-unpacked and try again."
    }
  }

  npm run package
  if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed."
  }

  $installer = Join-Path "release" "Shellmate-Setup-$version.exe"
  if (-not (Test-Path $installer)) {
    throw "Expected installer $installer was not produced."
  }

  $hash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLower()
  "$hash  Shellmate-Setup-$version.exe" | Out-File -Encoding ascii "$installer.sha256"
  Write-Output "Release ready: $installer"
}
finally {
  Pop-Location
}
