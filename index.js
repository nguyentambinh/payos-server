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

// DEBUG TẠM THỜI: in ra danh sách hàm thật sự có trên payOS để xác định
// đúng tên hàm check trạng thái đơn hàng. Xoá đoạn này sau khi xác định xong.
console.log('payOS methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(payOS)));

const app = express();
app.use(express.json());

// Render free tier sẽ "ngủ" sau 15 phút không có request. Endpoint này
// dùng để tự kiểm tra server còn sống, và bạn có thể ping định kỳ nếu muốn
// giảm cold start (không bắt buộc).
app.get('/', (req, res) => res.send('payOS server is running'));

// ============================================================================
// HÀM DÙNG CHUNG: đánh dấu đơn hàng đã thanh toán trong Firestore theo orderCode
// (dùng lại cho cả webhook lẫn endpoint check thủ công bên dưới)
// ============================================================================
async function markOrderPaidByOrderCode(orderCode) {
  const snap = await db
    .collection('orders')
    .where('orderCode', '==', orderCode)
    .limit(1)
    .get();

  if (snap.empty) {
    console.warn('Không tìm thấy đơn hàng khớp orderCode:', orderCode);
    return false;
  }

  const doc = snap.docs[0];
  if (doc.data().status === 'paid') {
    // Đã được đánh dấu paid từ trước (vd. webhook đã chạy), khỏi update lại.
    return true;
  }

  await doc.ref.update({
    status: 'paid',
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('Đã xác nhận thanh toán cho orderCode:', orderCode);
  return true;
}

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
    await markOrderPaidByOrderCode(webhookData.orderCode);

    // payOS yêu cầu phản hồi mã 2xx để biết webhook đã xử lý thành công
    return res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Webhook không hợp lệ:', err);
    return res.status(400).json({ message: 'Invalid webhook' });
  }
});

// ============================================================================
// 3) CHECK PAYMENT STATUS - endpoint DỰ PHÒNG cho webhook
// ============================================================================
// App gọi định kỳ (polling) trong lúc chờ ở màn hình QR. Endpoint này hỏi
// THẲNG payOS xem đơn đã thanh toán chưa (không phụ thuộc webhook), rồi tự
// cập nhật Firestore nếu đã paid. Bù cho trường hợp webhook bị "rớt" do
// server free tier ngủ đúng lúc payOS gọi webhook.
app.get('/check-payment-status/:orderCode', async (req, res) => {
  try {
    const orderCode = Number(req.params.orderCode);
    if (!orderCode) {
      return res.status(400).json({ error: 'orderCode không hợp lệ' });
    }

    const info = await payOS.getPaymentLinkInfomation(orderCode);
    const isPaid = info.status === 'PAID';

    if (isPaid) {
      await markOrderPaidByOrderCode(orderCode);
    }

    return res.json({ status: info.status, paid: isPaid });
  } catch (err) {
    console.error('Lỗi kiểm tra trạng thái thanh toán:', err);
    return res.status(500).json({ error: 'Không kiểm tra được trạng thái' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`payOS server đang chạy ở port ${PORT}`));