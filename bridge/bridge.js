const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { exec } = require('child_process');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Set to record IDs of messages sent by the bot to prevent infinite self-reply loops
const botMessageIds = new Set();
// Map to hold pending human-in-the-loop approval requests
const pendingApprovals = new Map();
let serverStarted = false;

function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { env: { ...process.env, OPENGRIVITY_CHANNEL: 'whatsapp' } }, (error, stdout, stderr) => {
            if (error) {
                reject(stderr || error.message);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

function getRequestToResolve(messageText) {
    const text = messageText.trim();
    let reqId = null;
    let decision = null;
    
    if (text.startsWith('/allow')) {
        decision = 'allow';
        const parts = text.split(/\s+/);
        if (parts.length > 1 && parts[1].startsWith('req_')) {
            reqId = parts[1];
        }
    } else if (text.startsWith('/disallow')) {
        decision = 'deny';
        const parts = text.split(/\s+/);
        if (parts.length > 1 && parts[1].startsWith('req_')) {
            reqId = parts[1];
        }
    } else if (text === '👍' || text.includes('👍')) {
        if (pendingApprovals.size > 0) {
            decision = 'allow';
        }
    } else if (text === '👎' || text.includes('👎')) {
        if (pendingApprovals.size > 0) {
            decision = 'deny';
        }
    }
    
    if (decision === null) {
        return null;
    }
    
    if (reqId) {
        if (pendingApprovals.has(reqId)) {
            return { reqId, decision };
        } else {
            return { error: `Authorization request ${reqId} not found or expired.` };
        }
    }
    
    if (pendingApprovals.size > 0) {
        const keys = Array.from(pendingApprovals.keys());
        const latestReqId = keys[keys.length - 1];
        return { reqId: latestReqId, decision };
    }
    
    return { error: "No pending authorization requests." };
}

function setHookEnabled(enabled) {
    try {
        const hooksPath = path.join(os.homedir(), '.gemini/config/hooks.json');
        let hooks = {};
        if (fs.existsSync(hooksPath)) {
            hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        }
        hooks["whatsapp-approval"] = {
            "enabled": enabled,
            "PreToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": `python3 "${path.join(__dirname, 'approval_hook.py')}" pre`,
                            "timeout": 130
                        }
                    ]
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": `python3 "${path.join(__dirname, 'approval_hook.py')}" post`,
                            "timeout": 30
                        }
                    ]
                }
            ],
            "Stop": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": `python3 "${path.join(__dirname, 'approval_hook.py')}" stop`,
                            "timeout": 30
                        }
                    ]
                }
            ]
        };
        fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), 'utf8');
        console.log(`[WhatsApp Bridge] Hook set to enabled=${enabled}`);
    } catch (e) {
        console.error("[WhatsApp Bridge] Error setting hook status:", e);
    }
}

const STATE_FILE = path.join(__dirname, 'state.json');

function getState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("[WhatsApp Bridge] Error reading state.json:", e);
    }
    return {};
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error("[WhatsApp Bridge] Error writing state.json:", e);
    }
}

function getProjectId() {
    try {
        const configPath = path.join(os.homedir(), '.gemini/config/config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return config?.sidecars?.['whatsapp-bridge']?.projectId || 'outside-of-project';
        }
    } catch (e) {
        console.error("[WhatsApp Bridge] Error reading config.json:", e);
    }
    return 'outside-of-project';
}

function getLastStepIndex(conversationId) {
    const logPath = path.join(os.homedir(), '.gemini/antigravity/brain', conversationId, '.system_generated/logs/transcript.jsonl');
    if (!fs.existsSync(logPath)) return -1;
    try {
        const data = fs.readFileSync(logPath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim() !== '');
        let maxIndex = -1;
        for (const line of lines) {
            const step = JSON.parse(line);
            if (step.step_index > maxIndex) {
                maxIndex = step.step_index;
            }
        }
        return maxIndex;
    } catch (e) {
        console.error(`[WhatsApp Bridge] Error reading last step index for ${conversationId}:`, e);
        return -1;
    }
}

