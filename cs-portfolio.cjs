const crypto=require('node:crypto');
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9]{20}$/.test(v);
// Plano e valor recorrente da assinatura, para o CS saber o nível de acompanhamento.
// Regra: valor ausente nunca vira zero. Sem preço fixo confiável => null.
const NOMES={1:'mensal',2:'bimestral',3:'trimestral',6:'semestral',12:'anual'};
function recorrente(s,products={}){
 const itens=(s.items?.data||[]).map(it=>{const p=it.price||it.plan;if(!p)return null;const rec=p.recurring||(p.interval?{interval:p.interval,interval_count:p.interval_count,usage_type:p.usage_type}:null);
  // Item medido por uso é consumo variável, não mensalidade.
  if(!rec||rec.usage_type==='metered')return null;const n=rec.interval_count||1,unit=p.unit_amount??p.amount,qty=it.quantity??1,pid=typeof p.product==='string'?p.product:p.product?.id;
  return{nome:p.nickname||(typeof p.product==='object'?p.product?.name:null)||products[pid]||null,cents:Number.isSafeInteger(unit)&&Number.isSafeInteger(qty)?unit*qty:null,moeda:String(p.currency||'').toUpperCase(),meses:rec.interval==='month'?n:rec.interval==='year'?12*n:null,semanal:rec.interval==='week'&&n===1};}).filter(Boolean);
 if(!itens.length)return{plano:null,valor_recorrente:null};
 const nomes=[...new Set(itens.map(i=>i.nome).filter(Boolean))],plano=nomes.length?nomes.join(' + ').slice(0,200):null,moeda=itens[0].moeda;
 if(itens.some(i=>i.cents===null||i.moeda!==moeda)||!/^[A-Z]{3}$/.test(moeda))return{plano,valor_recorrente:null};
 let cents,extra;
 if(itens.every(i=>i.meses&&i.meses===itens[0].meses)){cents=itens.reduce((t,i)=>t+i.cents,0);extra={periodicidade:NOMES[itens[0].meses]||'outro',meses:itens[0].meses};}
 else if(itens.every(i=>i.semanal)){cents=itens.reduce((t,i)=>t+i.cents,0);extra={periodicidade:'semanal'};}
 // Períodos diferentes na mesma assinatura: soma pelo equivalente mensal e avisa.
 else if(itens.every(i=>i.meses)){cents=itens.reduce((t,i)=>t+i.cents/i.meses,0);extra={periodicidade:'mensal',meses:1,equivalente:true};}
 else return{plano,valor_recorrente:null};
 // Cupom vigente na assinatura (objeto discount): o CS precisa do valor cobrado de fato.
 const cupom=s.discount?.coupon;if(cupom&&typeof cupom==='object'){if(Number.isFinite(cupom.percent_off)&&cupom.percent_off>0){cents=cents*(1-cupom.percent_off/100);extra.com_desconto=true;}else if(Number.isSafeInteger(cupom.amount_off)&&cupom.amount_off>0&&String(cupom.currency||'').toUpperCase()===moeda){cents=cents-cupom.amount_off;extra.com_desconto=true;}}
 const valor=Math.round(cents)/100;
 return{plano,valor_recorrente:valor>0?{valor,moeda,...extra}:null};
}
// Implementação (pagamento único) confirmada à mão na Gestão de clientes, por ID da conta.
function implementation(gestao,account){
 const i=valid(account)?gestao?.[account]?.implementacao:null;if(!i)return null;
 const valor=typeof i.valor==='number'?i.valor:typeof i.valor==='string'&&/^\d+(\.\d+)?$/.test(i.valor.trim())?Number(i.valor):NaN;
 if(!Number.isFinite(valor)||valor<=0)return null;
 const paga=typeof i.data_pagamento==='string'&&Number.isFinite(Date.parse(i.data_pagamento))?i.data_pagamento:null;
 return{valor:Math.round(valor*100)/100,moeda:'BRL',status:typeof i.status==='string'?i.status:null,paga_em:paga};
}
function implementations(gestao){return Object.fromEntries(Object.keys(gestao||{}).map(id=>[id,implementation(gestao,id)]).filter(([,v])=>v));}
function contracts(subs,mappings={},gestao={},products={}){
 if(!Array.isArray(subs))throw Error('Subscription collection incomplete');
 return [...new Map(subs.map(s=>{const customer=typeof s.customer==='string'?s.customer:s.customer?.id;if(!s.id||!customer)throw Error('Invalid subscription identity');const mapping=mappings[customer];const manual=typeof mapping==='string'?mapping:mapping?.ghl_location_id||mapping?.location_id||mapping?.ghl_id;const account=s.metadata?.locationId;const ids=valid(account)&&valid(manual)&&account!==manual?[]:valid(account)?[account]:valid(manual)?[manual]:[];const impl=ids.length===1?implementation(gestao,ids[0]):null;return[s.id,{id:s.id,fonte:'stripe',cliente_id:customer,account_ids:ids,vinculo:valid(account)&&valid(manual)&&account!==manual?'conflito':valid(account)?'subscription_metadata':valid(manual)?'manual_confirmed':'ausente',status:s.status,inicio:s.start_date?new Date(s.start_date*1000).toISOString():null,fim:s.ended_at?new Date(s.ended_at*1000).toISOString():null,cancela_em:s.cancel_at?new Date(s.cancel_at*1000).toISOString():s.cancel_at_period_end&&s.current_period_end?new Date(s.current_period_end*1000).toISOString():null,...recorrente(s,products),...(impl?{implementacao:impl}:{})}]})).values()];
}
// Nome do produto só é buscado quando algum preço fixo não tem apelido; falha aqui não derruba a carteira (plano fica null).
async function productNames(list,subs){
 const falta=subs.some(s=>(s.items?.data||[]).some(it=>{const p=it.price||it.plan;return p&&!p.nickname&&typeof p.product==='string'&&(p.recurring||p).usage_type!=='metered'}));
 if(!falta)return{};
 try{const rows=await list('products',{});return Array.isArray(rows)?Object.fromEntries(rows.filter(p=>p?.id&&typeof p.name==='string'&&p.name.trim()).map(p=>[p.id,p.name.trim()])):{};}catch{return{};}
}
function register(app,list,getMappings,getGestao=()=>({})){let cached=null,pending=null;app.get('/api/finance/cs-contracts',async(req,res)=>{
 const expected=process.env.FINANCE_SERVICE_TOKEN,provided=req.get('X-Finance-Service')||'';if(!expected||expected.length<24)return res.status(503).json({error:'Service identity missing'});if(provided.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return res.status(401).json({error:'Unauthorized'});
 try{if(!cached||Date.now()-cached.at>300000){pending||=(async()=>{const subs=await list('subscriptions',{status:'all'});if(!Array.isArray(subs))throw Error('Subscription collection incomplete');const gestao=getGestao()||{},rows=contracts(subs,getMappings(),gestao,await productNames(list,subs));cached={at:Date.now(),rows,implementacoes:implementations(gestao)};})().finally(()=>pending=null);await pending;}res.json({contratos:cached.rows,implementacoes:cached.implementacoes,completa:true,coletado_em:new Date(cached.at).toISOString()});}catch{res.status(503).json({error:'Contract source incomplete; previous snapshot preserved'});}
 });}
module.exports={contracts,register,recorrente,implementation,implementations};
