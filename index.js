const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(express.json());

// ============================================================
// ENV VARS
// ============================================================
const BOT_TOKEN       = process.env.BOT_TOKEN;
const GUILD_ID        = process.env.GUILD_ID;
const ROLE_ID         = process.env.ROLE_ID;
const API_SECRET      = process.env.API_SECRET;
const ADMIN_KEY       = process.env.ADMIN_KEY;
const LOG_CHANNEL_ID  = process.env.LOG_CHANNEL_ID;
const LINK_CHANNEL_ID = process.env.LINK_CHANNEL_ID;
const ID_ALLOWED      = process.env.ID_ALLOWED;
const BASE_URL        = process.env.BASE_URL || "https://21d3123-production.up.railway.app";

console.log("[STARTUP] BOT_TOKEN:",       BOT_TOKEN       ? "OK" : "FALTANDO");
console.log("[STARTUP] GUILD_ID:",        GUILD_ID        ? GUILD_ID  : "FALTANDO");
console.log("[STARTUP] ROLE_ID:",         ROLE_ID         ? ROLE_ID   : "FALTANDO");
console.log("[STARTUP] API_SECRET:",      API_SECRET      ? "OK" : "FALTANDO");
console.log("[STARTUP] ADMIN_KEY:",       ADMIN_KEY       ? "OK" : "FALTANDO");
console.log("[STARTUP] ID_ALLOWED:",      ID_ALLOWED      ? "OK" : "NAO DEFINIDO");
console.log("[STARTUP] LOG_CHANNEL_ID:",  LOG_CHANNEL_ID  || "NAO DEFINIDO");
console.log("[STARTUP] LINK_CHANNEL_ID:", LINK_CHANNEL_ID || "NAO DEFINIDO");
console.log("[STARTUP] BASE_URL:",        BASE_URL);

