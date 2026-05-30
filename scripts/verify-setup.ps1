# EcoHealth Lens - automated setup verification (run in PowerShell)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ext = Join-Path $root "extension"

Write-Host "=== EcoHealth setup check ===" -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $ext "manifest.json"))) {
  Write-Host "FAIL: Load unpacked from: $ext" -ForegroundColor Red
  exit 1
}
$manifest = Get-Content (Join-Path $ext "manifest.json") -Raw | ConvertFrom-Json
Write-Host "OK: manifest version $($manifest.version)"

foreach ($size in @(16, 48, 128)) {
  $icon = Join-Path $ext "icons\icon$size.png"
  if (-not (Test-Path $icon)) {
    Write-Host "FAIL: Missing $icon - run: node extension/scripts/generate-icons.mjs" -ForegroundColor Red
    exit 1
  }
}
Write-Host "OK: extension icons present"

node --check (Join-Path $ext "content\amazon-in-bundle.js") | Out-Null
Write-Host "OK: content script syntax"

try {
  $health = Invoke-RestMethod -Uri "http://localhost:3000/v1/health" -TimeoutSec 3
  Write-Host "OK: backend $($health.service) on port 3000"
} catch {
  Write-Host "FAIL: backend not running. Start with: cd backend; node server.js" -ForegroundColor Red
  exit 1
}

$body = @{
  retailer = "amazon_in"
  asin = "TEST"
  title = "Soft Cotton Cap"
  materialsText = "100% Cotton"
} | ConvertTo-Json
$r = Invoke-RestMethod -Uri "http://localhost:3000/v1/analyze" -Method POST -Body $body -ContentType "application/json"
Write-Host "OK: analyze API eco score = $($r.eco.total) (material-based)"

Write-Host ""
Write-Host "Chrome steps (manual - only you can do these):" -ForegroundColor Yellow
Write-Host ('  1. chrome://extensions -> Remove old EcoHealth -> Load unpacked -> ' + $ext)
Write-Host ('  2. Confirm version ' + $manifest.version)
Write-Host '  3. Open amazon.in product page, F12 Console, filter: EcoHealth'
Write-Host '  4. Expect EcoHealth script injected log on product URL'
