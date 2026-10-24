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
  $env:INITIAL_ADMIN_USERNAME = (Read-Host 'Initial admin username (remember this for Render)').Trim().ToLowerInvariant()
  $env:INITIAL_ADMIN_PASSWORD = Read-HiddenValue 'Initial admin password, 12-128 characters (input is hidden; remember it for Render)'

  $databaseUri = $null
  if (-not [Uri]::TryCreate($env:DATABASE_URL, [UriKind]::Absolute, [ref]$databaseUri) -or
      $databaseUri.Scheme -notin @('postgres', 'postgresql') -or
      $databaseUri.Host -notlike '*.neon.tech') {
    throw 'The hidden database value does not look like a Neon PostgreSQL connection string. Copy the full URI from the Neon Connect dialog and retry.'
  }
  if ($env:INITIAL_ADMIN_USERNAME -notmatch '^[a-z0-9][a-z0-9._/-]{1,39}$') {
    throw 'The admin username must be 2-40 characters and use only lowercase letters, numbers, dots, dashes, underscores, or slashes.'
  }
  if ($env:INITIAL_ADMIN_PASSWORD.Length -lt 12 -or $env:INITIAL_ADMIN_PASSWORD.Length -gt 128) {
    throw 'The admin password must be 12-128 characters. Choose a password and use the same one later in Render.'
  }

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