// ============================================================
// SQLITE
// ============================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cyclone.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS hwid_lock (
    discord_id TEXT PRIMARY KEY,
    hwid       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE IF NOT EXISTS banned_ids (
    discord_id TEXT PRIMARY KEY,
    reason     TEXT,
    banned_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hwid_penalty (
    hwid       TEXT PRIMARY KEY,
    until      INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS hwid_attempts (
    hwid       TEXT PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 0,
    last_try   INTEGER NOT NULL
  );
`);

// Migracao: adiciona last_login se nao existir
try { db.exec(`ALTER TABLE hwid_lock ADD COLUMN last_login INTEGER`); } catch (_) {}

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
async function discordFetch(endpoint, options = {}) {
    const url = `https://discord.com/api/v10${endpoint}`;
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

function checkAdmin(req, res) {
    const key = req.headers["x-admin-key"];
    if (!ADMIN_KEY || !key || key !== ADMIN_KEY) {
        res.status(401).json({ success: false, message: "Admin key invalida." });
        return false;
    }
    return true;
}

function getMemberName(member) {
    if (member.nick) return member.nick;
    if (member.user && member.user.global_name) return member.user.global_name;
    if (member.user && member.user.username) return member.user.username;
    return "Desconhecido";
}

// ============================================================
// BAN DE ID
// ============================================================
function isIdBanned(discord_id) {
    return !!db.prepare("SELECT 1 FROM banned_ids WHERE discord_id = ?").get(discord_id);
}

function banId(discord_id, reason) {
    db.prepare("INSERT OR REPLACE INTO banned_ids (discord_id, reason, banned_at) VALUES (?, ?, ?)")
      .run(discord_id, reason || "Sem motivo informado", Date.now());
}

function unbanId(discord_id) {
    db.prepare("DELETE FROM banned_ids WHERE discord_id = ?").run(discord_id);
}

// ============================================================
// CASTIGO DE HWID (6 tentativas erradas = bloqueio de 1h)
// ============================================================
const MAX_ATTEMPTS = 6;
const PENALTY_MS   = 60 * 60 * 1000;

function checkHwidPenalty(hwid) {
    const row = db.prepare("SELECT until FROM hwid_penalty WHERE hwid = ?").get(hwid);
    if (!row) return null;
    if (Date.now() < row.until) return row.until;
    db.prepare("DELETE FROM hwid_penalty WHERE hwid = ?").run(hwid);
    db.prepare("DELETE FROM hwid_attempts WHERE hwid = ?").run(hwid);
    return null;
}

function registerFailedAttempt(hwid) {
    const now = Date.now();
    const row = db.prepare("SELECT count FROM hwid_attempts WHERE hwid = ?").get(hwid);
    const count = row ? row.count + 1 : 1;
    db.prepare("INSERT OR REPLACE INTO hwid_attempts (hwid, count, last_try) VALUES (?, ?, ?)")
      .run(hwid, count, now);
    if (count >= MAX_ATTEMPTS) {
        const until = now + PENALTY_MS;
        db.prepare("INSERT OR REPLACE INTO hwid_penalty (hwid, until, attempts) VALUES (?, ?, ?)")
          .run(hwid, until, count);
        db.prepare("DELETE FROM hwid_attempts WHERE hwid = ?").run(hwid);
        return { penalized: true, until, count };
    }
    return { penalized: false, count, remaining: MAX_ATTEMPTS - count };
}

function clearHwidPenalty(hwid) {
    db.prepare("DELETE FROM hwid_penalty WHERE hwid = ?").run(hwid);
    db.prepare("DELETE FROM hwid_attempts WHERE hwid = ?").run(hwid);
}

// ============================================================
// LOG DE LOGIN (embed verde/azul + botao Reset HWID)
// ============================================================
async function sendLoginLog(discord_id, username, cargo, hwid, isNew) {
    if (!BOT_TOKEN || !LOG_CHANNEL_ID) return;

    const resetUrl = `${BASE_URL}/reset-hwid-web?id=${discord_id}&key=${encodeURIComponent(ADMIN_KEY)}&nome=${encodeURIComponent(username)}&cargo=${encodeURIComponent(cargo)}&hwid=${encodeURIComponent(hwid)}`;

    const embed = {
        title: isNew ? "🆕 Novo Registro — Loader Cyclone" : "✅ Login — Loader Cyclone",
        color: isNew ? 0x5865F2 : 0x57F287,
        fields: [
            { name: "👤 Nome",  value: `\`${username}\``,    inline: true  },
            { name: "🏷️ Cargo", value: `\`${cargo}\``,      inline: true  },
            { name: "\u200b",   value: "\u200b",             inline: true  },
            { name: "🆔 ID",    value: `\`${discord_id}\``,  inline: false },
            { name: "💻 HWID",  value: `\`${hwid}\``,        inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "Cyclone Store | Loader" }
    };

    try {
        await discordFetch(`/channels/${LOG_CHANNEL_ID}/messages`, {
            method: "POST",
            body: JSON.stringify({
                embeds: [embed],
                components: [{
                    type: 1,
                    components: [{
                        type: 2,
                        style: 5,
                        label: "🔄 Reset HWID",
                        url: resetUrl
                    }]
                }]
            })
        });
    } catch (err) {
        console.error("[LOG] Erro ao enviar login log:", err);
    }
}

// ============================================================
// LOG DE BLOQUEIO (embed vermelha + botao Painel Admin)
// ============================================================
async function sendBlockLog(discord_id, username, hwid, reason, attempts) {
    if (!BOT_TOKEN || !LOG_CHANNEL_ID) return;

    const adminUrl = `${BASE_URL}/admin-login`;

    const embed = {
        title: "🚫 Acesso Bloqueado — Loader Cyclone",
        color: 0xE74C3C,
        fields: [
            { name: "👤 Nome",       value: `\`${username}\``,       inline: true  },
            { name: "❌ Motivo",     value: `\`${reason}\``,         inline: true  },
            { name: "\u200b",        value: "\u200b",                inline: true  },
            { name: "🆔 ID",         value: `\`${discord_id}\``,     inline: false },
            { name: "💻 HWID",       value: `\`${hwid || "N/A"}\``,  inline: false },
            { name: "🔢 Tentativas", value: `\`${attempts}\``,       inline: true  },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "Cyclone Store | Loader" }
    };

    try {
        await discordFetch(`/channels/${LOG_CHANNEL_ID}/messages`, {
            method: "POST",
            body: JSON.stringify({
                embeds: [embed],
                components: [{
                    type: 1,
                    components: [{
                        type: 2,
                        style: 5,
                        label: "🛡️ Painel Admin",
                        url: adminUrl
                    }]
                }]
            })
        });
    } catch (err) {
        console.error("[LOG] Erro ao enviar block log:", err);
    }
}

// ============================================================
// BUSCA CARGO DO MEMBRO
// ============================================================
async function getMemberInfo(discord_id) {
    let username = "Desconhecido";
    let cargo    = "Membro";
    let avatar   = "";
    try {
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        if (memberRes.ok) {
            const member = await memberRes.json();
            username = getMemberName(member);
            // Avatar: server avatar tem prioridade, depois global
            if (member.avatar)
                avatar = `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${discord_id}/avatars/${member.avatar}.png?size=64`;
            else if (member.user && member.user.avatar)
                avatar = `https://cdn.discordapp.com/avatars/${discord_id}/${member.user.avatar}.png?size=64`;

            if (member.roles && member.roles.length > 0) {
                const rolesRes = await discordFetch(`/guilds/${GUILD_ID}/roles`);
                if (rolesRes.ok) {
                    const allRoles = await rolesRes.json();
                    const memberRoles = allRoles
                        .filter(r => member.roles.includes(r.id))
                        .filter(r => r.id !== GUILD_ID)
                        .sort((a, b) => b.position - a.position);
                    if (memberRoles.length > 0) {
                        let rawName = memberRoles[0].name;
                        const pipeIdx = rawName.indexOf('|');
                        if (pipeIdx !== -1) rawName = rawName.substring(pipeIdx + 1);
                        rawName = rawName.replace(/[^\x20-\x7E]/g, '').trim();
                        if (rawName.length > 0) cargo = rawName;
                    }
                }
            }
        }
    } catch (err) {
        console.error("[MEMBER-INFO] Erro:", err);
    }
    return { username, cargo, avatar };
}

// ============================================================
// ROTAS
// ============================================================

// 1) Solicitar codigo
app.post("/request-code", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id } = req.body;

    if (!discord_id || !/^\d{17,19}$/.test(discord_id))
        return res.status(400).json({ success: false, message: "ID invalido." });

    // Verifica ban
    if (isIdBanned(discord_id))
        return res.json({ success: false, message: "Sua conta foi banida. Contate o suporte." });

    try {
        const memberRes  = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        const memberBody = await memberRes.text();

        if (memberRes.status === 404)
            return res.json({ success: false, message: "Voce nao esta no servidor Discord." });
        if (memberRes.status === 401 || memberRes.status === 403)
            return res.status(500).json({ success: false, message: "Erro de permissao do bot." });
        if (!memberRes.ok)
            return res.status(500).json({ success: false, message: `Erro ao consultar Discord (${memberRes.status})` });

        const member = JSON.parse(memberBody);
        if (!member.roles.includes(ROLE_ID))
            return res.json({ success: false, message: "Voce nao tem o cargo necessario." });

        const code      = generateCode();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        pendingCodes.set(discord_id, { code, expiresAt });

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

    if (!discord_id || !code)
        return res.status(400).json({ authorized: false, message: "Dados invalidos." });

    // Verifica ban
    if (isIdBanned(discord_id))
        return res.json({ authorized: false, message: "Sua conta foi banida. Contate o suporte." });

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
    return res.json({ authorized: true, message: "Acesso liberado!" });
});

// 3) Vincular / verificar HWID
app.post("/bind-hwid", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, hwid } = req.body;

    if (!discord_id || !hwid || hwid.length < 8)
        return res.status(400).json({ allowed: false, message: "Dados invalidos." });

    // Verifica ban de ID
    if (isIdBanned(discord_id)) {
        const { username } = await getMemberInfo(discord_id).catch(() => ({ username: "Desconhecido" }));
        sendBlockLog(discord_id, username, hwid, "ID Banido", 0).catch(() => {});
        return res.json({ allowed: false, message: "Sua conta foi banida. Contate o suporte." });
    }

    // Verifica castigo de HWID
    const penaltyUntil = checkHwidPenalty(hwid);
    if (penaltyUntil) {
        const minRestantes = Math.ceil((penaltyUntil - Date.now()) / 60000);
        return res.json({ allowed: false, message: `HWID bloqueado por excesso de tentativas. Aguarde ${minRestantes} minuto(s) ou contate o suporte.` });
    }

    const { username, cargo, avatar } = await getMemberInfo(discord_id);

    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(discord_id);

    if (!row) {
        db.prepare("INSERT INTO hwid_lock (discord_id, hwid, created_at, last_login) VALUES (?, ?, ?, ?)")
          .run(discord_id, hwid, Date.now(), Date.now());
        sendLoginLog(discord_id, username, cargo, hwid, true).catch(() => {});
        return res.json({ allowed: true, message: "HWID registrado.", username, cargo, avatar });
    }

    if (row.hwid !== hwid) {
        const attempt = registerFailedAttempt(hwid);
        console.log(`[BIND-HWID] HWID errado para ${discord_id} | tentativa ${attempt.count}`);

        if (attempt.penalized) {
            sendBlockLog(discord_id, username, hwid, `Castigo: ${MAX_ATTEMPTS} tentativas erradas`, attempt.count).catch(() => {});
            return res.json({ allowed: false, message: `Muitas tentativas incorretas. HWID bloqueado por 1 hora.` });
        }

        sendBlockLog(discord_id, username, hwid, `HWID incorreto (tentativa ${attempt.count}/${MAX_ATTEMPTS})`, attempt.count).catch(() => {});
        return res.json({ allowed: false, message: `Acesso negado: PC diferente. Tentativa ${attempt.count}/${MAX_ATTEMPTS}. Contate o suporte.` });
    }

    // HWID correto — atualiza last_login e limpa tentativas
    db.prepare("UPDATE hwid_lock SET last_login = ? WHERE discord_id = ?").run(Date.now(), discord_id);
    clearHwidPenalty(hwid);
    sendLoginLog(discord_id, username, cargo, hwid, false).catch(() => {});
    return res.json({ allowed: true, message: "HWID verificado.", username, cargo, avatar });
});

