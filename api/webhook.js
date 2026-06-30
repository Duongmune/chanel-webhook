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

    // usernameClean: chữ thường, chỉ gồm a-z0-9 — khớp với field đã chuẩn hóa
    // sẵn ở phía frontend (vì ngân hàng tự xóa ký tự đặc biệt như "@" khỏi nội dung CK)
    const usernameClean = match[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    console.log(`🔍 Tìm donation pending của: ${usernameClean} — ${amount}đ`);

    const db = admin.database();

    // Mỗi user giờ có thể có NHIỀU bản ghi donate (mỗi lần donate = 1 push key
    // riêng, để cộng dồn được trên bảng xếp hạng). Tìm tất cả bản ghi có
    // usernameClean khớp, rồi lọc ra đúng cái đang "pending" + số tiền khớp
    // + còn trong hạn 24h. Nếu có nhiều cái khớp, chọn cái MỚI NHẤT.
    const snap = await db.ref('donations')
      .orderByChild('usernameClean')
      .equalTo(usernameClean)
      .once('value');

    if (!snap.exists()) {
      console.log('⚠️ Không tìm thấy donation nào của:', usernameClean);
      return res.status(200).json({ ok: true });
    }

    let foundKey = null;
    let foundTimestamp = -1;

    snap.forEach(child => {
      const d = child.val();
      const isFresh = (Date.now() - (d.timestamp || 0)) <= 24 * 60 * 60 * 1000;
      if (d.status === 'pending' && d.amount === amount && isFresh) {
        if (d.timestamp > foundTimestamp) {
          foundTimestamp = d.timestamp;
          foundKey = child.key;
        }
      }
    });

    if (!foundKey) {
      console.log(`⚠️ Không có donation pending khớp số tiền ${amount}đ cho:`, usernameClean);
      return res.status(200).json({ ok: true });
    }

    // ✅ Khớp — TỰ ĐỘNG DUYỆT!
    await db.ref('donations/' + foundKey).update({
      status    : 'approved',
      approvedAt: Date.now(),
      txRef     : String(tx.referenceCode || tx.id || '')
    });

    console.log(`✅ Đã duyệt: ${usernameClean} (${foundKey}) — ${amount}đ`);
    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error('💥 Lỗi webhook:', e);
    return res.status(200).json({ ok: true }); // Luôn trả 200 để SePay không retry
  }
};
