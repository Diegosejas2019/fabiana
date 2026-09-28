param(
  [Parameter(Mandatory = $true)]
  [string] $ZipPath,

  [string] $OutputPath = "data/processed/zip-inventory.json"
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$resolvedZip = Resolve-Path -LiteralPath $ZipPath
$resolvedOutput = Join-Path (Get-Location) $OutputPath
$outputDirectory = Split-Path -Parent $resolvedOutput

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
try {
  $entries = $archive.Entries | ForEach-Object {
    [pscustomobject]@{
      name = $_.FullName
      extension = [System.IO.Path]::GetExtension($_.FullName).ToLowerInvariant()
      length = $_.Length
      compressedLength = $_.CompressedLength
      lastWriteTime = $_.LastWriteTime.ToString("o")
    }
  }

  $summary = $entries |
    Group-Object extension |
    Sort-Object Count -Descending |
    ForEach-Object {
      [pscustomobject]@{
        extension = if ($_.Name) { $_.Name } else { "(sin extension)" }
        count = $_.Count
        bytes = ($_.Group | Measure-Object length -Sum).Sum
      }
    }

  [pscustomobject]@{
    zipPath = $resolvedZip.Path
    totalEntries = $entries.Count
    summary = $summary
    entries = $entries
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8

  Write-Output "Inventario: $resolvedOutput"
}
finally {
  $archive.Dispose()
}

