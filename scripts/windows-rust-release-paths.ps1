function Get-RustHostTarget {
  $HostOutput = @(& rustc --print host-tuple 2>&1)
  $RustcExitCode = $LASTEXITCODE
  if ($RustcExitCode -ne 0 -or $HostOutput.Count -ne 1) {
    throw 'could not determine the release runner Rust host target'
  }
  $HostTarget = ([string]$HostOutput[0]).Trim()
  if ($HostTarget -cnotmatch '^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+)+$') {
    throw 'could not determine the release runner Rust host target'
  }
  return $HostTarget
}

function Get-NonPrivateReleaseBuildRoot {
  param(
    [Parameter(Mandatory = $true)][string]$TemporaryPath,
    [Parameter(Mandatory = $true)][string]$AssetTarget
  )

  $VolumeRoot = [System.IO.Path]::GetPathRoot($TemporaryPath)
  if ([string]::IsNullOrWhiteSpace($VolumeRoot) -or
      $AssetTarget -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
    throw 'could not determine a non-private release build root'
  }
  return Join-Path $VolumeRoot "cartograph-release-build-$AssetTarget"
}

function Initialize-NonPrivateReleaseBuildEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$TemporaryPath,
    [Parameter(Mandatory = $true)][string]$AssetTarget,
    [Parameter(Mandatory = $true)][object[]]$PrivateRoots
  )

  $ReleaseBuildRoot = Get-NonPrivateReleaseBuildRoot `
    -TemporaryPath $TemporaryPath `
    -AssetTarget $AssetTarget
  $CargoHome = Join-Path $ReleaseBuildRoot 'cargo-home'
  $CompilerTemporaryDirectory = Join-Path $ReleaseBuildRoot 'temp'
  New-Item -ItemType Directory -Force -Path @($CargoHome, $CompilerTemporaryDirectory) | Out-Null
  $env:CARGO_HOME = $CargoHome
  $env:TEMP = $CompilerTemporaryDirectory
  $env:TMP = $CompilerTemporaryDirectory

  $PrivateValues = @(
    $PrivateRoots |
      ForEach-Object { [string]$_.Value } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  $RemappingRoots = @($PrivateValues + $ReleaseBuildRoot)
  Set-ReleaseBuildPathRemapping -Roots $RemappingRoots
  $AuditRoots = @($PrivateRoots) + @(
    [PSCustomObject]@{
      Label = 'isolated release build root'
      Value = $ReleaseBuildRoot
    }
  )

  return [PSCustomObject]@{
    Root = $ReleaseBuildRoot
    CargoHome = $CargoHome
    TemporaryDirectory = $CompilerTemporaryDirectory
    RemappingRoots = @($RemappingRoots)
    PrivateRoots = @($PrivateRoots)
    AuditRoots = @($AuditRoots)
  }
}

function Add-CargoEncodedRustFlag {
  param([Parameter(Mandatory = $true)][string]$Flag)

  $Separator = [char]0x1f
  if ([string]::IsNullOrWhiteSpace($env:CARGO_ENCODED_RUSTFLAGS)) {
    $env:CARGO_ENCODED_RUSTFLAGS = $Flag
  } else {
    $env:CARGO_ENCODED_RUSTFLAGS += "$Separator$Flag"
  }
}

function Add-NativeCompilerFlag {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Flag
  )

  $Current = [Environment]::GetEnvironmentVariable($Name)
  $Next = if ([string]::IsNullOrWhiteSpace($Current)) { $Flag } else { "$Current $Flag" }
  [Environment]::SetEnvironmentVariable($Name, $Next)
}

function Get-ReleasePathSpellings {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Spellings = @()
  $SeparatorForms = @($Path, $Path.Replace('\', '/'), $Path.Replace('/', '\'))
  foreach ($SeparatorForm in $SeparatorForms) {
    $Candidates = @($SeparatorForm)
    if ($SeparatorForm -match '^[A-Za-z]:') {
      $Candidates += [char]::ToLowerInvariant($SeparatorForm[0]) + $SeparatorForm.Substring(1)
      $Candidates += [char]::ToUpperInvariant($SeparatorForm[0]) + $SeparatorForm.Substring(1)
    }
    foreach ($Candidate in $Candidates) {
      if (-not [string]::IsNullOrWhiteSpace($Candidate) -and $Spellings -cnotcontains $Candidate) {
        $Spellings += $Candidate
      }
    }
  }
  return $Spellings
}

function Set-ReleaseBuildPathRemapping {
  param([Parameter(Mandatory = $true)][string[]]$Roots)

  if ([string]::IsNullOrWhiteSpace($env:CARGO_ENCODED_RUSTFLAGS) -and
      -not [string]::IsNullOrWhiteSpace($env:RUSTFLAGS)) {
    foreach ($InheritedFlag in ($env:RUSTFLAGS -split '\s+' | Where-Object { $_ })) {
      Add-CargoEncodedRustFlag -Flag $InheritedFlag
    }
  }
  $env:RUSTFLAGS = $null

  $Spellings = @()
  foreach ($Root in $Roots) {
    if ([string]::IsNullOrWhiteSpace($Root)) { continue }
    foreach ($Spelling in (Get-ReleasePathSpellings -Path $Root)) {
      if ($Spellings -cnotcontains $Spelling) {
        $Spellings += $Spelling
      }
    }
  }

  # /d1trimfile rewrites MSVC __FILE__ literals while /pathmap rewrites debug
  # records. Both are required: native dependencies can retain source paths in
  # release executables even when Rust path-prefix remapping is complete.
  foreach ($Spelling in $Spellings) {
    Add-CargoEncodedRustFlag -Flag "--remap-path-prefix=$Spelling=."
    Add-NativeCompilerFlag -Name 'CFLAGS' -Flag "/pathmap:$Spelling=."
    Add-NativeCompilerFlag -Name 'CXXFLAGS' -Flag "/pathmap:$Spelling=."
    Add-NativeCompilerFlag -Name 'CFLAGS' -Flag "/d1trimfile:$Spelling"
    Add-NativeCompilerFlag -Name 'CXXFLAGS' -Flag "/d1trimfile:$Spelling"
  }

  # rustc cannot rewrite paths that link.exe writes into the PE debug record.
  # Keep only the PDB basename in the executable, independent of the runner.
  Add-CargoEncodedRustFlag -Flag '-Clink-arg=/PDBALTPATH:%_PDB%'
}

function Assert-NoReleaseBuildRoots {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object[]]$Roots
  )

  $Bytes = [System.IO.File]::ReadAllBytes($Path)
  $Views = @(
    [PSCustomObject]@{ Label = 'ASCII'; Text = [System.Text.Encoding]::ASCII.GetString($Bytes) },
    [PSCustomObject]@{ Label = 'UTF-16LE'; Text = [System.Text.Encoding]::Unicode.GetString($Bytes) },
    [PSCustomObject]@{ Label = 'UTF-16BE'; Text = [System.Text.Encoding]::BigEndianUnicode.GetString($Bytes) }
  )

  foreach ($Root in $Roots) {
    $Value = [string]$Root.Value
    if ([string]::IsNullOrWhiteSpace($Value)) { continue }

    foreach ($Fragment in (Get-ReleasePathSpellings -Path $Value)) {
      $PathStyle = if ($Fragment.Contains('/')) { 'forward-slash path' } else { 'backslash path' }
      foreach ($View in $Views) {
        if ($View.Text.IndexOf($Fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
          throw "release binary contains a build-root fragment ($($Root.Label); $($View.Label); $PathStyle)"
        }
      }
    }
  }
}
