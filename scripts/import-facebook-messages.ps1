param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [string]$TargetName = "Fabiana Sejas",
  [string]$SelfName = "Diego Sejas"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Repair-FacebookText {
  param([AllowNull()][string]$Value)

  if ($null -eq $Value) {
    return $null
  }

  # Facebook exports sometimes contain UTF-8 text decoded as Latin-1.
  try {
    $latin1 = [System.Text.Encoding]::GetEncoding("ISO-8859-1")
    return [System.Text.Encoding]::UTF8.GetString($latin1.GetBytes($Value))
  } catch {
    return $Value
  }
}

function Slugify {
  param([string]$Value)

  $normalized = $Value.ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD)
  $builder = [System.Text.StringBuilder]::new()
  foreach ($char in $normalized.ToCharArray()) {
    $category = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($char)
    if ($category -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$builder.Append($char)
    }
  }

  return ($builder.ToString() -replace "[^a-z0-9]+", "_" -replace "^_+|_+$", "")
}

function RoleForSender {
  param([string]$Sender)

  if ($Sender -eq $TargetName) {
    return "targetPerson"
  }
  if ($Sender -eq $SelfName) {
    return "self"
  }
  return "other"
}

function ParticipantIdForSender {
  param([string]$Sender)

  $role = RoleForSender $Sender
  if ($role -eq "targetPerson") {
    return "participant_target"
  }
  if ($role -eq "self") {
    return "participant_self"
  }
  return "participant_other_$(Slugify $Sender)"
}

function LocalDateForTimestamp {
  param([Int64]$TimestampMs)

  $date = [DateTimeOffset]::FromUnixTimeMilliseconds($TimestampMs).ToLocalTime()
  return @{
    Iso = [DateTimeOffset]::FromUnixTimeMilliseconds($TimestampMs).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    LocalDate = $date.ToString("d/M/yyyy", [Globalization.CultureInfo]::InvariantCulture)
    LocalTime = $date.ToString("HH:mm", [Globalization.CultureInfo]::InvariantCulture)
  }
}

