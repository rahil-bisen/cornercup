$ErrorActionPreference='Stop'
$HARNESS='http://127.0.0.1:8790'
$pair=@{ 'Content-Type'='application/json'; 'cf-connecting-ip'='198.51.99.9' }
$clientIp='198.51.99.9'

function Login($slug,$body){ curl.exe -s -m 20 -w "`nHTTP %{http_code}`n" -X POST "$HARNESS/api/cafes/$slug/admin/login" -H $pair -d $body }
function RateCount($cafeId,$ip){
  $sql="SELECT count FROM rate_limits WHERE key='login:$cafeId`:$ip'"
  $out=cmd /c 'npx wrangler d1 execute corner-cup --local --command "' + $sql + '"' 2>$null
  $m=[regex]::Match($out,'"count":\s*(\d+)')
  if($m.Success){ [int]$m.Groups[1].Value } else { 0 }
}

$seed=Invoke-RestMethod -Uri "$HARNESS/seed" -Method Post -Headers @{ 'Content-Type'='application/json' } -Body (ConvertTo-Json @{serviceMode='counter'}) -ContentType 'application/json'
$cafeId=$seed.cafeId
$slug=$seed.slug
Write-Host "cafeId=$cafeId slug=$slug"

function Step($label,$body){
  Write-Host "=== $label ==="
  $r=Login $slug $body
  $lines=$r -split "`n"
  $status=[int]($lines[-1] -split ' ')[1]
  $bodyText=$lines[-2]
  try { $parsed=ConvertFrom-Json $bodyText } catch { $parsed=$bodyText }
  Write-Host "status=$status body=$bodyText"
  [PSCustomObject]@{label=$label;status=$status;body=$parsed}
}

$cases=@(
  (Step '1. missing password {}' (ConvertTo-Json @{})),
  (Step '2. empty string password' (ConvertTo-Json @{password=''})),
  (Step '3. whitespace-only password' (ConvertTo-Json @{password='   '})),
  (Step '4. incorrect password' (ConvertTo-Json @{password='wrong-password'}))
)
foreach($s in $cases){ Write-Host "$($s.label): status=$($s.status)" }

$before=RateCount $cafeId $clientIp
Write-Host "`ncounter BEFORE valid login = $before"

$ok=Step '5. valid password' (ConvertTo-Json @{password='harness-owner-password'})
Write-Host "valid password status=$($ok.status)"

$after=RateCount $cafeId $clientIp
Write-Host "counter AFTER valid login = $after  (expected 4)"

$ok2=Step '6. valid login again' (ConvertTo-Json @{password='harness-owner-password'})
Write-Host "valid again status=$($ok2.status)"

Write-Host "`n=== RESULTS ==="
New-Object PSObject -Property @{
  missing_password_401 = ($cases[0].status -eq 401)
  empty_password_401 = ($cases[1].status -eq 401)
  whitespace_401 = ($cases[2].status -eq 401)
  incorrect_401 = ($cases[3].status -eq 401)
  valid_200 = ($ok.status -eq 200)
  valid_again_200 = ($ok2.status -eq 200)
  counter_incremented = ($after -gt $before)
  counter_expected_value = ($after -eq 4)
  counterNotResetByValidLogin = ($after -eq $before + 4)
} | Format-List
