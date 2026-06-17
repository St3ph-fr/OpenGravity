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
            return { error: `La demande d'autorisation ${reqId} est introuvable ou a expiré.` };
        }
    }
    
    if (pendingApprovals.size > 0) {
        const keys = Array.from(pendingApprovals.keys());
        const latestReqId = keys[keys.length - 1];
        return { reqId: latestReqId, decision };
    }
    
    return { error: "Aucune demande d'autorisation en attente." };
}

function setHookEnabled(enabled) {
    try {
        const hooksPath = path.join(os.homedir(), '.gemini/config/hooks.json');
        let hooks = {};
        if (fs.existsSync(hooksPath)) {
            hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        }
        if (!hooks["whatsapp-approval"]) {
            hooks["whatsapp-approval"] = {
                "PreToolUse": [
                    {
                        "matcher": "run_command",
                        "hooks": [
                            {
                                "type": "command",
                                "command": `python3 "${path.join(__dirname, 'approval_hook.py')}"`,
                                "timeout": 130
                            }
                        ]
                    }
                ]
            };
        }
        hooks["whatsapp-approval"].enabled = enabled;
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
        console.error("[WhatsApp Bridge] Erreur lors de la lecture de state.json:", e);
    }
    return {};
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error("[WhatsApp Bridge] Erreur lors de l'écriture de state.json:", e);
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
        console.error("[WhatsApp Bridge] Erreur lors de la lecture de config.json:", e);
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
        console.error(`[WhatsApp Bridge] Erreur lors de la lecture du dernier step index de ${conversationId}:`, e);
        return -1;
    }
}

