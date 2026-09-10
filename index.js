const express = require('express');
const admin = require('firebase-admin');
const PayOS = require('@payos/node');

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const payOS = new PayOS(
  process.env.PAYOS_CLIENT_ID,
  process.env.PAYOS_API_KEY,
  process.env.PAYOS_CHECKSUM_KEY
);

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('payOS server is running');
});

app.get('/setup-webhook', async (req, res) => {
  try {
    const webhookUrl =
      'https://payos-server-by-tb.onrender.com/webhook';

    const result = await payOS.confirmWebhook(webhookUrl);

    console.log(
      '>> [setup-webhook] Xác nhận webhook thành công:',
      result
    );

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error('>> [setup-webhook] LỖI:', err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

app.post('/create-payment-link', async (req, res) => {
  console.log(
    '>> [create-payment-link] body nhận được:',
    req.body
  );

  try {
    const {
      orderId,
      amount,
      description,
    } = req.body;

    if (!orderId || !amount) {
      console.warn(
        '>> [create-payment-link] Thiếu orderId hoặc amount'
      );

      return res.status(400).json({
        error: 'Thiếu orderId hoặc amount',
      });
    }

    const orderCode = Math.floor(
      Date.now() / 1000
    );

    const paymentLink =
      await payOS.createPaymentLink({
        orderCode,
        amount: Math.round(amount),
        description: String(
          description || 'Thanh toan don hang'
        ).slice(0, 25),
        cancelUrl: 'https://your-domain.com/cancel',
        returnUrl: 'https://your-domain.com/success',
      });

    await db
      .collection('orders')
      .doc(orderId)
      .set(
        {
          orderCode,
          payosCheckoutUrl:
            paymentLink.checkoutUrl,
          payosQrCode:
            paymentLink.qrCode,
          status: 'pending',
        },
        {
          merge: true,
        }
      );

    console.log(
      '>> [create-payment-link] Tạo thành công, orderCode:',
      orderCode
    );

    return res.json({
      orderCode,
      checkoutUrl:
        paymentLink.checkoutUrl,
      qrCode:
        paymentLink.qrCode,
    });
  } catch (err) {
    console.error(
      '>> [create-payment-link] LỖI:',
      err
    );

    return res.status(500).json({
      error: 'Không tạo được link thanh toán',
    });
  }
});

app.post('/webhook', async (req, res) => {
  console.log(
    '>> [webhook] Nhận request:',
    JSON.stringify(req.body)
  );

  try {
    const webhookData =
      payOS.verifyPaymentWebhookData(
        req.body
      );

    const {
      orderCode,
    } = webhookData;

    console.log(
      '>> [webhook] Verify OK, orderCode:',
      orderCode
    );

    const snap = await db
      .collection('orders')
      .where(
        'orderCode',
        '==',
        orderCode
      )
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status: 'paid',
        paidAt:
          admin.firestore.FieldValue
            .serverTimestamp(),
      });

      console.log(
        '>> [webhook] Đã xác nhận thanh toán cho orderCode:',
        orderCode
      );
    } else {
      console.warn(
        '>> [webhook] Không tìm thấy đơn hàng khớp orderCode:',
        orderCode
      );
    }

    return res
      .status(200)
      .json({
        message: 'OK',
      });
  } catch (err) {
    console.error(
      '>> [webhook] Webhook không hợp lệ:',
      err
    );

    return res
      .status(400)
      .json({
        message: 'Invalid webhook',
      });
  }
});

app.get(
  '/check-payment-status/:orderCode',
  async (req, res) => {
    const orderCode = Number(
      req.params.orderCode
    );

    console.log(
      '>> [check-payment-status] Polling orderCode:',
      orderCode
    );

    try {
      const info =
        await payOS.getPaymentLinkInformation(
          orderCode
        );

      console.log(
        '>> [check-payment-status] Trạng thái từ payOS:',
        info.status
      );

      if (info.status === 'PAID') {
        const snap = await db
          .collection('orders')
          .where(
            'orderCode',
            '==',
            orderCode
          )
          .limit(1)
          .get();

        if (
          !snap.empty &&
          snap.docs[0].data().status !==
            'paid'
        ) {
          await snap.docs[0].ref.update({
            status: 'paid',
            paidAt:
              admin.firestore.FieldValue
                .serverTimestamp(),
          });

          console.log(
            '>> [check-payment-status] Đã xác nhận thanh toán qua polling cho orderCode:',
            orderCode
          );
        }
      }

      return res
        .status(200)
        .json({
          status: info.status,
        });
    } catch (err) {
      console.error(
        '>> [check-payment-status] LỖI:',
        err
      );

      return res
        .status(500)
        .json({
          error:
            'Không kiểm tra được trạng thái',
        });
    }
  }
);

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () =>
    console.log(
      `payOS server đang chạy ở port ${PORT}`
    )
);