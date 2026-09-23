param([string]$Destination = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$moduleRoot = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $moduleRoot 'module.json') -Raw | ConvertFrom-Json
if ($manifest.id -notmatch '^[a-z0-9][a-z0-9-]*$' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw 'Invalid module id or release version.'
}
$releaseRoot = [System.IO.Path]::GetFullPath($Destination)
$requiredFiles = @(
  'module.json', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', '规则依据.md',
  'lang/en.json', 'lang/zh-cn.json', 'scripts/i18n.mjs',
  'scripts/main.mjs', 'scripts/runtime.mjs', 'scripts/ui.mjs', 'scripts/ui-state.mjs',
  'scripts/model.mjs', 'scripts/context.mjs', 'scripts/calendar.mjs', 'scripts/weather.mjs',
  'scripts/assistant-core.mjs', 'scripts/assistants.mjs',
  'scripts/nightmare-model.mjs', 'scripts/nightmares.mjs',
  'scripts/boon-model.mjs', 'scripts/boons.mjs',
  'scripts/hazard-model.mjs', 'scripts/hazards.mjs',
  'scripts/soulheart-model.mjs', 'scripts/soulhearts.mjs',
  'styles/companion.css',
  'macros/sync-chapter.js', 'macros/adventure-assistants.js', 'macros/use-soulheart.js'
)
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$buildId = [Guid]::NewGuid().ToString('N')
$stageRoot = Join-Path $releaseRoot ('.stage-' + $buildId)
$stage = Join-Path $stageRoot $manifest.id
$temporaryArchive = Join-Path $releaseRoot ('.archive-' + $buildId + '.zip')
$archive = Join-Path $releaseRoot ($manifest.id + '-' + $manifest.version + '.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  foreach ($name in $requiredFiles) {
    $source = Join-Path $moduleRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing release source: $name" }
    $target = Join-Path $stage $name
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
  }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $temporaryArchive, [System.IO.Compression.CompressionLevel]::Optimal, $true, [System.Text.UTF8Encoding]::new($false))
  $zip = [System.IO.Compression.ZipFile]::OpenRead($temporaryArchive)
  try {
    $entries = @($zip.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\', '/') })
    $expected = @($requiredFiles | ForEach-Object { $manifest.id + '/' + $_ })
    if ($entries.Count -ne $expected.Count -or @(Compare-Object -ReferenceObject $expected -DifferenceObject $entries).Count) {
      throw "Archive does not match the exact release list: $($entries.Count) files."
    }
  } finally { $zip.Dispose() }
  Move-Item -LiteralPath $temporaryArchive -Destination $archive -Force
} finally {
  # Only remove this invocation's generated staging directory, inside its resolved output directory.
  $outputPrefix = $releaseRoot.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
  if (-not $resolvedStage.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      [System.IO.Path]::GetFileName($resolvedStage) -ne ('.stage-' + $buildId)) {
    throw 'Refusing to remove a staging directory outside the build output.'
  }
  if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
  if (Test-Path -LiteralPath $temporaryArchive -PathType Leaf) { Remove-Item -LiteralPath $temporaryArchive -Force }
}
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'), ($hash + '  ' + [System.IO.Path]::GetFileName($archive) + "`n"))
[pscustomobject]@{ archive = $archive; files = $entries.Count; sha256 = $hash } | ConvertTo-Json
