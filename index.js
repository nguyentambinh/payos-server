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
// 0) SETUP - Gọi 1 LẦN DUY NHẤT để đăng ký + xác nhận webhook URL với payOS.
// Chỉ dán URL trên my.payos.vn KHÔNG đủ - payOS bắt buộc phải confirm qua API
// này thì mới thật sự bắt đầu gửi webhook. Sau khi xác nhận thành công, có
// thể xoá route này đi (không bắt buộc, nhưng nên xoá để tránh ai gọi lại
// làm đổi webhook ngoài ý muốn).
// ============================================================================
app.get('/setup-webhook', async (req, res) => {
  try {
    const webhookUrl = 'https://payos-server-by-tb.onrender.com/webhook';
    const result = await payOS.confirmWebhook(webhookUrl);
    console.log('>> [setup-webhook] Xác nhận webhook thành công:', result);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('>> [setup-webhook] LỖI:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 1) TẠO LINK / QR THANH TOÁN
// ============================================================================
// App Flutter gọi POST /create-payment-link với { orderId, amount, description }
// orderId: id document Firestore đã tạo sẵn từ app (orders/{orderId})
app.post('/create-payment-link', async (req, res) => {
  console.log('>> [create-payment-link] body nhận được:', req.body);
  try {
    const { orderId, amount, description } = req.body;

    if (!orderId || !amount) {
      console.warn('>> [create-payment-link] Thiếu orderId hoặc amount');
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

    console.log('>> [create-payment-link] Tạo thành công, orderCode:', orderCode);

    return res.json({
      orderCode,
      checkoutUrl: paymentLink.checkoutUrl,
      qrCode: paymentLink.qrCode,
    });
  } catch (err) {
    console.error('>> [create-payment-link] LỖI:', err);
    return res.status(500).json({ error: 'Không tạo được link thanh toán' });
  }
});

// ============================================================================
// 2) WEBHOOK - PayOS gọi vào đây khi có kết quả thanh toán
// ============================================================================
// URL này (https://payos-server-by-tb.onrender.com/webhook) phải được xác
// nhận qua /setup-webhook (hoặc payOS.confirmWebhook) ít nhất 1 lần thì
// payOS mới thật sự gửi request tới đây.
app.post('/webhook', async (req, res) => {
  console.log('>> [webhook] Nhận request:', JSON.stringify(req.body));
  try {
    // verifyPaymentWebhookData tự kiểm tra chữ ký (checksumKey) - đảm bảo
    // request thật sự đến từ payOS, không phải giả mạo.
    const webhookData = payOS.verifyPaymentWebhookData(req.body);
    const { orderCode } = webhookData;
    console.log('>> [webhook] Verify OK, orderCode:', orderCode);

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
      console.log('>> [webhook] Đã xác nhận thanh toán cho orderCode:', orderCode);
    } else {
      console.warn('>> [webhook] Không tìm thấy đơn hàng khớp orderCode:', orderCode);
    }

    // payOS yêu cầu phản hồi mã 2xx để biết webhook đã xử lý thành công
    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('>> [webhook] Webhook không hợp lệ:', err);
    return res.status(400).json({ message: 'Invalid webhook' });
  }
});

// ============================================================================
// 3) DỰ PHÒNG - App gọi định kỳ để hỏi thẳng trạng thái thanh toán từ payOS,
// phòng trường hợp webhook bị lỡ do Render free tier ngủ đúng lúc payOS gọi.
// ============================================================================
app.get('/check-payment-status/:orderCode', async (req, res) => {
  const orderCode = Number(req.params.orderCode);
  console.log('>> [check-payment-status] Polling orderCode:', orderCode);
  try {
    const info = await payOS.getPaymentLinkInformation(orderCode);
    console.log('>> [check-payment-status] Trạng thái từ payOS:', info.status);

    if (info.status === 'PAID') {
      const snap = await db
        .collection('orders')
        .where('orderCode', '==', orderCode)
        .limit(1)
        .get();

      if (!snap.empty && snap.docs[0].data().status !== 'paid') {
        await snap.docs[0].ref.update({
          status: 'paid',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log('>> [check-payment-status] Đã xác nhận thanh toán (qua polling) cho orderCode:', orderCode);
      }
    }

    return res.status(200).json({ status: info.status });
  } catch (err) {
    console.error('>> [check-payment-status] LỖI:', err);
    return res.status(500).json({ error: 'Không kiểm tra được trạng thái' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`payOS server đang chạy ở port ${PORT}`));