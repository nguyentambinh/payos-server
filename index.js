const express = require('express');
const admin = require('firebase-admin');
const PayOS = require('@payos/node'); // default export, KHÔNG destructure { PayOS }

// ============================================================================
// KHỞI TẠO FIREBASE ADMIN (dùng service account key, KHÔNG cần Cloud Functions)
// ============================================================================
// Trên Render: dán nguyên nội dung file JSON service account vào biến môi
// trường FIREBASE_SERVICE_ACCOUNT (để trên 1 dòng).
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ============================================================================
// KHỞI TẠO PAYOS (bản @payos/node 1.0.6 nhận 3 tham số string, không phải object)
// ============================================================================
const payOS = new PayOS(
  process.env.PAYOS_CLIENT_ID,
  process.env.PAYOS_API_KEY,
  process.env.PAYOS_CHECKSUM_KEY
);

const app = express();
app.use(express.json());

// Render free tier sẽ "ngủ" sau 15 phút không có request. Endpoint này
// dùng để tự kiểm tra server còn sống, và bạn có thể ping định kỳ nếu muốn
// giảm cold start (không bắt buộc).
app.get('/', (req, res) => res.send('payOS server is running'));

// ============================================================================
// 1) TẠO LINK / QR THANH TOÁN
// ============================================================================
// App Flutter gọi POST /create-payment-link với { orderId, amount, description }
// orderId: id document Firestore đã tạo sẵn từ app (orders/{orderId})
app.post('/create-payment-link', async (req, res) => {
  try {
    const { orderId, amount, description } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ error: 'Thiếu orderId hoặc amount' });
    }

    // orderCode của PayOS phải là số nguyên, duy nhất - dùng epoch giây
    const orderCode = Math.floor(Date.now() / 1000);

    const paymentLink = await payOS.createPaymentLink({
      orderCode,
      amount: Math.round(amount),
      // payOS giới hạn description khá ngắn -> cắt bớt cho an toàn
      description: String(description || 'Thanh toan don hang').slice(0, 25),
      cancelUrl: 'https://your-domain.com/cancel',
      returnUrl: 'https://your-domain.com/success',
    });

    // Lưu orderCode + kết quả PayOS vào đúng document Firestore mà app đã tạo,
    // để webhook bên dưới tìm lại được và để app lắng nghe real-time.
    await db.collection('orders').doc(orderId).set(
      {
        orderCode,
        payosCheckoutUrl: paymentLink.checkoutUrl,
        payosQrCode: paymentLink.qrCode,
        status: 'pending',
      },
      { merge: true }
    );

    return res.json({
      orderCode,
      checkoutUrl: paymentLink.checkoutUrl,
      qrCode: paymentLink.qrCode,
    });
  } catch (err) {
    console.error('Lỗi tạo link thanh toán:', err);
    return res.status(500).json({ error: 'Không tạo được link thanh toán' });
  }
});

// ============================================================================
// 2) WEBHOOK - PayOS gọi vào đây khi có kết quả thanh toán
// ============================================================================
// URL này (https://ten-app.onrender.com/webhook) cần dán vào my.payos.vn
// ở mục Webhook của Kênh thanh toán.
app.post('/webhook', async (req, res) => {
  try {
    // verifyPaymentWebhookData tự kiểm tra chữ ký (checksumKey) - đảm bảo
    // request thật sự đến từ payOS, không phải giả mạo.
    const webhookData = payOS.verifyPaymentWebhookData(req.body);
    const { orderCode } = webhookData;

    const snap = await db
      .collection('orders')
      .where('orderCode', '==', orderCode)
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log('Đã xác nhận thanh toán cho orderCode:', orderCode);
    } else {
      console.warn('Không tìm thấy đơn hàng khớp orderCode:', orderCode);
    }

    // payOS yêu cầu phản hồi mã 2xx để biết webhook đã xử lý thành công
    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Webhook không hợp lệ:', err);
    return res.status(400).json({ message: 'Invalid webhook' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`payOS server đang chạy ở port ${PORT}`));