// 4) Reset de HWID via POST (API direta)
app.post("/reset-hwid", (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { discord_id } = req.body;
    if (!discord_id)
        return res.status(400).json({ success: false, message: "discord_id obrigatorio." });

    const info = db.prepare("DELETE FROM hwid_lock WHERE discord_id = ?").run(discord_id);
    if (info.changes === 0)
        return res.json({ success: false, message: "Nenhum HWID encontrado." });

    return res.json({ success: true, message: `HWID de ${discord_id} resetado.` });
});

// 5) Página web de confirmação de reset (link do botão Reset HWID nos logs)
app.get("/reset-hwid-web", (req, res) => {
    const { id, key, nome, cargo, hwid } = req.query;

    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).send(pageError("Chave de admin inválida."));

    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(id);
    const hwidAtual = row ? row.hwid : "Não registrado";

    res.send(pageConfirmReset({ id, key, nome, cargo, hwidAtual }));
});

// 6) Processa o reset via fetch da página web
app.post("/reset-hwid-confirm", (req, res) => {
    const { id, key } = req.body;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).json({ success: false, message: "Chave inválida." });
    if (!id)
        return res.status(400).json({ success: false, message: "ID obrigatorio." });

    const info = db.prepare("DELETE FROM hwid_lock WHERE discord_id = ?").run(id);
    if (info.changes === 0)
        return res.json({ success: false, message: "Nenhum HWID encontrado para esse ID." });

    return res.json({ success: true });
});

// 7) Ban de ID
app.post("/ban-id", async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { discord_id, reason } = req.body;
    if (!discord_id)
        return res.status(400).json({ success: false, message: "discord_id obrigatorio." });

    banId(discord_id, reason);

    // Busca infos e manda log no canal
    const { username, cargo } = await getMemberInfo(discord_id).catch(() => ({ username: "Desconhecido", cargo: "Membro" }));
    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(discord_id);
    sendBlockLog(discord_id, username, row?.hwid || "N/A", `Banido pelo admin${reason ? ': ' + reason : ''}`, 0).catch(() => {});

    return res.json({ success: true, message: `ID ${discord_id} banido.` });
});

// 8) Unban de ID
app.post("/unban-id", async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { discord_id } = req.body;
    if (!discord_id)
        return res.status(400).json({ success: false, message: "discord_id obrigatorio." });

    unbanId(discord_id);

    // Log de desban no canal
    const { username, cargo } = await getMemberInfo(discord_id).catch(() => ({ username: "Desconhecido", cargo: "Membro" }));
    if (BOT_TOKEN && LOG_CHANNEL_ID) {
        discordFetch(`/channels/${LOG_CHANNEL_ID}/messages`, {
            method: "POST",
            body: JSON.stringify({
                embeds: [{
                    title: "✅ Conta Desbanida — Loader Cyclone",
                    color: 0x57F287,
                    fields: [
                        { name: "👤 Nome",  value: `\`${username}\``,   inline: true },
                        { name: "🏷️ Cargo", value: `\`${cargo}\``,     inline: true },
                        { name: "🆔 ID",    value: `\`${discord_id}\``, inline: false },
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: "Cyclone Store | Loader" }
                }]
            })
        }).catch(() => {});
    }

    return res.json({ success: true, message: `ID ${discord_id} desbanido.` });
});

// 8.5) Check de status — loader consulta periodicamente se ainda tem acesso
app.post("/check-status", (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, hwid } = req.body;
    if (!discord_id || !hwid)
        return res.status(400).json({ active: false, message: "Dados invalidos." });

    // Verifica ban
    if (isIdBanned(discord_id))
        return res.json({ active: false, reason: "banned", message: "Sua conta foi banida. Contate o suporte." });

    // Verifica se HWID ainda está vinculado
    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(discord_id);
    if (!row)
        return res.json({ active: false, reason: "hwid_reset", message: "HWID foi resetado. Faca login novamente." });
    if (row.hwid !== hwid)
        return res.json({ active: false, reason: "hwid_mismatch", message: "PC nao autorizado. Faca login novamente." });

    return res.json({ active: true });
});

// 9) Tirar castigo de HWID
app.post("/clear-penalty", (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { hwid } = req.body;
    if (!hwid)
        return res.status(400).json({ success: false, message: "hwid obrigatorio." });

    clearHwidPenalty(hwid);
    return res.json({ success: true, message: `Castigo removido para HWID ${hwid}.` });
});

// 10) Listar todos os HWIDs
app.get("/list-hwids", (req, res) => {
    if (!checkAdmin(req, res)) return;
    const rows = db.prepare("SELECT discord_id, hwid, created_at, last_login FROM hwid_lock ORDER BY last_login DESC").all();
    return res.json({ success: true, count: rows.length, data: rows });
});

// 11) Painel admin — busca por ID, lista usuarios, ban/unban, castigo
app.get("/admin", (req, res) => {
    const { key } = req.query;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).send(pageError("Acesso negado."));
    res.send(pageAdmin(key));
});