// Function to poll the conversation log for planner responses
async function pollResponse(conversationId, sock, sender, startStepIndex = -1) {
    const logPath = path.join(os.homedir(), '.gemini/antigravity/brain', conversationId, '.system_generated/logs/transcript.jsonl');
    let lastStepIndex = startStepIndex;
    let attempts = 0;
    const maxAttempts = 300; // 10 minutes max (2s interval)

    console.log(`[WhatsApp Bridge] Commencer le polling du log pour la conversation : ${conversationId}`);

    return new Promise((resolve) => {
        let lastSize = 0;

        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                const reply = await sock.sendMessage(sender, { text: "⚠️ Temps d'attente dépassé (10 minutes). L'agent est toujours en cours d'exécution." });
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
                                        console.log(`[WhatsApp Bridge] Envoi de la réponse de l'agent : ${text.substring(0, 50)}...`);
                                        const finalReply = await sock.sendMessage(sender, { text: text });
                                        botMessageIds.add(finalReply.key.id);
                                    }

                                    // If there are no tool calls, the agent's turn is finished
                                    if (!hasToolCalls) {
                                        console.log(`[WhatsApp Bridge] L'agent a terminé son exécution.`);
                                        clearInterval(interval);
                                        resolve();
                                        return;
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignorer les lignes incomplètes
                        }
                    }
                }
            } catch (err) {
                console.error("[WhatsApp Bridge] Erreur lors du polling du transcript :", err);
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
                phone: process.env.WHATSAPP_PHONE_NUMBER || 'Non défini'
            }));
            return;
        }

        if (req.method === 'POST' && req.url === '/approve-request') {
            if (!isWhatsAppConnected || !activeSock) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ approved: false, error: "Le pont WhatsApp n'est pas connecté. Veuillez lier votre compte WhatsApp." }));
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
                    
                    const messageText = `⚠️ *[Demande d'autorisation OpenGravity]*\n\nOutil : \`${payload.tool_name}\`\nCommande : \`${command}\`\n\nRépondez par :\n* \`/allow ${requestId}\` (ou 👍) pour autoriser\n* \`/disallow ${requestId}\` (ou 👎) pour refuser`;
                    
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
            console.log("\n=== VEUILLEZ SCANNER LE QR CODE (PNG GÉNÉRÉ DANS VOTRE LOG) ===");
            qrcodeTerminal.generate(qr, { small: true });

            // Generate PNG image of the QR Code
            const qrPngPath = path.join(__dirname, 'qr.png');
            try {
                await QRCode.toFile(qrPngPath, qr, { scale: 8 });
                console.log(`[WhatsApp Bridge] QR Code PNG généré à : ${qrPngPath}`);
            } catch (err) {
                console.error("[WhatsApp Bridge] Échec de la génération du PNG du QR Code :", err);
            }

            // Request pairing code on the active socket
            if (!sock.pairingCodeRequested) {
                sock.pairingCodeRequested = true;
                const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
                if (!phoneNumber) {
                    console.log(`[WhatsApp Bridge] WHATSAPP_PHONE_NUMBER non défini. Ignorer la demande de code d'association par numéro.`);
                } else {
                    console.log(`[WhatsApp Bridge] QR émis. Demande de code d'association pour ${phoneNumber}...`);
                    setTimeout(async () => {
                        try {
                            const code = await sock.requestPairingCode(phoneNumber);
                            console.log(`\n=========================================`);
                            console.log(`VOTRE CODE D'ASSOCIATION WHATSAPP : ${code}`);
                            console.log(`=========================================\n`);
                        } catch (err) {
                            console.error("[WhatsApp Bridge] Échec de la demande de code d'association:", err);
                            sock.pairingCodeRequested = false;
                        }
                    }, 2000);
                }
            }
        }
        if (connection === 'close') {
            isWhatsAppConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[WhatsApp Bridge] Connexion fermée (Code: ${statusCode || 'inconnu'}).`);
            
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            if (isLoggedOut) {
                console.log("[WhatsApp Bridge] Déconnexion détectée. Suppression de la session...");
                try {
                    fs.rmSync(path.join(__dirname, 'auth_session'), { recursive: true, force: true });
                } catch (e) {
                    console.error("[WhatsApp Bridge] Échec de la suppression de la session :", e);
                }
            }
            
            console.log("[WhatsApp Bridge] Reconnexion dans 5 secondes...");
            setTimeout(startWhatsApp, 5000);
        } else if (connection === 'open') {
            isWhatsAppConnected = true;
            console.log('Connexion WhatsApp établie !');
            console.log(`Connecté sur le compte de : ${sock.user.name || sock.user.id}`);
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
                            const confirmationText = approved ? "✅ Commande autorisée (par réaction) !" : "❌ Commande refusée (par réaction) !";
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
                        const confirmationText = approved ? "✅ Commande autorisée !" : "❌ Commande refusée !";
                        const reply = await sock.sendMessage(sender, { text: confirmationText });
                        botMessageIds.add(reply.key.id);
                    }
                }
                continue; // VERY IMPORTANT: skip running agentapi for approval responses!
            }

            console.log(`Nouvelle consigne détectée : "${messageText}"`);

            const typingNotice = await sock.sendMessage(sender, { text: "⏳ Antigravity traite votre demande..." });
            botMessageIds.add(typingNotice.key.id);

            try {
                let cmd;
                let isReply = false;
                let conversationId = null;
                let startStepIndex = -1;

                if (messageText.startsWith('/new ')) {
                    const prompt = messageText.substring(5); // strip "/new "
                    const currentProjectId = getProjectId();
                    console.log(`[WhatsApp Bridge] Démarrage forcé d'une nouvelle conversation pour le projet : ${currentProjectId}`);
                    const systemNote = "\n\n(Note pour l'agent : Cette conversation démarre un nouveau contexte de discussion car l'utilisateur a demandé explicitement une nouvelle conversation. Parlez en français.)";
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
                    console.log(`[WhatsApp Bridge] Projet en cours configuré : ${currentProjectId}`);

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
                                console.log(`[WhatsApp Bridge] Réutilisation de la conversation récente : ${conversationId} pour le projet ${currentProjectId} (dernière activité il y a ${(ageMs/60000).toFixed(1)} minutes)`);
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
                        console.log(`[WhatsApp Bridge] Démarrage d'une nouvelle conversation pour le projet : ${currentProjectId}`);
                        const systemNote = "\n\n(Note pour l'agent : Cette conversation démarre un nouveau contexte de discussion car la précédente a expiré, a changé de projet ou est inexistante. Parlez en français.)";
                        const fullPrompt = messageText + systemNote;
                        const escapedPrompt = fullPrompt.replace(/"/g, '\\"');
                        const agentapiPath = path.join(os.homedir(), '.gemini/antigravity/bin/agentapi');
                        cmd = `"${agentapiPath}" new-conversation "${escapedPrompt}"`;
                    }
                }

                // Enable the validation hook dynamically before running agentapi
                setHookEnabled(true);

                const output = await runCommand(cmd);
                console.log(`Commande exécutée avec succès. Output: ${output}`);

                let result;
                try {
                    result = JSON.parse(output);
                } catch (e) {
                    console.error("Impossible de parser l'output JSON :", e);
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
                        const infoMsg = await sock.sendMessage(sender, { text: `id_conv: ${conversationId} (Nouvelle discussion)` });
                        botMessageIds.add(infoMsg.key.id);
                    }
                    // Poll and stream response steps back to the user
                    await pollResponse(conversationId, sock, sender, startStepIndex);
                } else {
                    const finalReply = await sock.sendMessage(sender, { text: `Exécuté : ${output}` });
                    botMessageIds.add(finalReply.key.id);
                }

            } catch (err) {
                console.error("Erreur lors de l'exécution d'agentapi :", err);
                const errorReply = await sock.sendMessage(sender, { text: `❌ Erreur : ${err.message || err}` });
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
