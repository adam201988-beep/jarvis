# Save the Grok Bot webhook sender key with Windows DPAPI.
#
# Microsoft docs: ConvertFrom-SecureString with no -Key and no -SecureKey
# encrypts with the Windows Data Protection API (DPAPI), for this user on
# this computer.
# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring
#
# Do not pass the key as a parameter or on the command line. The prompt hides it.
# The script refuses to run if any argument was supplied.
# It does not print the key. It does not ask PowerShell for a plain-text export.

if ($env:OS -ne 'Windows_NT') {
  Write-Error 'This setup only works on Windows, where DPAPI exists.'
  exit 1
}
if ($args.Count -gt 0 -or $PSBoundParameters.Count -gt 0) {
  Write-Error 'Do not pass the key on the command line. Run this script and paste when prompted.'
  exit 1
}

$destDir = Join-Path $env:LOCALAPPDATA 'Jarvis'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$urlFile = Join-Path $destDir 'inbox-webhook.url'
$keyFile = Join-Path $destDir 'inbox-webhook.dpapi'

Write-Host 'Paste the POST to URL from the routine Webhook section.'
$url = Read-Host 'POST to URL'
$url = $url.Trim()
$uri = $null
if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) {
  Write-Error 'That is not a URL. Nothing was saved.'
  exit 1
}
if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api2.cursor.sh' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
  Write-Error 'The URL must be https://api2.cursor.sh/automations/webhook/<id> with no query. Nothing was saved.'
  exit 1
}
if ($uri.AbsolutePath -notmatch '^/automations/webhook/[A-Za-z0-9_-]{8,200}$') {
  Write-Error 'The URL path is not a routine webhook path. Nothing was saved.'
  exit 1
}

Write-Host 'Paste the webhook sender key. The input is hidden and is not stored in the command line.'
$secure = Read-Host 'Sender key' -AsSecureString
if ($null -eq $secure -or $secure.Length -lt 8) {
  Write-Error 'The key was empty. Nothing was saved.'
  exit 1
}

$blob = ConvertFrom-SecureString -SecureString $secure
if ([string]::IsNullOrWhiteSpace($blob)) {
  Write-Error 'Windows did not encrypt the key. Nothing was saved.'
  exit 1
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($urlFile, $uri.AbsoluteUri.TrimEnd('/') + "`n", $utf8)
[System.IO.File]::WriteAllText($keyFile, $blob.Trim() + "`n", $utf8)

Write-Host "Saved the URL and a DPAPI blob for this Windows user under $destDir"
Write-Host 'The sender key was not printed.'
