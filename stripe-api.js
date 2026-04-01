const express = require('express');
const cors = require('cors');
const https = require('https');

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
function classifyTipo(descricao, valor, metodo, plataforma) {
  if (metodo === 'recorrente') return 'assinatura';
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
    targetDate = addBizDays(txDate, 2);
  } else if (metodo === 'pix') {
    targetDate = addBizDays(txDate, 1);
  } else if (metodo === 'boleto') {
    targetDate = addBizDays(txDate, 3);
  } else if (metodo === 'debito') {
    targetDate = addBizDays(txDate, 2);
  } else {
    targetDate = new Date(txDate.getTime() + 30 * 24 * 60 * 60 * 1000);
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

const fs = require('fs');
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

app.listen(PORT, () => {
  console.log(`Stripe API backend rodando na porta ${PORT}`);
});
