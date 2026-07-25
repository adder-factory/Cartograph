param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('windows-x64')][string]$AssetTarget
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleaseDir = Join-Path $Root 'release'
$StagingRoot = Join-Path $ReleaseDir '.staging'
$StageName = "cartograph-$AssetTarget"
$Stage = Join-Path $StagingRoot $StageName
$Archive = Join-Path $ReleaseDir "$StageName.zip"
$Direct = Join-Path $ReleaseDir "$StageName.exe"
$Binary = Join-Path $Root "target/$Target/release/cartograph.exe"

# Rust panic locations and vendored C/C++ grammar diagnostics retain source
# paths unless both toolchains are remapped. The PE audit below verifies that
# none of these runner-owned roots survive in either published artifact.
function Add-EncodedRustFlag {
  param([Parameter(Mandatory = $true)][string]$Flag)

  $Separator = [char]0x1f
  if ([string]::IsNullOrWhiteSpace($env:CARGO_ENCODED_RUSTFLAGS)) {
    $env:CARGO_ENCODED_RUSTFLAGS = $Flag
  } else {
    $env:CARGO_ENCODED_RUSTFLAGS += "$Separator$Flag"
  }
}

function Add-CompilerFlag {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Flag
  )

  $Current = [Environment]::GetEnvironmentVariable($Name)
  $Next = if ([string]::IsNullOrWhiteSpace($Current)) { $Flag } else { "$Current $Flag" }
  [Environment]::SetEnvironmentVariable($Name, $Next)
}

if ([string]::IsNullOrWhiteSpace($env:CARGO_ENCODED_RUSTFLAGS) -and
    -not [string]::IsNullOrWhiteSpace($env:RUSTFLAGS)) {
  foreach ($InheritedFlag in ($env:RUSTFLAGS -split '\s+' | Where-Object { $_ })) {
    Add-EncodedRustFlag -Flag $InheritedFlag
  }
}
$env:RUSTFLAGS = $null

$RemapRoots = @(
  $Root,
  $env:GITHUB_WORKSPACE,
  $env:RUNNER_WORKSPACE,
  $env:USERPROFILE,
  $env:HOME,
  $env:CARGO_HOME,
  $env:RUSTUP_HOME
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
foreach ($RemapRoot in $RemapRoots) {
  Add-EncodedRustFlag -Flag "--remap-path-prefix=$RemapRoot=."
  Add-CompilerFlag -Name 'CFLAGS' -Flag "/pathmap:$RemapRoot=."
  Add-CompilerFlag -Name 'CXXFLAGS' -Flag "/pathmap:$RemapRoot=."
}

function Assert-NoPrivateBuildRoots {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Bytes = [System.IO.File]::ReadAllBytes($Path)
  $Ascii = [System.Text.Encoding]::ASCII.GetString($Bytes)
  $Utf16Le = [System.Text.Encoding]::Unicode.GetString($Bytes)
  $Utf16Be = [System.Text.Encoding]::BigEndianUnicode.GetString($Bytes)
  $PrivateRoots = @(
    [PSCustomObject]@{ Label = 'repository root'; Value = $Root },
    [PSCustomObject]@{ Label = 'GitHub workspace'; Value = $env:GITHUB_WORKSPACE },
    [PSCustomObject]@{ Label = 'GitHub runner workspace'; Value = $env:RUNNER_WORKSPACE },
    [PSCustomObject]@{ Label = 'Windows user profile'; Value = $env:USERPROFILE },
    [PSCustomObject]@{ Label = 'home directory'; Value = $env:HOME },
    [PSCustomObject]@{ Label = 'Cargo home'; Value = $env:CARGO_HOME },
    [PSCustomObject]@{ Label = 'Rustup home'; Value = $env:RUSTUP_HOME },
    [PSCustomObject]@{ Label = 'Windows user profile root'; Value = 'C:\Users\' },
    [PSCustomObject]@{ Label = 'Unix user profile root'; Value = '/Users/' },
    [PSCustomObject]@{ Label = 'GitHub Windows runner root'; Value = 'D:\a\' },
    [PSCustomObject]@{ Label = 'GitHub Windows runner root'; Value = 'C:\a\' },
    [PSCustomObject]@{ Label = 'GitHub Unix runner root'; Value = '/home/runner/work/' }
  )

  foreach ($PrivateRoot in $PrivateRoots) {
    $Value = [string]$PrivateRoot.Value
    if ([string]::IsNullOrWhiteSpace($Value)) { continue }

    $Fragments = @(
      $Value,
      $Value.Replace('\', '/'),
      $Value.Replace('/', '\')
    ) | Select-Object -Unique
    foreach ($Fragment in $Fragments) {
      $ContainsFragment =
        $Ascii.IndexOf($Fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $Utf16Le.IndexOf($Fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $Utf16Be.IndexOf($Fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      if ($ContainsFragment) {
        throw "release binary contains a private build-root fragment ($($PrivateRoot.Label))"
      }
    }
  }
}

cargo build --locked --release --package cartograph-cli --target $Target
if ($LASTEXITCODE -ne 0) { throw 'cargo release build failed' }

# Audit the exact tag-built executable before either published artifact is made.
# Read all three common encodings because Windows toolchains can retain both
# narrow and wide path strings in PE files.
Assert-NoPrivateBuildRoots -Path $Binary

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
