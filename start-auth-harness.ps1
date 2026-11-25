$ErrorActionPreference='Stop'
$log = "$env:TEMP\auth-harness-$PID.log"
$p = Start-Process powershell -NoNewWindow -PassThru -ArgumentList '-ExecutionPolicy','Bypass','-Command',"
Set-Location '$PWD'
& npx wrangler dev --config wrangler.auth.jsonc --port 8790 --ip 127.0.0.1 *> `"$log`"
exit `$LASTEXITCODE
"
Write-Host "PID=$($p.Id)"
for ($i=0; $i -lt 60; $i++) {
  if (Test-Path $log) {
    $content = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($content -match 'Ready on') {
      Write-Host '--- log head ---'
      Get-Content $log | Select-Object -First 8
      Write-Host '--- ready ---'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 500
}
Write-Host '--- log tail ---'
Get-Content $log | Select-Object -Last 12
exit 1
