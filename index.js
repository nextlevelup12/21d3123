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

// Código alfanumérico tipo K9LM31 (sem caracteres confusos: 0,O,1,I)
function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++)
        code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

async function discordFetch(path, options = {}) {
    const url = `https://discord.com/api/v10${path}`;
    console.log(`[DISCORD] Requisitando: ${url}`);
    const res = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bot ${BOT_TOKEN}`,
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });
    console.log(`[DISCORD] Status: ${res.status}`);
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
    console.log(`[REQUEST-CODE] discord_id: "${discord_id}"`);

    if (!discord_id || !/^\d{17,19}$/.test(discord_id))
        return res.status(400).json({ success: false, message: "ID invalido." });

    try {
        const memberRes  = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        const memberBody = await memberRes.text();
        console.log(`[REQUEST-CODE] Resposta Discord: ${memberBody}`);

        if (memberRes.status === 404)
            return res.json({ success: false, message: "Voce nao esta no servidor Discord." });
        if (memberRes.status === 401 || memberRes.status === 403)
            return res.status(500).json({ success: false, message: "Erro de permissao do bot. Contate o suporte." });
        if (!memberRes.ok)
            return res.status(500).json({ success: false, message: `Erro ao consultar Discord (${memberRes.status})` });

        const member = JSON.parse(memberBody);
        if (!member.roles.includes(ROLE_ID)) {
            console.log(`[REQUEST-CODE] Sem cargo. Cargos: ${JSON.stringify(member.roles)}`);
            return res.json({ success: false, message: "Voce nao tem o cargo necessario." });
        }

        const code      = generateCode();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingCodes.set(discord_id, { code, expiresAt });
        console.log(`[REQUEST-CODE] Codigo: ${code} para ${discord_id}`);

        const dmRes = await discordFetch("/users/@me/channels", {
            method: "POST",
            body: JSON.stringify({ recipient_id: discord_id })
        });
        if (!dmRes.ok)
            return res.status(500).json({ success: false, message: "Nao foi possivel enviar DM. Abra suas DMs." });

        const dm = await dmRes.json();
        const msgRes = await discordFetch(`/channels/${dm.id}/messages`, {
            method: "POST",
            body: JSON.stringify({
                content: `## 🔐 Cyclone Store | Loader\n\n━━━━━━━━━━━━━━━━━━━━━\n\n🎫 **Seu codigo de acesso:**\n\`\`\`\n${code}\n\`\`\`\n⏱️ Expira em **5 minutos**\n🚫 **Nunca** compartilhe este codigo\n\n━━━━━━━━━━━━━━━━━━━━━`
            })
        });

        if (!msgRes.ok)
            return res.status(500).json({ success: false, message: "Erro ao enviar DM." });

        return res.json({ success: true, message: "Codigo enviado na sua DM!" });
    } catch (err) {
        console.error("[REQUEST-CODE] Excecao:", err);
        return res.status(500).json({ success: false, message: "Erro interno no servidor." });
    }
});

app.post("/verify-code", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, code } = req.body;
    console.log(`[VERIFY-CODE] id: "${discord_id}" | code: "${code}"`);

    if (!discord_id || !code)
        return res.status(400).json({ authorized: false, message: "Dados invalidos." });

    const entry = pendingCodes.get(discord_id);
    if (!entry)
        return res.json({ authorized: false, message: "Nenhum codigo pendente. Solicite novamente." });
    if (Date.now() > entry.expiresAt) {
        pendingCodes.delete(discord_id);
        return res.json({ authorized: false, message: "Codigo expirado. Solicite novamente." });
    }
    if (entry.code.toUpperCase() !== code.trim().toUpperCase())
        return res.json({ authorized: false, message: "Codigo incorreto." });

    pendingCodes.delete(discord_id);
    console.log(`[VERIFY-CODE] Acesso liberado para ${discord_id}`);
    return res.json({ authorized: true, message: "Acesso liberado!" });
});

app.get("/health", (req, res) => res.json({
    status: "ok",
    guild_id: GUILD_ID,
    role_id: ROLE_ID,
    bot_token_set: !!BOT_TOKEN,
    api_secret_set: !!API_SECRET
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[STARTUP] API rodando na porta ${PORT}`));
