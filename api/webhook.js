const admin = require('firebase-admin');

// Khởi tạo Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: 'https://sever-check-d7ad5-default-rtdb.firebaseio.com'
  });
}

module.exports = async function handler(req, res) {
  // Chỉ nhận POST
  if (req.method !== 'POST') return res.status(405).end();

  // Xác thực secret token trong URL: /api/webhook?token=...
  const token = req.query.token;
  if (!token || token !== process.env.WEBHOOK_SECRET) {
    console.log('❌ Unauthorized webhook call');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const tx = req.body;
    if (!tx) return res.status(200).json({ ok: true });

    // Chỉ xử lý tiền VÀO
    if (tx.transferType !== 'in') return res.status(200).json({ ok: true });

    const content = (tx.content || tx.description || '').toUpperCase().trim();
    const amount  = parseInt(tx.transferAmount) || 0;

    if (!content || !amount) return res.status(200).json({ ok: true });

    // Nội dung CK phải có dạng: "CHANEL USERNAME"
    const match = content.match(/CHANEL\s+([A-Z0-9_]+)/);
    if (!match) {
      console.log('⚠️ Không khớp format CHANEL USERNAME:', content);
      return res.status(200).json({ ok: true });
    }

    const usernameRaw = match[1].toLowerCase();
    console.log(`🔍 Tìm donation của: ${usernameRaw} — ${amount}đ`);

    const db = admin.database();

    // Username trong Firebase có thể lưu kèm dấu "@" (vd: @ndungvip)
    // nhưng ngân hàng tự xóa ký tự đặc biệt khỏi nội dung CK khi chuyển thật
    // → thử cả 2 trường hợp: không có "@" và có "@"
    let username = usernameRaw;
    let snap     = await db.ref('donations/' + username).once('value');

    if (!snap.exists()) {
      username = '@' + usernameRaw;
      snap     = await db.ref('donations/' + username).once('value');
    }

    if (!snap.exists()) {
      console.log('⚠️ Không tìm thấy donation pending của:', usernameRaw);
      return res.status(200).json({ ok: true });
    }

    const donation = snap.val();

    // Kiểm tra 3 điều kiện
    if (donation.status !== 'pending') {
      console.log('⚠️ Donation không còn pending:', donation.status);
      return res.status(200).json({ ok: true });
    }

    if (donation.amount !== amount) {
      console.log(`⚠️ Số tiền không khớp: expected ${donation.amount}, got ${amount}`);
      return res.status(200).json({ ok: true });
    }

    // Không quá 24h
    if (Date.now() - donation.timestamp > 24 * 60 * 60 * 1000) {
      console.log('⚠️ Donation đã quá 24h');
      return res.status(200).json({ ok: true });
    }

    // ✅ Tất cả đều khớp — TỰ ĐỘNG DUYỆT!
    await db.ref('donations/' + username).update({
      status    : 'approved',
      approvedAt: Date.now(),
      txRef     : String(tx.referenceCode || tx.id || '')
    });

    console.log(`✅ Đã duyệt: ${username} — ${amount}đ`);
    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error('💥 Lỗi webhook:', e);
    return res.status(200).json({ ok: true }); // Luôn trả 200 để SePay không retry
  }
};
