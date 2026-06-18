#!/usr/bin/env python3
import sys
import json
import os
import urllib.request
import urllib.error

def disable_hook_locally():
    try:
        hooks_path = os.path.expanduser("~/.gemini/config/hooks.json")
        if os.path.exists(hooks_path):
            with open(hooks_path, "r", encoding="utf-8") as f:
                hooks = json.load(f)
            if "whatsapp-approval" in hooks:
                hooks["whatsapp-approval"]["enabled"] = False
                with open(hooks_path, "w", encoding="utf-8") as f:
                    json.dump(hooks, f, indent=2)
    except Exception:
        pass

def main():
    # 1. Parse command line arguments to determine hook type (pre, post, or stop)
    hook_type = "pre"  # default
    if len(sys.argv) > 1:
        hook_type = sys.argv[1].lower()

    # 2. Read input from stdin
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"decision": "allow"}))
            return
        payload = json.loads(input_data)
    except Exception as e:
        # Avoid blocking the agent if stdin parsing fails
        print(json.dumps({"decision": "allow", "reason": f"Failed to parse stdin: {str(e)}"}))
        return

    # 3. Extract tool details (robust parsing for various formats)
    tool_call = payload.get("toolCall") or payload.get("tool_call") or {}
    tool_name = tool_call.get("name") or payload.get("toolName") or "unknown"
    args = tool_call.get("args") or payload.get("toolInput") or payload.get("args") or {}
    command = args.get("CommandLine") or args.get("command") or ""

    # 4. Check channel - only proceed if in whatsapp context
    channel = os.getenv("OPENGRIVITY_CHANNEL")
    if channel != "whatsapp":
        # Fall back to allow if not in WhatsApp context (e.g. running locally)
        print(json.dumps({"decision": "allow"}))
        return

    # 5. Handle based on hook_type
    if hook_type == "pre":
        # Pre-tool execution hook
        if tool_name == "run_command":
            # Use interactive approval process for shell commands
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
                            print(json.dumps({"decision": "deny", "reason": "The WhatsApp bridge is running but not connected to your WhatsApp account. Please authenticate."}))
                            return
                except Exception:
                    pass
                print(json.dumps({"decision": "deny", "reason": f"Unable to contact the WhatsApp bridge: {str(e)}"}))
        else:
            # Send notification message only (non-blocking)
            args_str = json.dumps(args, ensure_ascii=False)
            if len(args_str) > 150:
                args_str = args_str[:150] + "..."
            
            notify_msg = f"⚙️ *[Tool Notification - Start]*\nAgent is calling tool: `{tool_name}`\nArguments: `{args_str}`"
            
            url = "http://localhost:3000/notify"
            req_data = json.dumps({"message": notify_msg}).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    pass
            except Exception:
                pass
            
            # Non-blocking: always allow other tools
            print(json.dumps({"decision": "allow"}))

    elif hook_type == "post":
        # Post-tool execution hook
        result = payload.get("result") or payload.get("output") or payload.get("tool_response")
        error = payload.get("error")
        
        status_str = "✅ Success"
        if error:
            status_str = f"❌ Error: {error}"
            
        notify_msg = f"⚙️ *[Tool Notification - End]*\nTool `{tool_name}` completed.\nStatus: {status_str}"
        
        if result:
            result_str = str(result)
            if len(result_str) > 200:
                result_str = result_str[:200] + "..."
            notify_msg += f"\nResult: `{result_str}`"
            
        url = "http://localhost:3000/notify"
        req_data = json.dumps({"message": notify_msg}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                pass
        except Exception:
            pass
        
        print(json.dumps({"decision": "allow"}))

    elif hook_type == "stop":
        # Stop hook: execution loop terminated
        notify_msg = "⏹️ *[Execution Loop Terminated]*\nThe agent has finished its task execution loop."
        
        # Try to extract the last step or info from payload if available
        last_step = payload.get("lastStep") or payload.get("stepIndex") or payload.get("step_index")
        if last_step:
            notify_msg += f"\nTotal steps: {last_step}"
            
        url = "http://localhost:3000/notify"
        req_data = json.dumps({"message": notify_msg}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                pass
        except Exception:
            pass
            
        # Disable the hook to prevent disturbing local execution
        disable_hook_locally()
        print(json.dumps({"decision": "allow"}))
        
    else:
        print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()
