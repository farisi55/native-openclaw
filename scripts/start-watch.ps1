$restartCode = 42

do {
  node dist/index.js
  $exitCode = $LASTEXITCODE

  if ($exitCode -eq $restartCode) {
    Write-Host "smooth requested restart with exit code 42."
    Write-Host "Restarting now..."
    Start-Sleep -Seconds 1
  }
} while ($exitCode -eq $restartCode)

exit $exitCode
