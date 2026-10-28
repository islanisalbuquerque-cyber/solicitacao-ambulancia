param(
  [Parameter(Mandatory = $true)][string]$SdkDirectory,
  [Parameter(Mandatory = $true)][string]$JavaDirectory,
  [Parameter(Mandatory = $true)][string]$SigningDirectory,
  [string]$BuildDirectory,
  [string]$OutputFile,
  [string]$BuildToolsVersion = '36.0.0',
  [string]$PlatformVersion = 'android-36'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectDirectory = $PSScriptRoot
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $projectDirectory 'build' }
if (-not $OutputFile) { $OutputFile = Join-Path $projectDirectory 'solicitacao-ambulancia.apk' }
$sdkPath = (Resolve-Path -LiteralPath $SdkDirectory).Path
$javaPath = (Resolve-Path -LiteralPath $JavaDirectory).Path
$toolsPath = Join-Path $sdkPath "build-tools/$BuildToolsVersion"
$androidJar = Join-Path $sdkPath "platforms/$PlatformVersion/android.jar"
foreach ($required in @($androidJar, "$toolsPath/aapt2.exe", "$toolsPath/d8.bat", "$toolsPath/zipalign.exe", "$toolsPath/apksigner.bat", "$javaPath/bin/javac.exe")) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Ferramenta não encontrada: $required" }
}

function Invoke-BuildTool {
  param([string]$Executable, [string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Falha na ferramenta de compilação: $(Split-Path -Leaf $Executable)" }
}

$oldJavaHome = $env:JAVA_HOME
$oldPath = $env:PATH
$securePassword = $null
try {
  $env:JAVA_HOME = $javaPath
  $env:PATH = "$javaPath/bin;$oldPath"
  $runDirectory = Join-Path ([IO.Path]::GetFullPath($BuildDirectory)) ([Guid]::NewGuid().ToString('N'))
  foreach ($child in @('gen', 'classes', 'dex')) { New-Item -ItemType Directory -Path (Join-Path $runDirectory $child) -Force | Out-Null }
  $signingPath = [IO.Path]::GetFullPath($SigningDirectory)
  New-Item -ItemType Directory -Path $signingPath -Force | Out-Null
  $keystore = Join-Path $signingPath 'ambulancia-signing.p12'
  $protectedPasswordFile = Join-Path $signingPath 'password.dpapi'

  if ((Test-Path -LiteralPath $keystore) -ne (Test-Path -LiteralPath $protectedPasswordFile)) {
    throw 'A chave e sua senha protegida devem estar juntas. Restaure o backup da assinatura.'
  }
  if (-not (Test-Path -LiteralPath $keystore)) {
    $randomBytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
    $signingPassword = [Convert]::ToBase64String($randomBytes)
    $securePassword = ConvertTo-SecureString -String $signingPassword -AsPlainText -Force
    ConvertFrom-SecureString -SecureString $securePassword | Set-Content -LiteralPath $protectedPasswordFile -Encoding utf8
    $env:AMBULANCIA_APK_STORE_PASSWORD = $signingPassword
    Invoke-BuildTool "$javaPath/bin/keytool.exe" @('-genkeypair', '-noprompt', '-keystore', $keystore, '-storetype', 'PKCS12', '-storepass:env', 'AMBULANCIA_APK_STORE_PASSWORD', '-keypass:env', 'AMBULANCIA_APK_STORE_PASSWORD', '-alias', 'ambulancia', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Central de Ambulancia, OU=Aplicativo, O=Central de Operacoes, C=BR')
  } else {
    $securePassword = ConvertTo-SecureString (Get-Content -LiteralPath $protectedPasswordFile -Raw).Trim()
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $env:AMBULANCIA_APK_STORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }

  $resources = Join-Path $runDirectory 'resources.zip'
  $unsignedApk = Join-Path $runDirectory 'unsigned.apk'
  $alignedApk = Join-Path $runDirectory 'aligned.apk'
  Invoke-BuildTool "$toolsPath/aapt2.exe" @('compile', '--dir', (Join-Path $projectDirectory 'res'), '-o', $resources)
  Invoke-BuildTool "$toolsPath/aapt2.exe" @('link', '-I', $androidJar, '--manifest', (Join-Path $projectDirectory 'AndroidManifest.xml'), '--java', (Join-Path $runDirectory 'gen'), '--min-sdk-version', '26', '--target-sdk-version', '36', '-o', $unsignedApk, $resources)

  $javaSources = @(Get-ChildItem -LiteralPath (Join-Path $projectDirectory 'src'), (Join-Path $runDirectory 'gen') -Recurse -Filter '*.java' -File | Select-Object -ExpandProperty FullName)
  Invoke-BuildTool "$javaPath/bin/javac.exe" (@('-encoding', 'UTF-8', '--release', '8', '-classpath', $androidJar, '-d', (Join-Path $runDirectory 'classes')) + $javaSources)
  $classesJar = Join-Path $runDirectory 'classes.jar'
  Invoke-BuildTool "$javaPath/bin/jar.exe" @('cf', $classesJar, '-C', (Join-Path $runDirectory 'classes'), '.')
  Invoke-BuildTool "$toolsPath/d8.bat" @('--release', '--min-api', '26', '--lib', $androidJar, '--output', (Join-Path $runDirectory 'dex'), $classesJar)
  Invoke-BuildTool "$javaPath/bin/jar.exe" @('uf', $unsignedApk, '-C', (Join-Path $runDirectory 'dex'), 'classes.dex')
  Invoke-BuildTool "$toolsPath/zipalign.exe" @('-f', '4', $unsignedApk, $alignedApk)

  $apkPath = [IO.Path]::GetFullPath($OutputFile)
  New-Item -ItemType Directory -Path (Split-Path -Parent $apkPath) -Force | Out-Null
  Invoke-BuildTool "$toolsPath/apksigner.bat" @('sign', '--ks', $keystore, '--ks-key-alias', 'ambulancia', '--ks-pass', 'env:AMBULANCIA_APK_STORE_PASSWORD', '--key-pass', 'env:AMBULANCIA_APK_STORE_PASSWORD', '--out', $apkPath, $alignedApk)
  Invoke-BuildTool "$toolsPath/apksigner.bat" @('verify', '--verbose', $apkPath)
  Invoke-BuildTool "$toolsPath/zipalign.exe" @('-c', '4', $apkPath)
  Write-Output "APK gerado e assinatura verificada: $apkPath"
} finally {
  $env:JAVA_HOME = $oldJavaHome
  $env:PATH = $oldPath
  Remove-Item Env:AMBULANCIA_APK_STORE_PASSWORD -ErrorAction SilentlyContinue
  $signingPassword = $null
  if ($securePassword) { $securePassword.Dispose() }
}
