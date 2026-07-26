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

function Assert-NativeFlagExactlyOnce {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  $Flags = @($Value -split '\s+' | Where-Object { $_ })
  $Count = @($Flags | Where-Object { $_ -ceq $Expected }).Count
  if ($Count -ne 1) {
    throw "expected one exact native compiler flag for the test path; found $Count"
  }
}

$SavedEnvironment = @{}
foreach ($Name in @(
  'CARGO_ENCODED_RUSTFLAGS',
  'RUSTFLAGS',
  'CFLAGS',
  'CXXFLAGS',
  'CARGO_HOME',
  'TEMP',
  'TMP'
)) {
  $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name)
}

Get-RustHostTarget | Out-Null
$ReleaseBuildRoot = Get-NonPrivateReleaseBuildRoot `
  -TemporaryPath 'D:\a\_temp' `
  -AssetTarget 'windows-x64'
if ($ReleaseBuildRoot -cne 'D:\cartograph-release-build-windows-x64') {
  throw 'release tool state was not moved outside the private runner tree'
}

$TestDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "cartograph-path-audit-$([guid]::NewGuid())"
[System.IO.Directory]::CreateDirectory($TestDirectory) | Out-Null
$ReleaseBuildEnvironment = $null

try {
  if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    $RunnerTemporaryDirectory = $env:RUNNER_TEMP
    $PolicyPrivateRoots = @(
      [PSCustomObject]@{
        Label = 'test runner temporary directory'
        Value = $RunnerTemporaryDirectory
      }
    )
    $ReleaseBuildEnvironment = Initialize-NonPrivateReleaseBuildEnvironment `
      -TemporaryPath $RunnerTemporaryDirectory `
      -AssetTarget 'windows-x64' `
      -PrivateRoots $PolicyPrivateRoots
    $ExpectedReleaseBuildRoot = Get-NonPrivateReleaseBuildRoot `
      -TemporaryPath $RunnerTemporaryDirectory `
      -AssetTarget 'windows-x64'

    if ($ReleaseBuildEnvironment.Root -cne $ExpectedReleaseBuildRoot -or
        $env:CARGO_HOME -cne $ReleaseBuildEnvironment.CargoHome -or
        $env:TEMP -cne $ReleaseBuildEnvironment.TemporaryDirectory -or
        $env:TMP -cne $ReleaseBuildEnvironment.TemporaryDirectory) {
      throw 'release environment was not initialized from the non-private root policy'
    }
    if (@($ReleaseBuildEnvironment.RemappingRoots | Where-Object { $_ -ceq $ExpectedReleaseBuildRoot }).Count -ne 1 -or
        @($ReleaseBuildEnvironment.PrivateRoots | Where-Object { $_.Value -ceq $RunnerTemporaryDirectory }).Count -ne 1 -or
        @($ReleaseBuildEnvironment.PrivateRoots | Where-Object { $_.Value -ceq $ExpectedReleaseBuildRoot }).Count -ne 0 -or
        @($ReleaseBuildEnvironment.AuditRoots | Where-Object { $_.Value -ceq $RunnerTemporaryDirectory }).Count -ne 1 -or
        @($ReleaseBuildEnvironment.AuditRoots | Where-Object { $_.Value -ceq $ExpectedReleaseBuildRoot }).Count -ne 1) {
      throw 'release remapping and complete build-root audit policy diverged'
    }

    $PolicyFlags = $env:CARGO_ENCODED_RUSTFLAGS -split [char]0x1f
    foreach ($Spelling in (Get-ReleasePathSpellings -Path $ExpectedReleaseBuildRoot)) {
      Assert-ContainsExactlyOnce `
        -Values $PolicyFlags `
        -Expected "--remap-path-prefix=$Spelling=."
    }
    foreach ($CompilerFlags in @($env:CFLAGS, $env:CXXFLAGS)) {
      foreach ($Spelling in (Get-ReleasePathSpellings -Path $ExpectedReleaseBuildRoot)) {
        Assert-NativeFlagExactlyOnce -Value $CompilerFlags -Expected "/pathmap:$Spelling=."
        Assert-NativeFlagExactlyOnce -Value $CompilerFlags -Expected "/d1trimfile:$Spelling"
      }
    }
  }

  $env:CARGO_ENCODED_RUSTFLAGS = '--cfg=preserved_release_flag'
  $env:RUSTFLAGS = $null
  $env:CFLAGS = '/DKEEP_C_FLAG=1'
  $env:CXXFLAGS = '/DKEEP_CXX_FLAG=1'

  $UserRoot = 'C:\Users\build-user'
  $CargoRoot = 'C:\Users\build-user\.cargo'
  $WorkspaceRoot = 'D:\a\cartograph\cartograph'
  Set-ReleaseBuildPathRemapping -Roots @($WorkspaceRoot, $UserRoot, $CargoRoot)

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
    if (-not $CompilerFlags.StartsWith('/DKEEP_C')) {
      throw 'inherited native compiler flags were not preserved'
    }
    foreach ($BuildRoot in @($WorkspaceRoot, $UserRoot, $CargoRoot)) {
      foreach ($Spelling in (Get-ReleasePathSpellings -Path $BuildRoot)) {
        Assert-NativeFlagExactlyOnce -Value $CompilerFlags -Expected "/pathmap:$Spelling=."
        Assert-NativeFlagExactlyOnce -Value $CompilerFlags -Expected "/d1trimfile:$Spelling"
      }
    }
  }

  $NativeFlags = $env:CFLAGS -split '\s+'
  Assert-OrderedAfter `
    -Values $NativeFlags `
    -Later "/d1trimfile:$CargoRoot" `
    -Earlier "/d1trimfile:$UserRoot"

  $ForbiddenRoots = @(
    [PSCustomObject]@{ Label = 'test user profile'; Value = $UserRoot },
    [PSCustomObject]@{ Label = 'isolated release build root'; Value = $ReleaseBuildRoot }
  )
  $ForbiddenSamples = @(
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
    },
    [PSCustomObject]@{
      Name = 'ascii-isolated-build-root'
      Bytes = [System.Text.Encoding]::ASCII.GetBytes(
        'D:\cartograph-release-build-windows-x64\cargo-home\registry\src\aws-lc-sys\aws-lc\crypto\fipsmodule\bn\add.c'
      )
    }
  )

  foreach ($Sample in $ForbiddenSamples) {
    $SamplePath = Join-Path $TestDirectory "$($Sample.Name).bin"
    [System.IO.File]::WriteAllBytes($SamplePath, $Sample.Bytes)
    $Rejected = $false
    try {
      Assert-NoReleaseBuildRoots -Path $SamplePath -Roots $ForbiddenRoots
    } catch {
      $Rejected = $true
      if (-not $_.Exception.Message.StartsWith('release binary contains a build-root fragment')) {
        throw
      }
      if ($_.Exception.Message.Contains('build-user') -or
          $_.Exception.Message.Contains('cartograph-release-build')) {
        throw 'build-root audit diagnostics exposed the matched path'
      }
    }
    if (-not $Rejected) {
      throw "build-root audit accepted $($Sample.Name)"
    }
  }

  $CleanPath = Join-Path $TestDirectory 'clean.bin'
  [System.IO.File]::WriteAllBytes($CleanPath, [System.Text.Encoding]::UTF8.GetBytes('cartograph release'))
  Assert-NoReleaseBuildRoots -Path $CleanPath -Roots $ForbiddenRoots

  Write-Host '[rust-release] Windows path-remapping and complete build-root regressions passed'
} finally {
  foreach ($Name in $SavedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name])
  }
  if ($null -ne $ReleaseBuildEnvironment -and
      [System.IO.Directory]::Exists($ReleaseBuildEnvironment.Root)) {
    [System.IO.Directory]::Delete($ReleaseBuildEnvironment.Root, $true)
  }
  if ([System.IO.Directory]::Exists($TestDirectory)) {
    [System.IO.Directory]::Delete($TestDirectory, $true)
  }
}
