param([string]$Destination = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$moduleRoot = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $moduleRoot 'module.json') -Raw | ConvertFrom-Json
$releaseRoot = [System.IO.Path]::GetFullPath($Destination)
$stage = Join-Path $releaseRoot $manifest.id
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($name in @('module.json', 'README.md', '规则依据.md', 'scripts', 'styles', 'macros')) {
  Copy-Item -LiteralPath (Join-Path $moduleRoot $name) -Destination $stage -Recurse -Force
}
$archive = Join-Path $releaseRoot ($manifest.id + '-' + $manifest.version + '.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $true, [System.Text.UTF8Encoding]::new($false))
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
  $entries = @($zip.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\', '/') })
  $requiredFiles = @('module.json', 'scripts/main.mjs', 'scripts/runtime.mjs', 'scripts/ui.mjs', 'scripts/ui-state.mjs', 'scripts/model.mjs', 'scripts/context.mjs', 'scripts/calendar.mjs', 'scripts/weather.mjs', 'styles/companion.css', 'macros/sync-chapter.js', 'README.md', '规则依据.md')
  foreach ($required in $requiredFiles) {
    if (($manifest.id + '/' + $required) -notin $entries) { throw "Missing archive entry: $required" }
  }
  if ($entries.Count -ne $requiredFiles.Count) { throw "Unexpected archive contents: $($entries.Count) files" }
} finally { $zip.Dispose() }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'), ($hash + '  ' + [System.IO.Path]::GetFileName($archive) + "`n"))
[pscustomobject]@{ archive = $archive; files = $entries.Count; sha256 = $hash } | ConvertTo-Json
