# 把 Tailscale Funnel 配成 DSH Remote 的固定公网地址。
#
# 用法（普通权限即可，登录需要在浏览器里点一下）：
#   .\enable-funnel.ps1                    # 登录 + 开 Funnel + 打印地址并写进桥配置
#   .\enable-funnel.ps1 -LocalPort 3088    # 桥监听的端口
#   .\enable-funnel.ps1 -BridgeConfig 'C:\Users\你\.dsh\profiles\desktop\cordis.patch.yml'
#
# 前提：Tailscale 已安装（管理员装一次），并且 tailnet 里开了
#   1) MagicDNS（默认开）
#   2) HTTPS Certificates（admin console → DNS → HTTPS Certificates → Enable）
#   3) Funnel 权限（admin console → Access controls → 加 nodeAttrs: [{"target":["autogroup:member"],"attr":["funnel"]}]）
# 缺 2/3 时 tailscale 会把对应控制台链接直接打出来，照着点即可。

[CmdletBinding()]
param(
  [int]$LocalPort = 3088,
  [string]$Hostname = 'dsremote',
  [string]$BridgeConfig = '',
  [switch]$SkipLogin
)

$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $ts)) {
  Write-Host "找不到 $ts，请先安装 Tailscale（安装包要点一次管理员授权）。" -ForegroundColor Red
  exit 1
}

function Get-Status {
  try { return (& $ts status --json 2>$null | Out-String | ConvertFrom-Json) } catch { return $null }
}

# 1) 登录
$status = Get-Status
$needLogin = $true
if ($status -and $status.BackendState -eq 'Running') { $needLogin = $false }

if ($needLogin -and -not $SkipLogin) {
  Write-Host '正在启动 Tailscale 登录…' -ForegroundColor Cyan
  $job = Start-Job -ScriptBlock { param($exe) & $exe up --hostname=$args[0] --accept-dns=false 2>&1 } -ArgumentList $ts, $Hostname
  # 从输出里抓登录链接
  $authUrl = ''
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $out = Receive-Job -Job $job -Keep | Out-String
    $m = [regex]::Match($out, 'https://login\.tailscale\.com/\S+')
    if ($m.Success) { $authUrl = $m.Value; break }
    $st = Get-Status
    if ($st -and $st.BackendState -eq 'Running') { break }
  }
  if ($authUrl) {
    Write-Host "登录地址：$authUrl" -ForegroundColor Yellow
    Start-Process $authUrl
    Write-Host '已在浏览器打开，请用 Google / Microsoft / GitHub 邮箱登录（同一个邮箱注册的就是你的 tailnet）。' -ForegroundColor Yellow
  }
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 2
    $st = Get-Status
    if ($st -and $st.BackendState -eq 'Running') { break }
  }
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}

$status = Get-Status
if (-not $status -or $status.BackendState -ne 'Running') {
  Write-Host '还没登录成功：请在浏览器里完成登录后重跑本脚本。' -ForegroundColor Red
  exit 1
}

$dnsName = ($status.Self.DNSName -replace '\.$', '')
Write-Host "本机 tailnet 域名：$dnsName" -ForegroundColor Green

# 2) 开 Funnel（443 → 本地桥端口）
Write-Host "正在开放 Funnel：https://$dnsName/ → 127.0.0.1:$LocalPort" -ForegroundColor Cyan
$funnelOut = (& $ts funnel --bg --https=443 "http://127.0.0.1:$LocalPort" 2>&1 | Out-String)
Write-Host $funnelOut

if ($funnelOut -match 'funnel|Funnel') {
  if ($funnelOut -notmatch 'Available' -and $funnelOut -match 'not enabled|not available|HTTPS') {
    Write-Host ''
    Write-Host 'Funnel 还没在 tailnet 里打开。请按下面两条各点一次（一次性）：' -ForegroundColor Yellow
    Write-Host '  1) admin console → DNS → HTTPS Certificates → Enable HTTPS'
    Write-Host '  2) admin console → Access controls → 在策略里加：'
    Write-Host '     "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]'
    Write-Host '   或直接打开：https://login.tailscale.com/admin/settings/funnel'
    Write-Host '   加完等十几秒再重跑本脚本。'
    exit 2
  }
}

# 3) 验证公网可达
$url = "https://$dnsName/health"
$ok = $false
for ($i = 1; $i -le 20; $i++) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    Start-Sleep -Seconds 3
  }
}
if (-not $ok) {
  Write-Host "公网 /health 还打不通（$url）。等 1-2 分钟再试，或检查 funnel 是否已在跑：tailscale funnel status" -ForegroundColor Yellow
} else {
  Write-Host "公网可达：$url" -ForegroundColor Green
}

# 4) 写进桥配置：publicUrl + tunnel=off
if ($BridgeConfig -and (Test-Path $BridgeConfig)) {
  $text = [IO.File]::ReadAllText($BridgeConfig, [Text.Encoding]::UTF8)
  $text = $text -replace "(?m)^(\s*)publicUrl:.*$", "`$1publicUrl: 'https://$dnsName'"
  $text = $text -replace "(?m)^(\s*)tunnel: auto\s*$", "`$1tunnel: off"
  [IO.File]::WriteAllText($BridgeConfig, $text, (New-Object Text.UTF8Encoding($false)))
  Write-Host "已写入 $BridgeConfig（publicUrl=https://$dnsName，tunnel=off），重启 DSH Desktop 生效。" -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "把下面两行填进 profile 的 cordis.patch.yml 里 dshremote-bridge 的 config，然后重启 Desktop：" -ForegroundColor Yellow
  Write-Host "        publicUrl: 'https://$dnsName'"
  Write-Host '        tunnel: off'
}

Write-Host ''
Write-Host "固定地址：https://$dnsName" -ForegroundColor Green
