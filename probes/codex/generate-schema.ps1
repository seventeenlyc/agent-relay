$ErrorActionPreference = "Stop"
$outDir = "$PSScriptRoot/schema"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
Write-Host "Generating Codex app-server TypeScript bindings..."
codex app-server generate-ts --out "$outDir/ts" --experimental
Write-Host "Generating Codex app-server JSON Schema..."
codex app-server generate-json-schema --out "$outDir/json" --experimental
Write-Host "Done. Generated files located at: $outDir"
