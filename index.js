import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleMessage } from './app.js'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// TULIS NOMOR BOT LU DI SINI (Pakai awalan 62)
const NOMOR_BOT = "6285714494070"; 
// ==========================================

const settingsPath = './settings.json';
if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({ allowedNumbers: ["6285714494070"], privateMode: true }, null, 2));
}

const otpStore = {};

async function startSystem() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Mac OS', 'Chrome', '121.0.0.0']
    });

    // Otomatis minta kode pairing tanpa nunggu input keyboard
    if (!state.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(NOMOR_BOT);
                console.log(`\n================================`);
                console.log(`KODE PAIRING LU: ${code}`);
                console.log(`================================\n`);
            } catch (err) {
                console.log('\nGagal minta kode pairing.');
            }
        }, 3000); 
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, menghubungkan ulang...');
            if (shouldReconnect) startSystem();
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung ke WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (messageContent) {
            const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf-8'));
            if (settings.privateMode) {
                const isAllowed = settings.allowedNumbers.some(num => sender.includes(num));
                if (!isAllowed) return; 
            }
            await handleMessage(sock, sender, msg.pushName, messageContent);
        }
    });

    // SISTEM WEB & API (TETAP SAMA SEPERTI SEBELUMNYA)
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    app.post('/api/request-otp', async (req, res) => {
        let { phone } = req.body;
        phone = phone.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.substring(1);

        const targetJid = phone + '@s.whatsapp.net';
        const db = JSON.parse(fs.readFileSync('./database.json', 'utf-8'));
        const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf-8'));

        let userKey = Object.keys(db.users).find(k => k.includes(phone));
        if (!userKey) {
            const isOwner = settings.allowedNumbers.some(n => phone.includes(n));
            if (isOwner) {
                userKey = Object.keys(db.users).find(k => settings.allowedNumbers.some(n => k.includes(n)));
            }
        }

        if (!userKey) return res.status(400).json({ error: "Nomor kamu belum terdaftar!" });

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore[phone] = otpCode; 

        try {
            await sock.sendMessage(targetJid, { text: `🔐 *LOGIN WEB FINA*\n\nKode OTP: *${otpCode}*` });
            res.json({ success: true, message: "OTP dikirim!" });
        } catch (err) { res.status(500).json({ error: "Gagal kirim pesan WA." }); }
    });

    app.post('/api/verify-otp', (req, res) => {
        let { phone, otp } = req.body;
        phone = phone.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.substring(1);

        if (otpStore[phone] && otpStore[phone] === otp) {
            delete otpStore[phone]; 
            res.json({ success: true, phone: phone });
        } else { res.status(400).json({ error: "OTP salah/kadaluarsa!" }); }
    });

    app.get('/api/data', (req, res) => {
        let phone = req.query.phone;
        if (!phone) return res.status(401).json({ error: "Akses ditolak." });

        const db = JSON.parse(fs.readFileSync('./database.json', 'utf-8'));
        const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf-8'));

        let userKey = Object.keys(db.users).find(k => k.includes(phone));
        if (!userKey) {
            const isOwner = settings.allowedNumbers.some(n => phone.includes(n));
            if (isOwner) userKey = Object.keys(db.users).find(k => settings.allowedNumbers.some(n => k.includes(n)));
        }

        if (userKey && db.users[userKey]) res.json(db.users[userKey]);
        else res.status(404).json({ error: "Data tidak ditemukan." });
    });

    // Railway otomatis ngasih environment variable PORT
    const port = process.env.PORT || 3000;
    app.listen(port, '0.0.0.0', () => {
        console.log(`✅ Web Dashboard aktif di port ${port}`);
    });
}

startSystem();
