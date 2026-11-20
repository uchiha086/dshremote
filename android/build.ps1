# Build a signed DSH Remote APK with the plain command line toolchain (no Gradle).
# Requires: C:\Users\user\android-sdk with build-tools 34.0.0, and JDK at E:\dev\DevEco Studio\jbr
param(
  [string]$Sdk = 'C:\Users\user\android-sdk',
  [string]$Jdk = 'E:\dev\DevEco Studio\jbr',
  [string]$VersionName = '0.2.0',
  [int]$VersionCode = 3
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'src\main'
$out = Join-Path $here 'build'
$gen = Join-Path $here 'gen'
$classes = Join-Path $here 'classes'

$buildTools = Join-Path $Sdk 'build-tools\34.0.0'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'lib\apksigner.jar'
$d8Jar = Join-Path $buildTools 'lib\d8.jar'
$androidJar = Join-Path $Sdk 'platforms\android-34\android.jar'
$java = Join-Path $Jdk 'bin\java.exe'
$javac = Join-Path $Jdk 'bin\javac.exe'
$keytool = Join-Path $Jdk 'bin\keytool.exe'

foreach ($p in @($aapt2, $zipalign, $apksigner, $androidJar, $java, $javac)) {
  if (-not (Test-Path $p)) { throw "missing tool: $p" }
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
if (Test-Path $gen) { Remove-Item $gen -Recurse -Force }
if (Test-Path $classes) { Remove-Item $classes -Recurse -Force }
New-Item -ItemType Directory -Path $out, $gen, $classes | Out-Null

Write-Host '== aapt2 compile'
& $aapt2 compile --dir (Join-Path $src 'res') -o (Join-Path $out 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '== aapt2 link'
& $aapt2 link `
  -o (Join-Path $out 'app-unsigned.apk') `
  -I $androidJar `
  --manifest (Join-Path $src 'AndroidManifest.xml') `
  --java $gen `
  --min-sdk-version 24 --target-sdk-version 34 `
  --version-code $VersionCode --version-name $VersionName `
  --auto-add-overlay `
  (Join-Path $out 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '== javac'
$sources = @()
Get-ChildItem -Path (Join-Path $src 'java') -Recurse -Filter *.java | ForEach-Object { $sources += $_.FullName }
Get-ChildItem -Path $gen -Recurse -Filter *.java | ForEach-Object { $sources += $_.FullName }
& $javac -encoding UTF-8 --release 11 -classpath $androidJar -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '== d8'
$classFiles = Get-ChildItem -Path $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& $java -cp $d8Jar com.android.tools.r8.D8 --lib $androidJar --min-api 24 --output $out @classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Host '== add classes.dex to apk'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apkPath = Join-Path $out 'app-unsigned.apk'
$dex = Join-Path $out 'classes.dex'
$zip = [System.IO.Compression.ZipFile]::Open($apkPath, 'Update')
$entry = $zip.GetEntry('classes.dex')
if ($entry) { $entry.Delete() }
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dex, 'classes.dex') | Out-Null
$zip.Dispose()

Write-Host '== zipalign'
& $zipalign -p 4 (Join-Path $out 'app-unsigned.apk') (Join-Path $out 'app-aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Write-Host '== sign'
$ks = Join-Path $here 'debug.keystore'
if (-not (Test-Path $ks)) {
  & $keytool -genkeypair -keystore $ks -alias dshremote -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass dshremote -keypass dshremote -dname "CN=DSH Remote, O=dshremote, C=CN" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
$final = Join-Path $here ("dshremote-android-{0}.apk" -f $VersionName)
if (Test-Path $final) { Remove-Item $final -Force }
& $java -jar $apksigner sign --ks $ks --ks-pass pass:dshremote --key-pass pass:dshremote `
  --out $final (Join-Path $out 'app-aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Write-Host '== verify'
& $java -jar $apksigner verify --print-certs $final
& $aapt2 dump badging $final | Select-String 'package:|application-label|launchable-activity'
Write-Host ("APK: {0} ({1:N0} bytes)" -f $final, (Get-Item $final).Length)
