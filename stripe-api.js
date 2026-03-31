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
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ _body: data, _status: res.statusCode }));
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
    inicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
    fim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59);
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

function parseTx(txXml) {
  const pmMatch = txXml.match(/<paymentMethod[^>]*>([\s\S]*?)<\/paymentMethod>/);
  const pmType = pmMatch ? xmlVal(pmMatch[1], 'type') : '';
  const methodMap = { '1': 'cartao', '2': 'boleto', '3': 'debito', '4': 'saldo', '7': 'pix', '11': 'recorrente' };
  const statusMap = { '1': 'aguardando', '2': 'em_analise', '3': 'pago', '4': 'disponivel', '5': 'em_disputa', '6': 'devolvido', '7': 'cancelado', '8': 'chargeback', '9': 'retencao' };
  const senderMatch = txXml.match(/<sender[^>]*>([\s\S]*?)<\/sender>/);
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
    data: xmlVal(txXml, 'date').substring(0, 10),
  };
}

async function pagbankListAllTx(initialDate, finalDate) {
  let all = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const result = await pagbankLegacyRequest('/v3/transactions', {
      initialDate, finalDate, maxPageResults: 100, page,
    });
    const xml = result._body;
    if (!xml.includes('<transactionSearchResult>')) {
      throw new Error('PagBank API error (' + result._status + '): ' + xml.substring(0, 300));
    }
    const txXmls = xmlAll(xml, 'transaction');
    all = all.concat(txXmls.map(parseTx));
    const tp = parseInt(xmlVal(xml, 'totalPages') || '1');
    totalPages = tp > 0 ? tp : 1;
    page++;
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
    res.json({ transacoes: txs, total: txs.length });
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


app.listen(PORT, () => {
  console.log(`Stripe API backend rodando na porta ${PORT}`);
});