function To-JsonLine {
  param($Value)
  return ($Value | ConvertTo-Json -Depth 20 -Compress)
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  $threadEntries = $zip.Entries | Where-Object {
    $_.FullName -match "^your_facebook_activity/messages/.*/message_\d+\.json$"
  }

  $messages = [System.Collections.Generic.List[object]]::new()
  $memories = [System.Collections.Generic.List[object]]::new()
  $participantsById = @{}
  $importedThreads = [System.Collections.Generic.List[object]]::new()
  $messageIndex = 0

  foreach ($entry in $threadEntries) {
    $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8, $true)
    try {
      $jsonText = $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }

    $thread = $jsonText | ConvertFrom-Json
    $title = Repair-FacebookText $thread.title
    $participantNames = @($thread.participants | ForEach-Object { Repair-FacebookText $_.name })

    if ($participantNames -notcontains $TargetName -and $title -ne $TargetName) {
      continue
    }

    $threadSlug = (($entry.FullName -split "/")[-2])
    $threadMessages = @($thread.messages) | Sort-Object timestamp_ms
    $importedThreads.Add([PSCustomObject]@{
      title = $title
      path = $entry.FullName
      participants = $participantNames
      messageCount = $threadMessages.Count
    }) | Out-Null

    foreach ($participantName in $participantNames) {
      $participantId = ParticipantIdForSender $participantName
      if (-not $participantsById.ContainsKey($participantId)) {
        $participantsById[$participantId] = [PSCustomObject]@{
          id = $participantId
          role = RoleForSender $participantName
          author = $participantName
          displayName = $participantName
        }
      }
    }

    $threadMessageIndex = 0
    foreach ($message in $threadMessages) {
      $messageIndex++
      $threadMessageIndex++
      $sender = Repair-FacebookText $message.sender_name
      $content = Repair-FacebookText $message.content
      $timestamp = LocalDateForTimestamp ([Int64]$message.timestamp_ms)
      $role = RoleForSender $sender
      $participantId = ParticipantIdForSender $sender
      $messageId = "fb_$($threadSlug)_msg_$($threadMessageIndex.ToString("000000"))"

      $photoCount = @($message.photos).Count
      $videoCount = @($message.videos).Count
      $audioCount = @($message.audio_files).Count
      $fileCount = @($message.files).Count
      $media = $null
      if (($photoCount + $videoCount + $audioCount + $fileCount) -gt 0) {
        $media = [PSCustomObject]@{
          photoCount = $photoCount
          videoCount = $videoCount
          audioCount = $audioCount
          fileCount = $fileCount
        }
      }

      $source = [PSCustomObject]@{
        format = "facebook_export"
        zipPath = $ZipPath
        threadPath = $entry.FullName
        threadTitle = $title
        messageIndex = $threadMessageIndex
      }

      $normalized = [PSCustomObject]@{
        id = $messageId
        kind = "message"
        timestamp = $timestamp.Iso
        localDate = $timestamp.LocalDate
        localTime = $timestamp.LocalTime
        participantId = $participantId
        role = $role
        author = $sender
        text = $content
        textLength = if ($content) { $content.Length } else { 0 }
        media = $media
        source = $source
      }
      $messages.Add($normalized) | Out-Null

      if ($content -and $content.Trim().Length -gt 0) {
        $trimmed = $content.Trim()
        $memory = [PSCustomObject]@{
          id = "mem_$($messageId)_facebook_text"
          messageId = $messageId
          timestamp = $timestamp.Iso
          localDate = $timestamp.LocalDate
          localTime = $timestamp.LocalTime
          role = $role
          participantId = $participantId
          sourceType = "facebook_text"
          text = $trimmed
          textLength = $trimmed.Length
          eligibleForPersona = ($role -eq "targetPerson")
          evidence = [PSCustomObject]@{
            kind = "facebook_text"
            messageId = $messageId
            source = $source
          }
        }
        $memories.Add($memory) | Out-Null
      }
    }
  }

  $messagesSorted = $messages | Sort-Object timestamp, id
  $memoriesSorted = $memories | Sort-Object timestamp, id
  $participants = $participantsById.Values | Sort-Object id

  $messagesJsonl = ($messagesSorted | ForEach-Object { To-JsonLine $_ }) -join "`n"
  $memoriesJsonl = ($memoriesSorted | ForEach-Object { To-JsonLine $_ }) -join "`n"

  Set-Content -LiteralPath (Join-Path $OutputDir "messages.jsonl") -Value ($messagesJsonl + "`n") -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $OutputDir "memories.jsonl") -Value ($memoriesJsonl + "`n") -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $OutputDir "participants.json") -Value (($participants | ConvertTo-Json -Depth 20) + "`n") -Encoding UTF8

  $manifest = [PSCustomObject]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
    zipPath = $ZipPath
    targetName = $TargetName
    selfName = $SelfName
    importedThreads = $importedThreads
    messageCount = @($messagesSorted).Count
    memoryCount = @($memoriesSorted).Count
    byRole = @{}
    bySourceType = @{ facebook_text = @($memoriesSorted).Count }
    firstTimestamp = @($messagesSorted)[0].timestamp
    lastTimestamp = @($messagesSorted)[@($messagesSorted).Count - 1].timestamp
  }

  foreach ($roleGroup in ($messagesSorted | Group-Object role)) {
    $manifest.byRole[$roleGroup.Name] = $roleGroup.Count
  }

  Set-Content -LiteralPath (Join-Path $OutputDir "manifest.json") -Value (($manifest | ConvertTo-Json -Depth 20) + "`n") -Encoding UTF8

  [PSCustomObject]@{
    outputDir = $OutputDir
    importedThreadCount = $importedThreads.Count
    messageCount = @($messagesSorted).Count
    memoryCount = @($memoriesSorted).Count
    byRole = $manifest.byRole
    firstTimestamp = $manifest.firstTimestamp
    lastTimestamp = $manifest.lastTimestamp
  } | ConvertTo-Json -Depth 20
} finally {
  $zip.Dispose()
}
