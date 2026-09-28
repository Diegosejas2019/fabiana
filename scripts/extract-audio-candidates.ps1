param(
  [Parameter(Mandatory = $true)]
  [string] $ZipPath,

  [Parameter(Mandatory = $true)]
  [string] $CandidatesPath,

  [Parameter(Mandatory = $true)]
  [string] $OutputDir,

  [string] $Role = "targetPerson",

  [int] $Limit = 0
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$resolvedZip = Resolve-Path -LiteralPath $ZipPath
$resolvedCandidates = Resolve-Path -LiteralPath $CandidatesPath
$resolvedOutput = Join-Path (Get-Location) $OutputDir

New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

$candidates = Get-Content -LiteralPath $resolvedCandidates |
  Where-Object { $_.Trim().Length -gt 0 } |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.role -eq $Role -and $_.mediaStatus -eq "matched" }

if ($Limit -gt 0) {
  $candidates = $candidates | Select-Object -First $Limit
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
$files = @()
$missing = 0
$skipped = 0
$extracted = 0

try {
  $entryMap = @{}
  foreach ($entry in $archive.Entries) {
    $entryMap[$entry.FullName.ToLowerInvariant()] = $entry
  }

  foreach ($candidate in $candidates) {
    $entryName = [string] $candidate.zipEntryName
    $entry = $entryMap[$entryName.ToLowerInvariant()]

    if (-not $entry) {
      $missing++
      $files += [pscustomobject]@{
        candidateId = $candidate.id
        messageId = $candidate.messageId
        role = $candidate.role
        filename = $candidate.filename
        zipEntryName = $candidate.zipEntryName
        bytes = $candidate.bytes
        localPath = $null
        status = "missing"
      }
      continue
    }

    $safeName = [System.IO.Path]::GetFileName([string] $candidate.filename)
    $destination = Join-Path $resolvedOutput $safeName

    if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Length -eq $entry.Length)) {
      $skipped++
      $status = "skipped_existing"
    }
    else {
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
      $extracted++
      $status = "extracted"
    }

    $files += [pscustomobject]@{
      candidateId = $candidate.id
      messageId = $candidate.messageId
      role = $candidate.role
      filename = $candidate.filename
      zipEntryName = $candidate.zipEntryName
      bytes = $entry.Length
      localPath = $destination
      status = $status
    }
  }

  $manifest = [pscustomobject]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    zipPath = $resolvedZip.Path
    candidatesPath = $resolvedCandidates.Path
    outputDir = $resolvedOutput
    filter = [pscustomobject]@{
      role = $Role
      limit = $Limit
    }
    candidateCount = @($candidates).Count
    extractedCount = $extracted
    skippedExistingCount = $skipped
    missingCount = $missing
    files = $files
  }

  $manifestPath = Join-Path $resolvedOutput "extraction-manifest.json"
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  Write-Output "Manifest: $manifestPath"
  Write-Output "Candidates: $(@($candidates).Count)"
  Write-Output "Extracted: $extracted"
  Write-Output "Skipped existing: $skipped"
  Write-Output "Missing: $missing"
}
finally {
  $archive.Dispose()
}

