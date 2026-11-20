# 启动 Cloudflare 快速隧道，并把公网域名登记进桥插件的 trustedHosts。
# 用法： .\tools\tunnel.ps1                 （隧道指向桥的 3088 端口，一条地址同时提供网页和控制接口）
#        .\tools\tunnel.ps1 -Protocol quic （默认 http2；本机 QUIC/UDP 7844 被挡，必须走 http2）
#        .\tools\tunnel.ps1 -Stop          （停掉所有 cloudflared）
#
# 说明：快速隧道的域名每次重启都会变，电脑重启或杀掉 cloudflared 后需要重新跑本脚本。

param(
  [int]$BridgePort = 3088,
  [string]$Token = '',
  [ValidateSet('http2', 'quic', 'auto')]
  [string]$Protocol = 'http2',
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

$log = Join-Path $env:TEMP 'cloudflared-dshremote.log'
$url = ''
$proc = $null

# 本机 DNS 对 argotunnel.com 偶发失败，所以整体最多试三次
for ($attempt = 1; $attempt -le 3; $attempt++) {
  # 上一个隧道先关掉，避免多个 cloudflared 抢连接
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) { Remove-Item $log -Force }

  $proc = Start-Process -FilePath $exe `
    -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$BridgePort", '--protocol', $Protocol, '--no-autoupdate', '--loglevel', 'info', '--logfile', $log `
    -PassThru -WindowStyle Hidden

  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
      $hit = Select-String -Path $log -Pattern 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' | Select-Object -First 1
      if ($hit) { $url = $hit.Matches[0].Value; break }
    }
    if ($proc.HasExited) { break }
  }
  if ($url) { break }
  Write-Host "第 $attempt 次没拿到隧道地址（多半是 DNS/SRV 抖动），重试…"
  $url = ''
}

if (-not $url) { throw "三次都没拿到隧道地址，看日志：$log" }

# 等隧道真正注册上（Registered tunnel connection），否则手机可能瞬间 502
for ($i = 0; $i -lt 40; $i++) {
  if (Select-String -Path $log -Pattern 'Registered tunnel connection' -Quiet) { break }
  Start-Sleep -Milliseconds 500
}

$authority = ([Uri]$url).Host
$trustUrl = "http://127.0.0.1:$BridgePort/trust?token=$Token&host=$authority"
$trusted = 'no'
try {
  $resp = Invoke-WebRequest -Uri $trustUrl -UseBasicParsing -TimeoutSec 10
  $trusted = if ($resp.StatusCode -eq 200) { 'yes' } else { "HTTP $($resp.StatusCode)" }
} catch {
  $trusted = "失败：$($_.Exception.Message)"
}

# 把当前公网地址告诉桥：二维码和自动发现广播都会带上它，手机扫一次就换到新隧道。
$publicUrl = "http://127.0.0.1:$BridgePort/public?token=$Token&url=$([uri]::EscapeDataString($url))"
$published = 'no'
try {
  $resp = Invoke-WebRequest -Uri $publicUrl -UseBasicParsing -TimeoutSec 10
  $published = if ($resp.StatusCode -eq 200) { 'yes' } else { "HTTP $($resp.StatusCode)" }
} catch {
  $published = "失败：$($_.Exception.Message)"
}

Write-Host ''
Write-Host "隧道地址  : $url"
Write-Host "已登记信任: $trusted（$authority）"
Write-Host "已发布地址: $published"
Write-Host "传输协议  : $Protocol"
Write-Host "PID       : $($proc.Id)    日志: $log"
Write-Host ''
Write-Host '手机端：电脑上打开 http://127.0.0.1:3088/pair.html 出二维码，App「扫一扫」即可；'
Write-Host '       同一个 Wi-Fi 下也可以直接点「自动发现」。'
Write-Host '（隧道地址每次重启都会变；电脑重启后重新跑一次本脚本即可）'
