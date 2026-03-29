const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

app.use(cors());
app.use(express.json());

function stripeRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path: path,
      method: 'GET',
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Erro ao parsear resposta do Stripe')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function stripeListAll(endpoint, params = {}) {
  let all = [];
  let hasMore = true;
  let startingAfter = null;
  while (hasMore) {
    const queryParams = new URLSearchParams({ limit: '100', ...params });
    if (startingAfter) queryParams.set('starting_after', startingAfter);
    const result = await stripeRequest(`/v1/${endpoint}?${queryParams}`);
    if (result.error) throw new Error(result.error.message);
    all = all.concat(result.data);
    hasMore = result.has_more;
    if (hasMore) startingAfter = result.data[result.data.length - 1].id;
  }
  return all;
}

function getMesAtual() {
  const agora = new Date();
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const fim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59);
  return {
    inicio: Math.floor(inicio.getTime() / 1000),
    fim: Math.floor(fim.getTime() / 1000),
  };
}

app.get('/api/stripe/mrr', async (req, res) => {
  try {
    const subscriptions = await stripeListAll('subscriptions', { status: 'active' });
    let mrr = 0;
    for (const sub of subscriptions) {
      for (const item of sub.items.data) {
        const price = item.price;
        if (!price || !price.recurring) continue;
        let amount = (price.unit_amount || 0) / 100;
        const interval = price.recurring.interval;
        const count = price.recurring.interval_count || 1;
        if (interval === 'year') amount = (amount / 12) / count;
        else if (interval === 'week') amount = (amount * 4.33) / count;
        else if (interval === 'month') amount = amount / count;
        mrr += amount * (item.quantity || 1);
      }
    }
    res.json({ mrr: parseFloat(mrr.toFixed(2)), count: subscriptions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/invoices/paid', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();
    const invoices = await stripeListAll('invoices', {
      status: 'paid',
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const total = invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0) / 100;
    res.json({ total: parseFloat(total.toFixed(2)), count: invoices.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/invoices/open', async (req, res) => {
  try {
    const invoices = await stripeListAll('invoices', { status: 'open' });
    const total = invoices.reduce((sum, inv) => sum + (inv.amount_due || 0), 0) / 100;
    res.json({ total: parseFloat(total.toFixed(2)), count: invoices.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/refunds', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();
    const refunds = await stripeListAll('refunds', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const total = refunds.reduce((sum, r) => sum + (r.amount || 0), 0) / 100;
    res.json({ total: parseFloat(total.toFixed(2)), count: refunds.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/churn', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();

    // Stripe não suporta filtro por canceled_at — busca tudo e filtra manualmente
    const canceled = await stripeListAll('subscriptions', {
      status: 'canceled',
    });

    const doMes = canceled.filter((sub) => {
      const canceledAt = sub.canceled_at || sub.ended_at || 0;
      return canceledAt >= inicio && canceledAt <= fim;
    });

    res.json({ count: doMes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stripe/mrr-history', async (req, res) => {
  try {
    const history = [];
    const agora = new Date();
    for (let i = 5; i >= 0; i--) {
      const data = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      const mes = data.toLocaleString('pt-BR', { month: 'short', year: '2-digit' });
      const fim = new Date(agora.getFullYear(), agora.getMonth() - i + 1, 0, 23, 59, 59);
      const invoices = await stripeListAll('invoices', {
        status: 'paid',
        'created[gte]': String(Math.floor(data.getTime() / 1000)),
        'created[lte]': String(Math.floor(fim.getTime() / 1000)),
      });
      const total = invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0) / 100;
      history.push({ mes, total: parseFloat(total.toFixed(2)) });
    }
    res.json({ history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', keyConfigured: !!STRIPE_SECRET_KEY });
});

app.get('/api/stripe/volume-bruto', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });

    // Calcular período anterior para comparação
    const agora = new Date();
    const inicioMesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    const fimMesAnterior = new Date(agora.getFullYear(), agora.getMonth(), 0, 23, 59, 59);
    const chargesAnterior = await stripeListAll('charges', {
      'created[gte]': String(Math.floor(inicioMesAnterior.getTime() / 1000)),
      'created[lte]': String(Math.floor(fimMesAnterior.getTime() / 1000)),
    });

    const periodoAnterior = chargesAnterior
      .filter(c => c.status === 'succeeded')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    const concluido = charges
      .filter(c => c.status === 'succeeded' && !c.amount_refunded)
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    const nao_capturado = charges
      .filter(c => c.captured === false)
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    const reembolsado = charges
      .filter(c => c.amount_refunded > 0)
      .reduce((sum, c) => sum + (c.amount_refunded || 0), 0) / 100;

    const bloqueado = charges
      .filter(c => c.status === 'succeeded' && c.outcome?.type === 'blocked')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    const malsucedido = charges
      .filter(c => c.status === 'failed')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    const bruto = concluido + nao_capturado + bloqueado + malsucedido;

    res.json({
      bruto: parseFloat(bruto.toFixed(2)),
      concluido: parseFloat(concluido.toFixed(2)),
      nao_capturado: parseFloat(nao_capturado.toFixed(2)),
      reembolsado: parseFloat(reembolsado.toFixed(2)),
      bloqueado: parseFloat(bloqueado.toFixed(2)),
      malsucedido: parseFloat(malsucedido.toFixed(2)),
      periodo_anterior: parseFloat(periodoAnterior.toFixed(2)),
      taxas: 0,
      liquido: parseFloat(bruto.toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stripe/pagamentos', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const pagamentos = charges.map(c => {
      const match = c.description?.match(/Auto-Recharge for Sub-Account - (.+?) (?:of BRL|\d)/);
      const subconta = match ? match[1].trim() : '';
      return {
        id: c.id,
        valor: (c.amount || 0) / 100,
        status: c.status,
        email: c.billing_details?.email || 'N/A',
        descricao: c.description || '',
        subconta,
        tipo: c.invoice ? 'assinatura' : 'variavel',
        data: new Date(c.created * 1000).toLocaleDateString('pt-BR'),
        capturado: c.captured,
      };
    });
    res.json({ pagamentos, total: pagamentos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/pagamentos/falhas', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const falhas = charges
      .filter(c => c.status === 'failed')
      .map(c => ({
        id: c.id,
        valor: (c.amount || 0) / 100,
        email: c.billing_details?.email || 'N/A',
        motivo: c.failure_message || c.failure_code || 'Desconhecido',
        data: new Date(c.created * 1000).toLocaleDateString('pt-BR'),
        subconta: c.metadata?.subaccount || c.metadata?.location_name || '',
      }));
    res.json({ falhas, total: falhas.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/clientes/top', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const porCliente = {};
    for (const c of charges.filter(ch => ch.status === 'succeeded')) {
      const email = c.billing_details?.email || c.customer || 'desconhecido';
      const nome = c.billing_details?.name || email;
      if (!porCliente[email]) porCliente[email] = { email, nome, total: 0, count: 0 };
      porCliente[email].total += (c.amount || 0) / 100;
      porCliente[email].count += 1;
    }
    const top = Object.values(porCliente)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
    res.json({ clientes: top });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/divisao-receita', async (req, res) => {
  try {
    const { inicio, fim } = getMesAtual();

    // Buscar charges do mês
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });

    const succeeded = charges.filter(c => c.status === 'succeeded');

    const assinaturas = succeeded
      .filter(c => c.invoice)
      .reduce((sum, c) => sum + (c.amount || 0) / 100, 0);

    const variaveis = succeeded
      .filter(c => !c.invoice)
      .reduce((sum, c) => sum + (c.amount || 0) / 100, 0);

    const bruto = assinaturas + variaveis;

    // Buscar taxas reais via balance_transactions
    const balanceTxs = await stripeListAll('balance_transactions', {
      type: 'charge',
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const taxas = balanceTxs.reduce((sum, tx) => sum + (tx.fee || 0), 0) / 100;

    // Agregar subcontas via regex na descrição
    const subcontasMap = {};
    for (const c of succeeded) {
      const match = c.description?.match(/Auto-Recharge for Sub-Account - (.+?) (?:of BRL|\d)/);
      const nome = match ? match[1].trim() : null;
      if (!nome) continue;
      if (!subcontasMap[nome]) subcontasMap[nome] = { nome, total: 0, count: 0 };
      subcontasMap[nome].total += (c.amount || 0) / 100;
      subcontasMap[nome].count += 1;
    }
    const subcontas = Object.values(subcontasMap)
      .sort((a, b) => b.total - a.total)
      .map(s => ({ nome: s.nome, total: parseFloat(s.total.toFixed(2)), count: s.count }));

    res.json({
      bruto: parseFloat(bruto.toFixed(2)),
      assinaturas: parseFloat(assinaturas.toFixed(2)),
      variaveis: parseFloat(variaveis.toFixed(2)),
      taxas: parseFloat(taxas.toFixed(2)),
      liquido: parseFloat((bruto - taxas).toFixed(2)),
      subcontas,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/assinaturas/recentes', async (req, res) => {
  try {
    const subs = await stripeListAll('subscriptions', {
      status: 'all',
      limit: '10',
    });

    const recentes = subs.slice(0, 10).map(sub => {
      const item = sub.items?.data?.[0];
      const price = item?.price;
      const product = price?.product;
      return {
        id: sub.id,
        cliente_email: sub.customer?.email || sub.metadata?.email || 'N/A',
        cliente_nome: sub.customer?.name || sub.metadata?.name || 'N/A',
        plano: price?.nickname || (typeof product === 'object' ? product?.name : null) || 'N/A',
        valor: price?.unit_amount ? price.unit_amount / 100 : 0,
        intervalo: price?.recurring?.interval || 'N/A',
        status: sub.status,
        data_criacao: new Date(sub.created * 1000).toLocaleDateString('pt-BR'),
      };
    });

    res.json({ assinaturas: recentes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`Stripe API backend rodando na porta ${PORT}`);
});
