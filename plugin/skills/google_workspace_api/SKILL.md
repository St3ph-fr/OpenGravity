---
name: google_workspace_api_bash
description: Efficient Bash/Curl & PowerShell toolkit for Google Workspace API authentication, execution, base64url decoding, and multipart uploads.
---

# Google Workspace API: Bash & PowerShell Execution Guide
This skill provides streamlined guidelines and reusable helper scripts for executing requests against Google Workspace APIs (Gmail, Drive, Calendar, etc.) on Linux/macOS (Bash) and Windows (PowerShell) environments.

## 1. Unified Bash Helper Script (Linux / macOS)
For Linux/macOS, source or write the following functions (e.g., to `gw_helper.sh`) to handle standard operations safely. It requires `curl` and `jq`.

```bash
#!/bash
# --- 1. AUTHENTICATION ---
# Fetches the OAuth Token. Uses -d and -L to safely follow 302 redirects.
get_google_token() {
    curl -sL -H "Content-Type: application/json" \
         -d '{"apiKey": "YOUR_API_KEY"}' \
         "YOUR_GOOGLE_APPS_SCRIPT_URL" | jq -r '.access_token'
}

# --- 2. STANDARD API REQUEST ---
# Usage: google_api_request <TOKEN> <METHOD> <URL> [JSON_BODY]
google_api_request() {
    local token=$1 method=$2 url=$3 body=$4
    if [ -n "$body" ]; then
        curl -s -X "$method" -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body" "$url"
    else
        curl -s -X "$method" -H "Authorization: Bearer $token" "$url"
    fi
}

# --- 3. URL ENCODING ---
# Usage: url_encode "string with spaces or symbols"
url_encode() {
    jq -rn --arg x "$1" '$x|@uri'
}

# --- 4. BASE64URL DECODE (GMAIL) ---
# Usage: echo "base64url_string" | decode_base64url
decode_base64url() {
    sed 's/-/+/g; s/_/\//g' | awk '{ padding = 4 - (length($0) % 4); if (padding < 4) for (i=1; i<=padding; i++) printf "="; print "" }' | base64 -d
}

# --- 5. DRIVE MULTIPART UPLOAD ---
# Usage: upload_drive_file <TOKEN> <FILE_PATH> <MIME_TYPE> <NEW_NAME>
upload_drive_file() {
    local token=$1 file=$2 mime=$3 name=$4
    local boundary="gw_api_boundary_$(date +%s)"
    
    # Create metadata part
    printf -- "--%s\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{\"name\": \"%s\", \"mimeType\": \"%s\"}\r\n" "$boundary" "$name" "$mime" > meta.txt
    printf -- "\r\n--%s--\r\n" "$boundary" > end.txt
    cat meta.txt "$file" end.txt > upload.bin # Safe binary concatenation
    
    curl -s -X POST -H "Authorization: Bearer $token" \
         -H "Content-Type: multipart/related; boundary=$boundary" \
         --data-binary "@upload.bin" \
         "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"
    
    rm meta.txt end.txt upload.bin
}
```

## 2. Unified PowerShell Helper Script (Windows / PowerShell)
For Windows, import or run the following PowerShell functions (e.g., from `gw_helper.ps1`) to avoid quote escaping and display truncation issues.

