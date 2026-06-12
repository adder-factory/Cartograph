$ErrorActionPreference = 'Stop'

$repo = if ($env:CARTOGRAPH_REPO) { $env:CARTOGRAPH_REPO } else { 'adder-factory/cartograph' }
$installDir = if ($env:CARTOGRAPH_INSTALL_DIR) { $env:CARTOGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'cartograph-cli' }

# Only 64-bit x64 builds are published; Windows-on-ARM runs them via the
# built-in x64 emulation.
$target = 'windows-x64'

$version = $env:CARTOGRAPH_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
if (-not $version) { throw 'cartograph: could not resolve latest release; set CARTOGRAPH_VERSION.' }
if (-not $version.StartsWith('v')) { $version = "v$version" }

$url = "https://github.com/$repo/releases/download/$version/cartograph-$target.zip"
$tmp = Join-Path $env:TEMP ("cartograph-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'cartograph.zip'

Write-Host "Installing Cartograph $version ($target)..."
Invoke-WebRequest -Uri $url -OutFile $zip

# Verify the archive against the release's SHA256SUMS before extracting an
# executable. Set CARTOGRAPH_SKIP_CHECKSUM=1 to bypass (not recommended).
if ($env:CARTOGRAPH_SKIP_CHECKSUM -ne '1') {
  $sumsUrl = "https://github.com/$repo/releases/download/$version/SHA256SUMS"
  $sumsPath = Join-Path $tmp 'SHA256SUMS'
  try {
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath
  } catch {
    throw "cartograph: could not fetch SHA256SUMS for verification ($sumsUrl). Set CARTOGRAPH_SKIP_CHECKSUM=1 to install without verification."
  }
  $assetName = "cartograph-$target.zip"
  $expectedLine = Get-Content $sumsPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
  if (-not $expectedLine) { throw "cartograph: no checksum for $assetName in SHA256SUMS." }
  $expected = ($expectedLine -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
  if ($expected -ne $actual) {
    throw "cartograph: CHECKSUM MISMATCH - refusing to install.`n  expected $expected`n  actual   $actual"
  }
  Write-Host 'Verified checksum.'
}

$dest = Join-Path $installDir 'current'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force

$inner = Join-Path $dest "cartograph-$target"
if (Test-Path $inner) {
  Get-ChildItem -Force $inner | Move-Item -Destination $dest -Force
  Remove-Item -Recurse -Force $inner
}
Remove-Item -Recurse -Force $tmp

$binDir = Join-Path $dest 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your PATH. Restart your terminal to pick it up."
}

Write-Host "Installed to $dest"
Write-Host 'Run: cartograph --help'
Write-Host ''
Write-Host 'Agent-friendly project setup:'
Write-Host '  cd /path/to/your/project'
Write-Host '  cartograph install --yes --location=local'
Write-Host '  cartograph status --verbose'
