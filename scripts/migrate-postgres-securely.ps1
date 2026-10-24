$ErrorActionPreference = 'Stop'

function Read-HiddenValue([string]$prompt) {
  $secureValue = Read-Host $prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secureValue.Dispose()
  }
}

$exitCode = 1
try {
  $env:DATABASE_URL = Read-HiddenValue 'Neon DATABASE_URL (input is hidden)'
  $env:INITIAL_ADMIN_USERNAME = Read-Host 'Initial admin username (remember this for Render)'
  $env:INITIAL_ADMIN_PASSWORD = Read-HiddenValue 'Initial admin password, 12-128 characters (input is hidden; remember it for Render)'

  npm run migrate:postgres
  $exitCode = $LASTEXITCODE
}
catch {
  Write-Error $_
}
finally {
  Remove-Item Env:\DATABASE_URL, Env:\INITIAL_ADMIN_USERNAME, Env:\INITIAL_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}

exit $exitCode
