const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();const PORT = process.env.PORT || 3001;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

app.use(cors());
app.use(express.json());

function stripeRequest(path){
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

function getPeriodo(req) {
  const agora = new Date();
  if (req.query.start && req.query.end) {
    return {
      inicio: parseInt(req.query.start),
      fim: parseInt(req.query.end),
    };
  }
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
    res.json({
      mrr: parseFloat(mrr.toFixed(2)),
      count: subscriptions.length,
      is_current: true,
      nota: 'MRR reflete assinaturas ativas hoje',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/invoices/paid', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
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
    const { inicio, fim } = getPeriodo(req);
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
    const { inicio, fim } = getPeriodo(req);

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
    const { inicio, fim } = getPeriodo(req);
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });

    // Calcular período anterior: exatamente 1 mês antes (não apenas subtrair dias)
    const inicioAnteriorDate = new Date(inicio * 1000);
    inicioAnteriorDate.setMonth(inicioAnteriorDate.getMonth() - 1);
    const fimAnteriorDate = new Date(fim * 1000);
    fimAnteriorDate.setMonth(fimAnteriorDate.getMonth() - 1);
    const inicioAnterior = Math.floor(inicioAnteriorDate.getTime() / 1000);
    const fimAnterior = Math.floor(fimAnteriorDate.getTime() / 1000);
    const chargesAnterior = await stripeListAll('charges', {
      'created[gte]': String(inicioAnterior),
      'created[lte]': String(fimAnterior),
    });

    const periodoAnterior = chargesAnterior
      .filter(c => c.status === 'succeeded')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    // Volume bruto = todos os succeeded (antes de descontar reembolsos)
    const bruto = charges
      .filter(c => c.status === 'succeeded')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    // Concluído = succeeded menos o que foi reembolsado
    const concluido = charges
      .filter(c => c.status === 'succeeded')
      .reduce((sum, c) => sum + (c.amount || 0) - (c.amount_refunded || 0), 0) / 100;

    // Não capturado = authorized mas captured=false (informativo, NÃO entra no bruto)
    const nao_capturado = charges
      .filter(c => c.captured === false && c.status !== 'failed')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    // Reembolsado = total devolvido
    const reembolsado = charges
      .filter(c => (c.amount_refunded || 0) > 0)
      .reduce((sum, c) => sum + (c.amount_refunded || 0), 0) / 100;

    // Bloqueado = bloqueado pelo Radar (informativo)
    const bloqueado = charges
      .filter(c => c.outcome?.type === 'blocked')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    // Malsucedido = failed (informativo, NÃO entra no bruto)
    const malsucedido = charges
      .filter(c => c.status === 'failed')
      .reduce((sum, c) => sum + (c.amount || 0), 0) / 100;

    // Buscar TODOS os balance_transactions do período (todos os tipos)
    const allBalanceTxns = await stripeListAll('balance_transactions', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    // liquido = soma do campo net (já desconta taxas, reembolsos, disputas, Connect)
    const liquido = allBalanceTxns
      .filter(bt => ['charge','refund','adjustment','dispute'].includes(bt.type))
      .reduce((sum, bt) => sum + (bt.net || 0), 0) / 100;
    // taxas reais = soma do campo fee das transações de charge
    const taxasReais = allBalanceTxns
      .filter(bt => bt.type === 'charge')
      .reduce((sum, bt) => sum + (bt.fee || 0), 0) / 100;
    res.json({
      bruto: parseFloat(bruto.toFixed(2)),
      concluido: parseFloat(concluido.toFixed(2)),
      nao_capturado: parseFloat(nao_capturado.toFixed(2)),
      reembolsado: parseFloat(reembolsado.toFixed(2)),
      bloqueado: parseFloat(bloqueado.toFixed(2)),
      malsucedido: parseFloat(malsucedido.toFixed(2)),
      periodo_anterior: parseFloat(periodoAnterior.toFixed(2)),
      taxas: parseFloat(taxasReais.toFixed(2)),
      liquido: parseFloat(liquido.toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stripe/pagamentos', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
      'expand[]': 'data.balance_transaction',
    });
    const pagamentos = charges.map(c => {
      const match = c.description?.match(/Auto-Recharge for Sub-Account - (.+?) (?:of BRL|\d)/);
      const subconta = match ? match[1].trim() : '';
      const valor = (c.amount || 0) / 100;
      const bt = c.balance_transaction && typeof c.balance_transaction === 'object' ? c.balance_transaction : null;
      const valor_liquido = bt ? parseFloat(((bt.net || 0) / 100).toFixed(2)) : null;
      const taxa = bt ? parseFloat(((bt.fee || 0) / 100).toFixed(2)) : null;
      const pm = c.payment_method_details;
      const metodo = pm?.type === 'card' ? 'cartao' : (pm?.type || 'outro');
      const parcelas = pm?.card?.installments?.plan?.count || 1;
      const dataStr = new Date(c.created * 1000).toISOString().substring(0, 10);
      return {
        id: c.id,
        valor,
        valor_liquido,
        taxa,
        status: c.status,
        nome: c.billing_details?.name || 'N/A',
        email: c.billing_details?.email || 'N/A',
        telefone: c.billing_details?.phone || null,
        metodo,
        parcelas,
        descricao: c.description || '',
        subconta,
        tipo: classifyTipo(c.description, valor, c.invoice ? 'recorrente' : metodo, 'stripe'),
        data: new Date(c.created * 1000).toLocaleDateString('pt-BR'),
        plataforma: 'stripe',
        previsao_recebimento: calcPrevisaoRecebimento(dataStr, metodo, parcelas, c.status, 'stripe'),
      };
    });
    res.json({ pagamentos, total: pagamentos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stripe/pagamentos/falhas', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
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
    const { inicio, fim } = getPeriodo(req);
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
    const { inicio, fim } = getPeriodo(req);

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
    // Expandir apenas data.customer (expand duplo nao suportado em lista pelo Stripe)
    const result = await stripeRequest('/v1/subscriptions?status=all&limit=10&expand[]=data.customer');
    const subs = result.data || [];

    // Coletar IDs de produto unicos para buscar nomes em paralelo
    const productIds = [...new Set(
      subs.map(s => s.items?.data?.[0]?.price?.product).filter(id => id && typeof id === 'string')
    )];
    const productMap = {};
    await Promise.all(productIds.slice(0, 15).map(async (pid) => {
      try {
        const prod = await stripeRequest('/v1/products/' + pid);
        if (prod.name) productMap[pid] = prod.name;
      } catch (e) {}
    }));

    // Mapa email -> nome da subconta GHL
    let ghlEmailMap = {};
    try {
      const ghlLocs = await ghlGetAllLocations();
      for (const loc of ghlLocs) {
        const em = (loc.email || '').toLowerCase().trim();
        if (em) ghlEmailMap[em] = loc.name || loc.nome || null;
      }
    } catch (e) {}

    const recentes = subs.slice(0, 10).map(sub => {
      const item = sub.items?.data?.[0];
      const price = item?.price;
      const productId = typeof price?.product === 'string' ? price.product : price?.product?.id;
      const productName = productMap[productId] || null;
      const cust = typeof sub.customer === 'object' ? sub.customer : null;
      const email = cust?.email || sub.metadata?.email || null;
      const ghlNome = email ? ghlEmailMap[email.toLowerCase()] : null;
      const planoNome = price?.nickname || productName || 'N/A';
      const valor = price?.unit_amount ? price.unit_amount / 100 : 0;
      return {
        id: sub.id,
        cliente_email: email || 'N/A',
        cliente_nome: ghlNome || cust?.name || email || 'N/A',
        plano: planoNome,
        produto_id: productId || null,
        categoria: classifyAssinatura(planoNome, valor),
        valor,
        moeda: (price?.currency || 'brl').toUpperCase(),
        intervalo: price?.recurring?.interval === 'month' ? 'Mensal'
          : price?.recurring?.interval === 'year' ? 'Anual' : (price?.recurring?.interval || 'N/A'),
        status: sub.status,
        data_criacao: new Date(sub.created * 1000).toLocaleDateString('pt-BR'),
      };
    });

    res.json({ assinaturas: recentes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/stripe/saldo
app.get('/api/stripe/saldo', async (req, res) => {
  try {
    const balance = await stripeRequest('/v1/balance');
    const disponivel = (balance.available || []).reduce((sum, b) => sum + b.amount, 0) / 100;
    const pendente = (balance.pending || []).reduce((sum, b) => sum + b.amount, 0) / 100;
    res.json({ disponivel: parseFloat(disponivel.toFixed(2)), pendente: parseFloat(pendente.toFixed(2)), total: parseFloat((disponivel + pendente).toFixed(2)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stripe/repasses
// GET /api/stripe/repasses
app.get('/api/stripe/repasses', async (req, res) => {
  try {
    let params = {};
    if (req.query.start && req.query.end) {
      params['created[gte]'] = req.query.start;
      params['created[lte]'] = req.query.end;
    } else {
      const noventa = Math.floor(Date.now() / 1000) - (90 * 86400);
      params['created[gte]'] = String(noventa);
    }
    const payouts = await stripeListAll('payouts', params);
    const realizados = payouts
      .filter(p => p.status === 'paid')
      .map(p => ({
        id: p.id,
        valor: p.amount / 100,
        data_chegada: new Date(p.arrival_date * 1000).toLocaleDateString('pt-BR'),
        status: p.status,
        descricao: p.description || 'Repasse automático'
      }));
    const pendentes = payouts
      .filter(p => ['pending', 'in_transit'].includes(p.status))
      .map(p => ({
        id: p.id,
        valor: p.amount / 100,
        data_chegada_prevista: new Date(p.arrival_date * 1000).toLocaleDateString('pt-BR'),
        status: p.status
      }));
    const total_realizado = realizados.reduce((sum, p) => sum + p.valor, 0);
    const total_pendente = pendentes.reduce((sum, p) => sum + p.valor, 0);
    res.json({
      realizados,
      pendentes,
      total_realizado: parseFloat(total_realizado.toFixed(2)),
      total_pendente: parseFloat(total_pendente.toFixed(2))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stripe/payouts-total — total de repasses que chegaram ao banco no periodo
app.get('/api/stripe/payouts-total', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
    const payouts = await stripeListAll('payouts', {
      'arrival_date[gte]': String(inicio),
      'arrival_date[lte]': String(fim),
    });
    const pagos = payouts.filter(p => p.status === 'paid');
    const total = pagos.reduce((sum, p) => sum + (p.amount || 0), 0) / 100;
    res.json({ total: parseFloat(total.toFixed(2)), count: pagos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stripe/repasses/projecao
app.get('/api/stripe/repasses/projecao', async (req, res) => {
  try {
    const btxns = await stripeListAll('balance_transactions', { type: 'charge' });
    const pending = btxns.filter(t => t.status === 'pending');
    const a_receber_total = pending.reduce((sum, t) => sum + t.net, 0) / 100;

    // Group by week of projected payout date (created + 15 days)
    const weekMap = {};
    pending.forEach(t => {
      const payoutDate = new Date((t.created + 15 * 86400) * 1000);
      // Get start of week (Monday)
      const day = payoutDate.getDay();
      const diff = (day === 0 ? -6 : 1 - day);
      const weekStart = new Date(payoutDate);
      weekStart.setDate(payoutDate.getDate() + diff);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      const fmt = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      const key = 'Semana de ' + fmt(weekStart) + ' a ' + fmt(weekEnd);
      if (!weekMap[key]) weekMap[key] = { semana: key, valor_previsto: 0, quantidade: 0, _sort: weekStart.getTime() };
      weekMap[key].valor_previsto += t.net / 100;
      weekMap[key].quantidade += 1;
    });

    const projecao = Object.values(weekMap)
      .sort((a, b) => a._sort - b._sort)
      .map(({ _sort, ...rest }) => ({ ...rest, valor_previsto: parseFloat(rest.valor_previsto.toFixed(2)) }));

    // Next payout = earliest week
    let proximo_repasse = { data_prevista: 'N/A', valor: 0 };
    if (projecao.length > 0) {
      proximo_repasse = {
        data_prevista: projecao[0].semana,
        valor: projecao[0].valor_previsto
      };
    }

    res.json({
      a_receber_total: parseFloat(a_receber_total.toFixed(2)),
      projecao,
      proximo_repasse
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stripe/clientes/novos
app.get('/api/stripe/clientes/novos', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
    const clientes = await stripeListAll('customers', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    res.json({
      total: clientes.length,
      clientes: clientes.map(c => ({
        id: c.id,
        email: c.email || 'N/A',
        nome: c.name || c.email || 'N/A',
        data_criacao: new Date(c.created * 1000).toLocaleDateString('pt-BR')
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PAGBANK INTEGRATION (PagSeguro Legacy API v3 — XML)
// ============================================================

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || '';
const PAGBANK_EMAIL = process.env.PAGBANK_EMAIL || '';

function xmlVal(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\/' + tag + '>'));
  return m ? m[1].trim() : '';
}

function xmlAll(xml, tag) {
  const results = [];
  const re = new RegExp('<' + tag + '(?![a-zA-Z])[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'g');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}


// Classifica o tipo de transação PagBank com base na descrição e valor
// Classifica assinaturas Stripe em planos/categorias — prioridade: nome → valor
function classifyAssinatura(nome, valor) {
  const n = (nome || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Variaveis por nome: whatsapp, api, sms, ramal, uso, adicional, nao oficial, chatbot
  if (/whatsapp|(\bapi\b)|\bapi\s|\bsms\b|ramal|\buso\b|adicional|extra|variav|nao oficial|chatbot|zap|waba/.test(n)) return 'variavel';
  // Plano Avancado por nome
  if (/avancado|advanced|premium|\bpro\b|enterprise|elite/.test(n)) return 'avancado';
  // Plano Scale / Automatiza por nome
  if (/\bscale\b|automatiza|escala/.test(n)) return 'scale';
  // Plano Basico por nome
  if (/\bbasic|\bbasico/.test(n)) return 'basico';
  // Fallback por valor (criterio apenas Stripe)
  if (valor < 300)  return 'variavel';  // abaixo de R$300
  if (valor < 600)  return 'basico';    // R$300 - R$599
  if (valor < 1000) return 'scale';     // R$600 - R$999
  return 'avancado';                    // R$1000+
}

function classifyTipo(descricao, valor, metodo, plataforma) {
  // 'recorrente' só é assinatura no Stripe; no PagBank type 11 é apenas método de pagamento
  if (metodo === 'recorrente' && plataforma !== 'pagbank') return 'assinatura';
  const desc = (descricao || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (desc.includes('implementa')) {
    if (desc.includes('avancada') || valor > 5000) return 'implementacao_avancada';
    if (desc.includes('personalizada') || (valor >= 2500 && valor <= 5000)) return 'implementacao_personalizada';
    if (desc.includes('basica') || valor < 2500) return 'implementacao_basica';
    return 'implementacao';
  }
  // PagBank: todos sao implementacoes — classificar por valor
  if (plataforma === 'pagbank') {
    if (valor > 5000) return 'implementacao_avancada';
    if (valor >= 2500) return 'implementacao_personalizada';
    return 'implementacao_basica';
  }
  return 'variavel';
}

function pagbankLegacyRequest(path, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const params = { email: PAGBANK_EMAIL, token: PAGBANK_TOKEN, ...queryParams };
    const qs = new URLSearchParams(params).toString();
    const options = {
      hostname: 'ws.pagseguro.uol.com.br',
      path: path + '?' + qs,
      method: 'GET',
      headers: { 'Accept': 'application/xml;charset=ISO-8859-1' },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ _body: Buffer.concat(chunks).toString('latin1'), _status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getPeriodoPagbank(req) {
  const agora = new Date();
  let inicio, fim;
  if (req.query.start && req.query.end) {
    inicio = new Date(parseInt(req.query.start) * 1000);
    fim = new Date(parseInt(req.query.end) * 1000);
  } else {
    const brtNow = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
    inicio = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), 1, 3, 0, 0));
    fim = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth() + 1, 1, 2, 59, 59));
  }
  // PagSeguro usa BRT (UTC-3). Servidor roda em UTC.
  // Converter para BRT subtraindo 3h, e limitar fim ao agora em BRT
  const toPS = (d) => {
    const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000); // UTC -> BRT
    const pad = (n) => String(n).padStart(2, '0');
    return brt.getFullYear() + '-' + pad(brt.getMonth()+1) + '-' + pad(brt.getDate()) + 'T' + pad(brt.getHours()) + ':' + pad(brt.getMinutes());
  };
  // Limitar fim ao agora (em BRT) para evitar erro 13009
  const agoraBRT = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  if (new Date(fim.getTime() - 3 * 60 * 60 * 1000) > agoraBRT) {
    fim = new Date(agora.getTime() - 2 * 60 * 1000); // agora menos 2 min de margem
  }
  return { inicio: toPS(inicio), fim: toPS(fim), inicioDate: inicio, fimDate: fim };
}

// Cache em memória: referencia -> nome do link (evita chamadas repetidas)
const linkNomeCache = {};
const parcelasCache = {};
const senderCache = {}; // txCode -> { nome, email, telefone }

// Busca o nome real do link de pagamento PagSeguro pelo código de referência
// Endpoint: GET /v2/payment-requests/{code}
async function fetchLinkNome(referencia, txCode) {
  if (!referencia || linkNomeCache[referencia] !== undefined) {
    return linkNomeCache[referencia] || null;
  }
  if (!txCode) { linkNomeCache[referencia] = null; return null; }
  try {
    const result = await pagbankLegacyRequest('/v3/transactions/' + txCode);
    console.log('[fetchLinkNome] ref:', referencia, 'status:', result._status, 'body:', result._body.substring(0, 300));
    if (result._status === 200 && result._body.includes('<transaction>')) {
      const itemMatch = result._body.match(/<item[^>]*>([\s\S]*?)<\/item>/);
      const nome = itemMatch ? xmlVal(itemMatch[1], 'description') || null : null;
      linkNomeCache[referencia] = nome;
      if (txCode) {
        parcelasCache[txCode] = parseInt(xmlVal(result._body, 'installmentCount') || '0') || null;
        const senderXml = result._body.match(/<sender[^>]*>([\s\S]*?)<\/sender>/);
        if (senderXml) {
          const phoneXml = senderXml[1].match(/<phone[^>]*>([\s\S]*?)<\/phone>/);
          const ac = phoneXml ? xmlVal(phoneXml[1], 'areaCode') : '';
          const pn = phoneXml ? xmlVal(phoneXml[1], 'number') : '';
          senderCache[txCode] = {
            nome: xmlVal(senderXml[1], 'name') || null,
            email: xmlVal(senderXml[1], 'email') || null,
            telefone: ac && pn ? `(${ac}) ${pn}` : null,
          };
        }
      }
      return nome;
    }
  } catch (e) { console.error('[fetchLinkNome] erro:', e.message); }
  linkNomeCache[referencia] = null;
  return null;
}

function parseTx(txXml) {
  const pmMatch = txXml.match(/<paymentMethod[^>]*>([\s\S]*?)<\/paymentMethod>/);
  const pmType = pmMatch ? xmlVal(pmMatch[1], 'type') : '';
  const methodMap = { '1': 'cartao', '2': 'boleto', '3': 'debito', '4': 'saldo', '7': 'pix', '11': 'recorrente' };
  const statusMap = { '1': 'aguardando', '2': 'em_analise', '3': 'pago', '4': 'disponivel', '5': 'em_disputa', '6': 'devolvido', '7': 'cancelado', '8': 'chargeback', '9': 'retencao' };
  const senderMatch = txXml.match(/<sender[^>]*>([\s\S]*?)<\/sender>/);
  const itemMatch = txXml.match(/<item[^>]*>([\s\S]*?)<\/item>/);
  const phoneMatch = senderMatch ? senderMatch[1].match(/<phone[^>]*>([\s\S]*?)<\/phone>/) : null;
  const areaCode = phoneMatch ? xmlVal(phoneMatch[1], 'areaCode') : '';
  const phoneNum = phoneMatch ? xmlVal(phoneMatch[1], 'number') : '';
  return {
    id: xmlVal(txXml, 'code'),
    bruto: parseFloat(xmlVal(txXml, 'grossAmount') || '0'),
    liquido: parseFloat(xmlVal(txXml, 'netAmount') || '0'),
    taxa: parseFloat(xmlVal(txXml, 'feeAmount') || '0'),
    status: statusMap[xmlVal(txXml, 'status')] || xmlVal(txXml, 'status'),
    metodo: methodMap[pmType] || 'outro',
    parcelas: parseInt(xmlVal(txXml, 'installmentCount') || '1'),
    nome: senderMatch ? xmlVal(senderMatch[1], 'name') : 'N/A',
    email: senderMatch ? xmlVal(senderMatch[1], 'email') : 'N/A',
    telefone: areaCode && phoneNum ? `(${areaCode}) ${phoneNum}` : null,
    data: xmlVal(txXml, 'date').substring(0, 10),
    referencia: xmlVal(txXml, 'reference') || null,
    link_pagamento: itemMatch ? xmlVal(itemMatch[1], 'description') || null : null,
    plataforma: 'pagbank',
  };
}

function calcPrevisaoRecebimento(dataStr, metodo, parcelas, status, plataforma) {
  if (!dataStr || ['cancelado', 'devolvido', 'chargeback'].includes(status)) return null;
  const addBizDays = (date, days) => {
    const r = new Date(date.getTime());
    let added = 0;
    while (added < days) {
      r.setUTCDate(r.getUTCDate() + 1);
      const d = r.getUTCDay();
      if (d !== 0 && d !== 6) added++;
    }
    return r;
  };
  const txDate = new Date(dataStr + 'T03:00:00Z');
  let targetDate;
  if (plataforma === 'stripe') {
    // Stripe Brazil: D+2 dias uteis
    targetDate = addBizDays(txDate, 2);
  } else if (metodo === 'pix') {
    // PagBank PIX Link: D+1 dia corrido
    targetDate = new Date(txDate.getTime() + 1 * 24 * 60 * 60 * 1000);
  } else if (metodo === 'boleto') {
    // PagBank Boleto Link: D+1 dia util
    targetDate = addBizDays(txDate, 1);
  } else if (metodo === 'debito') {
    // PagBank Debito online: D+1 dia util
    targetDate = addBizDays(txDate, 1);
  } else {
    // PagBank Cartao credito Link de Pagamento: D+14 dias corridos
    targetDate = new Date(txDate.getTime() + 14 * 24 * 60 * 60 * 1000);
  }
  const now = new Date();
  const brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const todayMs = Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate());
  const diffDays = Math.ceil((targetDate.getTime() - todayMs) / 86400000);
  return {
    data_prevista: targetDate.toISOString().substring(0, 10),
    dias_restantes: Math.max(0, diffDays),
    ja_disponivel: diffDays <= 0,
  };
}

async function pagbankListAllTx(initialDate, finalDate) {
  // PagBank Legacy API max range: 30 dias. Divide em chunks para periodos maiores.
  const toPS = (d) => { const pad = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const startD = new Date(initialDate + ':00');
  const endD   = new Date(finalDate   + ':00');
  const MAX_MS  = 29 * 24 * 60 * 60 * 1000; // 29 dias para margem de seguranca
  let all = [];
  let chunkStart = new Date(startD);
  while (chunkStart < endD) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + MAX_MS, endD.getTime()));
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const result = await pagbankLegacyRequest('/v3/transactions', {
        initialDate: toPS(chunkStart), finalDate: toPS(chunkEnd), maxPageResults: 100, page,
      });
      const xml = result._body;
      if (!xml.includes('<transactionSearchResult>')) {
        console.error('[pagbankListAllTx] API error (' + result._status + '):', xml.substring(0, 200));
        break;
      }
      const txXmls = xmlAll(xml, 'transaction');
      all = all.concat(txXmls.map(parseTx));
      const tp = parseInt(xmlVal(xml, 'totalPages') || '1');
      totalPages = tp > 0 ? tp : 1;
      page++;
    }
    chunkStart = new Date(chunkEnd.getTime() + 60 * 1000);
  }
  return all;
}

// GET /api/pagbank/saldo — Legacy API (ws.pagseguro.uol.com.br)
app.get('/api/pagbank/saldo', async (req, res) => {
  try {
    const result = await pagbankLegacyRequest('/v2/balance');
    const xml = result._body;
    if (result._status === 200 && xml.includes('<balance>')) {
      const availableMatch = xml.match(/<available[^>]*>([\s\S]*?)<\/available>/);
      const releasingMatch = xml.match(/<releasing[^>]*>([\s\S]*?)<\/releasing>/);
      const disponivel = availableMatch ? parseFloat(xmlVal(availableMatch[1], 'value') || '0') : 0;
      const a_liberar = releasingMatch ? parseFloat(xmlVal(releasingMatch[1], 'value') || '0') : 0;
      res.json({
        disponivel: parseFloat(disponivel.toFixed(2)),
        a_liberar: parseFloat(a_liberar.toFixed(2)),
        total: parseFloat((disponivel + a_liberar).toFixed(2)),
        moeda: 'BRL'
      });
    } else {
      res.json({ disponivel: null, a_liberar: null, total: null, moeda: 'BRL', nota: 'Saldo indisponivel - status ' + result._status + ' - ' + xml.substring(0, 200) });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pagbank/volume// GET /api/pagbank/volume
app.get('/api/pagbank/volume', async (req, res) => {
  try {
    const { inicio, fim, inicioDate, fimDate } = getPeriodoPagbank(req);
    const txs = await pagbankListAllTx(inicio, fim);
    let pago = 0, pendente = 0, cancelado = 0, liquido = 0;
    let via_pix = 0, via_boleto = 0, via_cartao = 0, parcelado = 0;
    let a_receber = 0; // status 'pago'(3) = aprovado mas ainda nao liberado ao vendedor

    for (const tx of txs) {
      const isAprovado = ['pago', 'disponivel'].includes(tx.status);
      const isPendente = ['aguardando', 'em_analise'].includes(tx.status);
      const isCancelado = ['cancelado', 'devolvido', 'chargeback'].includes(tx.status);

      if (isAprovado) {
        pago += tx.bruto;
        liquido += tx.liquido;
        if (tx.status === 'pago') a_receber += tx.liquido; // aprovado mas nao creditado ainda
        if (tx.metodo === 'pix') via_pix += tx.bruto;
        else if (tx.metodo === 'boleto') via_boleto += tx.bruto;
        else if (tx.metodo === 'cartao' || tx.metodo === 'recorrente') {
          via_cartao += tx.bruto;
          if (tx.parcelas > 1) parcelado += tx.bruto;
        }
      } else if (isPendente) {
        pendente += tx.bruto;
      } else if (isCancelado) {
        cancelado += tx.bruto;
      }
    }

        const toPS = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    };
    const inicioAnterior = new Date(inicioDate); inicioAnterior.setMonth(inicioAnterior.getMonth() - 1);
    const fimAnterior = new Date(fimDate); fimAnterior.setMonth(fimAnterior.getMonth() - 1);
    const txsAnterior = await pagbankListAllTx(toPS(inicioAnterior), toPS(fimAnterior));
    let periodo_anterior = 0;
    for (const tx of txsAnterior) {
      if (['pago', 'disponivel'].includes(tx.status)) periodo_anterior += tx.bruto;
    }
    res.json({
      pago: parseFloat(pago.toFixed(2)),
      liquido: parseFloat(liquido.toFixed(2)),
      pendente: parseFloat(pendente.toFixed(2)),
      cancelado: parseFloat(cancelado.toFixed(2)),
      via_pix: parseFloat(via_pix.toFixed(2)),
      via_boleto: parseFloat(via_boleto.toFixed(2)),
      via_cartao: parseFloat(via_cartao.toFixed(2)),
      parcelado: parseFloat(parcelado.toFixed(2)),
      periodo_anterior: parseFloat(periodo_anterior.toFixed(2)),
      a_receber: parseFloat(a_receber.toFixed(2)),
      ja_liberado: parseFloat((liquido - a_receber).toFixed(2)),
      taxas: parseFloat((pago - liquido).toFixed(2)),
      total_transacoes: txs.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pagbank/transacoes
app.get('/api/pagbank/transacoes', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodoPagbank(req);
    const txs = await pagbankListAllTx(inicio, fim);
    txs.sort((a, b) => new Date(b.data) - new Date(a.data));

    // Enriquecer com nome real do link (busca em paralelo, com cache)
    const refToTxCode1 = {}; txs.forEach(tx => { if (tx.referencia && !refToTxCode1[tx.referencia]) refToTxCode1[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refToTxCode1).map(([ref, code]) => fetchLinkNome(ref, code)));

    const enriquecidas = txs.map(tx => {
      const parcelas = parcelasCache[tx.id] || tx.parcelas;
      const sender = senderCache[tx.id] || {};
      return {
        ...tx,
        nome: (sender.nome && sender.nome !== 'N/A') ? sender.nome : (tx.nome !== 'N/A' ? tx.nome : null),
        email: (sender.email && sender.email !== 'N/A') ? sender.email : (tx.email !== 'N/A' ? tx.email : null),
        telefone: sender.telefone || tx.telefone || null,
        link_pagamento: linkNomeCache[tx.referencia] || tx.link_pagamento,
        descricao: linkNomeCache[tx.referencia] || tx.link_pagamento || null,
        tipo: classifyTipo(linkNomeCache[tx.referencia] || tx.link_pagamento, tx.bruto, tx.metodo, 'pagbank'),
        parcelas,
        valor_liquido: tx.liquido, // alias para consistencia com Stripe
        previsao_recebimento: calcPrevisaoRecebimento(tx.data, tx.metodo, parcelas, tx.status, 'pagbank'),
      };
    });

    res.json({ transacoes: enriquecidas, total: enriquecidas.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pagbank/repasses/projecao — projeção de liberação de fundos PagBank por semana
// Prazos: PIX D+1, Boleto D+2, Cartão D+30
app.get('/api/pagbank/repasses/projecao', async (req, res) => {
  try {
    // Busca últimos 90 dias para pegar tudo "a liberar" (status pago = aprovado não liberado)
    const agora = new Date();
    const brt = (d) => new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const toPS = (d) => {
      const b = brt(d);
      return b.getFullYear() + '-' + pad(b.getMonth()+1) + '-' + pad(b.getDate()) + 'T' + pad(b.getHours()) + ':' + pad(b.getMinutes());
    };
    const inicio90 = new Date(agora.getTime() - 90 * 24 * 60 * 60 * 1000);
    const txs = await pagbankListAllTx(toPS(inicio90), toPS(new Date(agora.getTime() - 2 * 60 * 1000)));

    // Apenas transações aprovadas mas ainda não liberadas (status 'pago' = code 3)
    const pendentes = txs.filter(tx => tx.status === 'pago');

    // Prazo de liberação por método (dias corridos)
    const prazoMap = { pix: 1, boleto: 2, cartao: 30, recorrente: 30, debito: 1, saldo: 0, outro: 2 };

    const weekMap = {};
    let a_liberar_total = 0;

    pendentes.forEach(tx => {
      a_liberar_total += tx.liquido;
      const prazo = prazoMap[tx.metodo] ?? 2;
      const dataBase = new Date(tx.data + 'T12:00:00');
      const liberacao = new Date(dataBase.getTime() + prazo * 24 * 60 * 60 * 1000);

      // Início da semana (segunda-feira)
      const day = liberacao.getDay();
      const diff = (day === 0 ? -6 : 1 - day);
      const weekStart = new Date(liberacao);
      weekStart.setDate(liberacao.getDate() + diff);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      const fmt = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      const key = 'Semana de ' + fmt(weekStart) + ' a ' + fmt(weekEnd);
      if (!weekMap[key]) weekMap[key] = { semana: key, valor_previsto: 0, quantidade: 0, _sort: weekStart.getTime() };
      weekMap[key].valor_previsto += tx.liquido;
      weekMap[key].quantidade += 1;
    });

    const projecao = Object.values(weekMap)
      .sort((a, b) => a._sort - b._sort)
      .map(({ _sort, ...rest }) => ({ ...rest, valor_previsto: parseFloat(rest.valor_previsto.toFixed(2)) }));

    const proximo_repasse = projecao.length > 0
      ? { data_prevista: projecao[0].semana, valor: projecao[0].valor_previsto }
      : { data_prevista: 'N/A', valor: 0 };

    res.json({
      a_liberar_total: parseFloat(a_liberar_total.toFixed(2)),
      projecao,
      proximo_repasse,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pagamentos — pagamentos unificados Stripe + PagBank
app.get('/api/pagamentos', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
    const { inicio: inicioPB, fim: fimPB } = getPeriodoPagbank(req);

    const [charges, txsPagbank] = await Promise.all([
      stripeListAll('charges', {
        'created[gte]': String(inicio), 'created[lte]': String(fim),
        'expand[]': 'data.balance_transaction',
      }),
      pagbankListAllTx(inicioPB, fimPB),
    ]);

    const stripe = charges.map(c => {
      const match = c.description?.match(/Auto-Recharge for Sub-Account - (.+?) (?:of BRL|\d)/);
      const valor = (c.amount || 0) / 100;
      const bt = c.balance_transaction && typeof c.balance_transaction === 'object' ? c.balance_transaction : null;
      const valor_liquido = bt ? parseFloat(((bt.net || 0) / 100).toFixed(2)) : null;
      const taxa = bt ? parseFloat(((bt.fee || 0) / 100).toFixed(2)) : null;
      const pm = c.payment_method_details;
      const metodo = pm?.type === 'card' ? 'cartao' : (pm?.type || 'cartao');
      const parcelas = pm?.card?.installments?.plan?.count || 1;
      const dataStr = new Date(c.created * 1000).toISOString().substring(0, 10);
      const statusStr = c.status === 'succeeded' ? 'aprovado' : c.status === 'failed' ? 'falhou' : c.status;
      return {
        id: c.id,
        plataforma: 'stripe',
        valor,
        valor_liquido,
        taxa,
        nome: c.billing_details?.name || null,
        email: c.billing_details?.email || null,
        telefone: c.billing_details?.phone || null,
        status: statusStr,
        descricao: c.description || '',
        subconta: match ? match[1].trim() : '',
        tipo: classifyTipo(c.description, valor, c.invoice ? 'recorrente' : metodo, 'stripe'),
        metodo,
        parcelas,
        link_pagamento: null,
        referencia: null,
        data: new Date(c.created * 1000).toLocaleDateString('pt-BR'),
        data_sort: c.created,
        previsao_recebimento: calcPrevisaoRecebimento(dataStr, metodo, parcelas, statusStr, 'stripe'),
      };
    });

    // Enriquecer PagBank com nome real do link (cache compartilhado)
    const refToTxCode2 = {}; txsPagbank.forEach(tx => { if (tx.referencia && !refToTxCode2[tx.referencia]) refToTxCode2[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refToTxCode2).map(([ref, code2]) => fetchLinkNome(ref, code2)));

    const pagbank = txsPagbank.map(tx => {
      const nomeLink = linkNomeCache[tx.referencia] || tx.link_pagamento;
      const parcelas = parcelasCache[tx.id] || tx.parcelas;
      const statusStr = tx.status === 'disponivel' || tx.status === 'pago' ? 'aprovado' : tx.status === 'cancelado' || tx.status === 'devolvido' ? 'falhou' : tx.status;
      return {
        id: tx.id,
        plataforma: 'pagbank',
        valor: tx.bruto,
        valor_liquido: tx.liquido,
        taxa: tx.taxa,
        nome: (senderCache[tx.id]?.nome) || (tx.nome && tx.nome !== 'N/A' ? tx.nome : null),
        email: (senderCache[tx.id]?.email) || (tx.email && tx.email !== 'N/A' ? tx.email : null),
        telefone: (senderCache[tx.id]?.telefone) || tx.telefone || null,
        status: statusStr,
        descricao: nomeLink || tx.referencia || '',
        subconta: nomeLink || '',
        tipo: classifyTipo(nomeLink, tx.bruto, tx.metodo, 'pagbank'),
        metodo: tx.metodo,
        parcelas,
        link_pagamento: nomeLink,
        referencia: tx.referencia,
        data: tx.data,
        data_sort: new Date(tx.data + 'T12:00:00Z').getTime() / 1000,
        previsao_recebimento: calcPrevisaoRecebimento(tx.data, tx.metodo, parcelas, statusStr, 'pagbank'),
      };
    });

    const todos = [...stripe, ...pagbank].sort((a, b) => b.data_sort - a.data_sort);
    res.json({ pagamentos: todos, total: todos.length, stripe: stripe.length, pagbank: pagbank.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/projecao/recebimento — projecao unificada Stripe+PagBank por data de recebimento
app.get('/api/projecao/recebimento', async (req, res) => {
  try {
    // Busca os ultimos 90 dias para capturar todos os pagamentos pendentes de liquidacao
    const agora = new Date();
    const inicioUnix = Math.floor((agora.getTime() - 90 * 24 * 60 * 60 * 1000) / 1000);
    const fimUnix = Math.floor(agora.getTime() / 1000);
    const fakeReq = { query: { start: String(inicioUnix), end: String(fimUnix) } };

    const { inicio, fim } = getPeriodo(fakeReq);
    const { inicio: inicioPB, fim: fimPB } = getPeriodoPagbank(fakeReq);

    // Data de hoje em BRT (UTC-3) para filtrar somente datas futuras no grafico
    const brtNow = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
    const todayStr = brtNow.toISOString().substring(0, 10); // YYYY-MM-DD

    const [stripeBalance, charges, txsPagbank] = await Promise.all([
      // Balance API = fonte da verdade para stripe_pendente (total real a receber)
      stripeRequest('/v1/balance'),
      stripeListAll('charges', {
        'created[gte]': String(inicio), 'created[lte]': String(fim),
        'expand[]': 'data.balance_transaction',
      }),
      pagbankListAllTx(inicioPB, fimPB),
    ]);

    // stripe_pendente = saldo pending oficial da Stripe (bate com card "A liberar")
    const stripe_pendente = parseFloat(
      ((stripeBalance.pending || []).reduce((s, b) => s + b.amount, 0) / 100).toFixed(2)
    );

    // Enriquecer PagBank com senderCache e parcelasCache
    const refMap = {}; txsPagbank.forEach(tx => { if (tx.referencia && !refMap[tx.referencia]) refMap[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refMap).map(([ref, code2]) => fetchLinkNome(ref, code2)));

    // Acumular por data_prevista (somente datas futuras — hoje exclusive)
    const byDate = {};
    const addEntry = (date, stripe, pagbank) => {
      if (date <= todayStr) return; // ignorar datas de hoje ou passadas no grafico
      if (!byDate[date]) byDate[date] = { data: date, stripe: 0, pagbank: 0, total: 0 };
      byDate[date].stripe = parseFloat((byDate[date].stripe + stripe).toFixed(2));
      byDate[date].pagbank = parseFloat((byDate[date].pagbank + pagbank).toFixed(2));
      byDate[date].total = parseFloat((byDate[date].stripe + byDate[date].pagbank).toFixed(2));
    };

    // Stripe — bt.available_on como data exata; bt.status='pending' = nao liquidado ainda
    charges.forEach(c => {
      if (c.status !== 'succeeded') return;
      const bt = c.balance_transaction && typeof c.balance_transaction === 'object' ? c.balance_transaction : null;
      if (!bt || bt.status !== 'pending') return;
      const liquido = (bt.net || 0) / 100;
      const availableOn = new Date(bt.available_on * 1000).toISOString().substring(0, 10);
      addEntry(availableOn, liquido, 0);
    });

    // PagBank — status 'pago' = aprovado mas ainda nao creditado ao vendedor
    let pagbank_pendente_calc = 0;
    txsPagbank.forEach(tx => {
      if (tx.status !== 'pago') return;
      const parcelas = parcelasCache[tx.id] || tx.parcelas;
      const prev = calcPrevisaoRecebimento(tx.data, tx.metodo, parcelas, 'aprovado', 'pagbank');
      const valor = tx.liquido || tx.bruto;
      pagbank_pendente_calc += valor;
      if (prev) addEntry(prev.data_prevista, 0, valor);
    });
    const pagbank_pendente = parseFloat(pagbank_pendente_calc.toFixed(2));

    // Ordenar por data e formatar para o frontend
    const projecao = Object.values(byDate)
      .sort((a, b) => a.data.localeCompare(b.data))
      .map(d => ({
        ...d,
        data_br: d.data.split('-').reverse().join('/'), // DD/MM/YYYY
      }));

    res.json({
      projecao,
      // Totais usam fontes oficiais (Balance API Stripe + status PagBank)
      // garantindo coerencia com os cards de "A liberar" em toda plataforma
      stripe_pendente,
      pagbank_pendente,
      total_pendente: parseFloat((stripe_pendente + pagbank_pendente).toFixed(2)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pagbank/debug — remover após testes
app.get('/api/pagbank/debug', async (req, res) => {
  try {
    // Test Connect API balance
    const balanceResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.pagseguro.com',
        path: '/accounts/balance',
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + PAGBANK_TOKEN, 'Accept': 'application/json' },
      };
      const req = https.request(options, (r) => {
        let data = '';
        r.on('data', (chunk) => (data += chunk));
        r.on('end', () => resolve({ _body: data, _status: r.statusCode }));
      });

// GET /api/pagbank/raw-tx — debug: retorna XML bruto para verificar campos
app.get('/api/pagbank/raw-tx', async (req, res) => {
  try {
    const agora = new Date();
    const brt = (d) => new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const toPS = (d) => { const b = brt(d); return b.getFullYear() + '-' + pad(b.getMonth()+1) + '-' + pad(b.getDate()) + 'T' + pad(b.getHours()) + ':' + pad(b.getMinutes()); };
    const fim = new Date(agora.getTime() - 2 * 60 * 1000);
    const inicio = new Date(agora.getTime() - 35 * 24 * 60 * 60 * 1000);
    const result = await pagbankLegacyRequest('/v3/transactions', {
      initialDate: toPS(inicio), finalDate: toPS(fim), maxPageResults: 3, page: 1,
    });
    const txXmls = xmlAll(result._body, 'transaction');
    const firstTx = txXmls[0] || '';
    const installMatch = firstTx.match(/<installmentCount[^>]*>[\s\S]*?<\/installmentCount>/);
    const pmMatch2 = firstTx.match(/<paymentMethod[^>]*>[\s\S]*?<\/paymentMethod>/);
    const senderMatch2 = firstTx.match(/<sender[^>]*>[\s\S]*?<\/sender>/);
    res.json({
      status: result._status,
      total_txs: txXmls.length,
      installmentCount_tag: installMatch ? installMatch[0] : 'NOT FOUND IN XML',
      paymentMethod: pmMatch2 ? pmMatch2[0] : 'NOT FOUND',
      sender: senderMatch2 ? senderMatch2[0] : 'NOT FOUND',
      tx_snippet: firstTx.substring(0, 600),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
      req.on('error', reject);
      req.end();
    });
    const agora = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const brt = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
    const agoraStr = brt.getFullYear() + '-' + pad(brt.getMonth()+1) + '-' + pad(brt.getDate()) + 'T' + pad(brt.getHours()) + ':' + pad(brt.getMinutes());
    const inicioStr = brt.getFullYear() + '-' + pad(brt.getMonth()+1) + '-01T00:00';
    const txResult = await pagbankLegacyRequest('/v3/transactions', {
      initialDate: inicioStr, finalDate: agoraStr, maxPageResults: 5, page: 1,
    });
    const txXmls = xmlAll(txResult._body, 'transaction');
    res.json({
      balance_status: balanceResult._status,
      balance_raw: balanceResult._body.substring(0, 500),
      tx_status: txResult._status,
      txXmls_count: txXmls.length,
      parsed_transactions: txXmls.map(parseTx).slice(0, 3),
      dates_used: { inicio: inicioStr, fim: agoraStr },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// GHL AGENCY INTEGRATION
// ============================================================

const GHL_AGENCY_KEY = process.env.GHL_AGENCY_KEY || '';
const GHL_BASE = 'services.leadconnectorhq.com';

function ghlRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: GHL_BASE,
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + GHL_AGENCY_KEY,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), status: res.statusCode }); }
        catch(e) { resolve({ body: data, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// GET /api/ghl/subcontas — lista todas as subcontas
app.get('/api/ghl/subcontas', async (req, res) => {
  try {
    const result = await ghlRequest('/v1/agency/companies?limit=100&skip=0');
    if (result.status !== 200) return res.status(result.status).json({ error: result.body });
    const locations = (result.body.companies || result.body.locations || []).map(l => ({
      id: l.id || l._id,
      nome: l.name,
      email: l.email,
      plano: l.plan,
      ativo: l.isActive,
    }));
    res.json({ total: locations.length, subcontas: locations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ghl/revenda — receita de refaturamento por subconta
app.get('/api/ghl/revenda', async (req, res) => {
  try {
    const now = new Date();
    const mes = req.query.mes || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
    const [ano, m] = mes.split('-');
    const startDate = ano + '-' + m + '-01';
    const endDate = new Date(parseInt(ano), parseInt(m), 0);
    const endStr = ano + '-' + m + '-' + String(endDate.getDate()).padStart(2, '0');

    // Reseller revenue por produto
    const revenueResult = await ghlRequest('/v1/agency/reseller/revenue?startDate=' + startDate + '&endDate=' + endStr);
    // Wallet/carteira info
    const walletResult = await ghlRequest('/v1/agency/billing/wallet');

    res.json({
      mes,
      receita: revenueResult.body,
      carteira: walletResult.body,
      debug_revenue_status: revenueResult.status,
      debug_wallet_status: walletResult.status,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ghl/custo-subcontas — custo variavel por subconta (para cruzamento com Stripe)
app.get('/api/ghl/custo-subcontas', async (req, res) => {
  try {
    const now = new Date();
    const mes = req.query.mes || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
    const [ano, m] = mes.split('-');
    const startDate = ano + '-' + m + '-01';
    const endDate = new Date(parseInt(ano), parseInt(m), 0);
    const endStr = ano + '-' + m + '-' + String(endDate.getDate()).padStart(2, '0');

    // Custo por subconta
    const result = await ghlRequest('/v1/agency/billing/usage?startDate=' + startDate + '&endDate=' + endStr);
    res.json({
      mes,
      status: result.status,
      data: result.body,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ghl/debug — inspeciona dados de company e subcontas
app.get('/api/ghl/debug', async (req, res) => {
  try {
    const locsR = await ghlRequest('/locations/search?limit=100');
    const locs = locsR.body.locations || [];
    const companyId = locs[0] ? locs[0].companyId : 'NONE';

    // Get company info and try saas with version header
    const [compR, saasR, locsFullR] = await Promise.all([
      ghlRequest('/companies/' + companyId),
      ghlRequest('/saas/subscriptions?companyId=' + companyId + '&limit=10'),
      ghlRequest('/locations/search?limit=100&skip=0'),
    ]);

    res.json({
      total_locations: locs.length,
      company_status: compR.status,
      company_keys: compR.status === 200 ? Object.keys(compR.body) : [],
      company_billing: compR.status === 200 ? JSON.stringify(compR.body).substring(0, 500) : 'N/A',
      saas_status: saasR.status,
      saas_sample: JSON.stringify(saasR.body).substring(0, 300),
      locations_sample: locs.slice(0,3).map(l => ({
        id: l.id, name: l.name, plan: l.plan, saasSubscriptionStatus: l.saasSubscriptionStatus,
        trialEndDate: l.trialEndDate, suspended: l.suspended,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ============================================================
// GHL — Busca TODAS as subcontas com paginacao automatica
// Sempre dinamico: novas subcontas aparecem automaticamente
// ============================================================

async function ghlGetAllLocations() {
  const all = [];
  let skip = 0;
  const limit = 100;
  while (true) {
    const r = await ghlRequest('/locations/search?limit=' + limit + '&skip=' + skip);
    const locs = (r.body && r.body.locations) ? r.body.locations : [];
    all.push(...locs);
    if (locs.length < limit) break; // ultima pagina
    skip += limit;
  }
  return all;
}

// Normaliza nomes para comparacao fuzzy (remove acentos, espacos extras, case)
function normalizeName(str) {
  if (!str) return '';
  return str.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-z0-9s]/g, '')                      // remove especiais
    .replace(/s+/g, ' ').trim();
}

// Verifica se dois nomes sao suficientemente similares
function nomesSimilares(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Checa se um contem o outro (min 5 chars)
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (shorter.length >= 5 && longer.includes(shorter)) return true;
  // Palavras em comum (>=2 palavras de >=4 chars)
  const wordsA = na.split(' ').filter(w => w.length >= 4);
  const wordsB = new Set(nb.split(' ').filter(w => w.length >= 4));
  const common = wordsA.filter(w => wordsB.has(w));
  return common.length >= 2;
}

// GET /api/ghl/cruzamento — cruza subcontas GHL x assinaturas Stripe
// Sempre busca dados em tempo real — novas subcontas aparecem automaticamente
app.get('/api/ghl/cruzamento', async (req, res) => {
  try {
    // 1. Busca TODAS as subcontas GHL (paginado automaticamente)
    const locations = await ghlGetAllLocations();

    // 2. Busca TODOS os clientes Stripe com assinaturas ativas
    const stripeCustomers = await stripeListAll('customers', { limit: 100 });
    const stripeSubs = await stripeListAll('subscriptions', { limit: 100, status: 'active' });

    // Monta mapa: customerId -> subscription info
    const subByCustomer = {};
    for (const sub of stripeSubs) {
      subByCustomer[sub.customer] = {
        id: sub.id,
        status: sub.status,
        valor: sub.items && sub.items.data[0] ? sub.items.data[0].price.unit_amount / 100 : 0,
        moeda: sub.currency ? sub.currency.toUpperCase() : 'BRL',
        plano: sub.items && sub.items.data[0] && sub.items.data[0].price.nickname
          ? sub.items.data[0].price.nickname
          : (sub.items && sub.items.data[0] ? sub.items.data[0].price.id : 'N/A'),
        inicio: sub.start_date ? new Date(sub.start_date * 1000).toISOString().substring(0, 10) : null,
      };
    }

    // Monta lista de clientes Stripe com email e nome
    const stripeClientes = stripeCustomers.map(c => ({
      id: c.id,
      nome: c.name || '',
      email: c.email || '',
      sub: subByCustomer[c.id] || null,
    })).filter(c => c.sub !== null); // so quem tem assinatura ativa

    // 3. Cruza cada subconta GHL com Stripe
    // Cada cliente Stripe so pode ser matched UMA vez (evita falsos positivos)
    const matchedStripeIds = new Set();

    const resultado = locations.map(loc => {
      const nomeGHL = loc.name || '';
      const locId = loc.id;

      // PRIORIDADE 1: Mapeamento manual salvo pelo usuario
      let match = null;
      let mapeamentoManual = false;
      for (const [stripeId, map] of Object.entries(manualMappings)) {
        if (map.ghl_location_id === locId) {
          const cliente = stripeClientes.find(c => c.id === stripeId);
          if (cliente && !matchedStripeIds.has(cliente.id)) {
            match = cliente;
            mapeamentoManual = true;
            break;
          }
        }
      }

      // PRIORIDADE 2: Match exato por nome normalizado
      if (!match) match = stripeClientes.find(c =>
        !matchedStripeIds.has(c.id) &&
        normalizeName(c.nome) === normalizeName(nomeGHL) &&
        normalizeName(nomeGHL).length >= 3
      );

      // Fuzzy: substring de 6+ chars OU 2+ palavras de 5+ chars em comum
      if (!match) {
        match = stripeClientes.find(c => {
          if (matchedStripeIds.has(c.id)) return false;
          const na = normalizeName(c.nome);
          const nb = normalizeName(nomeGHL);
          if (!na || !nb || na.length < 4 || nb.length < 4) return false;
          const shorter = na.length < nb.length ? na : nb;
          const longer  = na.length < nb.length ? nb : na;
          if (shorter.length >= 6 && longer.includes(shorter)) return true;
          const wordsA = na.split(' ').filter(w => w.length >= 5);
          const wordsB = new Set(nb.split(' ').filter(w => w.length >= 5));
          return wordsA.filter(w => wordsB.has(w)).length >= 2;
        });
      }

      if (match) matchedStripeIds.add(match.id);

      return {
        ghl_id: loc.id,
        nome: nomeGHL,
        stripe_encontrado: !!match,
        stripe_customer_id: match ? match.id : null,
        stripe_email: match ? match.email : null,
        stripe_nome_match: match ? match.nome : null,
        assinatura: match ? match.sub : null,
        receita_mensal: match && match.sub ? match.sub.valor : 0,
        mapeamento_manual: mapeamentoManual,
        alerta: !match ? 'SEM_COBRANCA' : null,
      };
    });

    // Stripe ativos nao matcheados a nenhuma subconta GHL
    const stripeNaoMatcheados = stripeClientes.filter(c => !matchedStripeIds.has(c.id));

    // Ordena: primeiro sem cobranca (alertas), depois por receita decrescente
    resultado.sort((a, b) => {
      if (a.stripe_encontrado !== b.stripe_encontrado) return a.stripe_encontrado ? 1 : -1;
      return b.receita_mensal - a.receita_mensal;
    });

    const semCobranca = resultado.filter(r => !r.stripe_encontrado);
    const comCobranca = resultado.filter(r => r.stripe_encontrado);
    const receitaTotal = comCobranca.reduce((s, r) => s + r.receita_mensal, 0);

    res.json({
      total_subcontas_ghl: locations.length,
      total_stripe_ativos: stripeClientes.length,
      com_cobranca_stripe: comCobranca.length,
      sem_cobranca_stripe: semCobranca.length,
      receita_total_mensal: parseFloat(receitaTotal.toFixed(2)),
      subcontas: resultado,
      stripe_sem_match_ghl: stripeNaoMatcheados.map(c => ({
        stripe_id: c.id,
        nome: c.nome,
        email: c.email,
        receita_mensal: c.sub ? c.sub.valor : 0,
        plano: c.sub ? c.sub.plano : null,
        ja_mapeado: !!manualMappings[c.id],
      })),
      gerado_em: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message, stack: err.stack }); }
});

// ============================================================
// MAPEAMENTOS MANUAIS GHL <-> STRIPE (persistencia em arquivo)
// Permite vincular manualmente clientes Stripe a subcontas GHL
// quando o match automatico por nome nao funciona
// ============================================================

const MAPPINGS_FILE = '/tmp/ghl_stripe_mappings.json';

// Carrega mapeamentos do arquivo (persiste entre restarts)
function loadMappings() {
  try {
    if (fs.existsSync(MAPPINGS_FILE)) {
      return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Erro ao carregar mappings:', e.message); }
  return {};
}

// Salva mapeamentos no arquivo
function saveMappings(mappings) {
  try { fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2)); }
  catch (e) { console.error('Erro ao salvar mappings:', e.message); }
}

// Objeto em memoria (chave: stripe_customer_id, valor: { ghl_location_id, ghl_nome, stripe_nome, criado_em })
let manualMappings = loadMappings();

// GET /api/ghl/locations — lista todas as subcontas GHL em tempo real (para dropdown de vinculação)
app.get('/api/ghl/locations', async (req, res) => {
  try {
    const locations = await ghlGetAllLocations();
    const search = (req.query.search || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const result = locations
      .map(l => ({ id: l.id, nome: l.name || '', email: l.email || '' }))
      .filter(l => {
        if (!search) return true;
        const nome = l.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const email = l.email.toLowerCase();
        return nome.includes(search) || email.includes(search);
      })
      .sort((a, b) => a.nome.localeCompare(b.nome));
    res.json({ total: result.length, locations: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ghl/mapeamentos — lista todos os mapeamentos manuais salvos
app.get('/api/ghl/mapeamentos', (req, res) => {
  res.json({
    total: Object.keys(manualMappings).length,
    mapeamentos: manualMappings,
  });
});

// POST /api/ghl/mapeamentos — salva um novo mapeamento manual
// Body: { stripe_customer_id, stripe_nome, ghl_location_id, ghl_nome }
app.post('/api/ghl/mapeamentos', express.json(), (req, res) => {
  const { stripe_customer_id, stripe_nome, ghl_location_id, ghl_nome } = req.body || {};
  if (!stripe_customer_id || !ghl_location_id) {
    return res.status(400).json({ error: 'stripe_customer_id e ghl_location_id sao obrigatorios' });
  }
  manualMappings[stripe_customer_id] = {
    ghl_location_id,
    ghl_nome: ghl_nome || '',
    stripe_nome: stripe_nome || '',
    criado_em: new Date().toISOString(),
  };
  saveMappings(manualMappings);
  res.json({ ok: true, mapeamento: manualMappings[stripe_customer_id] });
});

// DELETE /api/ghl/mapeamentos/:stripe_customer_id — remove um mapeamento
app.delete('/api/ghl/mapeamentos/:stripe_customer_id', (req, res) => {
  const id = req.params.stripe_customer_id;
  if (!manualMappings[id]) return res.status(404).json({ error: 'Mapeamento nao encontrado' });
  delete manualMappings[id];
  saveMappings(manualMappings);
  res.json({ ok: true, removido: id });
});


// DEBUG: test PagBank payment-requests API directly
app.get('/api/debug/link', async (req, res) => {
  const code = req.query.code || '81DTTkpzq';
  try {
    const result = await pagbankLegacyRequest('/v3/transactions/' + code);
    res.json({ code, status: result._status, body: result._body.substring(0, 1000) });
  } catch (e) {
    res.json({ code, error: e.message });
  }
});

// ─── DASHBOARD UNIFICADO ──────────────────────────────────────────────────────

// GET /api/pagbank/transacoes/recentes — últimas N transações PagBank enriquecidas
app.get('/api/pagbank/transacoes/recentes', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10'), 50);
    const { inicio, fim } = getPeriodoPagbank(req);
    const txs = await pagbankListAllTx(inicio, fim);

    const refMap = {};
    txs.forEach(tx => { if (tx.referencia && !refMap[tx.referencia]) refMap[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refMap).map(([ref, code]) => fetchLinkNome(ref, code)));

    const recentes = txs.slice(0, limit).map(tx => {
      const sender = senderCache[tx.id] || {};
      const parcelas = parcelasCache[tx.id] || tx.parcelas;
      const statusStr = ['pago', 'disponivel'].includes(tx.status) ? 'aprovado'
        : ['cancelado', 'devolvido', 'chargeback'].includes(tx.status) ? 'cancelado' : tx.status;
      return {
        id: tx.id,
        data: tx.data,
        data_br: tx.data ? tx.data.split('-').reverse().join('/') : 'N/A',
        nome: sender.nome || (tx.nome && tx.nome !== 'N/A' ? tx.nome : null),
        email: sender.email || (tx.email && tx.email !== 'N/A' ? tx.email : null),
        descricao: linkNomeCache[tx.referencia] || tx.link_pagamento || null,
        metodo: tx.metodo,
        parcelas,
        status: tx.status,
        status_label: statusStr,
        bruto: tx.bruto,
        liquido: tx.liquido,
        previsao_recebimento: calcPrevisaoRecebimento(tx.data, tx.metodo, parcelas, statusStr, 'pagbank'),
      };
    });

    res.json({ transacoes: recentes, total: txs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/dashboard/resumo — métricas unificadas Stripe + PagBank em uma chamada
// Query params: plataforma=ambas|stripe|pagbank, start, end
app.get('/api/dashboard/resumo', async (req, res) => {
  try {
    const plataforma = (req.query.plataforma || 'ambas').toLowerCase();
    const { inicio, fim } = getPeriodo(req);
    const { inicio: inicioPB, fim: fimPB } = getPeriodoPagbank(req);
    const round = v => parseFloat((v || 0).toFixed(2));

    let s_bruto = 0, s_liquido = 0, s_taxas = 0, s_falhas = 0, s_a_receber = 0;
    let mrr = 0, s_novas = 0, s_cancelamentos = 0;
    const mrr_cat = { variavel: 0, basico: 0, scale: 0, avancado: 0 };
    const sub_count = { variavel: 0, basico: 0, scale: 0, avancado: 0 };
    let p_bruto = 0, p_liquido = 0, p_taxas = 0, p_falhas = 0, p_a_receber = 0;
    const pipeline = { cartao: 0, pix: 0, boleto: 0, debito: 0 };

    if (plataforma === 'ambas' || plataforma === 'stripe') {
      const [charges, activeSubs, stripeBalance] = await Promise.all([
        stripeListAll('charges', {
          'created[gte]': String(inicio), 'created[lte]': String(fim),
          'expand[]': 'data.balance_transaction',
        }),
        stripeListAll('subscriptions', { status: 'active' }),
        stripeRequest('/v1/balance'),
      ]);

      for (const c of (charges || [])) {
        if (c.status === 'succeeded') {
          const bt = c.balance_transaction && typeof c.balance_transaction === 'object' ? c.balance_transaction : null;
          s_bruto += (c.amount || 0) / 100;
          if (bt) { s_liquido += (bt.net || 0) / 100; s_taxas += (bt.fee || 0) / 100; }
        } else if (c.status === 'failed') {
          s_falhas += (c.amount || 0) / 100;
        }
      }

      s_a_receber = ((stripeBalance.pending || []).reduce((s, b) => s + b.amount, 0)) / 100;

      // MRR: mesma logica do /api/stripe/mrr — normaliza anual/semanal para mensal
      for (const sub of (activeSubs || [])) {
        for (const item of (sub.items?.data || [])) {
          const price = item.price;
          if (!price?.recurring) continue;
          let valor = (price.unit_amount || 0) / 100;
          const interval = price.recurring.interval;
          const cnt = price.recurring.interval_count || 1;
          if (interval === 'year') valor = (valor / 12) / cnt;
          else if (interval === 'week') valor = (valor * 4.33) / cnt;
          else if (interval === 'month') valor = valor / cnt;
          valor = valor * (item.quantity || 1);
          mrr += valor;
          const cat = classifyAssinatura(price.nickname || 'N/A', valor);
          mrr_cat[cat] = (mrr_cat[cat] || 0) + valor;
          sub_count[cat] = (sub_count[cat] || 0) + 1;
        }
      }
      // Novas e canceladas no período
      // Stripe nao suporta canceled_at como filtro — busca canceladas e filtra em memoria por ended_at
      const [newSubs, canceledSubs] = await Promise.all([
        stripeListAll('subscriptions', { status: 'all', 'created[gte]': String(inicio), 'created[lte]': String(fim) }),
        stripeListAll('subscriptions', { status: 'canceled', 'created[gte]': String(inicio - 180 * 86400) }),
      ]);
      s_novas = newSubs.length;
      s_cancelamentos = canceledSubs.filter(s => s.ended_at && s.ended_at >= inicio && s.ended_at <= fim).length;
    }

    // impl_tipos definido aqui para estar no scope do res.json
    const impl_tipos = {
      basica:        { count: 0, bruto: 0, liquido: 0, parcelas_soma: 0 },
      personalizada: { count: 0, bruto: 0, liquido: 0, parcelas_soma: 0 },
      avancada:      { count: 0, bruto: 0, liquido: 0, parcelas_soma: 0 },
      variavel:      { count: 0, bruto: 0, liquido: 0, parcelas_soma: 0 },
    };
    if (plataforma === 'ambas' || plataforma === 'pagbank') {
      // Loop period-filtered: bruto, liquido, taxas, falhas, impl_tipos
      const txs = await pagbankListAllTx(inicioPB, fimPB);
      const refMapD = {}; txs.forEach(tx => { if (tx.referencia && !refMapD[tx.referencia]) refMapD[tx.referencia] = tx.id; });
      await Promise.all(Object.entries(refMapD).map(([ref, code]) => fetchLinkNome(ref, code)));

      for (const tx of txs) {
        const isAprov = ['pago', 'disponivel'].includes(tx.status);
        const isCanc  = ['cancelado', 'devolvido', 'chargeback'].includes(tx.status);
        if (isAprov) {
          p_bruto   += tx.bruto;
          p_liquido += tx.liquido;
          p_taxas   += (tx.bruto - tx.liquido);
          const descricao = linkNomeCache[tx.referencia] || tx.link_pagamento || '';
          const tipoImpl = classifyTipo(descricao, tx.bruto, tx.metodo, 'pagbank');
          const tipoKey = tipoImpl === 'implementacao_avancada' ? 'avancada'
            : tipoImpl === 'implementacao_personalizada' ? 'personalizada'
            : tipoImpl === 'implementacao_basica' ? 'basica' : 'variavel';
          impl_tipos[tipoKey].count++;
          impl_tipos[tipoKey].bruto   = parseFloat((impl_tipos[tipoKey].bruto + tx.bruto).toFixed(2));
          impl_tipos[tipoKey].liquido = parseFloat((impl_tipos[tipoKey].liquido + tx.liquido).toFixed(2));
          impl_tipos[tipoKey].parcelas_soma += (parcelasCache[tx.id] || tx.parcelas || 1);
        } else if (isCanc) {
          p_falhas += tx.bruto;
        }
      }

      // p_a_receber e pipeline: sempre últimos 60 dias (independente do filtro de período)
      // Garante que o card "A Receber" mostra o saldo pendente real, não filtrado por data
      const agoraBRT = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
      const inicio60BRT = new Date(agoraBRT.getTime() - 60 * 24 * 60 * 60 * 1000);
      const toBRTStr = (d) => {
        const pad = n => String(n).padStart(2, '0');
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
      };
      const txsPendentes = await pagbankListAllTx(toBRTStr(inicio60BRT), toBRTStr(agoraBRT));
      for (const tx of txsPendentes) {
        if (tx.status === 'pago') {
          p_a_receber += tx.liquido;
          const m = tx.metodo || 'cartao';
          if (m === 'pix') pipeline.pix += tx.liquido;
          else if (m === 'boleto') pipeline.boleto += tx.liquido;
          else if (m === 'debito') pipeline.debito += tx.liquido;
          else pipeline.cartao += tx.liquido;
        }
      }
    }

    res.json({
      plataforma,
      receita_bruta:   round(s_bruto + p_bruto),
      receita_liquida: round(s_liquido + p_liquido),
      taxas:           round(s_taxas + p_taxas),
      a_receber:       round(s_a_receber + p_a_receber),
      falhas:          round(s_falhas + p_falhas),
      stripe: {
        bruto: round(s_bruto), liquido: round(s_liquido), taxas: round(s_taxas),
        falhas: round(s_falhas), a_receber: round(s_a_receber),
        mrr: round(mrr),
        total_assinaturas: (sub_count.variavel + sub_count.basico + sub_count.scale + sub_count.avancado),
        novas_assinaturas: s_novas,
        cancelamentos: s_cancelamentos,
        assinaturas_por_categoria: {
          variavel:  { count: sub_count.variavel,  mrr: round(mrr_cat.variavel)  },
          basico:    { count: sub_count.basico,    mrr: round(mrr_cat.basico)    },
          scale:     { count: sub_count.scale,     mrr: round(mrr_cat.scale)     },
          avancado:  { count: sub_count.avancado,  mrr: round(mrr_cat.avancado)  },
        },
      },
      pagbank: {
        bruto: round(p_bruto), liquido: round(p_liquido), taxas: round(p_taxas),
        falhas: round(p_falhas), a_receber: round(p_a_receber),
        total_implementacoes: (impl_tipos.basica.count + impl_tipos.personalizada.count + impl_tipos.avancada.count),
        implementacoes_por_tipo: {
          basica:        { count: impl_tipos.basica.count,        bruto: impl_tipos.basica.bruto,        liquido: impl_tipos.basica.liquido,        parcelas_media: impl_tipos.basica.count        > 0 ? round(impl_tipos.basica.parcelas_soma        / impl_tipos.basica.count)        : 0 },
          personalizada: { count: impl_tipos.personalizada.count, bruto: impl_tipos.personalizada.bruto, liquido: impl_tipos.personalizada.liquido, parcelas_media: impl_tipos.personalizada.count > 0 ? round(impl_tipos.personalizada.parcelas_soma / impl_tipos.personalizada.count) : 0 },
          avancada:      { count: impl_tipos.avancada.count,      bruto: impl_tipos.avancada.bruto,      liquido: impl_tipos.avancada.liquido,      parcelas_media: impl_tipos.avancada.count      > 0 ? round(impl_tipos.avancada.parcelas_soma      / impl_tipos.avancada.count)      : 0 },
        },
        pipeline: {
          cartao: round(pipeline.cartao), pix: round(pipeline.pix),
          boleto: round(pipeline.boleto), debito: round(pipeline.debito),
          total: round(p_a_receber),
        },
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stripe/ltv — LTV, valor médio por conta, ticket médio (respeita ?start=&end=)
app.get('/api/stripe/ltv', async (req, res) => {
  try {
    const agora = Date.now();
    const seisM = Math.floor((agora - 180 * 86400 * 1000) / 1000);

    const { inicio, fim } = getPeriodo(req);
    const { inicio: inicioPB, fim: fimPB } = getPeriodoPagbank(req);
    const meses_periodo = Math.max(1, (fim - inicio) / (30.44 * 86400));

    const isAutoRecharge = c => /auto-recharge|sub-account/i.test(c.description || '');

    // Fetch em paralelo — SEM charges_all (lento demais):
    // charges_periodo: período filtrado (assinatura + variável GHL)
    // activeSubs + canceledRecentes: MRR, tempo de vida, churn
    // txsPagbank: período filtrado — fonte principal de implementações
    const [charges_periodo, activeSubs, canceledRecentes, txsPagbank] = await Promise.all([
      stripeListAll('charges', { status: 'succeeded', 'created[gte]': String(inicio), 'created[lte]': String(fim) }),
      stripeListAll('subscriptions', { status: 'active' }),
      stripeListAll('subscriptions', { status: 'canceled', 'created[gte]': String(seisM) }),
      pagbankListAllTx(inicioPB, fimPB),
    ]);

    // Enriquece cache de nomes PagBank
    const refMapLTV = {};
    txsPagbank.forEach(tx => { if (tx.referencia && !refMapLTV[tx.referencia]) refMapLTV[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refMapLTV).map(([ref, code]) => fetchLinkNome(ref, code)));

    // ── Stripe período — assinatura e variável GHL ────────────────────────
    let receita_assin = 0, count_assin = 0;
    let receita_ghl_var = 0, count_ghl_var = 0;
    for (const c of charges_periodo) {
      const v = (c.amount || 0) / 100;
      if (c.invoice) { receita_assin += v; count_assin++; }
      else if (isAutoRecharge(c)) { receita_ghl_var += v; count_ghl_var++; }
      // Stripe avulsos não-GHL são ignorados: neste negócio implementações são PagBank
    }

    // ── PagBank período — impl vs variável ────────────────────────────────
    // PagBank: classifyTipo classifica por valor (implementacao_*) — 'recorrente' não é assinatura no PagBank.
    // Checar pelos tipos ESPECÍFICOS de implementação para não incluir recorrentes.
    const IMPL_TIPOS = ['implementacao_basica', 'implementacao_personalizada', 'implementacao_avancada', 'implementacao'];
    let receita_impl_pb = 0, count_impl_pb = 0;
    let receita_var_pb  = 0, count_var_pb  = 0;
    for (const tx of txsPagbank) {
      if (!['pago', 'disponivel'].includes(tx.status)) continue;
      const descricao = linkNomeCache[tx.referencia] || tx.link_pagamento || '';
      const tipo = classifyTipo(descricao, tx.bruto, tx.metodo, 'pagbank');
      if (IMPL_TIPOS.includes(tipo)) { receita_impl_pb += tx.liquido; count_impl_pb++; }
      else                           { receita_var_pb  += tx.liquido; count_var_pb++;  }
    }

    // ── Ticket médio — SOMENTE PagBank para implementação ────────────────
    // Lógica: implementações são 100% PagBank; Stripe avulso é ruído neste negócio
    const ticket_medio_implementacao = count_impl_pb > 0
      ? receita_impl_pb / count_impl_pb : 0;

    const ticket_medio_assinatura = count_assin > 0
      ? receita_assin / count_assin : 0;

    // Geral: (assinatura Stripe + impl PagBank) / (count_assin + count_impl_pb)
    const count_geral   = count_assin + count_impl_pb;
    const receita_geral = receita_assin + receita_impl_pb;
    const ticket_medio_geral = count_geral > 0 ? receita_geral / count_geral : 0;

    // ── MRR (sempre atual — não filtrado por período) ─────────────────────
    let mrr = 0;
    const mrr_por_cat   = { variavel: 0, basico: 0, scale: 0, avancado: 0 };
    const count_por_cat = { variavel: 0, basico: 0, scale: 0, avancado: 0 };
    const clientesSub   = new Set();

    for (const sub of activeSubs) {
      if (sub.customer) clientesSub.add(sub.customer);
      for (const item of (sub.items?.data || [])) {
        const price = item.price;
        if (!price?.recurring) continue;
        let valor = (price.unit_amount || 0) / 100;
        const interval = price.recurring.interval;
        const cnt = price.recurring.interval_count || 1;
        if (interval === 'year') valor = (valor / 12) / cnt;
        else if (interval === 'week') valor = (valor * 4.33) / cnt;
        else valor = valor / cnt;
        valor = valor * (item.quantity || 1);
        mrr += valor;
        const cat = classifyAssinatura(price.nickname || 'N/A', valor);
        mrr_por_cat[cat] = (mrr_por_cat[cat] || 0) + valor;
        count_por_cat[cat] = (count_por_cat[cat] || 0) + 1;
      }
    }

    // ── Valor médio por conta — 3 componentes SEPARADOS ──────────────────
    const contas = clientesSub.size || 1;

    // Assinatura: MRR atual / contas ativas (snapshot atual, não filtrado por período)
    const vmc_assinatura = mrr / contas;

    // Implementação: receita impl PagBank do período / meses / contas
    // "Se todo mês fosse como o período selecionado, cada conta traria X em impl/mês"
    const vmc_implementacao = (receita_impl_pb / meses_periodo) / contas;

    // Variável GHL: (GHL auto-recharge Stripe + variáveis PagBank) / meses / contas
    const vmc_variavel = ((receita_ghl_var + receita_var_pb) / meses_periodo) / contas;

    const valor_medio_conta = vmc_assinatura + vmc_implementacao + vmc_variavel;

    // ── LTV projetado ─────────────────────────────────────────────────────
    const tempos = activeSubs.map(s => (agora / 1000 - s.created) / (30.44 * 86400));
    const tempo_medio_meses = tempos.length > 0
      ? tempos.reduce((a, b) => a + b, 0) / tempos.length : 0;
    const ltv_projetado = valor_medio_conta * tempo_medio_meses;

    // ── Churn ─────────────────────────────────────────────────────────────
    const totalSubsBase = activeSubs.length + canceledRecentes.length;
    const churn_rate_mensal = totalSubsBase > 0
      ? parseFloat(((canceledRecentes.length / 6) / totalSubsBase * 100).toFixed(2)) : 0;

    const round = v => parseFloat((v || 0).toFixed(2));

    res.json({
      ltv_projetado: round(ltv_projetado),

      valor_medio_conta: round(valor_medio_conta),
      valor_medio_conta_breakdown: {
        assinatura:    round(vmc_assinatura),    // MRR / contas — maior componente
        implementacao: round(vmc_implementacao), // impl PagBank / meses / contas
        variavel_ghl:  round(vmc_variavel),      // GHL + var PagBank / meses / contas
      },

      // Ticket médio — período selecionado
      ticket_medio_geral: round(ticket_medio_geral),
      ticket_medio_assinatura: round(ticket_medio_assinatura),
      ticket_medio_implementacao: round(ticket_medio_implementacao), // = receita_impl_pb / count_impl_pb

      mrr: round(mrr),
      assinaturas_ativas: activeSubs.length,
      tempo_medio_vida_meses: round(tempo_medio_meses),
      churn_rate_mensal,
      contas_sub_ativas: clientesSub.size,
      meses_periodo: round(meses_periodo),

      // Auditoria — para validar no browser
      _debug: {
        count_impl_pb,
        receita_impl_pb: round(receita_impl_pb),
        ticket_impl_check: count_impl_pb > 0 ? round(receita_impl_pb / count_impl_pb) : 0,
        count_assin,
        receita_assin: round(receita_assin),
        count_ghl_var,
        receita_ghl_var: round(receita_ghl_var),
      },

      por_categoria: {
        variavel:  { count: count_por_cat.variavel,  mrr: round(mrr_por_cat.variavel)  },
        basico:    { count: count_por_cat.basico,    mrr: round(mrr_por_cat.basico)    },
        scale:     { count: count_por_cat.scale,     mrr: round(mrr_por_cat.scale)     },
        avancado:  { count: count_por_cat.avancado,  mrr: round(mrr_por_cat.avancado)  },
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// NF AUTOMÁTICA — integração Contabilizei → GHL via email
// ═══════════════════════════════════════════════════════════

// Historico NF — persistido em JSON para sobreviver restarts/deploys
const NF_DATA_FILE = path.join(__dirname, 'nf-data.json');
let nfHistorico = [];             // todos os registros (compat. retroativa)
let nfPorMes    = {};             // { "2026-04": [...] }

function loadNfData() {
  try {
    if (fs.existsSync(NF_DATA_FILE)) {
      const raw = fs.readFileSync(NF_DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      nfHistorico = data.historico || [];
      nfPorMes = data.porMes || {};
      console.log(`[NF] Carregados ${nfHistorico.length} registros de ${NF_DATA_FILE}`);
    }
  } catch (e) {
    console.error('[NF] Erro ao carregar nf-data.json:', e.message);
  }
}

function saveNfData() {
  try {
    fs.writeFileSync(NF_DATA_FILE, JSON.stringify({ historico: nfHistorico, porMes: nfPorMes }), 'utf8');
  } catch (e) {
    console.error('[NF] Erro ao salvar nf-data.json:', e.message);
  }
}

// Carregar dados de NF ao iniciar o servidor
loadNfData();

function mesAnoAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function addNfEntry(entry) {
  const ma = entry.mes_ano || mesAnoAtual();
  entry.mes_ano = ma;
  nfHistorico.unshift(entry);
  if (nfHistorico.length > 500) nfHistorico.pop();
  if (!nfPorMes[ma]) nfPorMes[ma] = [];
  // upsert por email ou nome normalizado
  const idx = nfPorMes[ma].findIndex(e =>
    (entry.email_cliente && e.email_cliente === entry.email_cliente) ||
    normStr(e.nome_razao_social) === normStr(entry.nome_razao_social)
  );
  if (idx >= 0) nfPorMes[ma][idx] = entry;
  else nfPorMes[ma].unshift(entry);
  saveNfData();
}

// Normaliza string para busca fuzzy: remove acentos, lowercase, trim
function normStr(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// GET /api/stripe/assinaturas/por-categoria — lista clientes de cada categoria para popup
app.get('/api/stripe/assinaturas/por-categoria', async (req, res) => {
  try {
    const categorias = { variavel: [], basico: [], scale: [], avancado: [] };

    // Busca todas as assinaturas ativas (sem expand — customer é string ID)
    const activeSubs = await stripeListAll('subscriptions', { status: 'active' });

    // Coleta IDs de clientes únicos para buscar nomes/emails em paralelo
    const customerIds = [...new Set(activeSubs.map(s => s.customer).filter(id => typeof id === 'string'))];
    const customerMap = {};
    await Promise.all(
      customerIds.map(async (cid) => {
        try {
          const c = await stripeRequest('/v1/customers/' + cid);
          if (c.id) customerMap[c.id] = { nome: c.name || null, email: c.email || null };
        } catch (e) {}
      })
    );

    for (const sub of activeSubs) {
      const item = sub.items?.data?.[0];
      const price = item?.price;
      if (!price?.recurring) continue;

      let mrr = (price.unit_amount || 0) / 100;
      const interval = price.recurring.interval;
      const cnt = price.recurring.interval_count || 1;
      if (interval === 'year') mrr = (mrr / 12) / cnt;
      else if (interval === 'week') mrr = (mrr * 4.33) / cnt;
      else if (interval === 'month') mrr = mrr / cnt;
      mrr = mrr * (item.quantity || 1);

      const plano = price.nickname || 'N/A';
      const cat = classifyAssinatura(plano, mrr);
      const cust = customerMap[sub.customer] || {};

      categorias[cat].push({
        sub_id: sub.id,
        cliente_nome: cust.nome || cust.email || 'N/A',
        cliente_email: cust.email || 'N/A',
        plano,
        mrr: parseFloat(mrr.toFixed(2)),
        moeda: (price.currency || 'brl').toUpperCase(),
        status: sub.status,
        inicio: sub.start_date ? new Date(sub.start_date * 1000).toISOString().substring(0, 10) : null,
      });
    }

    // Ordena por MRR desc dentro de cada categoria
    for (const cat of Object.keys(categorias)) {
      categorias[cat].sort((a, b) => b.mrr - a.mrr);
    }

    const round = v => parseFloat((v || 0).toFixed(2));
    res.json({
      variavel:  { count: categorias.variavel.length,  mrr_total: round(categorias.variavel.reduce((s,c)=>s+c.mrr,0)),  clientes: categorias.variavel  },
      basico:    { count: categorias.basico.length,    mrr_total: round(categorias.basico.reduce((s,c)=>s+c.mrr,0)),    clientes: categorias.basico    },
      scale:     { count: categorias.scale.length,     mrr_total: round(categorias.scale.reduce((s,c)=>s+c.mrr,0)),     clientes: categorias.scale     },
      avancado:  { count: categorias.avancado.length,  mrr_total: round(categorias.avancado.reduce((s,c)=>s+c.mrr,0)),  clientes: categorias.avancado  },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/nf/processar
// Recebe dados parseados do email Contabilizei, busca subconta GHL e marca NF emitida
app.post('/api/nf/processar', async (req, res) => {
  try {
    const { nome_razao_social, cnpj_cpf, valor, numero_nf, data_emissao, link_nf } = req.body;
    if (!nome_razao_social && !cnpj_cpf) {
      return res.status(400).json({ error: 'nome_razao_social ou cnpj_cpf obrigatorio' });
    }

    // ── 1. Buscar todas as subcontas GHL e encontrar a que bate com o tomador ──
    const locations = await ghlGetAllLocations();
    const nomeNorm = normStr(nome_razao_social);
    const cnpjClean = (cnpj_cpf || '').replace(/[^0-9]/g, '');

    let match = null;
    let matchScore = 0;

    for (const loc of locations) {
      // Comparar por CNPJ no nome da subconta ou email (mais preciso)
      const locNorm = normStr(loc.nome || loc.name || '');
      const locEmail = normStr(loc.email || '');

      // Score: nome contém parte significativa do tomador
      const nomeWords = nomeNorm.split(/\s+/).filter(w => w.length > 3);
      const matched = nomeWords.filter(w => locNorm.includes(w)).length;
      const score = nomeWords.length > 0 ? matched / nomeWords.length : 0;

      if (score > matchScore) {
        matchScore = score;
        match = loc;
      }
    }

    // Exige pelo menos 50% das palavras do nome batendo
    if (!match || matchScore < 0.5) {
      const entry = {
        ts: new Date().toISOString(), status: 'nao_encontrado',
        nome_razao_social, cnpj_cpf, valor, numero_nf, data_emissao,
        match_tentativa: match?.nome || null, match_score: matchScore,
      };
      addNfEntry(entry);
      return res.status(404).json({ error: 'Subconta GHL nao encontrada', ...entry });
    }

    // ── 2. Atualizar a subconta GHL com campos de NF emitida ──
    const locationId = match.id;

    // Adicionar nota na subconta via API GHL v2
    const nota = {
      body: [
        '✅ NF EMITIDA — Contabilizei',
        'Número: ' + (numero_nf || 'N/A'),
        'Data: ' + (data_emissao || new Date().toLocaleDateString('pt-BR')),
        'Tomador: ' + nome_razao_social,
        'CNPJ/CPF: ' + cnpj_cpf,
        'Valor: R$ ' + (valor || 'N/A'),
        link_nf ? 'Link: ' + link_nf : '',
      ].filter(Boolean).join('\n'),
    };

    // GHL v2: POST /locations/{locationId}/notes (requer location API key)
    // Como temos apenas agency key, usamos o endpoint de update de location custom values
    // Estratégia: adicionar tag "nf-emitida" + campo customizado via PATCH v2
    const patchResult = await new Promise((resolve) => {
      const bodyStr = JSON.stringify({
        tags: ['nf-emitida'],
      });
      const opts = {
        hostname: GHL_BASE,
        path: '/locations/' + locationId,
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + GHL_AGENCY_KEY,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
      };
      const r = https.request(opts, (rr) => {
        let d = '';
        rr.on('data', c => d += c);
        rr.on('end', () => resolve({ status: rr.statusCode, body: d.substring(0, 200) }));
      });
      r.on('error', () => resolve({ status: 0, body: 'connection error' }));
      r.write(bodyStr);
      r.end();
    });

    const entry = {
      ts: new Date().toISOString(), status: 'ok',
      nome_razao_social, cnpj_cpf, valor, numero_nf, data_emissao, link_nf,
      subconta_id: locationId, subconta_nome: match.nome || match.name,
      match_score: parseFloat(matchScore.toFixed(2)),
      ghl_patch_status: patchResult.status,
    };
    addNfEntry(entry);
    res.json({ sucesso: true, ...entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/nf/historico — últimas NFs processadas (opcionalmente filtrar por ?mes=2026-04)
app.get('/api/nf/historico', (req, res) => {
  const limit = parseInt(req.query.limit || '100');
  const mes   = req.query.mes; // ex: "2026-04"
  if (mes) {
    const entries = nfPorMes[mes] || [];
    return res.json({ total: entries.length, historico: entries, mes });
  }
  res.json({ total: nfHistorico.length, historico: nfHistorico.slice(0, limit) });
});

// GET /api/nf/meses — lista de meses disponíveis no histórico
app.get('/api/nf/meses', (req, res) => {
  const meses = Object.keys(nfPorMes).sort().reverse();
  // garante que o mês corrente aparece sempre
  const atual = mesAnoAtual();
  if (!meses.includes(atual)) meses.unshift(atual);
  res.json({ meses, atual });
});

// POST /api/nf/marcar-manual — dá baixa manual na NF de um cliente
// Body: { nome, email, numero_nf?, observacao?, mes_ano? }
app.post('/api/nf/marcar-manual', (req, res) => {
  const { nome, email, numero_nf, observacao, tipo_nf } = req.body;
  if (!nome && !email) return res.status(400).json({ error: 'nome ou email obrigatorio' });

  const entry = {
    ts: new Date().toISOString(),
    status: 'ok',
    origem: 'manual',
    nome_razao_social: nome || email,
    email_cliente: email || null,
    numero_nf: numero_nf || null,
    observacao: observacao || null,
    tipo_nf: tipo_nf || 'mensal',   // 'mensal' | 'implementacao'
    mes_ano: mesAnoAtual(),
  };

  addNfEntry(entry);
  res.json({ sucesso: true, ...entry });
});

// DELETE /api/nf/remover-manual — desfaz baixa manual de um cliente
// Body: { nome?, email?, mes_ano? }
app.delete('/api/nf/remover-manual', (req, res) => {
  const { nome, email, mes_ano } = req.body;
  if (!nome && !email) return res.status(400).json({ error: 'nome ou email obrigatorio' });
  const nomeNorm = normStr(nome || '');
  const ma = mes_ano || mesAnoAtual();

  // Remove do mês específico
  if (nfPorMes[ma]) {
    nfPorMes[ma] = nfPorMes[ma].filter(n => {
      if (n.origem !== 'manual') return true;
      const matchNome  = nome  && normStr(n.nome_razao_social) === nomeNorm;
      const matchEmail = email && n.email_cliente === email;
      return !(matchNome || matchEmail);
    });
  }
  // Remove do array geral
  const antes = nfHistorico.length;
  const filtrados = nfHistorico.filter(n => {
    if (n.origem !== 'manual') return true;
    if (n.mes_ano && n.mes_ano !== ma) return true; // só remove do mês alvo
    const matchNome  = nome  && normStr(n.nome_razao_social) === nomeNorm;
    const matchEmail = email && n.email_cliente === email;
    return !(matchNome || matchEmail);
  });
  nfHistorico.length = 0;
  filtrados.forEach(e => nfHistorico.push(e));
  saveNfData();
  res.json({ sucesso: true, removidos: antes - nfHistorico.length });
});

// POST /api/nf/importar — bulk import de NF entries (para re-popular após deploy)
app.post('/api/nf/importar', (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'body.entries deve ser um array não vazio' });
  }
  let added = 0;
  for (const entry of entries) {
    if (!entry.nome_razao_social && !entry.email_cliente) continue;
    entry.ts = entry.ts || new Date().toISOString();
    entry.status = entry.status || 'ok';
    addNfEntry(entry);
    added++;
  }
  res.json({ sucesso: true, importados: added, total: nfHistorico.length });
});

// GET /api/nf/exportar — exporta todos os dados de NF (para backup)
app.get('/api/nf/exportar', (req, res) => {
  res.json({ historico: nfHistorico, porMes: nfPorMes, total: nfHistorico.length });
});

// GET /api/nf/testar-match — testa qual subconta bate com um nome/CNPJ sem gravar
app.get('/api/nf/testar-match', async (req, res) => {
  try {
    const { nome, cnpj } = req.query;
    if (!nome) return res.status(400).json({ error: 'Param nome obrigatorio' });
    const locations = await ghlGetAllLocations();
    const nomeNorm = normStr(nome);
    const resultados = [];
    for (const loc of locations) {
      const locNorm = normStr(loc.nome || loc.name || '');
      const nomeWords = nomeNorm.split(/\s+/).filter(w => w.length > 3);
      const matched = nomeWords.filter(w => locNorm.includes(w)).length;
      const score = nomeWords.length > 0 ? matched / nomeWords.length : 0;
      if (score > 0) resultados.push({ id: loc.id, nome: loc.nome || loc.name, score: parseFloat(score.toFixed(2)) });
    }
    resultados.sort((a, b) => b.score - a.score);
    res.json({ query: nome, top_matches: resultados.slice(0, 5) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// CLIENTES — KPIs, lista completa + métricas de dias
// ============================================================

// GET /api/clientes/kpis — 5 métricas: total clientes, ticket médio/cliente, MRR, LTV, valor médio mensal
app.get('/api/clientes/kpis', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);

    // Busca em paralelo: charges do período, assinaturas ativas, todos os customers
    const [charges, activeSubs, allCustomers] = await Promise.all([
      stripeListAll('charges', {
        'created[gte]': String(inicio),
        'created[lte]': String(fim),
      }),
      stripeListAll('subscriptions', { status: 'active' }),
      stripeListAll('customers', {}),
    ]);

    const succeeded = charges.filter(c => c.status === 'succeeded');

    // IDs de customers com assinatura ativa
    const ativoSubIdsKpi = new Set(activeSubs.map(s => s.customer).filter(Boolean));

    // ── Total clientes reais: excluir quem só tem auto-recharge (variável GHL) ──
    const clientesReais = new Set();    // ativo ou sem_assinatura
    const clienteSoVariavel = new Set(); // apenas auto-recharge
    const receitaPorCliente = {};

    for (const ch of succeeded) {
      const cid = ch.customer || ch.billing_details?.email || ch.id;
      const valor = (ch.amount || 0) / 100;
      if (!_isAutoRecharge(ch)) {
        clientesReais.add(cid);
        receitaPorCliente[cid] = (receitaPorCliente[cid] || 0) + valor;
      } else {
        if (!clientesReais.has(cid)) clienteSoVariavel.add(cid);
      }
    }
    // Remove do soVariavel quem acabou entrando em reais também
    for (const cid of clientesReais) clienteSoVariavel.delete(cid);

    const total_clientes = clientesReais.size || 1;
    const receita_total = Object.values(receitaPorCliente).reduce((s, v) => s + v, 0);

    // ── Ticket médio por cliente (receita real período / clientes reais únicos) ──
    const ticket_medio_cliente = receita_total / total_clientes;

    // ── MRR (snapshot atual de assinaturas ativas) ──
    let mrr = 0;
    const clientesSub = new Set();
    for (const sub of activeSubs) {
      if (sub.customer) clientesSub.add(sub.customer);
      for (const item of (sub.items?.data || [])) {
        const price = item.price;
        if (!price?.recurring) continue;
        let valor = (price.unit_amount || 0) / 100;
        const interval = price.recurring.interval;
        const cnt = price.recurring.interval_count || 1;
        if (interval === 'year') valor = (valor / 12) / cnt;
        else if (interval === 'week') valor = (valor * 4.33) / cnt;
        else valor = valor / cnt;
        mrr += valor * (item.quantity || 1);
      }
    }

    // ── LTV: ticket_medio_cliente × meses médios de vida do cliente ──
    const agora = Math.floor(Date.now() / 1000);
    let soma_meses = 0;
    let count_cust = 0;
    for (const c of allCustomers) {
      if (c.created) {
        soma_meses += (agora - c.created) / (30 * 24 * 3600);
        count_cust++;
      }
    }
    const avg_meses_vida = count_cust > 0 ? soma_meses / count_cust : 12;
    const ltv = ticket_medio_cliente * avg_meses_vida;

    // ── Valor médio mensal por cliente ativo (MRR / contas com sub ativa) ──
    const contas_ativas = clientesSub.size || 1;
    const valor_medio_mensal = mrr / contas_ativas;

    // ── Clientes implementação — fonte: PagBank (não Stripe) ──────────────────────
    const { inicio: inicioPBkpi, fim: fimPBkpi } = getPeriodoPagbank(req);
    const txsPBkpi = await pagbankListAllTx(inicioPBkpi, fimPBkpi);

    // Buscar nomes/emails reais via fetchLinkNome (necessário para deduplicação correta)
    const refMapKpi = {};
    txsPBkpi.forEach(tx => { if (tx.referencia && !refMapKpi[tx.referencia]) refMapKpi[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refMapKpi).map(([ref, code]) => fetchLinkNome(ref, code)));

    const emailsComSubKpi = new Set();
    for (const sub of activeSubs) {
      const cust = allCustomers.find(c => c.id === sub.customer);
      if (cust?.email) emailsComSubKpi.add(cust.email.toLowerCase());
    }

    const IMPL_TIPOS_KPI = ['implementacao_basica', 'implementacao_personalizada', 'implementacao_avancada', 'implementacao'];
    const implEmailsSet = new Set();
    for (const tx of txsPBkpi) {
      if (!['pago', 'disponivel'].includes(tx.status)) continue;
      const descricao = linkNomeCache[tx.referencia] || tx.link_pagamento || '';
      const tipo = classifyTipo(descricao, tx.bruto, tx.metodo, 'pagbank');
      if (!IMPL_TIPOS_KPI.includes(tipo)) continue;
      const sender = senderCache[tx.id] || {};
      const email = (sender.email || tx.email || '').toLowerCase();
      const key = (email && email !== 'n/a') ? email : tx.id;
      implEmailsSet.add(key);
    }
    const soImpl = [...implEmailsSet].filter(e => !emailsComSubKpi.has(e));
    const total_implementacao = implEmailsSet.size;
    const total_ativos = activeSubs.length;
    const total_clientes_todos = total_ativos + soImpl.length;

    const r = v => parseFloat((v || 0).toFixed(2));
    res.json({
      total_clientes: total_clientes_todos,
      total_ativos,
      total_implementacao,
      ticket_medio_cliente: r(ticket_medio_cliente),
      mrr: r(mrr),
      ltv: r(ltv),
      valor_medio_mensal: r(valor_medio_mensal),
      _meta: {
        receita_total: r(receita_total),
        avg_meses_vida: r(avg_meses_vida),
        contas_ativas,
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Identifica cobranças que são recargas automáticas de subconta GHL — NÃO são clientes reais
const _isAutoRecharge = ch => /auto-recharge|sub-account/i.test(ch.description || '');

// GET /api/clientes/todos — clientes classificados: ativo | implementacao | variavel
// tipo_cliente:
//   'ativo'          → tem assinatura ativa no Stripe
//   'implementacao'  → cobranças reais no Stripe mas sem sub ativa (implementação paga / aguardando)
//   'variavel'       → cobranças são apenas auto-recharge/GHL (não é cliente real)
// Por padrão filtra fora 'variavel'. Passar ?incluir_variaveis=true para ver tudo.
// Passar ?mes=2026-04 para filtrar NF pelo mês específico.
app.get('/api/clientes/todos', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);
    const incluirVariaveis = req.query.incluir_variaveis === 'true';
    const mes = req.query.mes || mesAnoAtual();

    // Busca em paralelo: charges do período, assinaturas ativas, customers
    const [charges, activeSubs, allCustomers] = await Promise.all([
      stripeListAll('charges', {
        'created[gte]': String(inicio),
        'created[lte]': String(fim),
      }),
      stripeListAll('subscriptions', { status: 'active' }),
      stripeListAll('customers', {}),
    ]);

    // IDs de customers com assinatura ativa
    const ativoSubIds = new Set(activeSubs.map(s => s.customer).filter(Boolean));

    // Mapa customer id → valor mensal da assinatura (MRR individual)
    const subValorMap = {};
    for (const sub of activeSubs) {
      if (!sub.customer) continue;
      let mrr = 0;
      for (const item of (sub.items?.data || [])) {
        const price = item.price;
        if (!price?.recurring) continue;
        let v = (price.unit_amount || 0) / 100;
        const interval = price.recurring.interval;
        const cnt = price.recurring.interval_count || 1;
        if (interval === 'year') v = (v / 12) / cnt;
        else if (interval === 'week') v = (v * 4.33) / cnt;
        else v = v / cnt;
        mrr += v * (item.quantity || 1);
      }
      subValorMap[sub.customer] = (subValorMap[sub.customer] || 0) + mrr;
    }

    // Mapa customer id → nome/email
    const custMap = {};
    for (const c of allCustomers) {
      custMap[c.id] = { nome: c.name || '', email: c.email || '', created: c.created };
    }

    // Agrupa cobranças por cliente
    const porCliente = {};
    for (const ch of charges.filter(c => c.status === 'succeeded')) {
      const cid = ch.customer || ch.billing_details?.email || 'sem-id';
      const custInfo = custMap[cid] || {};
      const email = custInfo.email || ch.billing_details?.email || '';
      const nome = custInfo.nome || ch.billing_details?.name || email || 'N/A';

      if (!porCliente[cid]) {
        porCliente[cid] = {
          id: cid, nome, email,
          total: 0, count: 0,
          total_variavel: 0, count_variavel: 0,
          tem_cobranca_real: false,
          primeira_cobranca: ch.created,
          ultima_cobranca: ch.created,
          customer_criado: custInfo.created || null,
        };
      }
      const valor = (ch.amount || 0) / 100;
      if (_isAutoRecharge(ch)) {
        porCliente[cid].total_variavel += valor;
        porCliente[cid].count_variavel += 1;
      } else {
        porCliente[cid].total += valor;
        porCliente[cid].count += 1;
        porCliente[cid].tem_cobranca_real = true;
      }
      if (ch.created < porCliente[cid].primeira_cobranca) porCliente[cid].primeira_cobranca = ch.created;
      if (ch.created > porCliente[cid].ultima_cobranca) porCliente[cid].ultima_cobranca = ch.created;
    }

    // ── Garante que TODOS os clientes com sub ativa aparecem, mesmo sem cobrança no período ──
    for (const sub of activeSubs) {
      const cid = sub.customer;
      if (!cid || porCliente[cid]) continue; // já está no mapa
      const custInfo = custMap[cid] || {};
      if (!custInfo.nome && !custInfo.email) continue; // sem dados, ignora
      porCliente[cid] = {
        id: cid,
        nome: custInfo.nome || custInfo.email || 'N/A',
        email: custInfo.email || '',
        total: 0, count: 0,
        total_variavel: 0, count_variavel: 0,
        tem_cobranca_real: false,   // sem cobrança no período mas tem sub ativa
        primeira_cobranca: sub.created,
        ultima_cobranca: sub.current_period_start || sub.created,
        customer_criado: custInfo.created || null,
      };
    }

    // ── NF do mês solicitado ──
    const nfMes = nfPorMes[mes] || nfHistorico.filter(n => n.mes_ano === mes);
    const nfOk  = nfMes.filter(n => n.status === 'ok');

    // Função fuzzy de NF
    function nfMatch(nomeCl) {
      const nomeNorm = normStr(nomeCl);
      return nfOk.find(n => {
        const nfNorm = normStr(n.nome_razao_social);
        const words  = nfNorm.split(/\s+/).filter(w => w.length > 3);
        if (words.length === 0) return normStr(n.email_cliente) === normStr(nomeCl);
        return words.filter(w => nomeNorm.includes(w)).length / words.length >= 0.5;
      });
    }

    // ── PagBank: implementações do período → adiciona clientes ao mapa ──────────
    const { inicio: inicioPBtodos, fim: fimPBtodos } = getPeriodoPagbank(req);
    const txsPBtodos = await pagbankListAllTx(inicioPBtodos, fimPBtodos);
    const refMapTodos = {};
    txsPBtodos.forEach(tx => { if (tx.referencia && !refMapTodos[tx.referencia]) refMapTodos[tx.referencia] = tx.id; });
    await Promise.all(Object.entries(refMapTodos).map(([ref, code]) => fetchLinkNome(ref, code)));

    const emailToStripeId = {};
    for (const c of allCustomers) { if (c.email) emailToStripeId[c.email.toLowerCase()] = c.id; }

    const IMPL_TIPOS_TODOS = ['implementacao_basica', 'implementacao_personalizada', 'implementacao_avancada', 'implementacao'];

    for (const tx of txsPBtodos) {
      if (!['pago', 'disponivel'].includes(tx.status)) continue;
      const descricao = linkNomeCache[tx.referencia] || tx.link_pagamento || '';
      const tipo = classifyTipo(descricao, tx.bruto, tx.metodo, 'pagbank');
      if (!IMPL_TIPOS_TODOS.includes(tipo)) continue;

      const sender = senderCache[tx.id] || {};
      const rawEmail = (sender.email || tx.email || '').toLowerCase();
      const email  = (rawEmail && rawEmail !== 'n/a') ? rawEmail : '';
      const nome   = sender.nome || tx.nome || email || 'N/A';
      const valor  = tx.liquido || tx.bruto;
      const stripeId = email ? emailToStripeId[email] : null;
      const key = stripeId || ('pb_' + (email || tx.id));

      if (!porCliente[key]) {
        porCliente[key] = {
          id: key, nome, email,
          total: 0, count: 0,
          total_variavel: 0, count_variavel: 0,
          tem_cobranca_real: false,
          tem_impl_pagbank: false,
          primeira_cobranca: new Date(tx.data + 'T00:00:00').getTime() / 1000,
          ultima_cobranca:   new Date(tx.data + 'T00:00:00').getTime() / 1000,
          customer_criado: null,
        };
      }
      porCliente[key].tem_impl_pagbank = true;
      porCliente[key].total += valor;
      porCliente[key].count += 1;
    }

    const clientes = Object.values(porCliente).map(cl => {
      // Flags independentes: um cliente pode ter assinatura E implementação ao mesmo tempo
      const tem_assinatura = ativoSubIds.has(cl.id);
      const tem_implementacao = !!cl.tem_impl_pagbank;

      // tipo_cliente primário para ordenação/display
      let tipo_cliente;
      if (tem_assinatura && tem_implementacao) {
        tipo_cliente = 'ativo'; // primário é ativo, mas tem_implementacao = true
      } else if (tem_assinatura) {
        tipo_cliente = 'ativo';
      } else if (tem_implementacao) {
        tipo_cliente = 'implementacao';
      } else {
        tipo_cliente = 'variavel';
      }

      const nf = nfMatch(cl.nome) || (cl.email ? nfMatch(cl.email) : null);

      const valor_assinatura = parseFloat((subValorMap[cl.id] || 0).toFixed(2));

      return {
        id: cl.id,
        nome: cl.nome,
        email: cl.email,
        tipo_cliente,
        tem_assinatura,
        tem_implementacao,
        total: parseFloat(cl.total.toFixed(2)),
        valor_assinatura,          // MRR mensal da sub Stripe (sempre disponível se ativo)
        count: cl.count,
        nf_emitida: !!nf,
        nf_numero: nf?.numero_nf || null,
        nf_data: nf?.data_emissao || null,
        ultima_cobranca_fmt: cl.ultima_cobranca
          ? new Date(cl.ultima_cobranca * 1000).toLocaleDateString('pt-BR') : '-',
      };
    });

    // Filtra: por padrão exclui 'variavel'
    const filtrados = clientes.filter(cl => incluirVariaveis || cl.tipo_cliente !== 'variavel');
    filtrados.sort((a, b) => {
      const order = { ativo: 0, implementacao: 1, variavel: 2 };
      const od = (order[a.tipo_cliente] || 0) - (order[b.tipo_cliente] || 0);
      return od !== 0 ? od : b.total - a.total;
    });

    res.json({
      total: filtrados.length,
      total_ativos: filtrados.filter(c => c.tem_assinatura).length,
      total_implementacao: filtrados.filter(c => c.tem_implementacao).length,
      mes,
      clientes: filtrados,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/clientes/metricas — dia e semana com mais pagamentos
app.get('/api/clientes/metricas', async (req, res) => {
  try {
    const { inicio, fim } = getPeriodo(req);

    const charges = await stripeListAll('charges', {
      'created[gte]': String(inicio),
      'created[lte]': String(fim),
    });
    const succeeded = charges.filter(c => c.status === 'succeeded');

    // Dia da semana (0=Dom ... 6=Sáb) em BRT (UTC-3)
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const contDia = Array(7).fill(0);
    const valorDia = Array(7).fill(0);

    // Semana do mês (1-5)
    const contSemana = {};
    const valorSemana = {};

    for (const ch of succeeded) {
      const dt = new Date((ch.created - 3 * 3600) * 1000); // BRT offset
      const dow = dt.getUTCDay();
      contDia[dow]++;
      valorDia[dow] += (ch.amount || 0) / 100;

      const dom = dt.getUTCDate();
      const semana = Math.ceil(dom / 7);
      const sk = 'Semana ' + semana;
      contSemana[sk] = (contSemana[sk] || 0) + 1;
      valorSemana[sk] = (valorSemana[sk] || 0) + (ch.amount || 0) / 100;
    }

    // Dia com mais pagamentos
    const maxDiaIdx = contDia.indexOf(Math.max(...contDia));
    const diasData = diasSemana.map((nome, i) => ({
      nome,
      count: contDia[i],
      valor: parseFloat(valorDia[i].toFixed(2)),
    }));

    // Semana com mais pagamentos
    const semanasData = Object.keys(contSemana).map(sk => ({
      nome: sk,
      count: contSemana[sk],
      valor: parseFloat((valorSemana[sk] || 0).toFixed(2)),
    })).sort((a, b) => parseInt(a.nome.split(' ')[1]) - parseInt(b.nome.split(' ')[1]));

    const maxSemana = semanasData.reduce((best, s) => s.count > (best?.count || 0) ? s : best, null);

    res.json({
      dia_mais_pagamentos: {
        nome: diasSemana[maxDiaIdx],
        count: contDia[maxDiaIdx],
        valor: parseFloat(valorDia[maxDiaIdx].toFixed(2)),
      },
      semana_mais_pagamentos: maxSemana,
      por_dia: diasData,
      por_semana: semanasData,
      total_charges: succeeded.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// HISTÓRICO DO CLIENTE — GET /api/clientes/:customerId/historico
// ============================================================
// Retorna: info do cliente, todas as cobranças (lifetime), assinatura atual,
//          métricas (total pago, ticket médio, tempo, breakdowns), NFs emitidas.
app.get('/api/clientes/:customerId/historico', async (req, res) => {
  try {
    const { customerId } = req.params;
    if (!customerId) return res.status(400).json({ error: 'customerId obrigatorio' });

    // Busca em paralelo
    const [allCharges, activeSubs, customer] = await Promise.all([
      stripeListAll('charges', { customer: customerId }),
      stripeListAll('subscriptions', { customer: customerId, status: 'all' }),
      fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      }).then(r => r.json()).catch(() => null),
    ]);

    const nome  = customer?.name  || customer?.email || 'N/A';
    const email = customer?.email || '';
    const criado_em = customer?.created
      ? new Date(customer.created * 1000).toLocaleDateString('pt-BR') : null;

    const agora = Math.floor(Date.now() / 1000);
    const primeiraCobranca = allCharges.length > 0
      ? Math.min(...allCharges.map(c => c.created)) : (customer?.created || agora);
    const mesesConosco = parseFloat(((agora - primeiraCobranca) / (30.44 * 86400)).toFixed(1));

    // Classifica cada cobrança
    let total_mensalidade = 0, count_mensalidade = 0;
    let total_variavel    = 0, count_variavel    = 0;
    let total_impl        = 0, count_impl        = 0;

    const cobranças = allCharges
      .filter(c => c.status === 'succeeded')
      .sort((a, b) => b.created - a.created)
      .map(c => {
        const valor = (c.amount || 0) / 100;
        let tipo;
        if (c.invoice)            { tipo = 'mensalidade'; total_mensalidade += valor; count_mensalidade++; }
        else if (_isAutoRecharge(c)) { tipo = 'variavel';    total_variavel    += valor; count_variavel++;    }
        else                      { tipo = 'implementacao'; total_impl        += valor; count_impl++;        }
        return {
          id: c.id,
          data: new Date(c.created * 1000).toLocaleDateString('pt-BR'),
          data_ts: c.created,
          descricao: c.description || c.statement_descriptor || '-',
          valor: parseFloat(valor.toFixed(2)),
          tipo,
          invoice_id: c.invoice || null,
        };
      });

    const total_pago    = parseFloat((total_mensalidade + total_variavel + total_impl).toFixed(2));
    const total_real    = parseFloat((total_mensalidade + total_impl).toFixed(2)); // exclui variável
    const ticket_medio  = cobranças.length > 0
      ? parseFloat((total_pago / cobranças.length).toFixed(2)) : 0;

    // Todas as assinaturas ativas (cliente pode ter mais de uma — plano principal + adicionais)
    const subsAtivas = activeSubs.filter(s => s.status === 'active');
    const subAtiva = subsAtivas[0] || null; // usada para dados de assinatura principal
    let mrr_atual = 0;
    const planos_ativos = [];
    let proximo_vencimento_ts = null;

    for (const sub of subsAtivas) {
      for (const item of (sub.items?.data || [])) {
        const price = item.price;
        if (!price?.recurring) continue;
        let v = (price.unit_amount || 0) / 100;
        if (price.recurring.interval === 'year') v /= 12;
        else if (price.recurring.interval === 'week') v = (v * 4.33);
        mrr_atual += v * (item.quantity || 1);
        const nome_plano = price.nickname || price.id;
        if (!planos_ativos.includes(nome_plano)) planos_ativos.push(nome_plano);
      }
      // Próximo vencimento = o mais próximo entre todas as subs ativas
      if (sub.current_period_end) {
        if (!proximo_vencimento_ts || sub.current_period_end < proximo_vencimento_ts) {
          proximo_vencimento_ts = sub.current_period_end;
        }
      }
    }
    const plano_atual = planos_ativos.join(' + ') || null;

    // NFs emitidas para este cliente (busca em todo o histórico por email/nome)
    const nomeNorm = normStr(nome);
    const emailNorm = normStr(email);
    const nfsCliente = nfHistorico.filter(n => {
      if (email && n.email_cliente === email) return true;
      const nfNorm = normStr(n.nome_razao_social);
      const words  = nfNorm.split(/\s+/).filter(w => w.length > 3);
      if (words.length === 0) return false;
      return words.filter(w => nomeNorm.includes(w)).length / words.length >= 0.5;
    });

    const r = v => parseFloat((v || 0).toFixed(2));
    res.json({
      cliente: { id: customerId, nome, email, criado_em, meses_conosco: mesesConosco },
      metricas: {
        total_pago: r(total_pago),
        total_real: r(total_real),
        total_mensalidade: r(total_mensalidade),
        total_implementacao: r(total_impl),
        total_variavel: r(total_variavel),
        ticket_medio,
        meses_conosco: mesesConosco,
        mrr_atual: r(mrr_atual),
        plano_atual,
        count_cobranças: cobranças.length,
        count_mensalidade,
        count_impl,
        count_variavel,
      },
      assinatura: subAtiva ? {
        id: subAtiva.id,
        status: subAtiva.status,
        inicio: new Date(subAtiva.created * 1000).toLocaleDateString('pt-BR'),
        proximo_vencimento: proximo_vencimento_ts
          ? new Date(proximo_vencimento_ts * 1000).toLocaleDateString('pt-BR') : null,
        plano: plano_atual,
        mrr: r(mrr_atual),
        total_assinaturas: subsAtivas.length,
        assinaturas: subsAtivas.map(s => ({
          id: s.id,
          plano: s.items?.data?.map(i => i.price?.nickname || i.price?.id).join(', ') || null,
          proximo_vencimento: s.current_period_end
            ? new Date(s.current_period_end * 1000).toLocaleDateString('pt-BR') : null,
          mrr: r(s.items?.data?.reduce((acc, item) => {
            const price = item.price;
            if (!price?.recurring) return acc;
            let v = (price.unit_amount || 0) / 100;
            if (price.recurring.interval === 'year') v /= 12;
            return acc + v * (item.quantity || 1);
          }, 0)),
        })),
      } : null,
      cobranças,
      notas_fiscais: nfsCliente.map(n => ({
        mes_ano: n.mes_ano || null,
        data: n.data_emissao || n.ts?.slice(0, 10) || null,
        numero_nf: n.numero_nf || null,
        status: n.status,
        origem: n.origem,
        valor: n.valor || null,
        nome_razao_social: n.nome_razao_social,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AGENTE ANALISTA FINANCEIRO — powered by Claude AI
// ═══════════════════════════════════════════════════════════════════════════

const ANALISE_DATA_FILE     = path.join(__dirname, 'analise-financeira.json');
const CONHECIMENTO_FIN_FILE = path.join(__dirname, 'conhecimento-financeiro.json');

let analisesHistorico = [];
let conhecimentoFin   = {};

function loadAnaliseData() {
  try {
    if (fs.existsSync(ANALISE_DATA_FILE))
      analisesHistorico = JSON.parse(fs.readFileSync(ANALISE_DATA_FILE, 'utf8')) || [];
    if (fs.existsSync(CONHECIMENTO_FIN_FILE))
      conhecimentoFin = JSON.parse(fs.readFileSync(CONHECIMENTO_FIN_FILE, 'utf8')) || {};
    console.log(`[Analise] ${analisesHistorico.length} análises carregadas`);
  } catch(e) { console.error('[Analise] Erro ao carregar:', e.message); }
}

function saveAnaliseData() {
  try {
    fs.writeFileSync(ANALISE_DATA_FILE, JSON.stringify(analisesHistorico), 'utf8');
    fs.writeFileSync(CONHECIMENTO_FIN_FILE, JSON.stringify(conhecimentoFin, null, 2), 'utf8');
  } catch(e) { console.error('[Analise] Erro ao salvar:', e.message); }
}

loadAnaliseData();

// ── Chamada à API Claude via https nativo ─────────────────────────────────────
function callClaude(systemPrompt, userPrompt, maxTokens = 6000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) return reject(new Error('ANTHROPIC_API_KEY não configurada'));

    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.content?.[0]) resolve(json.content[0].text);
          else reject(new Error('Claude error: ' + JSON.stringify(json).slice(0, 300)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── callClaude multi-turn (suporta histórico de conversa) ────────────────────
function callClaudeMulti(systemPrompt, messages, maxTokens = 3000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) return reject(new Error('ANTHROPIC_API_KEY não configurada'));

    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });

    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.content?.[0]) resolve(json.content[0].text);
          else reject(new Error('Claude error: ' + JSON.stringify(json).slice(0, 300)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Coleta dados financeiros internamente ─────────────────────────────────────
async function coletarDadosFinanceiros(inicioTs, fimTs) {
  const agora  = Math.floor(Date.now() / 1000);
  const inicio = inicioTs || (agora - 30 * 86400);
  const fim    = fimTs    || agora;

  const [charges, activeSubs, canceledSubs, allCustomers] = await Promise.all([
    stripeListAll('charges', { 'created[gte]': String(inicio), 'created[lte]': String(fim) }),
    stripeListAll('subscriptions', { status: 'active' }),
    stripeListAll('subscriptions', { status: 'canceled' }).then(subs =>
      subs.filter(s => s.ended_at && s.ended_at >= inicio)
    ).catch(() => []),
    stripeListAll('customers', {}),
  ]);

  // MRR snapshot + distribuição de planos
  let mrr = 0;
  const planCount = {};
  for (const sub of activeSubs) {
    for (const item of (sub.items?.data || [])) {
      const price = item.price;
      if (!price?.recurring) continue;
      let v = (price.unit_amount || 0) / 100;
      if (price.recurring.interval === 'year') v /= 12;
      mrr += v * (item.quantity || 1);
      const cat = classifyAssinatura(price.nickname || '', v);
      planCount[cat] = (planCount[cat] || 0) + 1;
    }
  }

  // Receita do período
  const succeeded      = charges.filter(c => c.status === 'succeeded');
  const cobranças_reais = succeeded.filter(c => !_isAutoRecharge(c));
  const receitaReal    = cobranças_reais.reduce((s, c) => s + (c.amount || 0) / 100, 0);
  const clientesUnicos = new Set(cobranças_reais.map(c => c.customer || c.billing_details?.email)).size;
  const ticketMedio    = clientesUnicos > 0 ? receitaReal / clientesUnicos : 0;

  // LTV médio
  const agoraTs = Math.floor(Date.now() / 1000);
  let somaVida = 0, countCust = 0;
  for (const c of allCustomers) {
    if (c.created) { somaVida += (agoraTs - c.created) / (30.44 * 86400); countCust++; }
  }
  const avgMeses = countCust > 0 ? somaVida / countCust : 12;

  // Clientes com sub ativa mas sem cobrança no período (risco churn)
  const clientesComCobranca = new Set(succeeded.map(c => c.customer));
  const clientesRisco = activeSubs
    .filter(s => !clientesComCobranca.has(s.customer))
    .map(s => { const c = allCustomers.find(x => x.id === s.customer); return c?.name || c?.email || s.customer; })
    .slice(0, 10);

  // Top 5 clientes do período
  const receitaPorCliente = {};
  for (const ch of cobranças_reais) {
    const cid = ch.customer || 'avulso';
    receitaPorCliente[cid] = (receitaPorCliente[cid] || 0) + (ch.amount || 0) / 100;
  }
  const topClientes = Object.entries(receitaPorCliente)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([cid, valor]) => {
      const c = allCustomers.find(x => x.id === cid);
      return { nome: c?.name || c?.email || cid, valor: parseFloat(valor.toFixed(2)) };
    });

  // PagBank — implementações do período
  const pbReq = { query: { start: String(inicio), end: String(fim) } };
  const { inicio: pbIn, fim: pbFim } = getPeriodoPagbank(pbReq);
  const txsPB = await pagbankListAllTx(pbIn, pbFim).catch(() => []);
  const IMPL_TIPOS = ['implementacao_basica', 'implementacao_personalizada', 'implementacao_avancada', 'implementacao'];
  const implsPeriodo = txsPB.filter(tx => {
    if (!['pago', 'disponivel'].includes(tx.status)) return false;
    return IMPL_TIPOS.includes(classifyTipo(tx.link_pagamento || '', tx.bruto, tx.metodo, 'pagbank'));
  });
  const receitaImpl = implsPeriodo.reduce((s, t) => s + t.bruto, 0);
  const implPorTipo = {};
  for (const tx of implsPeriodo) {
    const tipo = classifyTipo(tx.link_pagamento || '', tx.bruto, tx.metodo, 'pagbank');
    implPorTipo[tipo] = (implPorTipo[tipo] || 0) + 1;
  }

  return {
    periodo: {
      inicio: new Date(inicio * 1000).toLocaleDateString('pt-BR'),
      fim:    new Date(fim    * 1000).toLocaleDateString('pt-BR'),
    },
    stripe: {
      mrr:                    parseFloat(mrr.toFixed(2)),
      assinaturas_ativas:     activeSubs.length,
      cancelamentos_periodo:  canceledSubs.length,
      receita_real_periodo:   parseFloat(receitaReal.toFixed(2)),
      ticket_medio:           parseFloat(ticketMedio.toFixed(2)),
      ltv_estimado:           parseFloat((ticketMedio * avgMeses).toFixed(2)),
      avg_meses_cliente:      parseFloat(avgMeses.toFixed(1)),
      distribuicao_planos:    planCount,
      clientes_sem_cobranca:  clientesRisco,
      top_clientes:           topClientes,
      novos_clientes_periodo: allCustomers.filter(c => c.created >= inicio && c.created <= fim).length,
    },
    pagbank: {
      implementacoes_count:     implsPeriodo.length,
      receita_implementacoes:   parseFloat(receitaImpl.toFixed(2)),
      distribuicao_tipos:       implPorTipo,
    },
    totais: {
      receita_total_periodo: parseFloat((receitaReal + receitaImpl).toFixed(2)),
    },
  };
}

// ── POST /api/analise-financeira ──────────────────────────────────────────────
app.post('/api/analise-financeira', async (req, res) => {
  try {
    const { inicio, fim, forcar = false } = req.body || {};

    // Cache de 3h
    const ultima = analisesHistorico[0];
    if (!forcar && ultima) {
      const horas = (Date.now() - new Date(ultima.data).getTime()) / 3600000;
      if (horas < 3) return res.json({ cache: true, analise: ultima });
    }

    const dados = await coletarDadosFinanceiros(inicio, fim);

    const systemPrompt = `Você é um CFO / analista financeiro sênior especializado em SaaS B2B brasileiro.
Analise os dados e retorne APENAS JSON válido, sem markdown, sem texto extra.
Strings máximo 100 caracteres. Seja direto, específico e acionável.

JSON schema EXATO:
{
  "resumo_executivo": "string",
  "saude_financeira": "otima|boa|atencao|critica",
  "mrr_analise": "string",
  "insights": [{ "titulo": "string", "descricao": "string", "impacto": "alto|medio|baixo" }],
  "alertas": [{ "titulo": "string", "descricao": "string", "urgencia": "imediata|esta_semana|proximo_mes" }],
  "acoes_recomendadas": [{ "acao": "string", "motivo": "string", "prazo": "string" }],
  "benchmark": { "churn_rate_estimado": "string", "ltv_cac_avaliacao": "string", "crescimento_estimado": "string" }
}`;

    const historicoCurto = (conhecimentoFin.historico_analises || []).slice(-3)
      .map(h => ({ data: h.data, mrr: h.mrr, assinaturas: h.assinaturas, resumo: h.resumo, saude: h.saude }));

    const userPrompt = `HISTÓRICO DAS ÚLTIMAS ANÁLISES:
${JSON.stringify(historicoCurto)}

FEEDBACKS DO USUÁRIO:
${JSON.stringify((conhecimentoFin.feedbacks || []).slice(-10))}

DADOS FINANCEIROS ATUAIS:
${JSON.stringify(dados)}

Gere análise completa como CFO/analista sênior.`;

    const rawText = await callClaude(systemPrompt, userPrompt, 6000);

    let analise;
    try {
      const clean = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      analise = JSON.parse(clean);
    } catch(e) {
      return res.status(500).json({ error: 'JSON inválido do Claude', raw: rawText.slice(0, 500) });
    }

    const registro = { id: Date.now().toString(), data: new Date().toISOString(), dados_periodo: dados, analise };
    analisesHistorico.unshift(registro);
    if (analisesHistorico.length > 20) analisesHistorico = analisesHistorico.slice(0, 20);

    conhecimentoFin.historico_analises = (conhecimentoFin.historico_analises || []);
    conhecimentoFin.historico_analises.push({
      data: registro.data, mrr: dados.stripe.mrr,
      assinaturas: dados.stripe.assinaturas_ativas,
      implementacoes: dados.pagbank.implementacoes_count,
      resumo: analise.resumo_executivo, saude: analise.saude_financeira,
    });
    conhecimentoFin.historico_analises = conhecimentoFin.historico_analises.slice(-10);

    saveAnaliseData();
    res.json({ cache: false, analise: registro });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analise-financeira/ultima ────────────────────────────────────────
app.get('/api/analise-financeira/ultima', (req, res) => {
  if (!analisesHistorico.length) return res.json({ analise: null });
  res.json({ analise: analisesHistorico[0] });
});

// ── GET /api/analise-financeira/historico ─────────────────────────────────────
app.get('/api/analise-financeira/historico', (req, res) => {
  const limit = parseInt(req.query.limit || '10');
  res.json({
    total: analisesHistorico.length,
    historico: analisesHistorico.slice(0, limit).map(a => ({
      id: a.id, data: a.data,
      saude: a.analise?.saude_financeira,
      resumo: a.analise?.resumo_executivo,
      mrr: a.dados_periodo?.stripe?.mrr,
      assinaturas: a.dados_periodo?.stripe?.assinaturas_ativas,
    })),
  });
});

// ── POST /api/analise-financeira/feedback ─────────────────────────────────────
app.post('/api/analise-financeira/feedback', (req, res) => {
  const { analise_id, avaliacao, comentario } = req.body;
  const analise = analisesHistorico.find(a => a.id === analise_id);
  if (analise) {
    analise.feedbacks = analise.feedbacks || [];
    analise.feedbacks.push({ avaliacao, comentario, data: new Date().toISOString() });
  }
  if (comentario?.length > 5) {
    conhecimentoFin.feedbacks = (conhecimentoFin.feedbacks || []);
    conhecimentoFin.feedbacks.push({
      avaliacao, comentario, data: new Date().toISOString(),
      contexto: analise?.analise?.resumo_executivo?.slice(0, 80) || null,
    });
    conhecimentoFin.feedbacks = conhecimentoFin.feedbacks.slice(-50);
  }
  saveAnaliseData();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAT COM CFO VIRTUAL — conversa em tempo real com contexto financeiro completo
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/chat-financeiro ─────────────────────────────────────────────────
app.post('/api/chat-financeiro', async (req, res) => {
  try {
    const { mensagem, historico = [], pagina_atual = null } = req.body || {};
    if (!mensagem || !mensagem.trim()) return res.status(400).json({ error: 'mensagem obrigatória' });

    // Contexto: última análise gravada — se não houver, coleta dados ao vivo (sem chamar Claude/IA)
    let ultimaAnalise = analisesHistorico[0];
    let dadosAoVivo   = null;
    if (!ultimaAnalise) {
      try {
        dadosAoVivo = await coletarDadosFinanceiros();
        console.log('[Chat] Sem análise em memória — usando dados coletados ao vivo');
      } catch(e) {
        console.error('[Chat] Falha ao coletar dados ao vivo:', e.message);
      }
    }
    const dados   = ultimaAnalise?.dados_periodo || dadosAoVivo || {};
    const analise = ultimaAnalise?.analise       || {};
    const stripe         = dados?.stripe  || {};
    const pagbank        = dados?.pagbank || {};
    const periodo        = dados?.periodo || {};

    const topClientes        = stripe.top_clientes            || [];
    const semCobranca        = stripe.clientes_sem_cobranca   || [];
    const distribuicaoPlanos = stripe.distribuicao_planos     || {};
    const historicoTendencia = (conhecimentoFin.historico_analises || []).slice(-6);
    const insightsAcumulados = (conhecimentoFin.insights_chat      || []).slice(-20);

    // Concentração de receita por cliente (% do MRR)
    const receitaTotal = stripe.receita_real_periodo || 0;
    const topClientesFormatado = topClientes.map((c, i) => {
      const pct = receitaTotal > 0 ? ((c.valor / receitaTotal) * 100).toFixed(1) : '?';
      return `${i + 1}. **${c.nome}** — R$${c.valor.toFixed(2)} (${pct}% da receita)`;
    }).join('\n');

    const systemPrompt = `Você é o CFO Virtual da Abil, um assistente financeiro sênior com acesso completo e em tempo real aos dados da empresa. Responda sempre em português brasileiro com tom profissional e direto.

## SNAPSHOT FINANCEIRO — Período ${periodo.inicio || '?'} a ${periodo.fim || '?'}

### Stripe (Assinaturas)
- MRR atual: **R$${(stripe.mrr || 0).toFixed(2)}**
- Assinaturas ativas: **${stripe.assinaturas_ativas || 0}**
- Cancelamentos no período: ${stripe.cancelamentos_periodo || 0}
- Novos clientes: ${stripe.novos_clientes_periodo || 0}
- Receita bruta Stripe no período: R$${(stripe.receita_real_periodo || 0).toFixed(2)}
- Ticket médio: R$${(stripe.ticket_medio || 0).toFixed(2)}
- LTV estimado: R$${(stripe.ltv_estimado || 0).toFixed(2)}
- Distribuição de planos: ${JSON.stringify(distribuicaoPlanos)}

### Top 5 Clientes por Receita (período)
${topClientesFormatado || 'Dados ainda não disponíveis — gere uma análise primeiro'}

### Clientes com assinatura ativa mas sem cobrança recente (risco churn)
${semCobranca.length ? semCobranca.map(n => `- ${n}`).join('\n') : 'Nenhum identificado'}

### PagBank (Implementações)
- Implementações realizadas: ${pagbank.implementacoes_count || 0}
- Receita de implementações: R$${(pagbank.receita_implementacoes || 0).toFixed(2)}
- Distribuição por tipo: ${JSON.stringify(pagbank.distribuicao_tipos || {})}

### Receita Total do Período
- **R$${(dados?.totais?.receita_total_periodo || 0).toFixed(2)}** (Stripe + PagBank)

## AVALIAÇÃO DO CFO
- Saúde financeira: **${analise.saude_financeira || 'N/A'}**
- Resumo executivo: ${analise.resumo_executivo || 'Análise não gerada ainda'}
- Alertas: ${JSON.stringify((analise.alertas || []).slice(0, 3))}
- Insights: ${JSON.stringify((analise.insights || []).slice(0, 3))}

## TENDÊNCIA HISTÓRICA (últimas análises)
${historicoTendencia.map(h =>
  `• ${new Date(h.data).toLocaleDateString('pt-BR')}: MRR R$${h.mrr} | ${h.assinaturas} subs | ${h.saude}`
).join('\n') || 'Primeira análise ainda'}

## CONHECIMENTO ACUMULADO DE CONVERSAS
${insightsAcumulados.length ? insightsAcumulados.map(i => `• ${i}`).join('\n') : 'Sem histórico de conversas'}

## PÁGINA ATUAL DO USUÁRIO
${pagina_atual ? `O usuário está vendo a aba: **${pagina_atual}**. Priorize informações e insights relevantes para essa visão. Ex: se está em "Clientes", foque em análise de clientes; se em "Pagamentos", foque em cobranças e receita; se em "Falhas", foque em inadimplência; se em "PagBank", foque em implementações.` : 'Página não informada — responda de forma geral.'}

## REGRAS DE RESPOSTA
- Use **markdown**: negrito, listas, tabelas quando enriquecer a leitura
- Seja específico: cite números reais dos dados acima
- Se um dado não está disponível, diga claramente e explique o que precisaria
- Para perguntas sobre clientes específicos, use os dados de top_clientes acima
- Dê recomendações acionáveis, não genéricas
- Máximo 600 palavras por resposta, a menos que o usuário peça detalhe`;

    // Monta histórico da conversa (limita a 12 trocas para não explodir tokens)
    const msgs = [
      ...historico.slice(-12),
      { role: 'user', content: mensagem.trim() },
    ];

    const resposta = await callClaudeMulti(systemPrompt, msgs, 2500);

    // ── Acumula no knowledge base ────────────────────────────────────────────
    conhecimentoFin.conversas = (conhecimentoFin.conversas || []);
    conhecimentoFin.conversas.push({
      pergunta:  mensagem.trim().slice(0, 200),
      resposta:  resposta.slice(0, 600),
      timestamp: new Date().toISOString(),
    });
    conhecimentoFin.conversas = conhecimentoFin.conversas.slice(-100);

    // Salva resumo do insight como aprendizado
    if (mensagem.trim().length > 15) {
      conhecimentoFin.insights_chat = (conhecimentoFin.insights_chat || []);
      const insight = `[${new Date().toLocaleDateString('pt-BR')}] P: "${mensagem.trim().slice(0, 80)}" → ${resposta.slice(0, 180)}`;
      conhecimentoFin.insights_chat.push(insight);
      conhecimentoFin.insights_chat = conhecimentoFin.insights_chat.slice(-30);
    }

    saveAnaliseData();
    res.json({ resposta, timestamp: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe API backend rodando na porta ${PORT}`);
});
