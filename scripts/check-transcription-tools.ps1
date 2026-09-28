$commands = @("ffmpeg", "whisper", "faster-whisper", "python", "py")

$commands | ForEach-Object {
  $cmd = Get-Command $_ -ErrorAction SilentlyContinue
  if ($cmd) {
    [pscustomobject]@{
      Name = $_
      Available = $true
      Source = $cmd.Source
      Version = $cmd.Version
    }
  }
  else {
    [pscustomobject]@{
      Name = $_
      Available = $false
      Source = $null
      Version = $null
    }
  }
} | ConvertTo-Json -Depth 3

