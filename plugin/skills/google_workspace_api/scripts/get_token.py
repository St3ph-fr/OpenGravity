import sys
import json
import urllib.request

def main():
    url = "YOUR_GOOGLE_APPS_SCRIPT_URL"
    payload = {"apiKey": "YOUR_API_KEY"}
    headers = {"Content-Type": "application/json"}
    
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            res = json.loads(response.read().decode('utf-8'))
            if res.get("status") == "success":
                # Print token directly to stdout
                print(res.get("access_token"))
            else:
                print(f"Error: {res}", file=sys.stderr)
                sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
