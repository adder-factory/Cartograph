$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'windows-rust-release-paths.ps1')

function Assert-ContainsExactlyOnce {
  param(
    [Parameter(Mandatory = $true)][string[]]$Values,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  $Count = @($Values | Where-Object { $_ -ceq $Expected }).Count
  if ($Count -ne 1) {
    throw "expected one exact remapping flag for the test path; found $Count"
  }
}

function Assert-OrderedAfter {
  param(
    [Parameter(Mandatory = $true)][string[]]$Values,
    [Parameter(Mandatory = $true)][string]$Later,
    [Parameter(Mandatory = $true)][string]$Earlier
  )

  if ([array]::IndexOf($Values, $Later) -le [array]::IndexOf($Values, $Earlier)) {
    throw 'the more-specific remapping must follow its parent remapping'
  }
}

$SavedEnvironment = @{}
foreach ($Name in @('CARGO_ENCODED_RUSTFLAGS', 'RUSTFLAGS', 'CFLAGS', 'CXXFLAGS')) {
  $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name)
}

Get-RustHostTarget | Out-Null

$TestDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "cartograph-path-audit-$([guid]::NewGuid())"
[System.IO.Directory]::CreateDirectory($TestDirectory) | Out-Null

try {
  $env:CARGO_ENCODED_RUSTFLAGS = '--cfg=preserved_release_flag'
  $env:RUSTFLAGS = $null
  $env:CFLAGS = '/DKEEP_C_FLAG=1'
  $env:CXXFLAGS = '/DKEEP_CXX_FLAG=1'

  $UserRoot = 'C:\Users\build-user'
  $CargoRoot = 'C:\Users\build-user\.cargo'
  $WorkspaceRoot = 'D:\a\cartograph\cartograph'
  Set-PrivateBuildPathRemapping -Roots @($WorkspaceRoot, $UserRoot, $CargoRoot)

  $Flags = $env:CARGO_ENCODED_RUSTFLAGS -split [char]0x1f
  $UserBackslashFlag = '--remap-path-prefix=C:\Users\build-user=.'
  $UserForwardFlag = '--remap-path-prefix=C:/Users/build-user=.'
  $CargoBackslashFlag = '--remap-path-prefix=C:\Users\build-user\.cargo=.'
  $CargoForwardFlag = '--remap-path-prefix=C:/Users/build-user/.cargo=.'

  foreach ($Expected in @(
    '--cfg=preserved_release_flag',
    '--remap-path-prefix=D:\a\cartograph\cartograph=.',
    '--remap-path-prefix=D:/a/cartograph/cartograph=.',
    '--remap-path-prefix=d:\a\cartograph\cartograph=.',
    '--remap-path-prefix=d:/a/cartograph/cartograph=.',
    $UserBackslashFlag,
    $UserForwardFlag,
    '--remap-path-prefix=c:\Users\build-user=.',
    '--remap-path-prefix=c:/Users/build-user=.',
    $CargoBackslashFlag,
    $CargoForwardFlag,
    '--remap-path-prefix=c:\Users\build-user\.cargo=.',
    '--remap-path-prefix=c:/Users/build-user/.cargo=.',
    '-Clink-arg=/PDBALTPATH:%_PDB%'
  )) {
    Assert-ContainsExactlyOnce -Values $Flags -Expected $Expected
  }

  Assert-OrderedAfter -Values $Flags -Later $CargoBackslashFlag -Earlier $UserBackslashFlag
  Assert-OrderedAfter -Values $Flags -Later $CargoForwardFlag -Earlier $UserForwardFlag

  foreach ($CompilerFlags in @($env:CFLAGS, $env:CXXFLAGS)) {
    foreach ($Expected in @(
      '/pathmap:C:\Users\build-user=.',
      '/pathmap:C:/Users/build-user=.',
      '/pathmap:c:\Users\build-user=.',
      '/pathmap:c:/Users/build-user=.',
      '/pathmap:C:\Users\build-user\.cargo=.',
      '/pathmap:C:/Users/build-user/.cargo=.',
      '/pathmap:c:\Users\build-user\.cargo=.',
      '/pathmap:c:/Users/build-user/.cargo=.'
    )) {
      if (-not $CompilerFlags.Contains($Expected)) {
        throw 'native compiler path remapping is incomplete'
      }
    }
  }

  $PrivateRoots = @(
    [PSCustomObject]@{ Label = 'test user profile'; Value = $UserRoot }
  )
  $PrivateSamples = @(
    [PSCustomObject]@{
      Name = 'ascii-forward'
      Bytes = [System.Text.Encoding]::ASCII.GetBytes('prefix C:/Users/build-user/source suffix')
    },
    [PSCustomObject]@{
      Name = 'utf16le-backslash'
      Bytes = [System.Text.Encoding]::Unicode.GetBytes('prefix C:\Users\build-user\source suffix')
    },
    [PSCustomObject]@{
      Name = 'utf16be-forward'
      Bytes = [System.Text.Encoding]::BigEndianUnicode.GetBytes('prefix C:/Users/build-user/source suffix')
    }
  )

  foreach ($Sample in $PrivateSamples) {
    $SamplePath = Join-Path $TestDirectory "$($Sample.Name).bin"
    [System.IO.File]::WriteAllBytes($SamplePath, $Sample.Bytes)
    $Rejected = $false
    try {
      Assert-NoPrivateBuildRoots -Path $SamplePath -PrivateRoots $PrivateRoots
    } catch {
      $Rejected = $true
      if (-not $_.Exception.Message.StartsWith('release binary contains a private build-root fragment')) {
        throw
      }
      if ($_.Exception.Message.Contains('build-user')) {
        throw 'private audit diagnostics exposed the matched path'
      }
    }
    if (-not $Rejected) {
      throw "private audit accepted $($Sample.Name)"
    }
  }

  $CleanPath = Join-Path $TestDirectory 'clean.bin'
  [System.IO.File]::WriteAllBytes($CleanPath, [System.Text.Encoding]::UTF8.GetBytes('cartograph release'))
  Assert-NoPrivateBuildRoots -Path $CleanPath -PrivateRoots $PrivateRoots

  Write-Host '[rust-release] Windows path-remapping and privacy regressions passed'
} finally {
  foreach ($Name in $SavedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name])
  }
  if ([System.IO.Directory]::Exists($TestDirectory)) {
    [System.IO.Directory]::Delete($TestDirectory, $true)
  }
}
