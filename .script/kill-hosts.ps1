$ErrorActionPreference='Stop'
$ports = 8790, 8799, 8789
$procs = Get-NetTCPConnection -State Listen,TimeWait -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports } | Select-Object -ExpandProperty OwningProcess -Unique
$procs | ForEach-Object { Write-Host "killing pid $_"; Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports } | ForEach-Object { Write-Host "still listening: $($ps rid $_.LocalPort) on $($_.LocalPort)" }
