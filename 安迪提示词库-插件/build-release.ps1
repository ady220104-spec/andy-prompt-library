# Build a clean Chrome extension zip for release.
# Only the runtime extension files are included. Docs, backup-host, .audit and tests are excluded.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'dist')
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw 'manifest.json not found' }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if (-not $version) { throw 'manifest version is empty' }

$files = @(
  'manifest.json',
  'background.js',
  'content.js',
  'vars.js',
  'panel.js',
  'panel.html',
  'panel.css',
  'seed.json',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
)
foreach ($f in $files) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) { throw "missing runtime file: $f" }
}
foreach ($bad in @('.audit', 'backup-host', 'dist', '修复备份.cmd', '安装说明.md')) {
  if ($files -contains $bad) { throw "refusing to package $bad" }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('andy-prompts-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  foreach ($f in $files) {
    $dst = Join-Path $stage $f
    $dir = Split-Path -Parent $dst
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item (Join-Path $root $f) $dst -Force
  }
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
  $zip = Join-Path $OutDir ("andy-prompts-v{0}.zip" -f $version)
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  $listed = Get-ChildItem $stage -Recurse -File | ForEach-Object { $_.FullName.Substring($stage.Length + 1) }
  Write-Output ("built: {0}" -f $zip)
  Write-Output ("version: {0}" -f $version)
  Write-Output ("files: {0}" -f $listed.Count)
  $listed | ForEach-Object { Write-Output ("  " + $_) }
  Write-Output ("size: {0} bytes" -f (Get-Item $zip).Length)
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
