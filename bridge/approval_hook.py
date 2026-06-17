#!/usr/bin/env python3
import sys
import json
import os
import urllib.request
import urllib.error

def main():
    # 1. Read input from stdin
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"decision": "deny", "reason": "No input received on stdin"}))
            return
        payload = json.loads(input_data)
    except Exception as e:
        print(json.dumps({"decision": "deny", "reason": f"Failed to parse stdin JSON: {str(e)}"}))
        return

    # Extract tool call details
    tool_call = payload.get("toolCall", {})
    tool_name = tool_call.get("name", "unknown")
    args = tool_call.get("args", {})
    command = args.get("CommandLine", "")
    
    # 2. Check channel
    channel = os.getenv("OPENGRIVITY_CHANNEL")
    
    if channel == "whatsapp":
        # Call the local HTTP server
        url = "http://localhost:3000/approve-request"
        req_data = json.dumps({
            "command": command,
            "tool_name": tool_name
        }).encode("utf-8")
        
        req = urllib.request.Request(
            url, 
            data=req_data, 
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        
        try:
            # Timeout is slightly longer than the bridge's internal timeout (120s)
            with urllib.request.urlopen(req, timeout=130) as response:
                resp_data = json.loads(response.read().decode("utf-8"))
                approved = resp_data.get("approved", False)
                if approved:
                    print(json.dumps({"decision": "allow"}))
                else:
                    reason = resp_data.get("reason", "Rejected via WhatsApp")
                    if "error" in resp_data:
                        reason = resp_data["error"]
                    print(json.dumps({"decision": "deny", "reason": reason}))
        except Exception as e:
            # Check if the bridge is running but not connected to WhatsApp
            try:
                status_req = urllib.request.Request("http://localhost:3000/status", method="GET")
                with urllib.request.urlopen(status_req, timeout=2) as status_resp:
                    status_data = json.loads(status_resp.read().decode("utf-8"))
                    if status_data.get("status") != "connected":
                        print(json.dumps({"decision": "deny", "reason": "Le pont WhatsApp est démarré mais n'est pas connecté à votre compte WhatsApp. Veuillez vous authentifier."}))
                        return
            except Exception:
                pass
            print(json.dumps({"decision": "deny", "reason": f"Impossible de contacter la passerelle WhatsApp : {str(e)}"}))
            
    else:
        # Fall back to allow (or default behavior) if not in WhatsApp context
        print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()
