import asyncio
import httpx
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
from google.antigravity.hooks import policy

# Custom safety policy handler that calls the WhatsApp bridge webhook for approvals
async def whatsapp_approval_handler(tool_call) -> bool:
    command = tool_call.arguments.get("CommandLine", "")
    print(f"[OpenGravity Agent] Intercepted run_command: {command}")
    
    # Send validation request to the local WhatsApp bridge HTTP endpoint
    bridge_url = "http://localhost:3000/approve-request"
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                bridge_url,
                json={
                    "command": command,
                    "tool_name": tool_call.name
                },
                timeout=120.0  # 2 minutes timeout for the user to respond on WhatsApp
            )
            
            if response.status_code == 200:
                result = response.json()
                approved = result.get("approved", False)
                print(f"[OpenGravity Agent] WhatsApp response: {'APPROVED' if approved else 'REJECTED'}")
                return approved
    except Exception as e:
        print(f"[OpenGravity Agent] Failed to contact WhatsApp bridge: {e}")
        
    return False  # Fail closed by default for safety

async def main():
    import os
    # Configure the agent policies
    policies = [
        policy.deny_all(), # Start by denying all tools
        policy.allow("view_file"), # Allow safe reading tools without prompt
        policy.allow("search_directory"),
    ]
    
    # Only register the WhatsApp approval handler if triggered via WhatsApp
    if os.getenv("OPENGRIVITY_CHANNEL") == "whatsapp":
        policies.append(policy.ask_user("run_command", handler=whatsapp_approval_handler))

    config = LocalAgentConfig(
        system_instructions="You are an autonomous OpenGravity agent. Speak in English.",
        capabilities=CapabilitiesConfig(),
        policies=policies,
    )

    print("[OpenGravity Agent] Starting agent session...")
    async with Agent(config=config) as agent:
        response = await agent.chat("Run an npm build or list the working directory.")
        async for token in response:
            print(token, end="", flush=True)

if __name__ == "__main__":
    asyncio.run(main())
