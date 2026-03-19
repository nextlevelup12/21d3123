const express = require("express");
const app = express();
app.use(express.json());

const BOT_TOKEN  = process.env.BOT_TOKEN;
const GUILD_ID   = process.env.GUILD_ID;
const ROLE_ID    = process.env.ROLE_ID;
const API_SECRET = process.env.API_SECRET;

// Verifica variaveis no startup
console.log("[STARTUP] BOT_TOKEN:", BOT_TOKEN ? "OK" : "FALTANDO");
console.log("[STARTUP] GUILD_ID:", GUILD_ID  ? GUILD_ID  : "FALTANDO");
console.log("[STARTUP] ROLE_ID:",  ROLE_ID   ? ROLE_ID   : "FALTANDO");
console.log("[STARTUP] API_SECRET:", API_SECRET ? "OK" : "FALTANDO");

// { discordId: { code, expiresAt } }
const pendingCodes = new Map();

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
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
        console.log("[AUTH] Falhou — secret invalido");
        res.status(401).json({ success: false, message: "Unauthorized" });
        return false;
    }
    return true;
}

// ============================================================
// ROTA 1: /request-code
// ============================================================
app.post("/request-code", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { discord_id } = req.body;
    console.log(`[REQUEST-CODE] discord_id recebido: "${discord_id}"`);

    if (!discord_id || !/^\d{17,19}$/.test(discord_id)) {
        console.log("[REQUEST-CODE] ID invalido ou fora do formato");
        return res.status(400).json({ success: false, message: "ID invalido. Use somente numeros (17-19 digitos)." });
    }

    try {
        // Busca membro no servidor
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        const memberBody = await memberRes.text();
        console.log(`[REQUEST-CODE] Resposta Discord: ${memberBody}`);

        if (memberRes.status === 404) {
            return res.json({ success: false, message: "Voce nao esta no servidor Discord." });
        }

        if (memberRes.status === 401 || memberRes.status === 403) {
            console.log("[REQUEST-CODE] Bot sem permissao — verifique Server Members Intent");
            return res.status(500).json({ success: false, message: "Erro interno de permissao. Contate o suporte." });
        }

        if (!memberRes.ok) {
            console.log(`[REQUEST-CODE] Erro inesperado do Discord: ${memberRes.status}`);
            return res.status(500).json({ success: false, message: `Erro ao consultar Discord (${memberRes.status})` });
        }

        const member = JSON.parse(memberBody);

        if (!member.roles.includes(ROLE_ID)) {
            console.log(`[REQUEST-CODE] Membro encontrado mas sem o cargo. Cargos: ${JSON.stringify(member.roles)}`);
            return res.json({ success: false, message: "Voce nao tem o cargo necessario." });
        }

        // Gera codigo de 6 digitos valido por 5 minutos
        const code      = generateCode();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingCodes.set(discord_id, { code, expiresAt });
        console.log(`[REQUEST-CODE] Codigo gerado: ${code} para ${discord_id}`);

        // Abre DM
        const dmRes = await discordFetch("/users/@me/channels", {
            method: "POST",
            body: JSON.stringify({ recipient_id: discord_id })
        });

        if (!dmRes.ok) {
            const dmBody = await dmRes.text();
            console.log(`[REQUEST-CODE] Erro ao abrir DM: ${dmBody}`);
            return res.status(500).json({ success: false, message: "Nao foi possivel enviar DM. Verifique se suas DMs estao abertas." });
        }

        const dm = await dmRes.json();

        // Envia codigo na DM
        const msgRes = await discordFetch(`/channels/${dm.id}/messages`, {
            method: "POST",
            body: JSON.stringify({
                content: `🔐 **Cyclone Store | Loader**\n\nSeu codigo de verificacao e: \`${code}\`\n\nEsse codigo expira em **5 minutos**.\nNunca compartilhe esse codigo com ninguem.`
            })
        });

        if (!msgRes.ok) {
            const msgBody = await msgRes.text();
            console.log(`[REQUEST-CODE] Erro ao enviar mensagem: ${msgBody}`);
            return res.status(500).json({ success: false, message: "Erro ao enviar DM" });
        }

        console.log(`[REQUEST-CODE] Codigo enviado com sucesso para ${discord_id}`);
        return res.json({ success: true, message: "Codigo enviado na sua DM do Discord!" });

    } catch (err) {
        console.error("[REQUEST-CODE] Excecao:", err);
        return res.status(500).json({ success: false, message: "Erro interno no servidor" });
    }
});

// ============================================================
// ROTA 2: /verify-code
// ============================================================
app.post("/verify-code", async (req, res) => {
    if (!checkSecret(req, res)) return;

    const { discord_id, code } = req.body;
    console.log(`[VERIFY-CODE] discord_id: "${discord_id}" | code: "${code}"`);

    if (!discord_id || !code) {
        return res.status(400).json({ authorized: false, message: "Dados invalidos" });
    }

    const entry = pendingCodes.get(discord_id);

    if (!entry) {
        console.log("[VERIFY-CODE] Nenhum codigo pendente para este ID");
        return res.json({ authorized: false, message: "Nenhum codigo pendente. Solicite novamente." });
    }

    if (Date.now() > entry.expiresAt) {
        pendingCodes.delete(discord_id);
        console.log("[VERIFY-CODE] Codigo expirado");
        return res.json({ authorized: false, message: "Codigo expirado. Solicite novamente." });
    }

    if (entry.code !== code.trim()) {
        console.log(`[VERIFY-CODE] Codigo incorreto. Esperado: ${entry.code} | Recebido: ${code.trim()}`);
        return res.json({ authorized: false, message: "Codigo incorreto" });
    }

    pendingCodes.delete(discord_id);
    console.log(`[VERIFY-CODE] Acesso liberado para ${discord_id}`);
    return res.json({ authorized: true, message: "Acesso liberado!" });
});

// ============================================================
// ROTA DE TESTE
// ============================================================
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        guild_id: GUILD_ID,
        role_id: ROLE_ID,
        bot_token_set: !!BOT_TOKEN,
        api_secret_set: !!API_SECRET
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[STARTUP] API rodando na porta ${PORT}`));
