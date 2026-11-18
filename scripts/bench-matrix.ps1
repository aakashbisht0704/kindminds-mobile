<#
.SYNOPSIS
  Measure the text model on this machine: prefill, decode, total latency, peak RSS.

.DESCRIPTION
  Runs the app's own prompt builder (scripts/eval-local-model.ts) against a fresh
  llama-server for each configuration, so the numbers describe the shipped path
  rather than a hand-written prompt. Threads and batch size are what a phone
  build would pick; peak memory is sampled while the request is in flight,
  because a per-process peak is the number that decides whether a 3 GB phone can
  hold the model at all.

.EXAMPLE
  pwsh -File scripts/bench-matrix.ps1
  pwsh -File scripts/bench-matrix.ps1 -Configs "2:128","4:256" -Query "panic attack"
#>
param(
  [string[]]$Configs = @('2:128', '2:256', '4:128', '4:256'),
  [string]$Query = 'heavy bleeding',
  [string]$Server = (Join-Path $PSScriptRoot '../Temp/llama-b11556/llama-server.exe'),
  [string]$Model = (Join-Path $PSScriptRoot '../Temp/qwen2.5-1.5b-q4km.gguf'),
  [int]$Port = 8099
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun/bin/bun.exe' }
$url = "http://127.0.0.1:$Port"

function Wait-Healthy([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      $body = Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 2
      if ($body.Content -match 'ok') { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

$rows = @()
foreach ($config in $Configs) {
  $parts = $config.Split(':')
  $threads = [int]$parts[0]
  $batch = [int]$parts[1]
  $log = Join-Path $repo "Temp/bench-$threads-$batch.log"

  $serverArgs = @('-m', $Model, '-c', '2048', '-t', "$threads", '-b', "$batch", '--port', "$Port", '--no-webui')
  $proc = Start-Process -FilePath $Server -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"

  if (-not (Wait-Healthy 90)) {
    Write-Warning "server did not become healthy for t=$threads b=$batch"
    if (-not $proc.HasExited) { $proc.Kill() }
    continue
  }

  # First request pays model load in the same process; it is excluded by
  # warming once with a tiny prompt, then the measured request runs.
  $warm = @{ messages = @(@{ role = 'user'; content = 'hi' }); max_tokens = 1; stream = $false } | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Uri "$url/v1/chat/completions" -Method Post -Body $warm -ContentType 'application/json' | Out-Null

  $env:KM_SERVER = "$url/v1/chat/completions"
  $env:KM_LANG = ''
  $env:KM_MODE = ''
  $env:KM_SOURCE = ''
  $env:JSON = $null
  $outFile = Join-Path $repo "Temp/bench-$threads-$batch.out"
  $job = Start-Job -ScriptBlock {
    param($bun, $repo, $query)
    Set-Location $repo
    & $bun scripts/eval-local-model.ts $query 2>&1
  } -ArgumentList $bun, $repo, $Query

  $peak = 0
  while ($job.State -eq 'Running') {
    try {
      $proc.Refresh()
      if ($proc.WorkingSet64 -gt $peak) { $peak = $proc.WorkingSet64 }
    } catch { }
    Start-Sleep -Milliseconds 100
  }
  $output = Receive-Job $job
  Remove-Job $job
  $output | Out-File -FilePath $outFile -Encoding utf8

  try {
    $proc.Refresh()
    if ($proc.WorkingSet64 -gt $peak) { $peak = $proc.WorkingSet64 }
  } catch { }

  if (-not $proc.HasExited) { $proc.Kill() }
  Start-Sleep -Seconds 1

  $text = ($output | Out-String)
  $prefill = [regex]::Match($text, 'prefill\s+([0-9.]+)s\s+\(([0-9.]+) tok/s\)')
  $decode = [regex]::Match($text, 'decode\s+([0-9.]+) tok/s')
  $tokens = [regex]::Match($text, ',\s+([0-9]+) tokens')
  $verdict = [regex]::Match($text, 'verdict: ([A-Z]+)(?:\s+\(([^)]*)\))?')

  $rows += [pscustomobject]@{
    Threads      = $threads
    Batch        = $batch
    PrefillSec   = if ($prefill.Success) { [double]$prefill.Groups[1].Value } else { 0 }
    PrefillTokS  = if ($prefill.Success) { [double]$prefill.Groups[2].Value } else { 0 }
    DecodeTokS   = if ($decode.Success) { [double]$decode.Groups[1].Value } else { 0 }
    Tokens       = if ($tokens.Success) { [int]$tokens.Groups[1].Value } else { 0 }
    LatencySec   = if ($prefill.Success -and $decode.Success -and $tokens.Success) {
      [math]::Round([double]$prefill.Groups[1].Value + ($tokens.Groups[1].Value / [double]$decode.Groups[1].Value), 1)
    } else { 0 }
    PeakRssMb    = [math]::Round($peak / 1MB, 0)
    Verdict      = if ($verdict.Success) { "$($verdict.Groups[1].Value) $($verdict.Groups[2].Value)".Trim() } else { 'n/a' }
  }
  $rows[-1] | Format-List | Out-String | Write-Host
}

Write-Host "`n-- matrix --"
$rows | Format-Table -AutoSize | Out-String | Write-Host
