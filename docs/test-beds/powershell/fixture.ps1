using module ./Helpers.psm1

$DefaultName = 'Ada'

class Greeter {
  [string] $Name

  Greeter([string] $name) {
    $this.Name = $name
  }

  [string] Greet([string] $target) {
    return Format-Greeting $target
  }
}

function Format-Greeting {
  param([string] $Name)
  Get-Date | Out-Null
  return "Hello $Name"
}

Format-Greeting -Name $DefaultName
