param([switch]$Execute)

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

try {
  $databaseUri = Read-HiddenValue 'Hosted PostgreSQL DATABASE_URL (input is hidden)'
  $parsedUri = $null
  if (-not [Uri]::TryCreate($databaseUri, [UriKind]::Absolute, [ref]$parsedUri) -or $parsedUri.Scheme -notin @('postgres', 'postgresql')) {
    throw 'The hidden database value must be a PostgreSQL connection string.'
  }
  $env:DATABASE_URL = $databaseUri

  if ($Execute) {
    $env:REPLACEMENT_INSTRUCTOR_NAME = (Read-Host 'Replacement instructor name').Trim()
    $env:REPLACEMENT_INSTRUCTOR_USERNAME = (Read-Host 'Replacement instructor username').Trim().ToLowerInvariant()
    $env:REPLACEMENT_INSTRUCTOR_TEMP_PASSWORD = Read-HiddenValue 'Replacement instructor temporary password, 8-128 characters (input is hidden)'
  }

  if ($Execute) { npm run instructors:remove -- --execute }
  else { npm run instructors:remove }
  if ($LASTEXITCODE -ne 0) { throw "Instructor migration command failed with exit code $LASTEXITCODE." }
}
catch {
  Write-Error $_
}
finally {
  Remove-Item Env:\DATABASE_URL, Env:\REPLACEMENT_INSTRUCTOR_NAME, Env:\REPLACEMENT_INSTRUCTOR_USERNAME, Env:\REPLACEMENT_INSTRUCTOR_TEMP_PASSWORD -ErrorAction SilentlyContinue
}
