const express = require('express');
const cors = require('cors');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const app = express();
const PORT = process.env.PORT || 3000;
const tracer = trace.getTracer('orders-api');
const meter = metrics.getMeter('orders-api');
const otelLogger = logs.getLogger('orders-api');

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
const orderCounter = meter.createCounter('orders_total', { description: 'Total orders created' });
const orderValueHistogram = meter.createHistogram('order_value_dollars', { description: 'Order values in dollars' });
const activeOrders = meter.createUpDownCounter('active_orders', { description: 'Currently active orders' });

app.use(cors());
app.use(express.json());

// In-memory store
const orders = [];
let nextId = 1;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime(), orders: orders.length });
});

// GET all orders
app.get('/api/orders', (req, res) => {
  const span = tracer.startSpan('list-orders');
  span.setAttribute('orders.count', orders.length);
  span.end();
  res.json(orders);
});

// POST create order
app.post('/api/orders', (req, res) => {
  const span = tracer.startSpan('create-order');
  try {
    const { customer, items, total } = req.body;
    if (!customer || !items) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Missing fields' });
      span.end();
      return res.status(400).json({ error: 'customer and items required' });
    }
    const order = {
      id: nextId++,
      customer,
      items,
      total: total || Math.round(Math.random() * 500 + 10),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    orders.push(order);

    orderCounter.add(1, { customer: order.customer, status: 'pending' });
    orderValueHistogram.record(order.total, { customer: order.customer });
    activeOrders.add(1);

    span.setAttribute('order.id', order.id);
    span.setAttribute('order.customer', order.customer);
    span.setAttribute('order.total', order.total);
    span.setStatus({ code: SpanStatusCode.OK });
    log('info', 'Order created', { orderId: order.id, customer: order.customer, total: order.total });
    span.end();
    res.status(201).json(order);
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.recordException(err);
    log('error', 'Order creation failed', { error: err.message });
    span.end();
    res.status(500).json({ error: err.message });
  }
});

// PUT update order status
app.put('/api/orders/:id', (req, res) => {
  const span = tracer.startSpan('update-order');
  const order = orders.find(o => o.id === parseInt(req.params.id));
  if (!order) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Not found' });
    span.end();
    return res.status(404).json({ error: 'Order not found' });
  }
  const oldStatus = order.status;
  order.status = req.body.status || order.status;
  if (order.status === 'completed' && oldStatus !== 'completed') activeOrders.add(-1);
  span.setAttribute('order.id', order.id);
  span.setAttribute('order.old_status', oldStatus);
  span.setAttribute('order.new_status', order.status);
  log('info', 'Order updated', { orderId: order.id, from: oldStatus, to: order.status });
  span.end();
  res.json(order);
});

// DELETE order
app.delete('/api/orders/:id', (req, res) => {
  const idx = orders.findIndex(o => o.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  const removed = orders.splice(idx, 1)[0];
  if (removed.status !== 'completed') activeOrders.add(-1);
  log('info', 'Order deleted', { orderId: removed.id });
  res.json({ message: 'Deleted', order: removed });
});

// Simulate traffic endpoint
app.post('/api/simulate', async (req, res) => {
  const span = tracer.startSpan('simulate-traffic');
  const customers = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];
  const items = ['Laptop', 'Phone', 'Tablet', 'Headphones', 'Monitor', 'Keyboard'];
  const count = req.body.count || 10;

  for (let i = 0; i < count; i++) {
    const customer = customers[Math.floor(Math.random() * customers.length)];
    const item = items[Math.floor(Math.random() * items.length)];
    const total = Math.round(Math.random() * 1000 + 10);
    const order = { id: nextId++, customer, items: [item], total, status: 'pending', createdAt: new Date().toISOString() };
    orders.push(order);
    orderCounter.add(1, { customer, status: 'pending' });
    orderValueHistogram.record(total, { customer });
    activeOrders.add(1);
    log('info', 'Simulated order', { orderId: order.id, customer, item, total });
  }
  span.setAttribute('simulate.count', count);
  span.end();
  res.json({ message: `Created ${count} simulated orders`, total: orders.length });
});

app.listen(PORT, '0.0.0.0', () => {
  log('info', `Orders API running on port ${PORT}`);
});
