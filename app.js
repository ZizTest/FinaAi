import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const dbPath = './database.json';
const brainPath = './brain.json';

if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ users: {}, pendingUsers: {} }, null, 2));
}

function loadDB() {
    return JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
}

function saveDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function loadBrain() {
    return JSON.parse(fs.readFileSync(brainPath, 'utf-8'));
}

function saveBrain(data) {
    fs.writeFileSync(brainPath, JSON.stringify(data, null, 2));
}

const formatRp = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(angka);

export async function handleMessage(sock, sender, pushName, messageContent) {
    let db = loadDB();
    let brain = loadBrain(); 
    const text = messageContent.trim();
    
    // 1. CEK REGISTRASI
    if (!db.users[sender]) {
        if (db.pendingUsers[sender]) {
            const namaUser = text;
            db.users[sender] = {
                id: sender.split('@')[0],
                name: namaUser,
                registeredAt: new Date().toISOString(),
                transactions: [] 
            };
            delete db.pendingUsers[sender];
            saveDB(db);
            
            await sock.sendMessage(sender, { 
                text: `Salam kenal, ${namaUser}! 🎉 Data kamu udah disimpen.\n\nSekarang kamu bisa catat keuangan, misalnya ketik: *"Kopi goceng"*.\nKetik *"kamu bisa apa ke bot"* buat lihat fitur lengkapnya.` 
            });
            return;
        } else {
            db.pendingUsers[sender] = true;
            saveDB(db);
            await sock.sendMessage(sender, { 
                text: `Halo! 👋 Sepertinya nomor kamu belum terdaftar di sistem aku.\n\nBoleh kasih tau siapa nama panggilan kamu?` 
            });
            return;
        }
    }

    const userData = db.users[sender];

    // 2. FITUR SWITCH MODEL AI
    if (text.toLowerCase() === "switch") {
        brain.currentModelIndex = (brain.currentModelIndex + 1) % brain.models.length;
        saveBrain(brain);
        const activeModel = brain.models[brain.currentModelIndex];
        await sock.sendMessage(sender, { text: `🔄 Sip! Model AI berhasil diganti ke: *${activeModel}*` });
        return;
    }

    // 3. MENU BANTUAN
    if (text.toLowerCase().includes("kamu bisa apa")) {
        await sock.sendMessage(sender, { text: `Hai *${userData.name}* 👋 Aku *${brain.botName}*, asisten keuangan pribadimu.\nCoba bilang:\n- "Gaji bulan ini 5jt"\n- "Habis 20rb buat makan"\n- "Bulan ini pengeluaran gua berapa?"\n- "Hapus semua catatanku"` });
        return;
    }

    // 4. PROSES GEMINI AI
    await sock.sendPresenceUpdate('composing', sender);

    try {
        const activeModelName = brain.models[brain.currentModelIndex];
        const genAI = new GoogleGenerativeAI(brain.token);
        const model = genAI.getGenerativeModel({ model: activeModelName });

        const now = new Date();
        const optionsDate = { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const hariIni = now.toLocaleDateString('id-ID', optionsDate);
        
        const currentMonth = now.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', month: 'long', year: 'numeric' });
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonth = lastMonthDate.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', month: 'long', year: 'numeric' });

        const history = userData.transactions;
        
        // MENGHITUNG SALDO SAAT INI SEBELUM DIKASIH KE AI
        let currentBalance = 0;
        history.forEach(trx => {
            if (trx.type === 'expense') currentBalance -= trx.amount;
            else if (trx.type === 'income') currentBalance += trx.amount;
        });
        
        const systemPrompt = `Kamu adalah ${brain.botName}, AI asisten keuangan yang pintar dan ramah. Nama user adalah ${userData.name}.
INFO WAKTU SEKARANG: 
- Hari ini: ${hariIni}
- Bulan ini: ${currentMonth}
- Saldo Saat Ini: Rp ${currentBalance}

Tugasmu: Analisa pesan user. WAJIB balas HANYA dengan JSON murni tanpa markdown persis seperti format di bawah.

1. JIKA MENCATAT TRANSAKSI (Pengeluaran/Pemasukan)
Kamu WAJIB memikirkan "category" yang pas (contoh: Makanan, Transportasi, Hiburan, Gaji, dll) dan satu "emoji" yang mewakili item tersebut.
Sertakan juga sisa saldo terbaru di dalam balasan "reply" dengan menghitung: Saldo Saat Ini dikurangi/ditambah transaksi baru.
{"action": "record", "type": "expense", "amount": 5000, "item": "Kopi", "category": "Jajan", "emoji": "☕", "date": "2026-08-05", "reply": "Sip, Kopi 5.000 (☕ Jajan) udah dicatat! Saldo kamu sekarang sisa Rp X."}

2. JIKA MENGHAPUS SEMUA DATA
{"action": "delete_all", "reply": "Oke, semua riwayat pengeluaran kamu udah dihapus bersih. Saldo jadi Rp 0 lagi!"}

3. JIKA MENGHAPUS ITEM TERTENTU
{"action": "delete_item", "item_keyword": "sabun", "reply": "Sip, catatan beli sabun udah dihapus!"}

4. JIKA BERTANYA / NGOBROL / CEK BULANAN
Gunakan data riwayat berikut untuk menjawab: ${JSON.stringify(history)}. Sebutkan juga total Saldo Saat Ini di balasanmu.
{"action": "chat", "reply": "Total pengeluaran bulan ini Rp X. Sisa saldo kamu saat ini Rp ${currentBalance}. Rinciannya: ..."}

Pesan user: "${text}"`;

        const result = await model.generateContent(systemPrompt);
        const responseText = result.response.text();
        
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Format balasan AI salah: " + responseText);

        const aiData = JSON.parse(jsonMatch[0]);

        if (aiData.action === 'record') {
            db.users[sender].transactions.push({
                id: Date.now().toString(),
                date: aiData.date,
                type: aiData.type,
                item: aiData.item,
                amount: aiData.amount,
                // Nyimpen kategori & emoji hasil pikiran AI
                category: aiData.category || "Lainnya",
                emoji: aiData.emoji || "📝"
            });
            saveDB(db);
        } else if (aiData.action === 'delete_all') {
            db.users[sender].transactions = []; 
            saveDB(db);
        } else if (aiData.action === 'delete_item') {
            const keyword = aiData.item_keyword.toLowerCase();
            db.users[sender].transactions = db.users[sender].transactions.filter(
                (trx) => !trx.item.toLowerCase().includes(keyword)
            );
            saveDB(db);
        }

        await sock.sendMessage(sender, { text: aiData.reply });

    } catch (error) {
        console.log("❌ ERROR AI:", error.message || error); 
        let errorMessage = "Waduh, aku agak pusing nih mikirnya. Coba ketik lagi ya! 😅";
        const errString = (error.message || "").toString();

        if (errString.includes('503')) errorMessage = "⏳ *Server Penuh (Error 503)*\nModel ini lagi *overload*. Ketik *switch* buat ganti ke model cadangan ya.";
        else if (errString.includes('429')) errorMessage = "🛑 *Limit Tercapai (Error 429)*\nKetik *switch* buat pakai model AI yang lain ya!";
        else if (errString.includes('404')) errorMessage = "🔍 *Model Tidak Ditemukan*\nKetik *switch* buat pindah model.";

        await sock.sendMessage(sender, { text: errorMessage });
    }
}
