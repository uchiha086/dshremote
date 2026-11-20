# 启动 Cloudflare 快速隧道，并把公网域名登记进桥插件的 trustedHosts。
# 用法： .\tools\tunnel.ps1            （隧道指向桥的 3088 端口，一条地址同时提供网页和控制接口）
#        .\tools\tunnel.ps1 -Stop      （停掉所有 cloudflared）

param(
  [int]$BridgePort = 3088,
  [string]$Token = '',
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

if ($Stop) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host '已停止 cloudflared'
  return
}

if (-not (Test-Path $exe)) { throw "找不到 $exe，先装：winget install Cloudflare.cloudflared" }
if ([string]::IsNullOrWhiteSpace($Token)) {
  $Token = (Get-Content "$env:USERPROFILE\.dsh\dshremote-bridge.token" -Raw).Trim()
}

# 上一个隧道先关掉，避免多个 cloudflared 抢连接
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

$log = Join-Path $env:TEMP 'cloudflared-dshremote.log'
if (Test-Path $log) { Remove-Item $log -Force }

$proc = Start-Process -FilePath $exe `
  -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$BridgePort", '--no-autoupdate', '--loglevel', 'info', '--logfile', $log `
  -PassThru -WindowStyle Hidden

$url = ''
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) {
    $hit = Select-String -Path $log -Pattern 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' | Select-Object -First 1
    if ($hit) { $url = $hit.Matches[0].Value; break }
  }
}
if (-not $url) { throw "20 秒内没拿到隧道地址，看日志：$log" }

$authority = ([Uri]$url).Host
$trustUrl = "http://127.0.0.1:$BridgePort/trust?token=$Token&host=$authority"
$trusted = 'no'
try {
  $resp = Invoke-WebRequest -Uri $trustUrl -UseBasicParsing -TimeoutSec 10
  $trusted = if ($resp.StatusCode -eq 200) { 'yes' } else { "HTTP $($resp.StatusCode)" }
} catch {
  $trusted = "失败：$($_.Exception.Message)"
}

Write-Host ''
Write-Host "隧道地址  : $url"
Write-Host "已登记信任: $trusted（$authority）"
Write-Host "PID       : $($proc.Id)    日志: $log"
Write-Host ''
Write-Host '手机端：设置 → 隧道地址 填上面这个 URL，然后「保存并进入」。'
Write-Host '（隧道地址每次重启都会变；电脑重启后重新跑一次本脚本即可）'