// 12) Busca dados do usuario pelo ID para o painel admin
app.post("/admin-buscar", async (req, res) => {
    const { id, key } = req.body;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).json({ success: false, message: "Chave inválida." });
    if (!id)
        return res.status(400).json({ success: false, message: "ID obrigatorio." });

    const row = db.prepare("SELECT hwid, created_at, last_login FROM hwid_lock WHERE discord_id = ?").get(id);
    const banned = isIdBanned(id);
    const banRow = db.prepare("SELECT reason, banned_at FROM banned_ids WHERE discord_id = ?").get(id);

    const { username, cargo } = await getMemberInfo(id);

    return res.json({
        success: true,
        username,
        cargo,
        hwid:       row ? row.hwid : null,
        created_at: row ? row.created_at : null,
        last_login: row ? row.last_login : null,
        banned,
        ban_reason: banRow ? banRow.reason : null,
        ban_at:     banRow ? banRow.banned_at : null,
    });
});

// 13) Lista todos usuarios registrados para o painel
app.post("/admin-list", (req, res) => {
    const { key } = req.body;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).json({ success: false, message: "Chave inválida." });

    const rows = db.prepare(`
        SELECT h.discord_id, h.hwid, h.created_at, h.last_login,
               b.reason as ban_reason, b.banned_at
        FROM hwid_lock h
        LEFT JOIN banned_ids b ON h.discord_id = b.discord_id
        ORDER BY COALESCE(h.last_login, h.created_at) DESC
    `).all();

    const penalties = db.prepare("SELECT hwid, until, attempts FROM hwid_penalty").all();

    return res.json({ success: true, data: rows, penalties });
});

// 14) Página de login do painel admin
app.get("/admin-login", (req, res) => {
    res.send(pageAdminLogin());
});

// 15) Verifica ID + chave de login
app.post("/admin-login-check", (req, res) => {
    const { discord_id, key } = req.body;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.json({ success: false, message: "Chave de acesso incorreta." });
    if (ID_ALLOWED) {
        const allowedList = ID_ALLOWED.split(",").map(s => s.trim());
        if (!allowedList.includes(discord_id))
            return res.json({ success: false, message: "ID do Discord nao autorizado." });
    }
    return res.json({ success: true });
});

// 16) Embed do painel no canal de link
async function sendAdminPanelEmbed() {
    if (!BOT_TOKEN || !LINK_CHANNEL_ID) return;
    const loginUrl = `${BASE_URL}/admin-login`;
    const embed = {
        title: "🛡️ Painel Administrativo",
        description: "Acesse o painel para gerenciar HWIDs dos usuários do Loader.",
        color: 0x2B2D31,
        fields: [
            { name: "🔐 Acesso restrito", value: "Apenas administradores com a chave correta podem acessar.", inline: false },
            { name: "⚙️ Funcionalidades", value: "• Buscar usuário por Discord ID\n• Visualizar HWID vinculado\n• Resetar / Tirar castigo de HWID\n• Banir / Desbanir contas\n• Listar todos os usuários", inline: false }
        ],
        footer: { text: "Cyclone Store · Loader Admin" },
        timestamp: new Date().toISOString()
    };
    try {
        await discordFetch(`/channels/${LINK_CHANNEL_ID}/messages`, {
            method: "POST",
            body: JSON.stringify({
                embeds: [embed],
                components: [{ type: 1, components: [{ type: 2, style: 5, label: "🔑 Acessar Painel", url: loginUrl }] }]
            })
        });
    } catch (err) {
        console.error("[ADMIN-EMBED] Erro:", err);
    }
}

app.post("/send-admin-embed", (req, res) => {
    if (!checkAdmin(req, res)) return;
    sendAdminPanelEmbed()
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).json({ success: false, message: err.message }));
});

// 17) Health check
app.get("/health", (req, res) => res.json({
    status: "ok", guild_id: GUILD_ID, role_id: ROLE_ID,
    log_channel_id: LOG_CHANNEL_ID, link_channel_id: LINK_CHANNEL_ID,
    bot_token_set: !!BOT_TOKEN, api_secret_set: !!API_SECRET,
    admin_key_set: !!ADMIN_KEY, db_path: DB_PATH
}));

// ============================================================
// HTML HELPERS
// ============================================================

