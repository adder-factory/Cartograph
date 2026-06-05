$ErrorActionPreference = 'Stop'

$repo = if ($env:CARTOGRAPH_REPO) { $env:CARTOGRAPH_REPO } else { 'adder-factory/cartograph' }
$installDir = if ($env:CARTOGRAPH_INSTALL_DIR) { $env:CARTOGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'cartograph-cli' }

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$target = "win32-$arch"

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
