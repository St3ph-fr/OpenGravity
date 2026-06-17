# OpenGravity

> Turn Antigravity into your autonomous agent running in the cloud.

OpenGravity is a WhatsApp-based control bridge and orchestration layer for **Antigravity**. It enables you to interact with, monitor, and guide your Antigravity agent instances from anywhere in the world using a simple WhatsApp chat interface.

---

## 🌟 The Vision & Genesis

OpenGravity was inspired by the deployment of autonomous agents like Hermes on GCP (as detailed in the [Hermes AI Agent step-by-step guide on Medium](https://medium.com/google-cloud/deploying-hermes-ai-agent-and-webui-on-gcp-a-step-by-step-hands-on-guide-ee32303c4bfb)). While external web-based agent UIs are fun and functional, leveraging a native, highly capable tool like **Antigravity 2.0** offers unparalleled power. 

Instead of switching to a separate platform, OpenGravity brings Antigravity's rich developer toolset—including file system access, terminal execution, and advanced agent workflows—directly to your mobile phone.

---

## 🚀 Key Benefits

### 1. Omnipresent Autonomous Assistant
Run your Antigravity agent in the background and communicate with it on the go. Whether you need to check the status of a project, trigger a script, or ask for research, your agent is just a WhatsApp message away.

### 2. Cost-Effective Power
OpenGravity operates directly through your Antigravity agent session. It consumes your existing AI Pro subscription quota rather than charging you per-token on third-party APIs. This allows you to run intensive, multi-step agent tasks without worrying about API bills.

### 3. Isolated Cloud VM Execution
Deploying OpenGravity on a cloud virtual machine (e.g., GCP, AWS) turns the host VM into a secure playground for your agent. The agent can freely run shell commands, write files, compile code, and test applications. This isolated sandbox setup keeps your personal computer safe from unauthorized or accidental executions.

### 4. Human-in-the-Loop Safeguards
Even when running autonomously in the cloud, you remain in control. OpenGravity features an HTTP approval server. When the agent attempts a potentially sensitive action (like executing a terminal command), it pauses and sends an interactive approval request (`👍`/`👎`) to your WhatsApp chat.

---

## 🏗️ Architecture Overview

```
+------------------+                   +--------------------+
|  WhatsApp App    | <=== WebSocket ==> |  WhatsApp Bridge   |
| (Phone/Self-Chat)|                    | (Baileys Sidecar)  |
+------------------+                   +--------------------+
         ^                                       ||
         ||                                exec(agentapi)
         ||                                      ||
         ||                                      \/
         ||                            +--------------------+
  [Human-in-the-loop] <== HTTP POST == | Antigravity Agent  |
  (Yes/No via text)                    |  (Active Project)  |
                                       +--------------------+
```

---

## 📂 Directory Structure

* `/bridge`: Contains the WhatsApp sidecar configuration (`sidecar.json`), package dependencies (`package.json`), and the connection script (`bridge.js`).
* `/plugin`: Contains the custom Antigravity/OpenGravity plugin configuration (`plugin.json`) and conversation manager skill instructions (`SKILL.md`).
* `/examples`: Python SDK script demonstrating human-in-the-loop approvals over WhatsApp.

---

## ⚙️ Setup Guide

### 1. Configure the WhatsApp Bridge Sidecar

#### Step 1: Create the Sidecar Folder
Copy the files in the `/bridge` folder to your local Antigravity sidecars directory:
```bash
mkdir -p ~/.gemini/config/sidecars/whatsapp-bridge
cp bridge/* ~/.gemini/config/sidecars/whatsapp-bridge/
```

#### Step 2: Install Dependencies
Navigate to the directory and install the required NPM packages:
```bash
cd ~/.gemini/config/sidecars/whatsapp-bridge
npm install
```

#### Step 3: Run the Initial Authentication
Start the script manually to log in and pair your WhatsApp account:
```bash
node bridge.js
```
A terminal QR code will be generated, and a high-resolution PNG image will be written to `qr.png`. Open WhatsApp on your phone, navigate to **Linked Devices** > **Link a Device**, and scan the QR code.

Once the terminal outputs `WhatsApp connection established!`, stop the process (`Ctrl + C`). Your session credentials will be saved securely in the `auth_session` folder.

---

### 2. Register the Antigravity Skill

To give your agent the ability to manage conversations, track workspaces, and inspect logs:

1. Copy the plugin directory into your Antigravity plugins directory:
   ```bash
   mkdir -p ~/.gemini/config/plugins/opengravity
   cp -r plugin/* ~/.gemini/config/plugins/opengravity/
   ```
2. Restart Antigravity. The agent will automatically load the `opengravity-manager` skill, which provides it with the context needed to process incoming messages.

---

### 3. Enable the Sidecar in Antigravity

Open your global Antigravity configuration file (`~/.gemini/config/config.json`) and register the sidecar under the `"sidecars"` key:

```json
{
  "sidecars": {
    "whatsapp-bridge": {
      "enabled": true,
      "projectId": "YOUR_PROJECT_ID_HERE"
    }
  }
}
```
Replace `YOUR_PROJECT_ID_HERE` with your active project ID. When Antigravity starts, the sidecar will launch as a background service.

---

## 🛠️ Usage & State Management

### Self-Chat vs. Dedicated Number
* **Self-Chat (Recommended)**: Message your own number. The bridge automatically handles self-chat loop prevention to avoid infinite recursive replies.
* **Dedicated Number**: Scan the QR code using a secondary WhatsApp number. Anyone messaging this number will interact with the agent (note: you can restrict JIDs in `bridge.js` if needed).

### State Tracking & Context Expiry
The bridge automatically tracks the conversation context in `state.json`:
* **Active Window (< 1 hour)**: If you message the agent within one hour of the last interaction, it continues the same conversation and fetches updates incrementally.
* **New Session (> 1 hour or Project Change)**: Messages received after one hour of inactivity, or after updating `projectId` in `config.json`, will automatically initialize a new conversation context with a system note notifying the agent.
* **Manual Override (Resume)**: Resume any active or historical conversation using:
  ```text
  /reply <CONVERSATION_ID> <your prompt>
  ```
* **Force New Session**: Explicitly force start a brand new conversation context for the current project:
  ```text
  /new <your prompt>
  ```

### Human-in-the-Loop Approvals
When running agents that perform modifications or run commands, the bridge runs an HTTP approval server on port `3000`. 
1. The agent intercepts sensitive tool calls (e.g., `run_command`).
2. The agent sends a POST request to `http://localhost:3000/approve-request`.
3. You receive a WhatsApp alert:
   ```text
   ⚠️ *[Demande d'autorisation OpenGravity]*
   Outil : run_command
   Commande : npm run build
   ```
4. Respond with `👍` or `/allow` to permit the action, or `👎` or `/disallow` to deny it.

See a working example in [examples/approval_agent.py](examples/approval_agent.py).