```powershell
# --- 1. AUTHENTICATION ---
# Fetches the OAuth Token. Handles redirect safely and displays raw token to avoid truncation.
function Get-GoogleToken {
    $body = @{ apiKey = "YOUR_API_KEY" } | ConvertTo-Json
    $resp = Invoke-RestMethod -Method Post -Uri "YOUR_GOOGLE_APPS_SCRIPT_URL" -ContentType "application/json" -Body $body
    return $resp.access_token
}

# --- 2. STANDARD API REQUEST ---
# Converts JSON body to UTF-8 byte array and sets charset explicitly to avoid character corruption (é, à, etc.).
# Usage: Invoke-GoogleApiRequest -Token $token -Method "POST" -Uri "https://..." -Body '{"key": "value"}'
function Invoke-GoogleApiRequest {
    param (
        [string]$Token,
        [string]$Method,
        [string]$Uri,
        [string]$Body
    )
    $headers = @{ Authorization = "Bearer $Token" }
    if ($Body) {
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
        return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bodyBytes
    } else {
        return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers
    }
}

# --- 3. URL ENCODING ---
# Usage: $encoded = ConvertTo-UrlEncoded "string with spaces or symbols"
function ConvertTo-UrlEncoded {
    param ([string]$String)
    return [uri]::EscapeDataString($String)
}

# --- 4. BASE64URL DECODE (GMAIL) ---
# Usage: $decodedText = Decode-Base64Url "base64url_string"
function Decode-Base64Url {
    param ([string]$InputString)
    $base64 = $InputString.Replace('-', '+').Replace('_', '/')
    $mod = $base64.Length % 4
    if ($mod -ne 0) { $base64 += "=" * (4 - $mod) }
    $bytes = [System.Convert]::FromBase64String($base64)
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

# --- 5. DRIVE MULTIPART UPLOAD ---
# Safe binary merger via MemoryStream to prevent encoding and corruption issues on Windows.
# Usage: Send-DriveMultipartUpload -Token $token -FilePath "C:\file.jpg" -MimeType "image/jpeg" -NewName "uploaded_file.jpg"
function Send-DriveMultipartUpload {
    param (
        [string]$Token,
        [string]$FilePath,
        [string]$MimeType,
        [string]$NewName
    )
    $boundary = "gw_api_boundary_$(Get-Date -UFormat %s)"
    
    # Read binary file bytes safely
    $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
    
    # Metadata JSON
    $metadataJson = @{
        name = $NewName
        mimeType = $MimeType
    } | ConvertTo-Json -Compress
    
    # Construct multipart text headers
    $firstPart = @"
--$boundary
Content-Type: application/json; charset=UTF-8

$metadataJson

--$boundary
Content-Type: $MimeType

"@
    
    $firstPartBytes = [System.Text.Encoding]::UTF8.GetBytes($firstPart)
    $endBoundaryBytes = [System.Text.Encoding]::UTF8.GetBytes("`r`n--$boundary--`r`n")
    
    # Safely merge byte arrays in memory
    $bodyStream = [System.IO.MemoryStream]::new()
    $bodyStream.Write($firstPartBytes, 0, $firstPartBytes.Length)
    $bodyStream.Write($fileBytes, 0, $fileBytes.Length)
    $bodyStream.Write($endBoundaryBytes, 0, $endBoundaryBytes.Length)
    $bodyBytesArray = $bodyStream.ToArray()
    $bodyStream.Dispose()
    
    $headers = @{ Authorization = "Bearer $Token" }
    $uri = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"
    $contentType = "multipart/related; boundary=$boundary"
    
    return Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType $contentType -Body $bodyBytesArray
}
```

## 3. Service-Specific Rules

### A. URL Encoding (Critical)
Always URL-encode query parameters containing spaces, colons, or plus signs.
*   *Gmail:* `q=puy%20du%20fou`
*   *Calendar:* `timeMin=2026-07-09T00%3A00%3A00Z` (Use `url_encode` or `ConvertTo-UrlEncoded` helper).
*   *PowerShell URI rule:* Always wrap URLs containing ampersands (`&`) in quotes in PowerShell to prevent background job execution errors.

### B. Calendar API Dates
*   **Format:** RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS+HH:MM`).
*   **Timed vs. All-Day:**
    *   Timed events use the `dateTime` field (e.g., `start.dateTime`).
    *   All-Day events use the `date` field (e.g., `start.date`).
    *   *Always implement logic using JQ or PowerShell to check both:*
        *   *JQ:* `jq '.start.dateTime // .start.date'`
        *   *PowerShell:* `$start = if ($event.start.dateTime) { $event.start.dateTime } else { $event.start.date }`

## 4. Error Handling & Discovery SOP

If an API call returns an error (`403`, `400`, etc.), follow this Standard Operating Procedure:

1.  **403 Forbidden / Unauthorized:** The temporary token expired. Call `get_google_token()` / `Get-GoogleToken` to fetch a new one and retry the request exactly **once**. If it fails again, abort and notify the user.
2.  **400 Bad Request (Malformed Query):** 
    *   Do not guess the fix.
    *   Fetch the Discovery Document for the failing service via `curl` / `Invoke-RestMethod`:
        *   **Gmail:** `https://gmail.googleapis.com/$discovery/rest?version=v1`
        *   **Drive:** `https://www.googleapis.com/discovery/v1/apis/drive/v3/rest`
        *   **Calendar:** `https://calendar-json.googleapis.com/$discovery/rest?version=v3`
        *   **Tasks:** `https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest`
        *   **Docs/Sheets/Slides:** `https://[service].googleapis.com/$discovery/rest?version=[v1/v4]`
    *   Search the discovery document for the correct path, parameters, or schema.
    *   Correct the API request and rerun.
