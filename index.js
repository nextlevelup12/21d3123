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
const ID_ALLOWED      = process.env.ID_ALLOWED; // Discord ID autorizado a acessar o painel
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
async function discordFetch(endpoint, options = {}) {
    const url = `https://discord.com/api/v10${endpoint}`;
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

function getMemberName(member) {
    if (member.nick) return member.nick;
    if (member.user && member.user.global_name) return member.user.global_name;
    if (member.user && member.user.username) return member.user.username;
    return "Desconhecido";
}

// ============================================================
// ENVIAR LOG NO CANAL DO DISCORD
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
        console.log(`[LOG] Mensagem enviada para canal ${LOG_CHANNEL_ID}`);
    } catch (err) {
        console.error("[LOG] Erro ao enviar log:", err);
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
    return res.json({ authorized: true, message: "Acesso liberado!" });
});

// 3) Vincular / verificar HWID + envia log no canal
app.post("/bind-hwid", async (req, res) => {
    if (!checkSecret(req, res)) return;
    const { discord_id, hwid } = req.body;
    console.log(`[BIND-HWID] id: "${discord_id}" | hwid: "${hwid}"`);

    if (!discord_id || !hwid || hwid.length < 8)
        return res.status(400).json({ allowed: false, message: "Dados invalidos." });

    let username = "Desconhecido";
    let cargo    = "Membro";
    try {
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${discord_id}`);
        if (memberRes.ok) {
            const member = await memberRes.json();
            username = getMemberName(member);

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
        console.error("[BIND-HWID] Erro ao buscar membro:", err);
    }

    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(discord_id);

    if (!row) {
        db.prepare("INSERT INTO hwid_lock (discord_id, hwid, created_at) VALUES (?, ?, ?)")
          .run(discord_id, hwid, Date.now());
        console.log(`[BIND-HWID] Novo vinculo: ${discord_id} -> ${hwid}`);
        sendLoginLog(discord_id, username, cargo, hwid, true).catch(() => {});
        return res.json({ allowed: true, message: "HWID registrado.", username, cargo });
    }

    if (row.hwid !== hwid) {
        console.log(`[BIND-HWID] BLOQUEADO: ${discord_id}`);
        return res.json({ allowed: false, message: "Acesso negado: ID vinculado a outro PC. Contate o suporte." });
    }

    sendLoginLog(discord_id, username, cargo, hwid, false).catch(() => {});
    return res.json({ allowed: true, message: "HWID verificado.", username, cargo });
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

    console.log(`[RESET-HWID] HWID removido para ${discord_id}`);
    return res.json({ success: true, message: `HWID de ${discord_id} resetado.` });
});

// 4.5) Painel admin — busca por ID e reseta HWID
app.get("/admin", (req, res) => {
    const { key } = req.query;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Negado</title>
        <style>body{background:#161616;color:#ccc;font-family:'Segoe UI',sans-serif;display:flex;
        align-items:center;justify-content:center;height:100vh;margin:0;}
        .box{background:#1e1e1e;border:1px solid #2e2e2e;border-radius:12px;padding:40px;text-align:center;}
        h2{color:#f44336;}</style></head><body>
        <div class="box"><h2>❌ Acesso Negado</h2><p>Chave de admin inválida.</p></div></body></html>`);

    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Admin — Cyclone Store</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #161616;
            color: #ccc;
            font-family: 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .card {
            background: #1e1e1e;
            border: 1px solid #2e2e2e;
            border-radius: 14px;
            padding: 36px 40px;
            width: 100%;
            max-width: 480px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .brand { font-size: 11px; color: #444; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 22px; }
        h2 { font-size: 20px; color: #e0e0e0; margin-bottom: 4px; }
        .sub { font-size: 13px; color: #555; margin-bottom: 26px; }

        /* Input busca */
        .search-row { display: flex; gap: 10px; margin-bottom: 24px; }
        .input-id {
            flex: 1;
            background: #252525;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 11px 14px;
            color: #ddd;
            font-size: 14px;
            font-family: 'Courier New', monospace;
            outline: none;
            transition: border-color .2s;
        }
        .input-id:focus { border-color: #555; }
        .input-id::placeholder { color: #444; font-family: 'Segoe UI', sans-serif; }
        .btn-buscar {
            background: #2a2a2a;
            border: 1px solid #383838;
            border-radius: 8px;
            padding: 11px 18px;
            color: #aaa;
            font-size: 14px;
            cursor: pointer;
            transition: opacity .15s;
            white-space: nowrap;
        }
        .btn-buscar:hover { opacity: 0.8; }

        /* Card resultado */
        .result-card {
            display: none;
            background: #242424;
            border: 1px solid #2e2e2e;
            border-radius: 10px;
            overflow: hidden;
            margin-bottom: 20px;
        }
        .result-card.show { display: block; }
        .rc-header {
            background: #1a1a1a;
            padding: 12px 16px;
            font-size: 12px;
            color: #555;
            text-transform: uppercase;
            letter-spacing: 1px;
            border-bottom: 1px solid #2a2a2a;
        }
        .rc-body { padding: 4px 0; }
        .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 9px 16px;
            border-bottom: 1px solid #292929;
            font-size: 14px;
            gap: 12px;
        }
        .info-row:last-child { border-bottom: none; }
        .lbl { color: #555; white-space: nowrap; }
        .val { color: #ddd; word-break: break-all; text-align: right; }
        .val.mono { font-family: 'Courier New', monospace; font-size: 12px; color: #999; }
        .no-hwid { color: #c0392b; }

        /* Confirmação */
        .confirm-area {
            display: none;
            background: #1f1818;
            border: 1px solid #3a2020;
            border-radius: 8px;
            padding: 14px 16px;
            font-size: 13px;
            color: #d88;
            margin-bottom: 16px;
            line-height: 1.5;
        }
        .confirm-area.show { display: block; }

        /* Botões */
        .btns { display: none; gap: 10px; }
        .btns.show { display: flex; }
        .btn {
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            font-size: 14px; font-weight: 600; cursor: pointer;
            transition: opacity .15s;
        }
        .btn:hover { opacity: 0.82; }
        .btn:disabled { opacity: 0.5; cursor: default; }
        .cancel { background: #252525; color: #888; border: 1px solid #303030; }
        .confirm { background: #c0392b; color: #fff; }

        /* Resultado final */
        .final { display: none; text-align: center; padding: 10px 0 4px; }
        .final.show { display: block; }
        .f-icon { font-size: 42px; margin-bottom: 12px; }
        .f-msg { font-size: 16px; color: #e0e0e0; margin-bottom: 6px; }
        .f-sub { font-size: 13px; color: #555; margin-bottom: 20px; }
        .btn-novo {
            background: #252525; border: 1px solid #333; border-radius: 8px;
            padding: 10px 20px; color: #aaa; font-size: 13px; cursor: pointer;
        }
        .btn-novo:hover { opacity: 0.8; }

        .error-msg { color: #c0392b; font-size: 13px; margin-bottom: 16px; display: none; }
        .error-msg.show { display: block; }
    </style>
</head>
<body>
<div class="card">
    <div class="brand">Cyclone Store &middot; Painel Admin</div>

    <div id="main">
        <h2>🔄 Reset de HWID</h2>
        <p class="sub">Digite o Discord ID do usuário para buscar e resetar.</p>

        <div class="search-row">
            <input class="input-id" id="inputId" type="text"
                placeholder="Discord ID (ex: 770009785583665172)"
                maxlength="20" oninput="this.value=this.value.replace(/[^0-9]/g,'')">
            <button class="btn-buscar" onclick="buscar()">Buscar</button>
        </div>

        <div class="error-msg" id="errMsg"></div>

        <div class="result-card" id="resultCard">
            <div class="rc-header">Dados encontrados</div>
            <div class="rc-body">
                <div class="info-row"><span class="lbl">Nome</span>  <span class="val" id="rNome">—</span></div>
                <div class="info-row"><span class="lbl">Cargo</span> <span class="val" id="rCargo">—</span></div>
                <div class="info-row"><span class="lbl">ID</span>    <span class="val mono" id="rId">—</span></div>
                <div class="info-row"><span class="lbl">HWID</span>  <span class="val mono" id="rHwid">—</span></div>
            </div>
        </div>

        <div class="confirm-area" id="confirmArea">
            ⚠️ Tem certeza que deseja resetar o HWID desta pessoa?<br>
            O usuário poderá logar de um PC diferente na próxima vez.
        </div>

        <div class="btns" id="btns">
            <button class="btn cancel" onclick="cancelar()">Cancelar</button>
            <button class="btn confirm" id="btnConfirm" onclick="confirmar()">Confirmar Reset</button>
        </div>
    </div>

    <div class="final" id="final">
        <div class="f-icon" id="fIcon"></div>
        <div class="f-msg"  id="fMsg"></div>
        <div class="f-sub"  id="fSub"></div>
        <button class="btn-novo" onclick="resetarTela()">Fazer outro reset</button>
    </div>
</div>

<script>
const ADMIN_KEY = '${key}';
let idAtual = '';

async function buscar() {
    const id = document.getElementById('inputId').value.trim();
    if (!id || id.length < 17) return mostrarErro('ID inválido. Deve ter entre 17 e 20 dígitos.');

    esconderErro();
    document.getElementById('resultCard').classList.remove('show');
    document.getElementById('confirmArea').classList.remove('show');
    document.getElementById('btns').classList.remove('show');

    try {
        const r = await fetch('/admin-buscar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, key: ADMIN_KEY })
        });
        const d = await r.json();

        if (!d.success) return mostrarErro(d.message || 'Usuário não encontrado.');

        idAtual = id;
        document.getElementById('rNome').textContent  = d.username || '—';
        document.getElementById('rCargo').textContent = d.cargo    || '—';
        document.getElementById('rId').textContent    = id;

        const hwidEl = document.getElementById('rHwid');
        if (d.hwid) {
            hwidEl.textContent = d.hwid;
            hwidEl.classList.remove('no-hwid');
            document.getElementById('confirmArea').classList.add('show');
            document.getElementById('btns').classList.add('show');
        } else {
            hwidEl.textContent = 'Sem HWID vinculado';
            hwidEl.classList.add('no-hwid');
        }

        document.getElementById('resultCard').classList.add('show');
    } catch(e) {
        mostrarErro('Erro de conexão. Tente novamente.');
    }
}

function cancelar() {
    document.getElementById('resultCard').classList.remove('show');
    document.getElementById('confirmArea').classList.remove('show');
    document.getElementById('btns').classList.remove('show');
    document.getElementById('inputId').value = '';
    idAtual = '';
}

async function confirmar() {
    const btn = document.getElementById('btnConfirm');
    btn.disabled = true;
    btn.textContent = 'Aguarde...';

    try {
        const r = await fetch('/reset-hwid-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: idAtual, key: ADMIN_KEY })
        });
        const d = await r.json();

        document.getElementById('main').style.display = 'none';
        const final = document.getElementById('final');
        final.classList.add('show');

        if (d.success) {
            document.getElementById('fIcon').textContent = '✅';
            document.getElementById('fMsg').textContent  = 'HWID resetado com sucesso!';
            document.getElementById('fSub').textContent  = 'O usuário poderá logar de um PC diferente agora.';
        } else {
            document.getElementById('fIcon').textContent = '❌';
            document.getElementById('fMsg').textContent  = 'Erro ao resetar.';
            document.getElementById('fSub').textContent  = d.message || '';
        }
    } catch(e) {
        btn.disabled = false;
        btn.textContent = 'Confirmar Reset';
        mostrarErro('Erro de conexão. Tente novamente.');
    }
}

function resetarTela() {
    document.getElementById('main').style.display = 'block';
    document.getElementById('final').classList.remove('show');
    cancelar();
    esconderErro();
    document.getElementById('btnConfirm').disabled = false;
    document.getElementById('btnConfirm').textContent = 'Confirmar Reset';
}

function mostrarErro(msg) {
    const el = document.getElementById('errMsg');
    el.textContent = msg;
    el.classList.add('show');
}
function esconderErro() {
    document.getElementById('errMsg').classList.remove('show');
}

document.getElementById('inputId').addEventListener('keydown', e => {
    if (e.key === 'Enter') buscar();
});
</script>
</body>
</html>`);
});

// 4.6) Busca dados do usuário pelo ID para o painel admin
app.post("/admin-buscar", async (req, res) => {
    const { id, key } = req.body;
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.status(403).json({ success: false, message: "Chave inválida." });
    if (!id)
        return res.status(400).json({ success: false, message: "ID obrigatorio." });

    // Busca HWID no banco
    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(id);

    // Busca nome e cargo no Discord
    let username = "Desconhecido";
    let cargo    = "Membro";
    try {
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${id}`);
        if (memberRes.ok) {
            const member = await memberRes.json();
            username = getMemberName(member);

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
        } else if (memberRes.status === 404) {
            return res.json({ success: false, message: "Usuário não encontrado no servidor Discord." });
        }
    } catch (err) {
        console.error("[ADMIN-BUSCAR] Erro:", err);
    }

    return res.json({
        success: true,
        username,
        cargo,
        hwid: row ? row.hwid : null
    });
});

// 5) Página web de confirmação de reset (link do botão do Discord)
app.get("/reset-hwid-web", (req, res) => {
    const { id, key, nome, cargo, hwid } = req.query;

    if (!ADMIN_KEY || key !== ADMIN_KEY) {
        return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Negado</title>
        <style>body{background:#161616;color:#ccc;font-family:'Segoe UI',sans-serif;display:flex;
        align-items:center;justify-content:center;height:100vh;margin:0;}
        .box{background:#1e1e1e;border:1px solid #2e2e2e;border-radius:12px;padding:40px;text-align:center;}
        h2{color:#f44336;}</style></head><body>
        <div class="box"><h2>❌ Acesso Negado</h2><p>Chave de admin inválida.</p></div></body></html>`);
    }

    const row = db.prepare("SELECT hwid FROM hwid_lock WHERE discord_id = ?").get(id);
    const hwidAtual = row ? row.hwid : "Não registrado";

    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Reset HWID — Cyclone Store</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #161616;
            color: #ccc;
            font-family: 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .card {
            background: #1e1e1e;
            border: 1px solid #2e2e2e;
            border-radius: 14px;
            padding: 36px 40px;
            max-width: 460px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .brand {
            font-size: 11px;
            color: #444;
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-bottom: 22px;
        }
        h2 { font-size: 20px; color: #e0e0e0; margin-bottom: 4px; }
        .sub { font-size: 13px; color: #555; margin-bottom: 26px; }
        .info-row {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding: 10px 0;
            border-bottom: 1px solid #252525;
            font-size: 14px;
            gap: 12px;
        }
        .info-row:last-of-type { border-bottom: none; margin-bottom: 0; }
        .lbl { color: #555; white-space: nowrap; }
        .val { color: #ddd; word-break: break-all; text-align: right; }
        .val.mono { font-family: 'Courier New', monospace; font-size: 12px; color: #999; }
        .warn {
            background: #1f1818;
            border: 1px solid #3a2020;
            border-radius: 8px;
            padding: 13px 15px;
            font-size: 13px;
            color: #d88;
            margin: 22px 0 20px;
            line-height: 1.5;
        }
        .btns { display: flex; gap: 10px; }
        .btn {
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            font-size: 14px; font-weight: 600; cursor: pointer;
            transition: opacity .15s; text-align: center;
        }
        .btn:hover { opacity: 0.82; }
        .btn:disabled { opacity: 0.5; cursor: default; }
        .cancel { background: #252525; color: #888; border: 1px solid #303030; }
        .confirm { background: #c0392b; color: #fff; }
        .result { display: none; text-align: center; padding: 16px 0 4px; }
        .result.show { display: block; }
        .r-icon { font-size: 44px; margin-bottom: 14px; }
        .r-msg { font-size: 17px; color: #e0e0e0; margin-bottom: 6px; }
        .r-sub { font-size: 13px; color: #555; }
    </style>
</head>
<body>
<div class="card">
    <div class="brand">Cyclone Store &middot; Painel Admin</div>

    <div id="content">
        <h2>🔄 Reset de HWID</h2>
        <p class="sub">Revise os dados antes de confirmar.</p>

        <div class="info-row">
            <span class="lbl">Nome</span>
            <span class="val">${nome || "—"}</span>
        </div>
        <div class="info-row">
            <span class="lbl">Cargo</span>
            <span class="val">${cargo || "—"}</span>
        </div>
        <div class="info-row">
            <span class="lbl">Discord ID</span>
            <span class="val mono">${id || "—"}</span>
        </div>
        <div class="info-row">
            <span class="lbl">HWID atual</span>
            <span class="val mono">${hwidAtual}</span>
        </div>

        <div class="warn">
            ⚠️ Ao confirmar, o HWID será removido do banco. O usuário poderá fazer login de um PC diferente na próxima vez.
        </div>

        <div class="btns">
            <button class="btn cancel" onclick="window.close()">Cancelar</button>
            <button class="btn confirm" id="btnConfirm" onclick="doReset()">Confirmar Reset</button>
        </div>
    </div>

    <div class="result" id="result">
        <div class="r-icon" id="rIcon"></div>
        <div class="r-msg"  id="rMsg"></div>
        <div class="r-sub"  id="rSub"></div>
    </div>
</div>

<script>
async function doReset() {
    const btn = document.getElementById('btnConfirm');
    btn.disabled = true;
    btn.textContent = 'Aguarde...';
    try {
        const r = await fetch('/reset-hwid-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: '${id}', key: '${key}' })
        });
        const d = await r.json();
        document.getElementById('content').style.display = 'none';
        const res = document.getElementById('result');
        res.classList.add('show');
        if (d.success) {
            document.getElementById('rIcon').textContent = '✅';
            document.getElementById('rMsg').textContent  = 'HWID resetado com sucesso!';
            document.getElementById('rSub').textContent  = 'O usuário poderá logar de um novo PC agora.';
        } else {
            document.getElementById('rIcon').textContent = '❌';
            document.getElementById('rMsg').textContent  = 'Erro ao resetar.';
            document.getElementById('rSub').textContent  = d.message || '';
        }
    } catch(e) {
        btn.disabled = false;
        btn.textContent = 'Confirmar Reset';
        alert('Erro de conexão. Tente novamente.');
    }
}
</script>
</body>
</html>`);
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

    console.log(`[RESET-HWID-WEB] HWID removido para ${id}`);
    return res.json({ success: true });
});

// 7) Listar todos os HWIDs
app.get("/list-hwids", (req, res) => {
    if (!checkAdmin(req, res)) return;
    const rows = db.prepare("SELECT discord_id, hwid, created_at FROM hwid_lock ORDER BY created_at DESC").all();
    return res.json({ success: true, count: rows.length, data: rows });
});

// 8) Health check
app.get("/health", (req, res) => res.json({
    status: "ok",
    guild_id: GUILD_ID,
    role_id: ROLE_ID,
    log_channel_id: LOG_CHANNEL_ID,
    link_channel_id: LINK_CHANNEL_ID,
    bot_token_set: !!BOT_TOKEN,
    api_secret_set: !!API_SECRET,
    admin_key_set: !!ADMIN_KEY,
    db_path: DB_PATH
}));

// 9) Envia embed do painel admin no canal LINK_CHANNEL_ID (chamada manual ou no startup)
async function sendAdminPanelEmbed() {
    if (!BOT_TOKEN || !LINK_CHANNEL_ID) {
        console.log("[ADMIN-EMBED] LINK_CHANNEL_ID nao definido, pulando.");
        return;
    }

    const loginUrl = `${BASE_URL}/admin-login`;

    const embed = {
        title: "🛡️ Painel Administrativo",
        description: "Acesse o painel para gerenciar HWIDs dos usuários do Loader.",
        color: 0x2B2D31,
        fields: [
            {
                name: "🔐 Acesso restrito",
                value: "Apenas administradores com a chave correta podem acessar.",
                inline: false
            },
            {
                name: "⚙️ Funcionalidades",
                value: "• Buscar usuário por Discord ID\n• Visualizar HWID vinculado\n• Resetar HWID",
                inline: false
            }
        ],
        footer: { text: "Cyclone Store · Loader Admin" },
        timestamp: new Date().toISOString()
    };

    try {
        await discordFetch(`/channels/${LINK_CHANNEL_ID}/messages`, {
            method: "POST",
            body: JSON.stringify({
                embeds: [embed],
                components: [{
                    type: 1,
                    components: [{
                        type: 2,
                        style: 5,
                        label: "🔑 Acessar Painel",
                        url: loginUrl
                    }]
                }]
            })
        });
        console.log(`[ADMIN-EMBED] Embed enviada para canal ${LINK_CHANNEL_ID}`);
    } catch (err) {
        console.error("[ADMIN-EMBED] Erro ao enviar embed:", err);
    }
}

// 10) Rota que envia a embed manualmente (chamada uma vez pra configurar)
app.post("/send-admin-embed", (req, res) => {
    if (!checkAdmin(req, res)) return;
    sendAdminPanelEmbed()
        .then(() => res.json({ success: true, message: "Embed enviada!" }))
        .catch(err => res.status(500).json({ success: false, message: err.message }));
});

// 11) Página de login do painel admin — ID + chave
app.get("/admin-login", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Login — Cyclone Store Admin</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #161616; color: #ccc; font-family: 'Segoe UI', sans-serif;
               display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 14px;
                padding: 40px; width: 100%; max-width: 380px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5); text-align: center; }
        .icon-wrap { width: 52px; height: 52px; border-radius: 50%; background: #252525;
                     border: 1px solid #333; display: flex; align-items: center;
                     justify-content: center; margin: 0 auto 18px; }
        .brand { font-size: 11px; color: #444; text-transform: uppercase;
                 letter-spacing: 2px; margin-bottom: 6px; }
        h2 { font-size: 20px; color: #e0e0e0; margin-bottom: 4px; }
        .sub { font-size: 13px; color: #555; margin-bottom: 26px; }
        .field { margin-bottom: 10px; text-align: left; }
        .field label { display: block; font-size: 11px; color: #555; margin-bottom: 5px;
                       letter-spacing: 0.8px; text-transform: uppercase; }
        .input-wrap { position: relative; }
        .input-wrap input {
            width: 100%; background: #252525; border: 1px solid #333; border-radius: 8px;
            padding: 11px 40px 11px 13px; color: #ddd; font-size: 14px; outline: none;
            transition: border-color .2s; font-family: 'Courier New', monospace; letter-spacing: 1px;
        }
        .input-wrap input:focus { border-color: #555; }
        .input-wrap input::placeholder { color: #3a3a3a; font-family: 'Segoe UI', sans-serif; letter-spacing: 0; }
        .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
                   background: none; border: none; cursor: pointer; color: #555;
                   padding: 0; font-size: 14px; line-height: 1; }
        .eye-btn:hover { color: #888; }
        .divider { border: none; border-top: 1px solid #252525; margin: 14px 0; }
        .err { font-size: 12px; color: #e88; background: #1f1818; border: 1px solid #3a2020;
               border-radius: 6px; padding: 8px 12px; margin-bottom: 12px;
               display: none; text-align: left; }
        .err.show { display: block; }
        .btn-login { width: 100%; background: #2a2a2a; border: 1px solid #383838;
                     border-radius: 8px; padding: 12px; color: #aaa; font-size: 14px;
                     font-weight: 600; cursor: pointer; transition: all .15s; }
        .btn-login:hover { background: #303030; color: #ccc; border-color: #444; }
        .btn-login:disabled { opacity: 0.5; cursor: default; }
        .success { display: none; text-align: center; padding: 8px 0; }
        .success.show { display: block; }
        .s-msg { font-size: 15px; color: #8bc34a; font-weight: 500; margin-bottom: 4px; }
        .s-sub { font-size: 12px; color: #555; }
        .footer-txt { font-size: 11px; color: #333; margin-top: 22px; }
    </style>
</head>
<body>
<div class="card">
    <div class="icon-wrap">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
    </div>
    <div class="brand">Cyclone Store</div>
    <h2>Painel admin</h2>
    <p class="sub">Preencha os dois campos para acessar.</p>

    <div id="formArea">
        <div class="field">
            <label>Discord ID</label>
            <div class="input-wrap">
                <input id="inputId" type="text" placeholder="Seu Discord ID"
                    maxlength="20" oninput="this.value=this.value.replace(/[^0-9]/g,'')">
            </div>
        </div>

        <hr class="divider">

        <div class="field">
            <label>Chave de acesso</label>
            <div class="input-wrap">
                <input id="inputKey" type="password" placeholder="Chave secreta">
                <button class="eye-btn" onclick="toggleVer()" type="button">&#128065;</button>
            </div>
        </div>

        <div class="err" id="errMsg"></div>

        <button class="btn-login" id="btnLogin" onclick="logar()">Entrar</button>
    </div>

    <div class="success" id="successArea">
        <div class="s-msg">&#10003; Acesso concedido!</div>
        <div class="s-sub">Redirecionando para o painel...</div>
    </div>

    <div class="footer-txt">Cyclone Store &middot; Loader Admin Panel</div>
</div>
<script>
function toggleVer() {
    const i = document.getElementById('inputKey');
    i.type = i.type === 'password' ? 'text' : 'password';
}
async function logar() {
    const discord_id = document.getElementById('inputId').value.trim();
    const key        = document.getElementById('inputKey').value.trim();
    const err        = document.getElementById('errMsg');
    const btn        = document.getElementById('btnLogin');
    err.classList.remove('show');
    if (!discord_id || discord_id.length < 17) {
        err.textContent = 'Discord ID invalido.';
        return err.classList.add('show');
    }
    if (!key) {
        err.textContent = 'Preencha a chave de acesso.';
        return err.classList.add('show');
    }
    btn.disabled = true;
    btn.textContent = 'Verificando...';
    try {
        const r = await fetch('/admin-login-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ discord_id, key })
        });
        const d = await r.json();
        if (d.success) {
            document.getElementById('formArea').style.display = 'none';
            document.getElementById('successArea').classList.add('show');
            setTimeout(() => { window.location.href = '/admin?key=' + encodeURIComponent(key); }, 1200);
        } else {
            err.textContent = d.message || 'Acesso negado.';
            err.classList.add('show');
            btn.disabled = false;
            btn.textContent = 'Entrar';
        }
    } catch(e) {
        err.textContent = 'Erro de conexao. Tente novamente.';
        err.classList.add('show');
        btn.disabled = false;
        btn.textContent = 'Entrar';
    }
}
['inputId','inputKey'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if(e.key==='Enter') logar(); });
});
</script>
</body>
</html>`);
});

// 12) Verifica ID + chave de login
app.post("/admin-login-check", (req, res) => {
    const { discord_id, key } = req.body;

    // Verifica chave
    if (!ADMIN_KEY || key !== ADMIN_KEY)
        return res.json({ success: false, field: "key", message: "Chave de acesso incorreta." });

    // Verifica ID se ID_ALLOWED estiver definido
    if (ID_ALLOWED) {
        // Suporta multiplos IDs separados por virgula: "123,456,789"
        const allowedList = ID_ALLOWED.split(",").map(s => s.trim());
        if (!allowedList.includes(discord_id))
            return res.json({ success: false, field: "id", message: "ID do Discord nao autorizado." });
    }

    return res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[STARTUP] API rodando na porta ${PORT}`);
    // Envia embed do painel admin no canal de link ao iniciar
    if (LINK_CHANNEL_ID)
        sendAdminPanelEmbed().catch(() => {});
});
