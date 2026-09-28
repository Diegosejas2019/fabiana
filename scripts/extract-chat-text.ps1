param(
  [Parameter(Mandatory = $true)]
  [string] $ZipPath,

  [string] $OutputPath = "data/raw/chat.txt"
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$resolvedZip = Resolve-Path -LiteralPath $ZipPath
$resolvedOutput = Join-Path (Get-Location) $OutputPath
$outputDirectory = Split-Path -Parent $resolvedOutput

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
try {
  $entry = $archive.Entries | Where-Object { $_.FullName -like "*.txt" } | Select-Object -First 1
  if (-not $entry) {
    throw "No se encontro ningun .txt dentro del ZIP."
  }

  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $resolvedOutput, $true)
  Write-Output "Extraido: $resolvedOutput"
}
finally {
  $archive.Dispose()
}

