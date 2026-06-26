$body = @{ apiKey = "YOUR_API_KEY" } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post -Uri "YOUR_GOOGLE_APPS_SCRIPT_URL" -ContentType "application/json" -Body $body
if ($resp.status -eq "success") {
    Write-Output $resp.access_token
} else {
    Write-Error "Failed to retrieve token: $($resp | ConvertTo-Json -Compress)"
}
