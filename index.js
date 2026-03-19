const express = require("express");
const app = express();
app.use(express.json());

// ============================================================
// CONFIGURAR NO RAILWAY (Variables)
// ============================================================
const BOT_TOKEN  = process.env.BOT_TOKEN;
const GUILD_ID   = process.env.GUILD_ID;
const ROLE_ID    = process.env.ROLE_ID;
const API_SECRET = process.env.API_SECRET;
// ============================================================

// Armazena os codigos temporarios em memoria
// { discordId: { code, expiresAt } }
const pendingCodes = new Map();

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function discordFetch(path, options = {}) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
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

// ============================================================
// ROTA 1: /request-code
// Verifica cargo e envia DM com codigo temporario
// ============================================================
app.post("/request-code", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { discord_id } = req.body;

    if (!discord_id || !/^\d{17,19}$/.test(discord_id)) {
        return res.status(400).json({ success: false, message: "ID invalido" });
    }

    try {
        // 1. Verifica se o usuario esta no servidor e tem o cargo
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);

        if (memberRes.status === 404) {
            return res.json({ success: false, message: "Voce nao esta no servidor" });
        }
        if (!memberRes.ok) {
            return res.status(500).json({ success: false, message: "Erro ao consultar Discord" });
        }

        const member = await memberRes.json();
        if (!member.roles.includes(ROLE_ID)) {
            return res.json({ success: false, message: "Voce nao tem o cargo necessario" });
        }

        // 2. Gera codigo de 6 digitos valido por 5 minutos
        const code      = generateCode();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingCodes.set(discord_id, { code, expiresAt });

        // 3. Abre DM com o usuario
        const dmRes = await discordFetch("/users/@me/channels", {
            method: "POST",
            body: JSON.stringify({ recipient_id: discord_id })
        });

        if (!dmRes.ok) {
            return res.status(500).json({ success: false, message: "Nao foi possivel enviar DM. Verifique se suas DMs estao abertas." });
        }

        const dm = await dmRes.json();

        // 4. Envia o codigo na DM
        const msgRes = await discordFetch(`/channels/${dm.id}/messages`, {
            method: "POST",
            body: JSON.stringify({
                content: `🔐 **Cyclone Store | Loader**\n\nSeu codigo de verificacao e: \`${code}\`\n\nEsse codigo expira em **5 minutos**.\nNunca compartilhe esse codigo com ninguem.`
            })
        });

        if (!msgRes.ok) {
            return res.status(500).json({ success: false, message: "Erro ao enviar DM" });
        }

        return res.json({ success: true, message: "Codigo enviado na sua DM do Discord!" });

    } catch (err) {
        console.error("Erro /request-code:", err);
        return res.status(500).json({ success: false, message: "Erro interno" });
    }
});

// ============================================================
// ROTA 2: /verify-code
// Valida o codigo digitado pelo usuario
// ============================================================
app.post("/verify-code", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { discord_id, code } = req.body;

    if (!discord_id || !code) {
        return res.status(400).json({ authorized: false, message: "Dados invalidos" });
    }

    const entry = pendingCodes.get(discord_id);

    if (!entry) {
        return res.json({ authorized: false, message: "Nenhum codigo pendente. Solicite novamente." });
    }

    if (Date.now() > entry.expiresAt) {
        pendingCodes.delete(discord_id);
        return res.json({ authorized: false, message: "Codigo expirado. Solicite novamente." });
    }

    if (entry.code !== code.trim()) {
        return res.json({ authorized: false, message: "Codigo incorreto" });
    }

    // Codigo valido — remove da memoria
    pendingCodes.delete(discord_id);

    return res.json({ authorized: true, message: "Acesso liberado!" });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));