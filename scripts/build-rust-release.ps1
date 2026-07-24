param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('windows-x64')][string]$AssetTarget
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleaseDir = Join-Path $Root 'release'
$StageName = "cartograph-$AssetTarget"
$Stage = Join-Path $ReleaseDir $StageName
$Archive = Join-Path $ReleaseDir "$StageName.zip"
$Binary = Join-Path $Root "target/$Target/release/cartograph.exe"

cargo build --locked --release --package cartograph-cli --target $Target
if ($LASTEXITCODE -ne 0) { throw 'cargo release build failed' }

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Stage, $Archive
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'bin') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'share/cartograph') | Out-Null
Copy-Item $Binary (Join-Path $Stage 'bin/cartograph.exe')
Copy-Item (Join-Path $Root 'LICENSE') (Join-Path $Stage 'LICENSE')
Copy-Item (Join-Path $Root 'README.md') (Join-Path $Stage 'README.md')
Copy-Item (Join-Path $Root 'ACKNOWLEDGEMENTS.md') (Join-Path $Stage 'ACKNOWLEDGEMENTS.md')
Copy-Item (Join-Path $Root 'docs/v2/LICENSING.md') (Join-Path $Stage 'share/cartograph/PARADEDB-NOTICE.md')

$Version = (& $Binary --version).Trim()
$Metadata = cargo metadata --no-deps --format-version 1 | ConvertFrom-Json
$ExpectedPackage = $Metadata.packages | Where-Object { $_.name -eq 'cartograph-cli' } | Select-Object -First 1
if (-not $ExpectedPackage) { throw 'cartograph-cli package missing from cargo metadata' }
$ExpectedVersion = "cartograph $($ExpectedPackage.version)"
if ($Version -ne $ExpectedVersion) {
  throw "release binary version mismatch: expected '$ExpectedVersion', got '$Version'"
}

$Help = (& $Binary --help) -join "`n"
foreach ($Command in @('index', 'status', 'find', 'context', 'graph', 'affected', 'serve', 'doctor', 'db')) {
  if ($Help -notmatch "(?m)^\s+$([regex]::Escape($Command))(\s|$)") {
    throw "release binary help is missing '$Command'"
  }
}

$ExpectedFiles = @(
  'ACKNOWLEDGEMENTS.md',
  'LICENSE',
  'README.md',
  'bin/cartograph.exe',
  'share/cartograph/PARADEDB-NOTICE.md'
)
$ActualFiles = Get-ChildItem -Recurse -File $Stage |
  ForEach-Object { $_.FullName.Substring($Stage.Length + 1).Replace('\', '/') } |
  Sort-Object
if (Compare-Object $ExpectedFiles $ActualFiles) {
  throw 'release archive allowlist mismatch'
}

$Tree = cargo tree --locked --workspace --all-features -e normal
if (($Tree -join "`n") -match '(?i)(^|[-_ ])(sqlite|libsqlite)') {
  throw 'Cartograph v2 release dependency graph contains SQLite'
}

Compress-Archive -Path $Stage -DestinationPath $Archive -Force
Write-Host "[rust-release] wrote $Archive ($Version)"
