# POST one inbox payload. The sender key stays in this process.
#
# Decrypt uses ConvertTo-SecureString with no -Key, which is the DPAPI pair of
# ConvertFrom-SecureString:
# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertto-securestring
#
# Stdin is JSON: { "url": "...", "body": { ... }, "timeoutSec": 8 }
# Stdout is one JSON object: { "status": <number>, "error": "<code or empty>" }
# The key, the Authorization header, and the task text are never written out.

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') {
  Write-Output '{"status":0,"error":"not-windows"}'
  exit 0
}

function Write-Result([int]$status, [string]$error) {
  $safe = if ($error) { $error } else { '' }
  Write-Output ('{"status":' + $status + ',"error":"' + $safe + '"}')
}

function Test-Blocked([System.Net.IPAddress]$ip) {
  $text = $ip.IPAddressToString.ToLowerInvariant()
  if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
    $p = $text.Split('.')
    $a = [int]$p[0]; $b = [int]$p[1]
    if ($a -eq 0 -or $a -eq 10 -or $a -eq 127) { return $true }
    if ($a -eq 169 -and $b -eq 254) { return $true }
    if ($a -eq 172 -and $b -ge 16 -and $b -le 31) { return $true }
    if ($a -eq 192 -and ($b -eq 168 -or $b -eq 0)) { return $true }
    if ($a -eq 100 -and $b -ge 64 -and $b -le 127) { return $true }
    if ($a -eq 198 -and ($b -eq 18 -or $b -eq 19)) { return $true }
    if ($a -ge 224) { return $true }
    return $false
  }
  if ($text -eq '::1' -or $text -eq '::') { return $true }
  if ($text.StartsWith('fc') -or $text.StartsWith('fd') -or $text.StartsWith('fe8') -or $text.StartsWith('fe9') -or $text.StartsWith('fea') -or $text.StartsWith('feb') -or $text.StartsWith('ff')) { return $true }
  return $false
}

$rawIn = [Console]::In.ReadToEnd()
$msg = $null
try { $msg = $rawIn | ConvertFrom-Json } catch {
  Write-Result 0 'bad-input'
  exit 0
}

$urlText = [string]$msg.url
$uri = $null
if (-not [Uri]::TryCreate($urlText, [UriKind]::Absolute, [ref]$uri)) {
  Write-Result 0 'refused-target'
  exit 0
}
if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api2.cursor.sh' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
  Write-Result 0 'refused-target'
  exit 0
}
if ($uri.AbsolutePath -notmatch '^/automations/webhook/[A-Za-z0-9_-]{8,200}$') {
  Write-Result 0 'refused-target'
  exit 0
}

$addresses = @()
try { $addresses = [System.Net.Dns]::GetHostAddresses($uri.Host) } catch {
  Write-Result 0 'network'
  exit 0
}
if ($addresses.Count -lt 1) {
  Write-Result 0 'network'
  exit 0
}
foreach ($ip in $addresses) {
  if (Test-Blocked $ip) {
    Write-Result 0 'refused-target'
    exit 0
  }
}
$chosen = $addresses[0]

$keyFile = Join-Path $env:LOCALAPPDATA 'Jarvis\inbox-webhook.dpapi'
if (-not (Test-Path -LiteralPath $keyFile)) {
  Write-Result 0 'not-configured'
  exit 0
}
$blob = ([System.IO.File]::ReadAllText($keyFile)).Trim()
$secure = ConvertTo-SecureString -String $blob
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$key = $null
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $json = $msg.body | ConvertTo-Json -Compress -Depth 5
  $payload = [Text.Encoding]::UTF8.GetBytes($json)
  $tcp = New-Object System.Net.Sockets.TcpClient
  $wait = $tcp.ConnectAsync($chosen, 443)
  $timeoutSec = 8
  if ($msg.timeoutSec) { $timeoutSec = [int]$msg.timeoutSec }
  if (-not $wait.Wait([TimeSpan]::FromSeconds($timeoutSec))) {
    $tcp.Dispose()
    Write-Result 0 'timeout'
    exit 0
  }
  $stream = $tcp.GetStream()
  $ssl = New-Object System.Net.Security.SslStream($stream, $false)
  $ssl.AuthenticateAsClient($uri.Host)
  $header = "POST $($uri.AbsolutePath) HTTP/1.1`r`nHost: $($uri.Host)`r`nAuthorization: Bearer $key`r`nContent-Type: application/json`r`nContent-Length: $($payload.Length)`r`nConnection: close`r`n`r`n"
  $headBytes = [Text.Encoding]::ASCII.GetBytes($header)
  $ssl.Write($headBytes, 0, $headBytes.Length)
  $ssl.Write($payload, 0, $payload.Length)
  $ssl.Flush()
  $reader = New-Object System.IO.StreamReader($ssl)
  $statusLine = $reader.ReadLine()
  $status = 0
  if ($statusLine -match '^HTTP/\d(?:\.\d)?\s+(\d{3})') { $status = [int]$Matches[1] }
  $reader.Dispose()
  $ssl.Dispose()
  $tcp.Dispose()
  if ($status -eq 0) { Write-Result 0 'network' } else { Write-Result $status '' }
} catch {
  Write-Result 0 'network'
} finally {
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  $key = $null
  $header = $null
}
