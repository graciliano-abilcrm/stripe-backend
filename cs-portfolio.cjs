const crypto=require('node:crypto');
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9]{20}$/.test(v);
function contracts(subs,mappings={}){
 if(!Array.isArray(subs))throw Error('Subscription collection incomplete');
 return [...new Map(subs.map(s=>{const customer=typeof s.customer==='string'?s.customer:s.customer?.id;if(!s.id||!customer)throw Error('Invalid subscription identity');const mapping=mappings[customer];const manual=typeof mapping==='string'?mapping:mapping?.ghl_location_id||mapping?.location_id||mapping?.ghl_id;const account=s.metadata?.locationId;return[s.id,{id:s.id,fonte:'stripe',cliente_id:customer,account_ids:valid(account)&&valid(manual)&&account!==manual?[]:valid(account)?[account]:valid(manual)?[manual]:[],vinculo:valid(account)&&valid(manual)&&account!==manual?'conflito':valid(account)?'subscription_metadata':valid(manual)?'manual_confirmed':'ausente',status:s.status,inicio:s.start_date?new Date(s.start_date*1000).toISOString():null,fim:s.ended_at?new Date(s.ended_at*1000).toISOString():null,cancela_em:s.cancel_at?new Date(s.cancel_at*1000).toISOString():s.cancel_at_period_end&&s.current_period_end?new Date(s.current_period_end*1000).toISOString():null}]})).values()];
}
function register(app,list,getMappings){let cached=null,pending=null;app.get('/api/finance/cs-contracts',async(req,res)=>{
 const expected=process.env.FINANCE_SERVICE_TOKEN,provided=req.get('X-Finance-Service')||'';if(!expected||expected.length<24)return res.status(503).json({error:'Service identity missing'});if(provided.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return res.status(401).json({error:'Unauthorized'});
 try{if(!cached||Date.now()-cached.at>300000){pending||=(async()=>{const rows=contracts(await list('subscriptions',{status:'all'}),getMappings());cached={at:Date.now(),rows};})().finally(()=>pending=null);await pending;}res.json({contratos:cached.rows,completa:true,coletado_em:new Date(cached.at).toISOString()});}catch{res.status(503).json({error:'Contract source incomplete; previous snapshot preserved'});}
 });}
module.exports={contracts,register};
