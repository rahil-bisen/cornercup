$ErrorActionPreference='Stop'
$HARNESS='http://127.0.0.1:8790'
$json=@{'Content-Type'='application/json'}
$pair=@{
  'Content-Type'='application/json'
  'cf-connecting-ip'='198.51.99.9'
}
$clientIp='198.51.99.9'

function Login($body){ curl.exe -s -m 20 -w "`nHTTP %{http_code}`n" -X POST "$HARNESS/api/cafes/$using:slug/admin/login" -H $pair -d $body }
function Step($label,$body){ Write-Host "=== $label ==="; $r=Login $body; Write-Host ($r -join "`n"); $parts=$r.Trim().Split("`n"); $status=[int]($parts[-1].Split(' ')[1]); $bodyText=$parts[-2]; $parsed=@{}; try{$parsed=echo $bodyText| ConvertFrom-Json}catch{}; [PSCustomObject]@{label=$label;status=$status;body=$bodyText;parsed=$parsed} }

$seed=Invoke-RestMethod -Uri "$HARNESS/seed" -Method Post -Headers $json -Body (ConvertTo-Json @{serviceMode='counter'}) -ContentType 'application/json'
$cafeId=$seed.cafeId
$slug=$seed.slug
Write-Host "cafeId=$cafeId slug=$slug"

function Clean{ curl.exe -s -m 10 -X POST "$HARNESS/clean" -H $json -d (ConvertTo-Json @{cafeId=$cafeId}) | Out-Null }
$null=Register-ObjectEvent -InputObject ([System.Threading.CancellationToken]::None) -EventName None -Action { Clean } | Out-Null
trap { Clean; continue }

$steps=@(
  (Step '1. missing password {}' '{}'),
  (Step '2. empty string password' (ConvertTo-Json @{password=''})),
  (Step '3. whitespace-only password' (ConvertTo-Json @{password='   '})),
  (Step '4. incorrect password' (ConvertTo-Json @{password='wrong-password'}))
)
foreach($s in $steps){ Write-Host "$($s.label): status=$($s.status) body=$($s.body)" }

Write-Host "`n=== counter BEFORE valid login ==="
$beforeRows=Invoke-RestMethod -Uri "$HARNESS/rate-limit/row" -Method Post -Headers $json -Body (ConvertTo-Json @{key="login:$cafeId:$clientIp"}) -ContentType 'application/json'
Write-Host ($beforeRows | ConvertTo-Json -Depth 2)
$beforeCount=$beforeRows.row.count

Write-Host "`n=== 5. valid password ==="
$ok=Step '5. valid password' (ConvertTo-Json @{password='harness-owner-password'})
Write-Host "status=$($ok.status) body=$($ok.body)"

Write-Host "`n=== counter AFTER valid login ==="
$afterRows=Invoke-RestMethod -Uri "$HARNESS/rate-limit/row" -Method Post -Headers $json -Body (ConvertTo-Json @{key="login:$cafeId:$clientIp"}) -ContentType 'application/json'
Write-Host ($afterRows | ConvertTo-Json -Depth 2)
$afterCount=$afterRows.row.count

Write-Host "`n=== 6. valid login again (counter not reset) ==="
$ok2=Step '6. valid login again' (ConvertTo-Json @{password='harness-owner-password'})
Write-Host "status=$($ok2.status) body=$($ok2.body)"

Write-Host "`n=== analysis ==="
Write-Host "missing_password_401= $(if($steps[0].status -eq 401){'PASS';$true}else{'FAIL';$false})"
Write-Host "empty_password_401= $(if($steps[1].status -eq 401){'PASS';$true}else{'FAIL';$false})"
Write-Host "whitespace_401= $(if($steps[2].status -eq 401){'PASS';$true}else{'FAIL';$false})"
Write-Host "incorrect_401= $(if($steps[3].status -eq 401){'PASS';$true}else{'FAIL';$false})"
Write-Host "valid_200= $(if($ok.status -eq 200){'PASS';$true}else{'FAIL';$false})"
Write-Host "counter_before= $beforeCount"
Write-Host "counter_after= $afterCount  (expected: 4 failures; valid login does not reset)"
