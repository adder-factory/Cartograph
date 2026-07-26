param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('windows-x64')][string]$AssetTarget
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'windows-rust-release-paths.ps1')

$RunnerTemp = $env:RUNNER_TEMP
$OriginalCargoHome = $env:CARGO_HOME
$OriginalTemporaryDirectory = $env:TEMP
$OriginalAlternateTemporaryDirectory = $env:TMP
$env:CARGO_TARGET_DIR = Join-Path $Root 'target'
$ReleaseDir = Join-Path $Root 'release'
$StagingRoot = Join-Path $ReleaseDir '.staging'
$StageName = "cartograph-$AssetTarget"
$Stage = Join-Path $StagingRoot $StageName
$Archive = Join-Path $ReleaseDir "$StageName.zip"
$Direct = Join-Path $ReleaseDir "$StageName.exe"
$Binary = Join-Path $env:CARGO_TARGET_DIR 'release/cartograph.exe'

$HostTarget = Get-RustHostTarget
if ($HostTarget -cne $Target) {
  throw "Windows release builds must run natively on $Target; runner host is $HostTarget"
}

$PrivateEnvironmentRoots = @(
  [PSCustomObject]@{ Label = 'repository root'; Value = $Root },
  [PSCustomObject]@{ Label = 'Cargo target directory'; Value = $env:CARGO_TARGET_DIR },
  [PSCustomObject]@{ Label = 'GitHub workspace'; Value = $env:GITHUB_WORKSPACE },
  [PSCustomObject]@{ Label = 'GitHub runner workspace'; Value = $env:RUNNER_WORKSPACE },
  [PSCustomObject]@{ Label = 'GitHub runner temporary directory'; Value = $env:RUNNER_TEMP },
  [PSCustomObject]@{ Label = 'GitHub runner tool cache'; Value = $env:RUNNER_TOOL_CACHE },
  [PSCustomObject]@{ Label = 'Windows user profile'; Value = $env:USERPROFILE },
  [PSCustomObject]@{ Label = 'home directory'; Value = $env:HOME },
  [PSCustomObject]@{ Label = 'original Cargo home'; Value = $OriginalCargoHome },
  [PSCustomObject]@{ Label = 'Rustup home'; Value = $env:RUSTUP_HOME },
  [PSCustomObject]@{ Label = 'original temporary directory'; Value = $OriginalTemporaryDirectory },
  [PSCustomObject]@{ Label = 'original alternate temporary directory'; Value = $OriginalAlternateTemporaryDirectory },
  [PSCustomObject]@{ Label = 'local application data'; Value = $env:LOCALAPPDATA },
  [PSCustomObject]@{ Label = 'roaming application data'; Value = $env:APPDATA }
)
$StaticPrivateRoots = @(
  [PSCustomObject]@{ Label = 'Windows user profile root'; Value = 'C:\Users\' },
  [PSCustomObject]@{ Label = 'Unix user profile root'; Value = '/Users/' },
  [PSCustomObject]@{ Label = 'GitHub Windows runner root'; Value = 'D:\a\' },
  [PSCustomObject]@{ Label = 'GitHub Windows runner root'; Value = 'C:\a\' },
  [PSCustomObject]@{ Label = 'GitHub Unix runner root'; Value = '/home/runner/work/' }
)

# Passing --target for a native Windows build prevents Cargo from applying
# CARGO_ENCODED_RUSTFLAGS to host build scripts and proc macros. Build natively
# so every Rust compiler invocation receives both Windows path spellings.
$AuditedEnvironmentRoots = $PrivateEnvironmentRoots
if (-not [string]::IsNullOrWhiteSpace($RunnerTemp)) {
  # Some native/vendor objects retain their registry or compiler scratch root
  # even after compiler path remapping. Keep those tool-owned paths stable and
  # outside every user-, repository-, and runner-specific directory.
  $BuildEnvironment = Initialize-NonPrivateReleaseBuildEnvironment `
    -TemporaryPath $RunnerTemp `
    -AssetTarget $AssetTarget `
    -PrivateRoots $PrivateEnvironmentRoots
  $AuditedEnvironmentRoots = @($BuildEnvironment.PrivateRoots)
} else {
  Set-PrivateBuildPathRemapping -Roots @(
    $PrivateEnvironmentRoots |
      ForEach-Object { [string]$_.Value } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
}

cargo build --locked --release --package cartograph-cli
if ($LASTEXITCODE -ne 0) { throw 'cargo release build failed' }

# Audit the exact tag-built executable before either published artifact is made.
# Read all three common encodings because Windows toolchains can retain both
# narrow and wide path strings in PE files.
Assert-NoPrivateBuildRoots -Path $Binary -PrivateRoots @($AuditedEnvironmentRoots + $StaticPrivateRoots)

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Stage, $Archive, $Direct
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
foreach ($Command in @('index', 'status', 'find', 'context', 'graph', 'affected', 'review', 'install', 'uninstall', 'serve', 'doctor', 'db')) {
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
Copy-Item $Binary $Direct
$DirectVersion = (& $Direct --version).Trim()
if ($DirectVersion -ne $ExpectedVersion) {
  throw "direct release binary version mismatch: expected '$ExpectedVersion', got '$DirectVersion'"
}
Write-Host "[rust-release] wrote $Archive and $Direct ($Version)"
