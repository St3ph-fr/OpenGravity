---
name: opengravity-manager
description: "Manage OpenGravity/Antigravity conversations and locate active projects. Use this skill when you need to understand how projects, sidecars, and conversation logs are structured and linked, or to locate conversation files."
---

# OpenGravity Manager Skill

This skill provides guidelines and instructions on how to manage conversations, locate active projects, and link sidecars to conversations in the OpenGravity ecosystem.

## Locating Active Projects

To locate the active projects and their corresponding IDs:
1. Load the global configuration file at: `~/.gemini/config/config.json`.
2. Inspect the `sidecars` section. Each sidecar configures a `projectId` which maps to a project definition file under `~/.gemini/config/projects/`.

### Active Projects Mapping (Example)
- `news-check` sidecar maps to project `fb4af2e8-582b-4f09-a394-2b893e920a6e`
- `workspace-update-blog` sidecar maps to project `53a12e23-55bb-49f0-be2f-e5dc695c6b3f`
- `whatsapp-bridge` sidecar maps to project `7fa3bef5-cd2e-4373-8d70-6a8e9c095540` (Project "agent")

---

## Listing and Managing Conversations

OpenGravity conversation states are stored in two locations:

### 1. Protocol Buffer Files (`.pb`)
- Path: `~/.gemini/antigravity/conversations/`
- Format: Binary `.pb` files named `<conversation_id>.pb`.
- Usage: The existence and modification time (mtime) of these files indicate when a conversation was last active.

### 2. Conversation Transcript Logs (`transcript.jsonl`)
- Path: `~/.gemini/antigravity/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`
- Format: JSON Lines (JSONL), where each line is a step in the conversation.
- Usage: To inspect historical messages, tool calls, and replies. The last step of type `PLANNER_RESPONSE` with status `DONE` contains the final answer of that turn.

---

## Modifying Bridge States & Switching Projects
The WhatsApp bridge (`whatsapp-bridge` sidecar) stores its active conversation state in:
`~/.gemini/config/sidecars/whatsapp-bridge/state.json`

Format:
```json
{
  "lastConversationId": "<conversation_id>",
  "lastProjectId": "<project_id>"
}
```

### Creating or Switching Projects
If the user requests to create a new project or switch to a different project:
1. **Create or modify the project configuration** under `~/.gemini/config/projects/<project_id>.json`.
2. **Update the state file**: Write the new `lastProjectId` to `~/.gemini/config/sidecars/whatsapp-bridge/state.json`.
3. **Reset the conversation**: You **MUST** clear the `lastConversationId` (set it to `""` or `null`, or remove it) in the `state.json` file. This forces the WhatsApp bridge to start a brand new conversation context for the new project next time a message is sent.
