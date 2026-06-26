function Decode-Base64Url {
    param (
        [Parameter(Mandatory=$true, ValueFromPipeline=$true)]
        [string]$InputString
    )
    
    # Replace URL-safe characters
    $base64 = $InputString.Replace('-', '+').Replace('_', '/')
    
    # Add padding characters (=)
    $mod = $base64.Length % 4
    if ($mod -ne 0) {
        $base64 += "=" * (4 - $mod)
    }
    
    # Convert from Base64 string to bytes
    $bytes = [Convert]::FromBase64String($base64)
    
    # Try to decode as UTF-8 string, otherwise return the raw bytes
    try {
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        return $bytes
    }
}

if ($args.Count -gt 0) {
    Decode-Base64Url -InputString $args[0]
} else {
    $input | ForEach-Object { Decode-Base64Url -InputString $_ }
}
