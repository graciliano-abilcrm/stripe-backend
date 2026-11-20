const {test}=require('node:test'),assert=require('node:assert/strict');const{contracts,register}=require('./cs-portfolio.cjs');const a='AAAAAAAAAAAAAAAAAAAA',b='BBBBBBBBBBBBBBBBBBBB';
test('preserva contratos cancelados e ativos sem promover por nome',()=>{const r=contracts([{id:'s1',customer:'c',status:'canceled',metadata:{locationId:a}},{id:'s2',customer:'c',status:'active',cancel_at_period_end:true,current_period_end:2000000000}],{c:{ghl_location_id:a}});assert.equal(r.length,2);assert.equal(r[0].status,'canceled');assert.deepEqual(r[1].account_ids,[a]);assert.ok(r[1].cancela_em);});
test('conflito de IDs não escolhe silenciosamente um vínculo',()=>{assert.deepEqual(contracts([{id:'s',customer:'c',metadata:{locationId:a}}],{c:b})[0].account_ids,[]);assert.throws(()=>contracts(null));});
test('endpoint exige serviço e falha sem substituir por vazio',async()=>{let handler;const app={get:(p,h)=>handler=h};const old=process.env.FINANCE_SERVICE_TOKEN;process.env.FINANCE_SERVICE_TOKEN='x'.repeat(32);register(app,async()=>{throw Error('incomplete')},()=>({}));const response=()=>({code:200,status(c){this.code=c;return this},json(b){this.body=b;return this}});try{const denied=response();await handler({get:()=>''},denied);assert.equal(denied.code,401);const failed=response();await handler({get:()=>process.env.FINANCE_SERVICE_TOKEN},failed);assert.equal(failed.code,503);assert.equal(failed.body.contratos,undefined);}finally{if(old===undefined)delete process.env.FINANCE_SERVICE_TOKEN;else process.env.FINANCE_SERVICE_TOKEN=old;}});