function hasActiveBackgroundTasks(logPath) {
    if (!fs.existsSync(logPath)) return false;
    try {
        const data = fs.readFileSync(logPath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim() !== '');
        
        const runningTasks = new Set();
        for (const line of lines) {
            try {
                const step = JSON.parse(line);
                // Check if a task started running in the background
                if (step.status === 'RUNNING' && step.content) {
                    const match = step.content.match(/task id:\s*([^\s\n]+)/i);
                    if (match) {
                        runningTasks.add(match[1]);
                    }
                }
                // Check if a task finished
                if (step.type === 'SYSTEM_MESSAGE' && step.content) {
                    const match = step.content.match(/sender=([^\s]+)/i);
                    if (match && match[1].includes('task-')) {
                        runningTasks.delete(match[1]);
                    }
                }
            } catch (e) {}
        }
        return runningTasks.size > 0;
    } catch (err) {
        console.error("[WhatsApp Bridge] Error checking background tasks:", err);
        return false;
    }
}

// Function to poll the conversation log for planner responses
async function pollResponse(conversationId, sock, sender, startStepIndex = -1) {
    const logPath = path.join(os.homedir(), '.gemini/antigravity/brain', conversationId, '.system_generated/logs/transcript.jsonl');
    let lastStepIndex = startStepIndex;
    let attempts = 0;
    const maxAttempts = 300; // 10 minutes max (2s interval)

    console.log(`[WhatsApp Bridge] Starting log polling for conversation: ${conversationId}`);

    return new Promise((resolve) => {
        let lastSize = 0;

        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                const reply = await sock.sendMessage(sender, { text: "⚠️ Timeout reached (10 minutes). Agent is still running." });
                botMessageIds.add(reply.key.id);
                resolve();
                return;
            }

            if (!fs.existsSync(logPath)) {
                return; // Wait for log file to be created
            }

            try {
                const stat = fs.statSync(logPath);
                if (stat.size > lastSize) {
                    const fd = fs.openSync(logPath, 'r');
                    const buffer = Buffer.alloc(stat.size - lastSize);
                    fs.readSync(fd, buffer, 0, buffer.length, lastSize);
                    fs.closeSync(fd);
                    
                    lastSize = stat.size;
                    const newContent = buffer.toString('utf8');
                    const lines = newContent.split('\n').filter(line => line.trim() !== '');
                    
                    for (const line of lines) {
                        try {
                            const step = JSON.parse(line);
                            if (step.step_index > lastStepIndex) {
                                lastStepIndex = step.step_index;
                                
                                // Check if it's a completed planner response
                                if (step.type === 'PLANNER_RESPONSE' && step.status === 'DONE') {
                                    const hasToolCalls = step.tool_calls && step.tool_calls.length > 0;
                                    const text = step.content;

                                    if (text && text.trim()) {
                                        console.log(`[WhatsApp Bridge] Sending agent response: ${text.substring(0, 50)}...`);
                                        const finalReply = await sock.sendMessage(sender, { text: text });
                                        botMessageIds.add(finalReply.key.id);
                                    }

                                    // If there are no tool calls, the agent's turn is finished
                                    if (!hasToolCalls) {
                                        const hasTasks = hasActiveBackgroundTasks(logPath);
                                        if (!hasTasks) {
                                            console.log(`[WhatsApp Bridge] Agent has finished executing (no active background tasks).`);
                                            clearInterval(interval);
                                            resolve();
                                            return;
                                        } else {
                                            console.log(`[WhatsApp Bridge] Agent turn finished, but background tasks are still running. Continuing to poll...`);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore incomplete lines
                        }
                    }
                }
            } catch (err) {
                console.error("[WhatsApp Bridge] Error polling transcript:", err);
            }
        }, 2000);
    });
}

let activeSock = null;
let isWhatsAppConnected = false;

function startHttpServer() {
    if (serverStarted) return;
    
    const server = http.createServer((req, res) => {
        if (req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: isWhatsAppConnected ? 'connected' : 'disconnected',
                phone: process.env.WHATSAPP_PHONE_NUMBER || 'Not defined'
            }));
            return;
        }

        if (req.method === 'POST' && req.url === '/notify') {
            if (!isWhatsAppConnected || !activeSock) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', error: "Not connected" }));
                return;
            }
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    const message = payload.message;
                    if (message) {
                        const myJid = activeSock.user.id.split(':')[0] + '@s.whatsapp.net';
                        const notifyMsg = await activeSock.sendMessage(myJid, { text: message });
                        botMessageIds.add(notifyMsg.key.id);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success' }));
                } catch (err) {
                    console.error("[HTTP Server] Error processing notify request:", err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/approve-request') {
            if (!isWhatsAppConnected || !activeSock) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ approved: false, error: "The WhatsApp bridge is not connected. Please link your WhatsApp account." }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    const command = payload.command;
                    
                    console.log(`[HTTP Server] Approval request received for command: "${command}"`);
                    
                    const myJid = activeSock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                    
                    const messageText = `⚠️ *[OpenGravity Authorization Request]*\n\nTool: \`${payload.tool_name}\`\nCommand: \`${command}\`\n\nReply with:\n* \`/allow ${requestId}\` (or 👍) to authorize\n* \`/disallow ${requestId}\` (or 👎) to deny`;
                    
                    const approvalMsg = await activeSock.sendMessage(myJid, { text: messageText });
                    botMessageIds.add(approvalMsg.key.id);
                    
                    pendingApprovals.set(requestId, {
                        res: res,
                        msgId: approvalMsg.key.id,
                        timeout: setTimeout(() => {
                            if (pendingApprovals.has(requestId)) {
                                console.log(`[HTTP Server] Request ${requestId} timed out.`);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ approved: false, error: 'Timeout' }));
                                pendingApprovals.delete(requestId);
                            }
                        }, 120000) // 2 minutes timeout
                    });
                } catch (err) {
                    console.error("[HTTP Server] Error processing approval request:", err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    
    const PORT = 3000;
    server.listen(PORT, () => {
        console.log(`[HTTP Server] Approval listener server listening on port ${PORT}`);
        serverStarted = true;
    });
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.00']
    });

    activeSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("\n=== PLEASE SCAN THE QR CODE (PNG GENERATED IN YOUR LOG) ===");
            qrcodeTerminal.generate(qr, { small: true });

            // Generate PNG image of the QR Code
            const qrPngPath = path.join(__dirname, 'qr.png');
            try {
                await QRCode.toFile(qrPngPath, qr, { scale: 8 });
                console.log(`[WhatsApp Bridge] QR Code PNG generated at: ${qrPngPath}`);
            } catch (err) {
                console.error("[WhatsApp Bridge] Failed to generate QR Code PNG:", err);
            }

            // Request pairing code on the active socket
            if (!sock.pairingCodeRequested) {
                sock.pairingCodeRequested = true;
                const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
                if (!phoneNumber) {
                    console.log(`[WhatsApp Bridge] WHATSAPP_PHONE_NUMBER not defined. Skipping pairing code request.`);
                } else {
                    console.log(`[WhatsApp Bridge] QR generated. Requesting pairing code for ${phoneNumber}...`);
                    setTimeout(async () => {
                        try {
                            const code = await sock.requestPairingCode(phoneNumber);
                            console.log(`\n=========================================`);
                            console.log(`YOUR WHATSAPP PAIRING CODE: ${code}`);
                            console.log(`=========================================\n`);
                        } catch (err) {
                            console.error("[WhatsApp Bridge] Pairing code request failed:", err);
                            sock.pairingCodeRequested = false;
                        }
                    }, 2000);
                }
            }
        }
        if (connection === 'close') {
            isWhatsAppConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[WhatsApp Bridge] Connection closed (Code: ${statusCode || 'unknown'}).`);
            
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            if (isLoggedOut) {
                console.log("[WhatsApp Bridge] Logout detected. Deleting session...");
                try {
                    fs.rmSync(path.join(__dirname, 'auth_session'), { recursive: true, force: true });
                } catch (e) {
                    console.error("[WhatsApp Bridge] Failed to delete session:", e);
                }
            }
            
            console.log("[WhatsApp Bridge] Reconnecting in 5 seconds...");
            setTimeout(startWhatsApp, 5000);
        } else if (connection === 'open') {
            isWhatsAppConnected = true;
            console.log('WhatsApp connection established!');
            console.log(`Connected to account: ${sock.user.name || sock.user.id}`);
        }
    });

    sock.ev.on('messages.upsert', async m => {
        console.log(`[WhatsApp Bridge Debug] Event messages.upsert received. Type: ${m.type}, count: ${m.messages ? m.messages.length : 0}`);
        if (!sock.user) {
            console.log(`[WhatsApp Bridge Debug] sock.user is not defined yet.`);
            return;
        }

        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const myLid = sock.user.lid ? (sock.user.lid.split(':')[0] + '@lid') : null;
        console.log(`[WhatsApp Bridge Debug] myJid is: ${myJid}, myLid is: ${myLid}`);

        for (const msg of m.messages) {
            const sender = msg.key.remoteJid;
            const messageId = msg.key.id;
            const fromMe = msg.key.fromMe;

            // Check if this is a reaction message targeting a pending approval
            const reaction = msg.message?.reactionMessage;
            if (reaction) {
                console.log(`[WhatsApp Bridge Debug] Reaction detected: text="${reaction.text}", targetMsgId="${reaction.key?.id}"`);
                let targetReqId = null;
                for (const [reqId, data] of pendingApprovals.entries()) {
                    if (data.msgId === reaction.key?.id) {
                        targetReqId = reqId;
                        break;
                    }
                }
                
                if (targetReqId) {
                    const reactionEmoji = reaction.text;
                    let decision = null;
                    if (reactionEmoji === '👍') {
                        decision = 'allow';
                    } else if (reactionEmoji === '👎') {
                        decision = 'deny';
                    }
                    
                    if (decision) {
                        const pending = pendingApprovals.get(targetReqId);
                        if (pending) {
                            clearTimeout(pending.timeout);
                            const approved = (decision === 'allow');
                            
                            // Respond to the HTTP client (the hook script)
                            pending.res.writeHead(200, { 'Content-Type': 'application/json' });
                            pending.res.end(JSON.stringify({ approved: approved }));
                            pendingApprovals.delete(targetReqId);
                            
                            // Send confirmation to WhatsApp
                            const confirmationText = approved ? "✅ Command authorized (via reaction)!" : "❌ Command denied (via reaction)!";
                            const reply = await sock.sendMessage(sender, { text: confirmationText });
                            botMessageIds.add(reply.key.id);
                        }
                        continue; // skip invoking agentapi for reaction
                    }
                }
            }

            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            console.log(`[WhatsApp Bridge Debug] Msg Details: JID=${sender}, fromMe=${fromMe}, ID=${messageId}, Text="${messageText}"`);

            if (!messageText) {
                console.log(`[WhatsApp Bridge Debug] Skipping: No message text found.`);
                continue;
            }

            // Only process messages in our own self-chat
            const isSelfJid = (sender === myJid) || (myLid && sender === myLid);
            if (!isSelfJid) {
                console.log(`[WhatsApp Bridge Debug] Skipping: Sender ${sender} does not match myJid ${myJid} or myLid ${myLid}.`);
                continue;
            }

            // Prevent loops: ignore if the message is from the bot
            if (botMessageIds.has(messageId)) {
                console.log(`[WhatsApp Bridge Debug] Loop prevention: Message ${messageId} is from the bot itself. Ignoring.`);
                botMessageIds.delete(messageId); // Memory clean-up
                continue;
            }

            // --- CHECK FOR COMMAND APPROVAL RESPONSE FIRST ---
            const approvalResult = getRequestToResolve(messageText);
            if (approvalResult) {
                if (approvalResult.error) {
                    const reply = await sock.sendMessage(sender, { text: `⚠️ ${approvalResult.error}` });
                    botMessageIds.add(reply.key.id);
                } else {
                    const { reqId, decision } = approvalResult;
                    const pending = pendingApprovals.get(reqId);
                    if (pending) {
                        clearTimeout(pending.timeout);
                        const approved = (decision === 'allow');
                        
                        // Respond to the HTTP client (the hook script)
                        pending.res.writeHead(200, { 'Content-Type': 'application/json' });
                        pending.res.end(JSON.stringify({ approved: approved }));
                        pendingApprovals.delete(reqId);
                        
                        // Send confirmation to WhatsApp
                        const confirmationText = approved ? "✅ Command authorized!" : "❌ Command denied!";
                        const reply = await sock.sendMessage(sender, { text: confirmationText });
                        botMessageIds.add(reply.key.id);
                    }
                }
                continue; // VERY IMPORTANT: skip running agentapi for approval responses!
            }

            console.log(`New instruction detected: "${messageText}"`);

            const typingNotice = await sock.sendMessage(sender, { text: "⏳ Antigravity is processing your request..." });
            botMessageIds.add(typingNotice.key.id);

            try {
                let cmd;
                let isReply = false;
                let conversationId = null;
                let startStepIndex = -1;

                if (messageText.startsWith('/new ')) {
                    const prompt = messageText.substring(5); // strip "/new "
                    const currentProjectId = getProjectId();
                    console.log(`[WhatsApp Bridge] Forced start of a new conversation for project: ${currentProjectId}`);
                    const systemNote = "\n\n(Note for the agent: This conversation starts a new context because the user explicitly requested a new conversation. Speak in English.)";
                    const fullPrompt = prompt + systemNote;
                    const escapedPrompt = fullPrompt.replace(/"/g, '\\"');
                    const agentapiPath = path.join(os.homedir(), '.gemini/antigravity/bin/agentapi');
                    cmd = `"${agentapiPath}" new-conversation "${escapedPrompt}"`;
                } else if (messageText.startsWith('/reply ')) {
                    const parts = messageText.split(' ');
                    conversationId = parts[1];
                    const prompt = parts.slice(2).join(' ');
                    const escapedPrompt = prompt.replace(/"/g, '\\"');
                    const agentapiPath = path.join(os.homedir(), '.gemini/antigravity/bin/agentapi');
                    cmd = `"${agentapiPath}" send-message ${conversationId} "${escapedPrompt}"`;
                    isReply = true;
                    startStepIndex = getLastStepIndex(conversationId);
                } else {
                    const currentProjectId = getProjectId();
                    console.log(`[WhatsApp Bridge] Currently configured project: ${currentProjectId}`);

                    // Check if we have a saved conversation ID that is less than 1 hour old and matches the current project
                    const state = getState();
                    const savedId = state.lastConversationId;
                    const savedProjectId = state.lastProjectId;
                    let useSaved = false;

                    if (savedId && savedProjectId === currentProjectId) {
                        const transcriptPath = path.join(os.homedir(), '.gemini/antigravity/brain', savedId, '.system_generated/logs/transcript.jsonl');
                        if (fs.existsSync(transcriptPath)) {
                            const stat = fs.statSync(transcriptPath);
                            const ageMs = Date.now() - stat.mtimeMs;
                            if (ageMs < 3600 * 1000) { // < 1 hour
                                useSaved = true;
                                conversationId = savedId;
                                console.log(`[WhatsApp Bridge] Reusing recent conversation: ${conversationId} for project ${currentProjectId} (last active ${(ageMs/60000).toFixed(1)} minutes ago)`);
                            }
                        }
                    }

                    if (useSaved) {
                        const escapedPrompt = messageText.replace(/"/g, '\\"');
                        const agentapiPath = path.join(os.homedir(), '.gemini/antigravity/bin/agentapi');
                        cmd = `"${agentapiPath}" send-message ${conversationId} "${escapedPrompt}"`;
                        isReply = true;
                        startStepIndex = getLastStepIndex(conversationId);
                    } else {
                        console.log(`[WhatsApp Bridge] Starting a new conversation for project: ${currentProjectId}`);
                        const systemNote = "\n\n(Note for the agent: This conversation starts a new context because the previous one expired, changed project, or does not exist. Speak in English.)";
                        const fullPrompt = messageText + systemNote;
                        const escapedPrompt = fullPrompt.replace(/"/g, '\\"');
                        const agentapiPath = path.join(os.homedir(), '.gemini/antigravity/bin/agentapi');
                        cmd = `"${agentapiPath}" new-conversation "${escapedPrompt}"`;
                    }
                }

                // Enable the validation hook dynamically before running agentapi
                setHookEnabled(true);

                const output = await runCommand(cmd);
                console.log(`Command executed successfully. Output: ${output}`);

                let result;
                try {
                    result = JSON.parse(output);
                } catch (e) {
                    console.error("Unable to parse JSON output:", e);
                }

                if (!isReply && result) {
                    conversationId = result?.response?.newConversation?.conversationId;
                    if (conversationId) {
                        const currentProjectId = getProjectId();
                        // Save both conversation ID and project ID to state file
                        saveState({ 
                            lastConversationId: conversationId,
                            lastProjectId: currentProjectId
                        });
                    }
                } else if (isReply && result) {
                    conversationId = result?.response?.sendMessage?.recipientId;
                }

                if (conversationId) {
                    if (!isReply) {
                        const infoMsg = await sock.sendMessage(sender, { text: `conv_id: ${conversationId} (New discussion)` });
                        botMessageIds.add(infoMsg.key.id);
                    }
                    // Poll and stream response steps back to the user
                    await pollResponse(conversationId, sock, sender, startStepIndex);
                } else {
                    const finalReply = await sock.sendMessage(sender, { text: `Executed: ${output}` });
                    botMessageIds.add(finalReply.key.id);
                }

            } catch (err) {
                console.error("Error executing agentapi:", err);
                const errorReply = await sock.sendMessage(sender, { text: `❌ Error: ${err.message || err}` });
                botMessageIds.add(errorReply.key.id);
            } finally {
                // Ensure hook is disabled after execution ends
                setHookEnabled(false);
            }
        }
    });
}

startHttpServer();
startWhatsApp();
