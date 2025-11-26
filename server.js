// Survey Pro Backend Server - Production Ready
// Save this file as: server.js
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static HTML file
app.use(express.static(__dirname));

// M-PESA Configuration - YOUR REAL CREDENTIALS
const MPESA_CONFIG = {
  consumerKey: 'mM00raK4LNwNCK1Rb0Vo7xrjH5ieklbbv0aowLygGlb0eGrp',
  consumerSecret: 'bSL3JopPSGvLb53pJjBYtiX1BnelmcADr8C7fERjcIXRaCV92AWqKA1GQ5ueKwJv',
  businessShortCode: '174379',
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  apiUrl: 'https://sandbox.safaricom.co.ke',
  // Your Railway App URL - Callback endpoint
  callbackUrl: 'https://authentic-laughter-production-680f.up.railway.app/api/mpesa/callback',
  // For production, change apiUrl to: 'https://api.safaricom.co.ke'
};

// Store payment statuses and users (use database in production)
const paymentStatuses = {};
const users = [];

// Logging
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// 1. Get M-PESA Access Token
async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(
      `${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`
    ).toString('base64');

    log('Requesting M-PESA access token...');

    const response = await axios.get(
      `${MPESA_CONFIG.apiUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    log('Access token received successfully');
    return response.data.access_token;
  } catch (error) {
    log('Error getting access token', error.response?.data || error.message);
    throw new Error('Failed to get access token');
  }
}

// 2. Initiate STK Push
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phoneNumber, amount } = req.body;

    log('STK Push initiated', { phoneNumber, amount });

    if (!phoneNumber || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and amount are required',
      });
    }

    // Format phone number
    let formattedPhone = phoneNumber.replace(/\s/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('+254')) {
      formattedPhone = formattedPhone.substring(1);
    } else if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    log('Formatted phone number', { original: phoneNumber, formatted: formattedPhone });

    // Get access token
    const accessToken = await getMpesaAccessToken();

    // Generate timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, -3);

    // Generate password
    const password = Buffer.from(
      `${MPESA_CONFIG.businessShortCode}${MPESA_CONFIG.passkey}${timestamp}`
    ).toString('base64');

    // Get the callback URL - use configured URL or generate from request
    let callbackUrl = MPESA_CONFIG.callbackUrl;
    
    // If no callback URL is configured, try to build one from request
    if (!callbackUrl || callbackUrl.includes('webhook.site')) {
      // For local testing, we'll use a mock URL that M-PESA accepts
      callbackUrl = 'https://mydomain.com/mpesa/callback';
      log('⚠️  WARNING: Using placeholder callback URL for testing');
      log('⚠️  In production, set a real public URL in MPESA_CONFIG.callbackUrl');
    }
    
    log('Callback URL', { callbackUrl });

    // Prepare STK Push request
    const stkPushData = {
      BusinessShortCode: MPESA_CONFIG.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.floor(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.businessShortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: 'SurveyPro',
      TransactionDesc: 'Survey Access Fee',
    };

    log('Sending STK Push request to Safaricom');

    // Send STK Push
    const response = await axios.post(
      `${MPESA_CONFIG.apiUrl}/mpesa/stkpush/v1/processrequest`,
      stkPushData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    log('STK Push response received', response.data);

    const { ResponseCode, ResponseDescription, CheckoutRequestID, MerchantRequestID } = response.data;

    if (ResponseCode === '0') {
      // Store initial status
      paymentStatuses[CheckoutRequestID] = {
        status: 'pending',
        phoneNumber: formattedPhone,
        amount: amount,
        timestamp: new Date().toISOString(),
        merchantRequestId: MerchantRequestID,
      };

      log('Payment initiated successfully', {
        checkoutRequestId: CheckoutRequestID,
        merchantRequestId: MerchantRequestID,
      });

      return res.json({
        success: true,
        message: ResponseDescription,
        checkoutRequestId: CheckoutRequestID,
        merchantRequestId: MerchantRequestID,
      });
    } else {
      log('Payment initiation failed', { ResponseCode, ResponseDescription });
      return res.status(400).json({
        success: false,
        message: ResponseDescription,
      });
    }
  } catch (error) {
    log('STK Push Error', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.errorMessage || 'Payment initiation failed',
      error: error.message,
    });
  }
});

// 3. Check Payment Status
app.post('/api/mpesa/status', async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;

    if (!checkoutRequestId) {
      return res.status(400).json({
        success: false,
        message: 'Checkout Request ID is required',
      });
    }

    log('Checking payment status', { checkoutRequestId });

    // Check in-memory status first
    if (paymentStatuses[checkoutRequestId]) {
      const status = paymentStatuses[checkoutRequestId];
      log('Status from memory', status);
      return res.json({
        success: true,
        status: status.status,
        data: status,
      });
    }

    // Query M-PESA API
    const accessToken = await getMpesaAccessToken();
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, -3);
    const password = Buffer.from(
      `${MPESA_CONFIG.businessShortCode}${MPESA_CONFIG.passkey}${timestamp}`
    ).toString('base64');

    const queryData = {
      BusinessShortCode: MPESA_CONFIG.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    log('Querying M-PESA for status');

    const response = await axios.post(
      `${MPESA_CONFIG.apiUrl}/mpesa/stkpushquery/v1/query`,
      queryData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    log('Status query response', response.data);

    const { ResultCode, ResultDesc } = response.data;

    let status = 'pending';
    if (ResultCode === '0') {
      status = 'success';
    } else if (ResultCode === '1032' || ResultCode === '1037') {
      status = 'pending';
    } else {
      status = 'failed';
    }

    // Update status
    if (paymentStatuses[checkoutRequestId]) {
      paymentStatuses[checkoutRequestId].status = status;
      paymentStatuses[checkoutRequestId].resultDesc = ResultDesc;
    }

    return res.json({
      success: true,
      status: status,
      resultCode: ResultCode,
      resultDesc: ResultDesc,
    });
  } catch (error) {
    log('Status Check Error', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to check payment status',
      error: error.message,
    });
  }
});

// 4. M-PESA Callback (Receives payment confirmation from Safaricom)
app.post('/api/mpesa/callback', (req, res) => {
  log('=== M-PESA CALLBACK RECEIVED ===');
  log('Callback body', req.body);

  const { Body } = req.body;

  if (Body && Body.stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;

    log('Callback details', {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
    });

    // Update payment status
    if (paymentStatuses[CheckoutRequestID]) {
      if (ResultCode === 0) {
        paymentStatuses[CheckoutRequestID].status = 'success';
        
        // Extract payment details
        if (CallbackMetadata && CallbackMetadata.Item) {
          const metadata = {};
          CallbackMetadata.Item.forEach((item) => {
            metadata[item.Name] = item.Value;
          });
          paymentStatuses[CheckoutRequestID].metadata = metadata;
          log('Payment successful with details', metadata);
        }
      } else {
        paymentStatuses[CheckoutRequestID].status = 'failed';
        paymentStatuses[CheckoutRequestID].resultDesc = ResultDesc;
        log('Payment failed', { ResultDesc });
      }
    }
  }

  // Always acknowledge receipt
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// 5. Register User
app.post('/api/users/register', (req, res) => {
  try {
    const { name, email, phone } = req.body;
    
    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required',
      });
    }

    const user = {
      id: users.length + 1,
      name,
      email,
      phone,
      earnings: 50, // Registration bonus
      registeredAt: new Date().toISOString(),
    };

    users.push(user);
    log('User registered', { name, email, phone });

    res.json({
      success: true,
      user: user,
    });
  } catch (error) {
    log('Registration error', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
    });
  }
});

// 6. Get All Payments (Admin)
app.get('/api/admin/payments', (req, res) => {
  res.json({
    success: true,
    payments: Object.entries(paymentStatuses).map(([id, data]) => ({
      checkoutRequestId: id,
      ...data,
    })),
  });
});

// 7. Get All Users (Admin)
app.get('/api/admin/users', (req, res) => {
  res.json({
    success: true,
    users: users,
  });
});

// 8. Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    mpesa: {
      apiUrl: MPESA_CONFIG.apiUrl,
      businessShortCode: MPESA_CONFIG.businessShortCode,
    },
  });
});

// 9. Serve HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 10. API Documentation
app.get('/api', (req, res) => {
  res.json({
    message: 'Survey Pro M-PESA Backend API',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      stkPush: 'POST /api/mpesa/stkpush',
      checkStatus: 'POST /api/mpesa/status',
      callback: 'POST /api/mpesa/callback',
      register: 'POST /api/users/register',
      health: 'GET /api/health',
      adminPayments: 'GET /api/admin/payments',
      adminUsers: 'GET /api/admin/users',
    },
    documentation: {
      stkPush: {
        method: 'POST',
        body: {
          phoneNumber: '0712345678',
          amount: 199,
        },
      },
      checkStatus: {
        method: 'POST',
        body: {
          checkoutRequestId: 'ws_CO_01012023123456789',
        },
      },
    },
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  log('Unhandled error', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: error.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 SURVEY PRO BACKEND SERVER STARTED');
  console.log('='.repeat(60));
  console.log(`📡 Server running on: http://localhost:${PORT}`);
  console.log(`🌐 Open website at: http://localhost:${PORT}`);
  console.log(`📱 M-PESA API: ${MPESA_CONFIG.apiUrl}`);
  console.log(`💼 Business ShortCode: ${MPESA_CONFIG.businessShortCode}`);
  console.log(`🔐 Environment: ${MPESA_CONFIG.apiUrl.includes('sandbox') ? 'SANDBOX (Testing)' : 'PRODUCTION (Live)'}`);
  console.log('='.repeat(60));
  console.log('\n💡 API Endpoints:');
  console.log('   - POST /api/mpesa/stkpush    - Initiate payment');
  console.log('   - POST /api/mpesa/status     - Check payment status');
  console.log('   - POST /api/mpesa/callback   - M-PESA callback');
  console.log('   - GET  /api/health           - Health check');
  console.log('   - GET  /api/admin/payments   - View all payments');
  console.log('   - GET  /api/admin/users      - View all users');
  console.log('\n📝 Test with sandbox numbers:');
  console.log('   - 254708374149');
  console.log('   - 254711369369');
  console.log('   - 254733341571');
  console.log('\n⚠️  Remember: Press Ctrl+C to stop the server');
  console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});

module.exports = app;