const{recorrente,implementation,implementations}=require('./cs-portfolio.cjs');
const item=(unit,interval='month',extra={})=>({quantity:1,price:{unit_amount:unit,currency:'brl',nickname:'Scale',recurring:{interval,interval_count:1},...extra}});
test('plano e valor recorrente: mensal, anual, quantidade e nome do produto',()=>{
 assert.deepEqual(recorrente({items:{data:[item(87000)]}}),{plano:'Scale',valor_recorrente:{valor:870,moeda:'BRL',periodicidade:'mensal',meses:1}});
 assert.deepEqual(recorrente({items:{data:[item(835200,'year',{nickname:null,product:'prod_1'})]}},{prod_1:'Scale anual'}),{plano:'Scale anual',valor_recorrente:{valor:8352,moeda:'BRL',periodicidade:'anual',meses:12}});
 assert.deepEqual(recorrente({items:{data:[item(87000),{quantity:2,price:{unit_amount:5000,currency:'brl',nickname:'Usuário adicional',recurring:{interval:'month'}}}]}}),{plano:'Scale + Usuário adicional',valor_recorrente:{valor:970,moeda:'BRL',periodicidade:'mensal',meses:1}});
 assert.equal(recorrente({items:{data:[item(87000,'month',{recurring:{interval:'month',interval_count:6}})]}}).valor_recorrente.periodicidade,'semestral');
});
test('valor ausente nunca vira zero; uso medido fica fora; períodos mistos viram equivalente mensal',()=>{
 assert.deepEqual(recorrente({}),{plano:null,valor_recorrente:null});
 assert.deepEqual(recorrente({items:{data:[item(null)]}}),{plano:'Scale',valor_recorrente:null});
 assert.deepEqual(recorrente({items:{data:[item(0)]}}),{plano:'Scale',valor_recorrente:null});
 assert.deepEqual(recorrente({items:{data:[item(100,'month',{nickname:'WhatsApp',recurring:{interval:'month',usage_type:'metered'}})]}}),{plano:null,valor_recorrente:null});
 assert.deepEqual(recorrente({items:{data:[item(87000),item(120000,'year',{nickname:'Suporte'})]}}).valor_recorrente,{valor:970,moeda:'BRL',periodicidade:'mensal',meses:1,equivalente:true});
 assert.equal(recorrente({items:{data:[item(87000),item(1000,'month',{currency:'usd'})]}}).valor_recorrente,null);
});
test('cupom vigente reduz o valor e fica marcado',()=>{
 assert.deepEqual(recorrente({discount:{coupon:{percent_off:20}},items:{data:[item(187000)]}}).valor_recorrente,{valor:1496,moeda:'BRL',periodicidade:'mensal',meses:1,com_desconto:true});
 assert.equal(recorrente({discount:{coupon:{amount_off:7000,currency:'brl'}},items:{data:[item(87000)]}}).valor_recorrente.valor,800);
 assert.equal(recorrente({discount:{coupon:{percent_off:100}},items:{data:[item(87000)]}}).valor_recorrente,null);
});
test('implementação vem só da gestão confirmada pelo ID da conta e vai no contrato',()=>{
 const gestao={[a]:{implementacao:{status:'pago',valor:2500,data_pagamento:'2026-03-12'}},[b]:{implementacao:{status:'nao_informado',valor:null}},curto:{implementacao:{valor:900}}};
 assert.deepEqual(implementation(gestao,a),{valor:2500,moeda:'BRL',status:'pago',paga_em:'2026-03-12'});
 assert.equal(implementation(gestao,b),null);assert.equal(implementation(gestao,'curto'),null);assert.equal(implementation({[a]:{implementacao:{valor:'2.500,00'}}},a),null);assert.equal(implementation({[a]:{implementacao:{valor:'2500.50'}}},a).valor,2500.5);
 assert.deepEqual(implementations(gestao),{[a]:{valor:2500,moeda:'BRL',status:'pago',paga_em:'2026-03-12'}});
 const r=contracts([{id:'s1',customer:'c',status:'active',metadata:{locationId:a},items:{data:[item(87000)]}},{id:'s2',customer:'d',status:'active',metadata:{locationId:b}},{id:'s3',customer:'e',status:'active',metadata:{locationId:a}}],{e:b},gestao);
 assert.deepEqual(r[0].implementacao,{valor:2500,moeda:'BRL',status:'pago',paga_em:'2026-03-12'});assert.equal(r[0].plano,'Scale');assert.equal(r[0].valor_recorrente.valor,870);
 assert.equal('implementacao' in r[1],false);assert.equal(r[1].valor_recorrente,null);
 assert.deepEqual(r[2].account_ids,[]);assert.equal('implementacao' in r[2],false);
});
test('endpoint devolve implementações por conta e busca nome de produto sem derrubar a carteira',async()=>{let handler;const app={get:(p,h)=>handler=h};const old=process.env.FINANCE_SERVICE_TOKEN;process.env.FINANCE_SERVICE_TOKEN='x'.repeat(32);const calls=[];register(app,async(what)=>{calls.push(what);if(what==='products')throw Error('fora');return[{id:'s1',customer:'c',status:'active',metadata:{locationId:a},items:{data:[item(87000,'month',{nickname:null,product:'prod_1'})]}}]},()=>({}),()=>({[a]:{implementacao:{valor:1500}}}));const res={code:200,status(c){this.code=c;return this},json(x){this.body=x;return this}};try{await handler({get:()=>process.env.FINANCE_SERVICE_TOKEN},res);assert.equal(res.code,200);assert.deepEqual(calls,['subscriptions','products']);assert.equal(res.body.contratos[0].plano,null);assert.equal(res.body.contratos[0].valor_recorrente.valor,870);assert.deepEqual(res.body.implementacoes,{[a]:{valor:1500,moeda:'BRL',status:null,paga_em:null}});assert.equal(res.body.completa,true);}finally{if(old===undefined)delete process.env.FINANCE_SERVICE_TOKEN;else process.env.FINANCE_SERVICE_TOKEN=old;}});
