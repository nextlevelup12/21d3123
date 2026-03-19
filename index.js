const express = require("express");
const app = express();
app.use(express.json());

const BOT_TOKEN  = process.env.BOT_TOKEN;
const GUILD_ID   = process.env.GUILD_ID;
const ROLE_ID    = process.env.ROLE_ID;
const API_SECRET = process.env.API_SECRET;

console.log("[STARTUP] BOT_TOKEN:", BOT_TOKEN ? "OK" : "FALTANDO");
console.log("[STARTUP] GUILD_ID:", GUILD_ID  ? GUILD_ID  : "FALTANDO");
console.log("[STARTUP] ROLE_ID:",  ROLE_ID   ? ROLE_ID   : "FALTANDO");
console.log("[STARTUP] API_SECRET:", API_SECRET ? "OK" : "FALTANDO");

const pendingCodes = new Map();

// Código alfanumérico tipo K9LM31
function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++)
        code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

async function discordFetch(path, options = {}) {
    const url = `https://discord.com/api/v10${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bot ${BOT_TOKEN}`,
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });
    return res;
}

function checkSecret(req, res) {
    const secret = req.headers["x-api-secret"];
    if (!secret || secret !== API_SECRET) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return false;
    }
    return true;
}

app.post("/request-code", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id } = req.body;

    if (!discord_id || !/^\d{17,19}$/.test(discord_id))
        return res.status(400).json({ success: false, message: "ID invalido." });

    try {
        const memberRes  = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        if (memberRes.status === 404)
            return res.json({ success: false, message: "Voce nao esta no servidor Discord." });
        
        if (!memberRes.ok)
            return res.status(500).json({ success: false, message: "Erro ao consultar Discord." });

        const member = await memberRes.json();
        if (!member.roles.includes(ROLE_ID)) {
            return res.json({ success: false, message: "Voce nao tem o cargo necessario." });
        }

        const code      = generateCode();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingCodes.set(discord_id, { code, expiresAt });

        const dmRes = await discordFetch("/users/@me/channels", {
            method: "POST",
            body: JSON.stringify({ recipient_id: discord_id })
        });

        if (!dmRes.ok)
            return res.status(500).json({ success: false, message: "Abra suas DMs para receber o codigo." });

        const dm = await dmRes.json();
        
        // --- PARTE VISUAL MELHORADA (EMBED) ---
        const msgRes = await discordFetch(`/channels/${dm.id}/messages`, {
            method: "POST",
            body: JSON.stringify({
                embeds: [{
                    title: "🔐 Autenticação Cyclone Store",
                    description: "Um novo acesso ao seu **Loader** foi solicitado via API.",
                    color: 0x5865F2, // Cor Blurple do Discord
                    fields: [
                        {
                            name: "🔑 Código de Verificação",
                            value: `\`\`\`${code}\`\`\``,
                            inline: false
                        },
                        {
                            name: "⏱️ Expira em",
                            value: "5 minutos",
                            inline: true
                        },
                        {
                            name: "⚠️ Segurança",
                            value: "Nunca compartilhe.",
                            inline: true
                        }
                    ],
                    footer: {
                        text: "Cyclone Store | Proteção de Acesso",
                        icon_url: "https://cdn-icons-png.flaticon.com/512/1162/1162456.png"
                    },
                    timestamp: new Date().toISOString()
                }]
            })
        });

        if (!msgRes.ok)
            return res.status(500).json({ success: false, message: "Erro ao enviar Embed." });

        return res.json({ success: true, message: "Codigo enviado na sua DM!" });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Erro interno." });
    }
});

app.post("/verify-code", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, code } = req.body;

    if (!discord_id || !code)
        return res.status(400).json({ authorized: false, message: "Dados invalidos." });

    const entry = pendingCodes.get(discord_id);
    if (!entry)
        return res.json({ authorized: false, message: "Nenhum codigo pendente." });
    
    if (Date.now() > entry.expiresAt) {
        pendingCodes.delete(discord_id);
        return res.json({ authorized: false, message: "Codigo expirado." });
    }
    
    if (entry.code.toUpperCase() !== code.trim().toUpperCase())
        return res.json({ authorized: false, message: "Codigo incorreto." });

    pendingCodes.delete(discord_id);
    return res.json({ authorized: true, message: "Acesso liberado!" });
});

app.get("/health", (req, res) => res.json({
    status: "ok",
    bot_ready: !!BOT_TOKEN
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[STARTUP] API rodando na porta ${PORT}`));
