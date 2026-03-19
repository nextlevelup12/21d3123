const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(express.json());

// ============================================================
// ENV VARS
// ============================================================
const BOT_TOKEN  = process.env.BOT_TOKEN;
const GUILD_ID   = process.env.GUILD_ID;
const ROLE_ID    = process.env.ROLE_ID;
const API_SECRET = process.env.API_SECRET;
const ADMIN_KEY  = process.env.ADMIN_KEY;

console.log("[STARTUP] BOT_TOKEN:",   BOT_TOKEN  ? "OK" : "FALTANDO");
console.log("[STARTUP] GUILD_ID:",    GUILD_ID   ? GUILD_ID  : "FALTANDO");
console.log("[STARTUP] ROLE_ID:",     ROLE_ID    ? ROLE_ID   : "FALTANDO");
console.log("[STARTUP] API_SECRET:",  API_SECRET ? "OK" : "FALTANDO");
console.log("[STARTUP] ADMIN_KEY:",   ADMIN_KEY  ? "OK" : "FALTANDO (reset de HWID desativado)");

// ============================================================
// SQLITE
// ============================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cyclone.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS hwid_lock (
    discord_id TEXT PRIMARY KEY,
    hwid       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

console.log("[STARTUP] SQLite OK:", DB_PATH);

// ============================================================
// CODIGOS PENDENTES
// ============================================================
const pendingCodes = new Map();

function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++)
        code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// ============================================================
// HELPERS
// ============================================================
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

function checkAdmin(req, res) {
    const key = req.headers["x-admin-key"];
    if (!ADMIN_KEY || !key || key !== ADMIN_KEY) {
        res.status(401).json({ success: false, message: "Admin key invalida." });
        return false;
    }
    return true;
}

// Pega o nome de display do membro no servidor
// Prioridade: nick do servidor > display_name global > username
function getMemberName(member) {
    if (member.nick) return member.nick;
    if (member.user && member.user.global_name) return member.user.global_name;
    if (member.user && member.user.username) return member.user.username;
    return "Desconhecido";
}

// Busca o nome do cargo pelo ROLE_ID na lista de roles do servidor
async function getRoleName(roleId) {
    try {
        const res = await discordFetch(`/guilds/${GUILD_ID}/roles`);
        if (!res.ok) return "Membro";
        const roles = await res.json();
        const role = roles.find(r => r.id === roleId);
        return role ? role.name : "Membro";
    } catch {
        return "Membro";
    }
}

// ============================================================
// ROTAS
// ============================================================

// 1) Solicitar codigo
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

// 2) Verificar codigo
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

// 3) Vincular / verificar HWID — agora retorna username e cargo
app.post("/bind-hwid", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, hwid } = req.body;
    console.log(`[BIND-HWID] id: "${discord_id}" | hwid: "${hwid}"`);

    if (!discord_id || !hwid || hwid.length < 8)
        return res.status(400).json({ allowed: false, message: "Dados invalidos." });

    // Busca infos do membro no Discord para retornar nome e cargo
    let username = "Desconhecido";
    let cargo    = "Membro";
    try {
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        if (memberRes.ok) {
            const member = await memberRes.json();
            username = getMemberName(member);

            // Pega o nome do cargo mais alto que o membro tem
            // (ignora @everyone que todo mundo tem)
            if (member.roles && member.roles.length > 0) {
                const rolesRes = await discordFetch(`/guilds/${GUILD_ID}/roles`);
                if (rolesRes.ok) {
                    const allRoles = await rolesRes.json();
                    // Filtra pelos cargos que o membro tem, ordena por posicao (maior = mais importante)
                    const memberRoles = allRoles
                        .filter(r => member.roles.includes(r.id))
                        .sort((a, b) => b.position - a.position);
                    if (memberRoles.length > 0)
                        cargo = memberRoles[0].name;
                }
            }
        }
    } catch (err) {
        console.error("[BIND-HWID] Erro ao buscar membro Discord:", err);
        // Continua mesmo se falhar — nao bloqueia o login
    }

    console.log(`[BIND-HWID] username: "${username}" | cargo: "${cargo}"`);

    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(discord_id);

    if (!row) {
        db.prepare("INSERT INTO hwid_lock (discord_id, hwid, created_at) VALUES (?, ?, ?)")
          .run(discord_id, hwid, Date.now());
        console.log(`[BIND-HWID] Novo vinculo: ${discord_id} -> ${hwid}`);
        return res.json({ allowed: true, message: "HWID registrado com sucesso.", username, cargo });
    }

    if (row.hwid !== hwid) {
        console.log(`[BIND-HWID] BLOQUEADO: ${discord_id} | esperado: ${row.hwid} | recebido: ${hwid}`);
        return res.json({ allowed: false, message: "Acesso negado: este ID ja esta vinculado a outro PC. Contate o suporte." });
    }

    console.log(`[BIND-HWID] HWID ok para ${discord_id}`);
    return res.json({ allowed: true, message: "HWID verificado.", username, cargo });
});

// 4) Reset de HWID
app.post("/reset-hwid", (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { discord_id } = req.body;

    if (!discord_id)
        return res.status(400).json({ success: false, message: "discord_id obrigatorio." });

    const info = db.prepare("DELETE FROM hwid_lock WHERE discord_id = ?").run(discord_id);

    if (info.changes === 0)
        return res.json({ success: false, message: "Nenhum HWID encontrado para esse ID." });

    console.log(`[RESET-HWID] HWID removido para ${discord_id}`);
    return res.json({ success: true, message: `HWID de ${discord_id} resetado com sucesso.` });
});

// 5) Listar todos os HWIDs vinculados
app.get("/list-hwids", (req, res) => {
    if (!checkAdmin(req, res)) return;
    const rows = db.prepare("SELECT discord_id, hwid, created_at FROM hwid_lock ORDER BY created_at DESC").all();
    return res.json({ success: true, count: rows.length, data: rows });
});

// 6) Health check
app.get("/health", (req, res) => res.json({
    status: "ok",
    guild_id: GUILD_ID,
    role_id: ROLE_ID,
    bot_token_set: !!BOT_TOKEN,
    api_secret_set: !!API_SECRET,
    admin_key_set: !!ADMIN_KEY,
    db_path: DB_PATH
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[STARTUP] API rodando na porta ${PORT}`));
