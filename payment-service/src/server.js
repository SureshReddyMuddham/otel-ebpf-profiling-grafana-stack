const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const app = express();
const PORT = process.env.PORT || 3001;
const tracer = trace.getTracer('payment-service');
const meter = metrics.getMeter('payment-service');
const otelLogger = logs.getLogger('payment-service');

// Emit log via OTel Logs API → OTLP → Collector → Loki
function log(level, body, attributes = {}) {
  otelLogger.emit({
    severityNumber: level === 'error' ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes,
  });
  console.log(JSON.stringify({ level, ...attributes, msg: body }));
}

// Custom metrics
const transactionCounter = meter.createCounter('payments_total', { description: 'Total payment transactions' });
const paymentAmountHistogram = meter.createHistogram('payment_amount_dollars', { description: 'Payment amounts in dollars' });
const paymentDuration = meter.createHistogram('payment_processing_ms', { description: 'Payment processing duration in ms' });
const pendingPayments = meter.createUpDownCounter('pending_payments', { description: 'Currently pending payments' });
const failedPayments = meter.createCounter('payments_failed_total', { description: 'Total failed payments' });

app.use(cors());
app.use(express.json());

// In-memory store
const transactions = [];

// Card validation (simplified)
function validateCard(cardNumber, expiry, cvv) {
  if (!cardNumber || !expiry || !cvv) return { valid: false, reason: 'Missing card details' };
  const cleaned = cardNumber.replace(/\s|-/g, '');
  if (cleaned.length < 13 || cleaned.length > 19) return { valid: false, reason: 'Invalid card number length' };
  let cardType = 'unknown';
  if (/^4/.test(cleaned)) cardType = 'visa';
  else if (/^5[1-5]/.test(cleaned)) cardType = 'mastercard';
  else if (/^3[47]/.test(cleaned)) cardType = 'amex';
  else if (/^6(?:011|5)/.test(cleaned)) cardType = 'discover';
  if (cardType !== 'visa' && cardType !== 'mastercard') {
    return { valid: false, reason: `Card type ${cardType} not accepted. Only Visa and MasterCard.`, cardType };
  }
  return { valid: true, cardType };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'payment-service', uptime: process.uptime(), transactions: transactions.length });
});

// POST /api/charge
app.post('/api/charge', (req, res) => {
  const startTime = Date.now();
  const span = tracer.startSpan('process-payment');
  try {
    const { cardNumber, expiry, cvv, amount, currency, orderId, customer } = req.body;
    if (!amount || amount <= 0) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid amount' });
      failedPayments.add(1, { reason: 'invalid_amount' });
      span.end();
      return res.status(400).json({ error: 'Valid amount required' });
    }
    const validation = validateCard(cardNumber, expiry, cvv);
    span.setAttribute('payment.card_type', validation.cardType || 'unknown');
    span.setAttribute('payment.card_valid', validation.valid);
    if (!validation.valid) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: validation.reason });
      failedPayments.add(1, { reason: 'card_validation', card_type: validation.cardType || 'unknown' });
      log('error', 'Payment failed: card validation', { reason: validation.reason, orderId });
      span.end();
      return res.status(400).json({ error: validation.reason });
    }
    if (Math.random() < 0.05) {
      const failReason = 'Payment processor declined';
      span.setStatus({ code: SpanStatusCode.ERROR, message: failReason });
      failedPayments.add(1, { reason: 'declined', card_type: validation.cardType });
      log('error', 'Payment declined', { orderId, amount, customer });
      span.end();
      return res.status(402).json({ error: failReason });
    }
    const transaction = {
      transactionId: uuidv4(),
      orderId: orderId || null,
      customer: customer || 'anonymous',
      amount,
      currency: currency || 'USD',
      cardType: validation.cardType,
      cardLast4: cardNumber ? cardNumber.slice(-4) : '****',
      status: 'completed',
      loyaltyLevel: ['platinum', 'gold', 'silver', 'bronze'][Math.floor(Math.random() * 4)],
      createdAt: new Date().toISOString(),
    };
    transactions.push(transaction);
    const processingTime = Date.now() - startTime;
    transactionCounter.add(1, { card_type: validation.cardType, currency: transaction.currency, status: 'completed' });
    paymentAmountHistogram.record(amount, { card_type: validation.cardType, currency: transaction.currency });
    paymentDuration.record(processingTime, { card_type: validation.cardType });
    span.setAttribute('payment.transaction_id', transaction.transactionId);
    span.setAttribute('payment.amount', amount);
    span.setAttribute('payment.currency', transaction.currency);
    span.setStatus({ code: SpanStatusCode.OK });
    log('info', 'Payment processed', { transactionId: transaction.transactionId, orderId, customer: transaction.customer, amount, cardType: validation.cardType });
    span.end();
    res.status(201).json(transaction);
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.recordException(err);
    failedPayments.add(1, { reason: 'internal_error' });
    log('error', 'Payment processing failed', { error: err.message });
    span.end();
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transactions
app.get('/api/transactions', (req, res) => {
  const span = tracer.startSpan('list-transactions');
  span.setAttribute('transactions.count', transactions.length);
  span.end();
  res.json(transactions);
});

// POST /api/refund/:transactionId
app.post('/api/refund/:transactionId', (req, res) => {
  const span = tracer.startSpan('process-refund');
  const txn = transactions.find(t => t.transactionId === req.params.transactionId);
  if (!txn) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Transaction not found' });
    span.end();
    return res.status(404).json({ error: 'Transaction not found' });
  }
  if (txn.status === 'refunded') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Already refunded' });
    span.end();
    return res.status(400).json({ error: 'Transaction already refunded' });
  }
  txn.status = 'refunded';
  txn.refundedAt = new Date().toISOString();
  transactionCounter.add(1, { card_type: txn.cardType, currency: txn.currency, status: 'refunded' });
  span.setAttribute('payment.transaction_id', txn.transactionId);
  span.setAttribute('payment.refund_amount', txn.amount);
  log('info', 'Payment refunded', { transactionId: txn.transactionId, amount: txn.amount });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  res.json({ message: 'Refunded', transaction: txn });
});

// POST /api/simulate-payments
app.post('/api/simulate-payments', (req, res) => {
  const span = tracer.startSpan('simulate-payments');
  const count = req.body.count || 10;
  const customers = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank'];
  for (let i = 0; i < count; i++) {
    const customer = customers[Math.floor(Math.random() * customers.length)];
    const amount = Math.round(Math.random() * 500 + 5);
    const isVisa = Math.random() > 0.5;
    const txn = {
      transactionId: uuidv4(),
      customer, amount, currency: 'USD',
      cardType: isVisa ? 'visa' : 'mastercard',
      cardLast4: '0000', status: 'completed',
      loyaltyLevel: ['platinum', 'gold', 'silver', 'bronze'][Math.floor(Math.random() * 4)],
      createdAt: new Date().toISOString(),
    };
    transactions.push(txn);
    transactionCounter.add(1, { card_type: txn.cardType, currency: 'USD', status: 'completed' });
    paymentAmountHistogram.record(amount, { card_type: txn.cardType, currency: 'USD' });
    log('info', 'Simulated payment', { transactionId: txn.transactionId, customer, amount });
  }
  span.setAttribute('simulate.count', count);
  span.end();
  res.json({ message: `Created ${count} simulated payments`, total: transactions.length });
});

app.listen(PORT, '0.0.0.0', () => {
  log('info', `Payment Service running on port ${PORT}`);
});