function pageError(msg) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro</title>
    <style>body{background:#161616;color:#ccc;font-family:'Segoe UI',sans-serif;display:flex;
    align-items:center;justify-content:center;height:100vh;margin:0;}
    .box{background:#1e1e1e;border:1px solid #2e2e2e;border-radius:12px;padding:40px;text-align:center;}
    h2{color:#f44336;margin-bottom:8px;}</style></head><body>
    <div class="box"><h2>❌ Acesso Negado</h2><p>${msg}</p></div></body></html>`;
}

function fmtDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function pageConfirmReset({ id, key, nome, cargo, hwidAtual }) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Reset HWID — Cyclone Store</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#161616;color:#ccc;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{background:#1e1e1e;border:1px solid #2e2e2e;border-radius:14px;padding:36px 40px;max-width:460px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.5);}
.brand{font-size:11px;color:#444;text-transform:uppercase;letter-spacing:2px;margin-bottom:22px;}
h2{font-size:20px;color:#e0e0e0;margin-bottom:4px;}
.sub{font-size:13px;color:#555;margin-bottom:26px;}
.info-row{display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;border-bottom:1px solid #252525;font-size:14px;gap:12px;}
.info-row:last-of-type{border-bottom:none;}
.lbl{color:#555;white-space:nowrap;}
.val{color:#ddd;word-break:break-all;text-align:right;}
.val.mono{font-family:'Courier New',monospace;font-size:12px;color:#999;}
.warn{background:#1f1818;border:1px solid #3a2020;border-radius:8px;padding:13px 15px;font-size:13px;color:#d88;margin:22px 0 20px;line-height:1.5;}
.btns{display:flex;gap:10px;}
.btn{flex:1;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s;text-align:center;}
.btn:hover{opacity:.82;}
.btn:disabled{opacity:.5;cursor:default;}
.cancel{background:#252525;color:#888;border:1px solid #303030;}
.confirm{background:#c0392b;color:#fff;}
.result{display:none;text-align:center;padding:16px 0 4px;}
.result.show{display:block;}
.r-icon{font-size:44px;margin-bottom:14px;}
.r-msg{font-size:17px;color:#e0e0e0;margin-bottom:6px;}
.r-sub{font-size:13px;color:#555;}
</style></head><body>
<div class="card">
<div class="brand">Cyclone Store &middot; Painel Admin</div>
<div id="content">
<h2>🔄 Reset de HWID</h2>
<p class="sub">Revise os dados antes de confirmar.</p>
<div class="info-row"><span class="lbl">Nome</span><span class="val">${nome||"—"}</span></div>
<div class="info-row"><span class="lbl">Cargo</span><span class="val">${cargo||"—"}</span></div>
<div class="info-row"><span class="lbl">Discord ID</span><span class="val mono">${id||"—"}</span></div>
<div class="info-row"><span class="lbl">HWID atual</span><span class="val mono">${hwidAtual}</span></div>
<div class="warn">⚠️ Ao confirmar, o HWID será removido. O usuário poderá logar de um PC diferente.</div>
<div class="btns">
<button class="btn cancel" onclick="window.close()">Cancelar</button>
<button class="btn confirm" id="btnConfirm" onclick="doReset()">Confirmar Reset</button>
</div></div>
<div class="result" id="result">
<div class="r-icon" id="rIcon"></div>
<div class="r-msg" id="rMsg"></div>
<div class="r-sub" id="rSub"></div>
</div></div>
<script>
async function doReset(){
const btn=document.getElementById('btnConfirm');
btn.disabled=true;btn.textContent='Aguarde...';
try{
const r=await fetch('/reset-hwid-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'${id}',key:'${key}'})});
const d=await r.json();
document.getElementById('content').style.display='none';
const res=document.getElementById('result');res.classList.add('show');
if(d.success){document.getElementById('rIcon').textContent='✅';document.getElementById('rMsg').textContent='HWID resetado com sucesso!';document.getElementById('rSub').textContent='O usuário poderá logar de um novo PC.';}
else{document.getElementById('rIcon').textContent='❌';document.getElementById('rMsg').textContent='Erro ao resetar.';document.getElementById('rSub').textContent=d.message||'';}
}catch(e){btn.disabled=false;btn.textContent='Confirmar Reset';alert('Erro de conexão.');}
}
</script></body></html>`;
}

function pageAdminLogin() {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Login — Cyclone Store Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#161616;color:#ccc;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{background:#1e1e1e;border:1px solid #2e2e2e;border-radius:14px;padding:40px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.5);text-align:center;}
.icon-wrap{width:52px;height:52px;border-radius:50%;background:#252525;border:1px solid #333;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;}
.brand{font-size:11px;color:#444;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;}
h2{font-size:20px;color:#e0e0e0;margin-bottom:4px;}
.sub{font-size:13px;color:#555;margin-bottom:26px;}
.field{margin-bottom:10px;text-align:left;}
.field label{display:block;font-size:11px;color:#555;margin-bottom:5px;letter-spacing:.8px;text-transform:uppercase;}
.input-wrap{position:relative;}
.input-wrap input{width:100%;background:#252525;border:1px solid #333;border-radius:8px;padding:11px 40px 11px 13px;color:#ddd;font-size:14px;outline:none;transition:border-color .2s;font-family:'Courier New',monospace;letter-spacing:1px;}
.input-wrap input:focus{border-color:#555;}
.input-wrap input::placeholder{color:#3a3a3a;font-family:'Segoe UI',sans-serif;letter-spacing:0;}
.eye-btn{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#555;padding:0;font-size:14px;line-height:1;}
.eye-btn:hover{color:#888;}
.divider{border:none;border-top:1px solid #252525;margin:14px 0;}
.err{font-size:12px;color:#e88;background:#1f1818;border:1px solid #3a2020;border-radius:6px;padding:8px 12px;margin-bottom:12px;display:none;text-align:left;}
.err.show{display:block;}
.btn-login{width:100%;background:#2a2a2a;border:1px solid #383838;border-radius:8px;padding:12px;color:#aaa;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;}
.btn-login:hover{background:#303030;color:#ccc;border-color:#444;}
.btn-login:disabled{opacity:.5;cursor:default;}
.success{display:none;text-align:center;padding:8px 0;}
.success.show{display:block;}
.s-msg{font-size:15px;color:#8bc34a;font-weight:500;margin-bottom:4px;}
.s-sub{font-size:12px;color:#555;}
.footer-txt{font-size:11px;color:#333;margin-top:22px;}
</style></head><body>
<div class="card">
<div class="icon-wrap">
<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5">
<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
</svg></div>
<div class="brand">Cyclone Store</div>
<h2>Painel admin</h2>
<p class="sub">Preencha os dois campos para acessar.</p>
<div id="formArea">
<div class="field"><label>Discord ID</label>
<div class="input-wrap"><input id="inputId" type="text" placeholder="Seu Discord ID" maxlength="20" oninput="this.value=this.value.replace(/[^0-9]/g,'')"></div></div>
<hr class="divider">
<div class="field"><label>Chave de acesso</label>
<div class="input-wrap"><input id="inputKey" type="password" placeholder="Chave secreta">
<button class="eye-btn" onclick="toggleVer()" type="button">&#128065;</button></div></div>
<div class="err" id="errMsg"></div>
<button class="btn-login" id="btnLogin" onclick="logar()">Entrar</button>
</div>
<div class="success" id="successArea">
<div class="s-msg">&#10003; Acesso concedido!</div>
<div class="s-sub">Redirecionando...</div>
</div>
<div class="footer-txt">Cyclone Store &middot; Loader Admin Panel</div>
</div>
<script>
function toggleVer(){const i=document.getElementById('inputKey');i.type=i.type==='password'?'text':'password';}
async function logar(){
const discord_id=document.getElementById('inputId').value.trim();
const key=document.getElementById('inputKey').value.trim();
const err=document.getElementById('errMsg');
const btn=document.getElementById('btnLogin');
err.classList.remove('show');
if(!discord_id||discord_id.length<17){err.textContent='Discord ID invalido.';return err.classList.add('show');}
if(!key){err.textContent='Preencha a chave de acesso.';return err.classList.add('show');}
btn.disabled=true;btn.textContent='Verificando...';
try{
const r=await fetch('/admin-login-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discord_id,key})});
const d=await r.json();
if(d.success){document.getElementById('formArea').style.display='none';document.getElementById('successArea').classList.add('show');setTimeout(()=>{window.location.href='/admin?key='+encodeURIComponent(key);},1200);}
else{err.textContent=d.message||'Acesso negado.';err.classList.add('show');btn.disabled=false;btn.textContent='Entrar';}
}catch(e){err.textContent='Erro de conexao.';err.classList.add('show');btn.disabled=false;btn.textContent='Entrar';}
}
['inputId','inputKey'].forEach(id=>{document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')logar();});});
</script></body></html>`;
}

function pageAdmin(key) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Admin — Cyclone Store</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#161616;color:#ccc;font-family:'Segoe UI',sans-serif;min-height:100vh;padding:24px;}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;}
.brand{font-size:11px;color:#444;text-transform:uppercase;letter-spacing:2px;}
h1{font-size:20px;color:#e0e0e0;font-weight:500;}
.tabs{display:flex;gap:8px;margin-bottom:20px;}
.tab{padding:8px 18px;border-radius:8px;border:1px solid #2e2e2e;background:#1e1e1e;color:#888;font-size:13px;cursor:pointer;transition:all .15s;}
.tab.active,.tab:hover{background:#252525;color:#ccc;border-color:#444;}
.tab.active{color:#e0e0e0;border-color:#555;}
.card{background:#1e1e1e;border:1px solid #2e2e2e;border-radius:12px;padding:24px;margin-bottom:16px;}
.card h2{font-size:15px;color:#e0e0e0;margin-bottom:16px;font-weight:500;}
.search-row{display:flex;gap:10px;margin-bottom:16px;}
input[type=text],input[type=password],textarea{background:#252525;border:1px solid #333;border-radius:8px;padding:10px 13px;color:#ddd;font-size:14px;outline:none;transition:border-color .2s;font-family:'Courier New',monospace;}
input[type=text]:focus,input[type=password]:focus,textarea:focus{border-color:#555;}
input::placeholder,textarea::placeholder{color:#3a3a3a;font-family:'Segoe UI',sans-serif;}
.btn{padding:10px 16px;border:1px solid #383838;border-radius:8px;background:#2a2a2a;color:#aaa;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;}
.btn:hover{background:#303030;color:#ccc;border-color:#444;}
.btn:disabled{opacity:.5;cursor:default;}
.btn-danger{background:#2a1515;border-color:#4a2020;color:#e88;}
.btn-danger:hover{background:#3a1818;border-color:#6a2a2a;}
.btn-success{background:#152a15;border-color:#204a20;color:#8e8;}
.btn-success:hover{background:#183018;border-color:#2a6a2a;}
.btn-warn{background:#2a2515;border-color:#4a4020;color:#ee8;}
.btn-warn:hover{background:#333018;}
.info-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #252525;font-size:14px;gap:12px;}
.info-row:last-child{border-bottom:none;}
.lbl{color:#555;white-space:nowrap;}
.val{color:#ddd;word-break:break-all;text-align:right;}
.val.mono{font-family:'Courier New',monospace;font-size:12px;color:#999;}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;}
.badge-ban{background:#2a1515;color:#e88;border:1px solid #4a2020;}
.badge-ok{background:#152a15;color:#8e8;border:1px solid #204a20;}
.badge-penalty{background:#2a2515;color:#ee8;border:1px solid #4a4020;}
.err{font-size:12px;color:#e88;background:#1f1818;border:1px solid #3a2020;border-radius:6px;padding:8px 12px;margin-bottom:12px;display:none;}
.err.show{display:block;}
.ok-msg{font-size:12px;color:#8e8;background:#151f15;border:1px solid #204a20;border-radius:6px;padding:8px 12px;margin-bottom:12px;display:none;}
.ok-msg.show{display:block;}
.section{display:none;}
.section.active{display:block;}
.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th{text-align:left;padding:8px 10px;color:#555;font-weight:500;border-bottom:1px solid #252525;white-space:nowrap;}
td{padding:8px 10px;border-bottom:1px solid #222;color:#bbb;vertical-align:middle;}
tr:hover td{background:#1a1a1a;}
.td-mono{font-family:'Courier New',monospace;font-size:11px;color:#888;}
.penalty-item{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#252520;border:1px solid #3a3820;border-radius:8px;margin-bottom:8px;font-size:13px;}
</style></head><body>
<div class="header">
<div><div class="brand">Cyclone Store &middot; Painel Admin</div><h1>Gerenciamento</h1></div>
</div>

<div class="tabs">
<button class="tab active" onclick="showTab('buscar',this)">Buscar ID</button>
<button class="tab" onclick="showTab('lista',this)">Todos Usuários</button>
<button class="tab" onclick="showTab('castigo',this)">Castigos Ativos</button>
</div>

<!-- TAB BUSCAR -->
<div class="section active" id="tab-buscar">
<div class="card">
<h2>🔍 Buscar por Discord ID</h2>
<div class="search-row">
<input type="text" id="inputId" placeholder="Discord ID" maxlength="20" oninput="this.value=this.value.replace(/[^0-9]/g,'')" style="flex:1">
<button class="btn" onclick="buscar()">Buscar</button>
</div>
<div class="err" id="errBuscar"></div>
<div id="resultArea" style="display:none">
<div class="info-row"><span class="lbl">Nome</span><span class="val" id="rNome">—</span></div>
<div class="info-row"><span class="lbl">Cargo</span><span class="val" id="rCargo">—</span></div>
<div class="info-row"><span class="lbl">Discord ID</span><span class="val mono" id="rId">—</span></div>
<div class="info-row"><span class="lbl">HWID</span><span class="val mono" id="rHwid">—</span></div>
<div class="info-row"><span class="lbl">Registrado em</span><span class="val" id="rCreated">—</span></div>
<div class="info-row"><span class="lbl">Último login</span><span class="val" id="rLastLogin">—</span></div>
<div class="info-row"><span class="lbl">Status</span><span class="val" id="rStatus">—</span></div>
<div id="banReasonRow" class="info-row" style="display:none"><span class="lbl">Motivo ban</span><span class="val" id="rBanReason">—</span></div>
<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
<button class="btn" id="btnReset" onclick="resetHwid()">🔄 Reset HWID</button>
<button class="btn btn-danger" id="btnBan" onclick="banUser()">🚫 Banir</button>
<button class="btn btn-success" id="btnUnban" onclick="unbanUser()" style="display:none">✅ Desbanir</button>
</div>
<div style="margin-top:10px">
<input type="text" id="inputBanReason" placeholder="Motivo do ban (opcional)" style="width:100%">
</div>
<div class="err" id="errAcao"></div>
<div class="ok-msg" id="okAcao"></div>
</div>
</div>

<div class="card">
<h2>🔓 Tirar Castigo de HWID</h2>
<div class="search-row">
<input type="text" id="inputHwidCastigo" placeholder="Cole o HWID aqui" style="flex:1">
<button class="btn btn-warn" onclick="tirarCastigo()">Remover Castigo</button>
</div>
<div class="err" id="errCastigo"></div>
<div class="ok-msg" id="okCastigo"></div>
</div>
</div>

<!-- TAB LISTA -->
<div class="section" id="tab-lista">
<div class="card">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
<h2 style="margin:0">👥 Usuários Registrados</h2>
<button class="btn" onclick="carregarLista()">↻ Atualizar</button>
</div>
<div class="err" id="errLista"></div>
<div class="table-wrap">
<table id="tabelaUsuarios">
<thead><tr>
<th>ID</th><th>HWID</th><th>Registrado</th><th>Último Login</th><th>Status</th>
</tr></thead>
<tbody id="tbodyUsuarios"><tr><td colspan="5" style="text-align:center;color:#444;padding:24px">Clique em Atualizar para carregar</td></tr></tbody>
</table>
</div>
</div>
</div>

<!-- TAB CASTIGOS -->
<div class="section" id="tab-castigo">
<div class="card">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
<h2 style="margin:0">⏱️ Castigos Ativos</h2>
<button class="btn" onclick="carregarCastigos()">↻ Atualizar</button>
</div>
<div id="listaCastigos"><p style="color:#444;font-size:13px">Clique em Atualizar para carregar</p></div>
</div>
</div>

<script>
const ADMIN_KEY = '${key}';
let currentId = '';
let currentHwid = '';
let currentBanned = false;

function showTab(name, el) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-'+name).classList.add('active');
    el.classList.add('active');
    if(name==='lista') carregarLista();
    if(name==='castigo') carregarCastigos();
}

function fmtDate(ts) {
    if(!ts) return '—';
    return new Date(ts).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
}

function showErr(id,msg){const e=document.getElementById(id);e.textContent=msg;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),4000);}
function showOk(id,msg){const e=document.getElementById(id);e.textContent=msg;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),3000);}

async function buscar() {
    const id = document.getElementById('inputId').value.trim();
    if(!id||id.length<17) return showErr('errBuscar','ID inválido.');
    document.getElementById('resultArea').style.display='none';
    document.getElementById('errBuscar').classList.remove('show');
    try {
        const r = await fetch('/admin-buscar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,key:ADMIN_KEY})});
        const d = await r.json();
        if(!d.success) return showErr('errBuscar', d.message||'Não encontrado.');
        currentId = id;
        currentHwid = d.hwid||'';
        currentBanned = d.banned;
        document.getElementById('rNome').textContent = d.username||'—';
        document.getElementById('rCargo').textContent = d.cargo||'—';
        document.getElementById('rId').textContent = id;
        document.getElementById('rHwid').textContent = d.hwid||'Sem HWID';
        document.getElementById('rCreated').textContent = fmtDate(d.created_at);
        document.getElementById('rLastLogin').textContent = fmtDate(d.last_login);
        const statusEl = document.getElementById('rStatus');
        if(d.banned){
            statusEl.innerHTML = '<span class="badge badge-ban">Banido</span>';
            document.getElementById('banReasonRow').style.display='flex';
            document.getElementById('rBanReason').textContent = d.ban_reason||'—';
            document.getElementById('btnBan').style.display='none';
            document.getElementById('btnUnban').style.display='inline-block';
        } else {
            statusEl.innerHTML = '<span class="badge badge-ok">Ativo</span>';
            document.getElementById('banReasonRow').style.display='none';
            document.getElementById('btnBan').style.display='inline-block';
            document.getElementById('btnUnban').style.display='none';
        }
        document.getElementById('resultArea').style.display='block';
    } catch(e) { showErr('errBuscar','Erro de conexão.'); }
}

async function resetHwid() {
    if(!currentId) return;
    if(!confirm('Resetar o HWID de '+currentId+'?')) return;
    try {
        const r = await fetch('/reset-hwid-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:currentId,key:ADMIN_KEY})});
        const d = await r.json();
        if(d.success) { showOk('okAcao','HWID resetado com sucesso!'); document.getElementById('rHwid').textContent='Sem HWID'; currentHwid=''; }
        else showErr('errAcao', d.message||'Erro ao resetar.');
    } catch(e) { showErr('errAcao','Erro de conexão.'); }
}

async function banUser() {
    if(!currentId) return;
    const reason = document.getElementById('inputBanReason').value.trim();
    try {
        const r = await fetch('/ban-id',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMIN_KEY},body:JSON.stringify({discord_id:currentId,reason})});
        const d = await r.json();
        if(d.success){ showOk('okAcao','Conta banida!'); currentBanned=true; buscar(); }
        else showErr('errAcao',d.message||'Erro ao banir.');
    } catch(e){ showErr('errAcao','Erro de conexão.'); }
}

async function unbanUser() {
    if(!currentId) return;
    try {
        const r = await fetch('/unban-id',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMIN_KEY},body:JSON.stringify({discord_id:currentId})});
        const d = await r.json();
        if(d.success){ showOk('okAcao','Conta desbanida!'); currentBanned=false; buscar(); }
        else showErr('errAcao',d.message||'Erro ao desbanir.');
    } catch(e){ showErr('errAcao','Erro de conexão.'); }
}

async function tirarCastigo() {
    const hwid = document.getElementById('inputHwidCastigo').value.trim();
    if(!hwid) return showErr('errCastigo','Cole o HWID.');
    try {
        const r = await fetch('/clear-penalty',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMIN_KEY},body:JSON.stringify({hwid})});
        const d = await r.json();
        if(d.success){ showOk('okCastigo','Castigo removido!'); document.getElementById('inputHwidCastigo').value=''; }
        else showErr('errCastigo',d.message||'Erro.');
    } catch(e){ showErr('errCastigo','Erro de conexão.'); }
}

async function carregarLista() {
    const tbody = document.getElementById('tbodyUsuarios');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#444;padding:24px">Carregando...</td></tr>';
    try {
        const r = await fetch('/admin-list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:ADMIN_KEY})});
        const d = await r.json();
        if(!d.success) return showErr('errLista','Erro ao carregar.');
        if(!d.data.length){ tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:#444;padding:24px">Nenhum usuário registrado</td></tr>'; return; }
        tbody.innerHTML = d.data.map(u => {
            const banned = u.ban_reason !== null && u.ban_reason !== undefined;
            const status = banned ? '<span class="badge badge-ban">Banido</span>' : '<span class="badge badge-ok">Ativo</span>';
            return \`<tr>
<td class="td-mono">\${u.discord_id}</td>
<td class="td-mono">\${u.hwid ? u.hwid.substring(0,20)+'...' : '—'}</td>
<td>\${fmtDate(u.created_at)}</td>
<td>\${fmtDate(u.last_login)}</td>
<td>\${status}</td>
</tr>\`;
        }).join('');
    } catch(e){ showErr('errLista','Erro de conexão.'); }
}

async function carregarCastigos() {
    const lista = document.getElementById('listaCastigos');
    lista.innerHTML = '<p style="color:#444;font-size:13px">Carregando...</p>';
    try {
        const r = await fetch('/admin-list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:ADMIN_KEY})});
        const d = await r.json();
        if(!d.penalties||!d.penalties.length){ lista.innerHTML='<p style="color:#444;font-size:13px">Nenhum castigo ativo no momento.</p>'; return; }
        lista.innerHTML = d.penalties.map(p => {
            const minRestantes = Math.max(0, Math.ceil((p.until - Date.now()) / 60000));
            return \`<div class="penalty-item">
<div><div class="td-mono" style="margin-bottom:4px">\${p.hwid}</div>
<div style="font-size:12px;color:#888">\${p.attempts} tentativas &middot; Libera em \${minRestantes} min</div></div>
<button class="btn btn-warn" style="font-size:12px;padding:6px 12px" onclick="tirarCastigoDirecto('\${p.hwid}',this)">Remover</button>
</div>\`;
        }).join('');
    } catch(e){ lista.innerHTML='<p style="color:#e88;font-size:13px">Erro de conexão.</p>'; }
}

async function tirarCastigoDirecto(hwid, btn) {
    btn.disabled=true;
    try {
        const r = await fetch('/clear-penalty',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':ADMIN_KEY},body:JSON.stringify({hwid})});
        const d = await r.json();
        if(d.success) carregarCastigos();
        else { btn.disabled=false; alert(d.message||'Erro.'); }
    } catch(e){ btn.disabled=false; alert('Erro de conexão.'); }
}

document.getElementById('inputId').addEventListener('keydown', e => { if(e.key==='Enter') buscar(); });
</script></body></html>`;
}

// ============================================================
// ROTA: REPORT DE DETECCAO DE CHEAT (loader chama isso automaticamente)
// ============================================================
app.post("/report-cheat", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, hwid, reason } = req.body;
    if (!discord_id || !hwid)
        return res.status(400).json({ success: false });

    console.log(`[CHEAT] Deteccao: ${discord_id} | ${reason}`);

    // Bane o ID automaticamente
    banId(discord_id, `Auto-ban: ${reason}`);

    // Coloca HWID em castigo permanente (until = ano 2099)
    const until = 4102444800000;
    db.prepare("INSERT OR REPLACE INTO hwid_penalty (hwid, until, attempts) VALUES (?, ?, ?)")
      .run(hwid, until, 999);

    // Busca infos e manda log no canal
    const { username, cargo } = await getMemberInfo(discord_id).catch(() => ({ username: "Desconhecido", cargo: "Membro" }));

    if (BOT_TOKEN && LOG_CHANNEL_ID) {
        const embed = {
            title: "🔴 Detecção de Cheat — Auto-Ban",
            color: 0xFF0000,
            fields: [
                { name: "👤 Nome",    value: `\`${username}\``,    inline: true  },
                { name: "🏷️ Cargo",  value: `\`${cargo}\``,       inline: true  },
                { name: "\u200b",     value: "\u200b",             inline: true  },
                { name: "🆔 ID",      value: `\`${discord_id}\``,  inline: false },
                { name: "💻 HWID",    value: `\`${hwid}\``,        inline: false },
                { name: "⚠️ Motivo", value: `\`${reason}\``,      inline: false },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Cyclone Store | Anti-Cheat" }
        };
        discordFetch(`/channels/${LOG_CHANNEL_ID}/messages`, {
            method: "POST",
            body: JSON.stringify({ embeds: [embed] })
        }).catch(() => {});
    }

    return res.json({ success: true });
});

// ============================================================
// BOT ONLINE VIA DISCORD GATEWAY (WebSocket)
// ============================================================
const https = require("https");
const WebSocket = require("ws");

let gatewayWs = null;
let heartbeatInterval = null;
let gatewaySequence = null;
let reconnectTimer = null;

function connectGateway() {
    if (gatewayWs) {
        try { gatewayWs.terminate(); } catch (_) {}
    }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

    console.log("[GATEWAY] Conectando ao Discord...");
    gatewayWs = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");

    gatewayWs.on("open", () => {
        console.log("[GATEWAY] Conectado ao WebSocket do Discord");
    });

    gatewayWs.on("message", (data) => {
        const payload = JSON.parse(data);
        const { op, d, s } = payload;

        if (s) gatewaySequence = s;

        if (op === 10) {
            // Hello — inicia heartbeat
            const interval = d.heartbeat_interval;
            heartbeatInterval = setInterval(() => {
                if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                    gatewayWs.send(JSON.stringify({ op: 1, d: gatewaySequence }));
                }
            }, interval);

            // Identify
            gatewayWs.send(JSON.stringify({
                op: 2,
                d: {
                    token: BOT_TOKEN,
                    intents: 0,
                    properties: { os: "linux", browser: "disco", device: "disco" },
                    presence: {
                        status: "online",
                        activities: [{
                            name: "Cyclone Store",
                            type: 3  // type 3 = Watching
                        }],
                        afk: false
                    }
                }
            }));
        }

        if (op === 0 && payload.t === "READY") {
            console.log("[GATEWAY] Bot online! Tag:", d.user?.username);
        }

        if (op === 7 || op === 9) {
            // Reconnect ou Invalid Session
            console.log("[GATEWAY] Reconectando (op:", op, ")");
            setTimeout(connectGateway, 3000);
        }
    });

    gatewayWs.on("close", (code) => {
        console.log(`[GATEWAY] Conexao fechada (${code}), reconectando em 5s...`);
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectGateway, 5000);
    });

    gatewayWs.on("error", (err) => {
        console.error("[GATEWAY] Erro WebSocket:", err.message);
    });
}

// ============================================================
// STARTUP
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[STARTUP] API rodando na porta ${PORT}`);
    if (LINK_CHANNEL_ID)
        sendAdminPanelEmbed().catch(() => {});
    // Conecta ao Gateway para ficar online
    if (BOT_TOKEN)
        connectGateway();
});
