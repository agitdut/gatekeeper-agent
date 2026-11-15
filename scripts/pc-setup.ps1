# Gatekeeper Agent — setup di PC Windows (PowerShell)
# Cara pakai: klik kanan file ini > "Run with PowerShell", atau jalankan dari
# PowerShell:
#   PowerShell -ExecutionPolicy Bypass -File .\pc-setup.ps1
# Script ini: download repo (tanpa git), npm install, pastikan cloudflared
# terinstal (via winget), jalankan service + tunnel, lalu menampilkan URL publik.
# Biarkan KEDUA jendela (node + tunnel) tetap terbuka dan PC tetap menyala
# selama ronde (17:30-03:30 WIB). URL tunnel berubah kalau tunnel di-restart.
$ErrorActionPreference = "Stop"
$workDir = "$env:USERPROFILE\gatekeeper-agent"
$repoZip = "$env:TEMP\gatekeeper-agent.zip"
$repoUrl = "https://github.com/agitdut/gatekeeper-agent/archive/refs/heads/main.zip"

Write-Host "=== Gatekeeper Agent — PC setup ==="

# 1. Node.js harus sudah terinstal (vAPI juga pakai Node, jadi biasanya sudah ada)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js belum terinstal. Instal dari https://nodejs.org (LTS), lalu jalankan script ini lagi."
  pause; exit 1
}
Write-Host "Node: $(node --version)"

# 2. Repo (download ZIP, tanpa git)
if (-not (Test-Path "$workDir\package.json")) {
  Write-Host "Download repo..."
  if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
  Invoke-WebRequest -Uri $repoUrl -OutFile $repoZip
  $extractDir = "$env:TEMP\gk-extract"
  if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
  Expand-Archive -Path $repoZip -DestinationPath $extractDir -Force
  Move-Item "$extractDir\gatekeeper-agent-main" $workDir
  Remove-Item $repoZip -Force
  Write-Host "Repo di: $workDir"
} else {
  Write-Host "Repo sudah ada di $workDir"
}

# 3. Dependencies
Set-Location $workDir
Write-Host "npm install..."
npm install

# 4. cloudflared (via winget, sumber resmi Microsoft Store)
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "Instal cloudflared via winget..."
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# 5. Jalankan service di jendela baru (npm start = download sirkuit + start server)
Write-Host "Menjalankan service di jendela baru..."
Start-Process -FilePath "cmd.exe" -ArgumentList '/c npm start' -WorkingDirectory $workDir
Start-Sleep -Seconds 10
try {
  $h = Invoke-RestMethod -Uri "http://localhost:8787/health" -TimeoutSec 10
  Write-Host "Service OK: $($h | ConvertTo-Json -Compress)"
} catch {
  Write-Host "Service belum merespons — cek jendela node yang baru terbuka (mungkin Windows Firewall minta Allow, klik Allow)."
}

# 6. Tunnel di jendela ini (foreground — jangan tutup jendela ini)
Write-Host ""
Write-Host "=== TUNNEL ==="
Write-Host "URL publik akan muncul di bawah (https://....trycloudflare.com)."
Write-Host "Kirim URL itu ke Muse — endpoint yang didaftarkan adalah <URL>/agent"
Write-Host "Jangan tutup jendela ini selama ronde berjalan."
cloudflared tunnel --url http://localhost:8787
