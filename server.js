require('dotenv').config();
const express=require('express'),helmet=require('helmet'),rateLimit=require('express-rate-limit'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),crypto=require('crypto'),path=require('path'),fs=require('fs'),Database=require('better-sqlite3');
const E=process.env;
const DB_FILE=E.DB_PATH||'./data.db';
try{fs.mkdirSync(path.dirname(path.resolve(DB_FILE)),{recursive:true})}catch(e){console.error('Cannot create DB folder:',e.message)}
// If JWT_SECRET / ENC_KEY are not set in the environment, generate them once and keep them beside the DB file.
if(!E.JWT_SECRET||E.JWT_SECRET.length<24||!E.ENC_KEY){
  const sf=path.join(path.dirname(path.resolve(DB_FILE)),'secrets.json');let sec={};
  try{sec=JSON.parse(fs.readFileSync(sf,'utf8'))}catch{}
  if(!sec.JWT_SECRET)sec.JWT_SECRET=crypto.randomBytes(32).toString('hex');
  if(!sec.ENC_KEY)sec.ENC_KEY=crypto.randomBytes(32).toString('hex');
  try{fs.writeFileSync(sf,JSON.stringify(sec),{mode:0o600})}catch(e){console.warn('WARNING: cannot persist secrets; set JWT_SECRET and ENC_KEY env vars.',e.message)}
  if(!E.JWT_SECRET||E.JWT_SECRET.length<24){E.JWT_SECRET=sec.JWT_SECRET;console.warn('JWT_SECRET not set: using auto-generated secret stored next to the database.')}
  if(!E.ENC_KEY)E.ENC_KEY=sec.ENC_KEY}
const db=new Database(DB_FILE);
db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');
db.exec(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
class HttpErr extends Error{constructor(c,m){super(m);this.code=c}}
const bad=(m,c=400)=>{throw new HttpErr(c,m)};
const r4=n=>Math.round(n*1e4)/1e4;
const KEY=crypto.createHash('sha256').update(E.ENC_KEY||E.JWT_SECRET).digest();
const enc=t=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',KEY,iv),b=Buffer.concat([c.update(t,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64')};
const dec=s=>{const b=Buffer.from(s,'base64'),d=crypto.createDecipheriv('aes-256-gcm',KEY,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8')};
const log=(uid,a,d)=>db.prepare('INSERT INTO logs(user_id,action,detail) VALUES(?,?,?)').run(uid,a,String(d||''));
const notify=(uid,t)=>db.prepare('INSERT INTO notifications(user_id,text) VALUES(?,?)').run(uid,t);
const setting=(k,d='')=>{const x=db.prepare('SELECT value FROM settings WHERE key=?').get(k);return x?x.value:d};
const num=(v,min=-1e9,max=1e9)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)bad('Invalid number');return n};
// Must run inside db.transaction(): moves balance + records ledger row
function money(uid,amt,type,note,ref){
  const u=db.prepare('SELECT balance FROM users WHERE id=?').get(uid),nb=r4(u.balance+amt);
  if(nb<0)bad('Insufficient balance');
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(nb,uid);
  db.prepare('INSERT INTO transactions(user_id,type,amount,balance_after,note,ref) VALUES(?,?,?,?,?,?)').run(uid,type,amt,nb,note||'',ref||null);
  return nb}
const upd=(t,id,b,f)=>{const k=f.filter(x=>b[x]!==undefined);if(!k.length)bad('Nothing to update');db.prepare(`UPDATE ${t} SET ${k.map(x=>x+'=?').join(',')} WHERE id=?`).run(...k.map(x=>b[x]),id)};
// ---------- supplier ----------
async function sup(p){
  if(!E.SUPPLIER_API_URL||!E.SUPPLIER_API_KEY)throw new Error('Supplier API not configured');
  const r=await fetch(E.SUPPLIER_API_URL,{method:'POST',body:new URLSearchParams({key:E.SUPPLIER_API_KEY,...p}),signal:AbortSignal.timeout(20000)});
  return r.json()}
const MAP={'pending':'Pending','in progress':'Processing','processing':'Processing','completed':'Completed','partial':'Partial','canceled':'Cancelled','cancelled':'Cancelled','failed':'Failed'};
const FINAL=['Completed','Partial','Failed','Cancelled'];
function finish(o,st,remains=0){
  db.transaction(()=>{
    const c=db.prepare('SELECT status FROM smm_orders WHERE id=?').get(o.id);
    if(FINAL.includes(c.status))return;
    let rf=0;
    if(st==='Failed'||st==='Cancelled')rf=o.charge;else if(st==='Partial')rf=r4(o.charge*remains/o.quantity);
    if(rf>0)money(o.user_id,rf,'refund',`SMM #${o.id} ${st}`);
    db.prepare('UPDATE smm_orders SET status=?,remains=?,refunded=?,updated=CURRENT_TIMESTAMP WHERE id=?').run(st,remains,rf,o.id);
    notify(o.user_id,`Order #${o.id}: ${st}`)})()}
async function submit(id){
  const o=db.prepare('SELECT * FROM smm_orders WHERE id=?').get(id),sv=db.prepare('SELECT * FROM services WHERE id=?').get(o.service_id);
  if(!sv.supplier_service){db.prepare("UPDATE smm_orders SET status='Processing',error='Manual fulfilment',updated=CURRENT_TIMESTAMP WHERE id=?").run(id);return}
  try{
    const r=await sup({action:'add',service:sv.supplier_service,link:o.link,quantity:o.quantity});
    if(r.order)db.prepare("UPDATE smm_orders SET status='Processing',supplier_order=?,error=NULL,updated=CURRENT_TIMESTAMP WHERE id=?").run(String(r.order),id);
    else{db.prepare('UPDATE smm_orders SET error=? WHERE id=?').run(String(r.error||'Supplier rejected'),id);finish(o,'Failed')}
  }catch(e){db.prepare('UPDATE smm_orders SET error=? WHERE id=?').run('Supplier unreachable, will retry: '+e.message,id)}}
async function syncOrders(){
  for(const o of db.prepare("SELECT * FROM smm_orders WHERE status IN('Pending','Processing') LIMIT 100").all()){
    if(!o.supplier_order){if(o.status==='Pending')await submit(o.id);continue}
    try{const r=await sup({action:'status',order:o.supplier_order});if(r.error){db.prepare('UPDATE smm_orders SET error=? WHERE id=?').run(String(r.error),o.id);continue}
      const st=MAP[String(r.status||'').toLowerCase()];if(!st)continue;
      if(FINAL.includes(st))finish(o,st,parseInt(r.remains)||0);else db.prepare('UPDATE smm_orders SET status=?,updated=CURRENT_TIMESTAMP WHERE id=?').run(st,o.id)
    }catch(e){db.prepare('UPDATE smm_orders SET error=? WHERE id=?').run(e.message,o.id)}}}
setInterval(()=>syncOrders().catch(()=>{}),60000);
// ---------- payments ----------
function confirmPayment(ref,providerRef,amount,by){
  return db.transaction(()=>{
    const p=db.prepare('SELECT * FROM payments WHERE ref=?').get(ref);
    if(!p)bad('Payment not found',404);
    if(p.status!=='pending')return p; // idempotent: never credit twice
    if(amount!=null&&Math.abs(Number(amount)-p.amount)>0.001)bad('Amount mismatch');
    if(providerRef&&db.prepare('SELECT 1 FROM payments WHERE provider_ref=?').get(String(providerRef)))bad('Transaction already used',409);
    money(p.user_id,r4(p.amount+p.bonus),'deposit',`Deposit ${p.ref}`+(p.bonus?` (+bonus ${p.bonus})`:''),p.ref);
    db.prepare("UPDATE payments SET status='paid',provider_ref=?,paid_at=CURRENT_TIMESTAMP WHERE id=?").run(providerRef?String(providerRef):null,p.id);
    notify(p.user_id,`Deposit $${p.amount} confirmed`);log(by,'payment_confirm',ref);return p})()}
// ---------- app ----------
const app=express();app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false,frameguard:false}));
app.use(express.json({limit:'100kb'}));
app.use('/api',rateLimit({windowMs:60000,limit:120,standardHeaders:true,legacyHeaders:false}));
const authLimit=rateLimit({windowMs:15*60000,limit:20});
const w=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(n);
const sign=u=>jwt.sign({id:u.id},E.JWT_SECRET,{expiresIn:'30d'});
const pub=u=>({id:u.id,username:u.username,email:u.email,balance:u.balance,role:u.role});
function auth(q,s,n){try{const{id}=jwt.verify((q.headers.authorization||'').slice(7),E.JWT_SECRET);const u=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!u||u.banned)return s.status(401).json({error:'Unauthorized'});q.user=u;n()}catch{s.status(401).json({error:'Unauthorized'})}}
const adm=(q,s,n)=>q.user.role==='admin'?n():s.status(403).json({error:'Forbidden'});
const A=express.Router();app.use('/api/admin',auth,adm,A);
const str=(v,max=500)=>{v=String(v??'').trim();if(!v||v.length>max)bad('Invalid input');return v};
app.get('/healthz',(q,s)=>s.send('ok'));
app.get('/api/config',(q,s)=>s.json({brand:setting('brand','AngKer SMM'),announcement:setting('announcement'),tg:!!E.BOT_TOKEN}));
app.post('/api/auth/register',authLimit,w((q,s)=>{
  const u=str(q.body.username,32),p=String(q.body.password||'');
  if(!/^\w{3,32}$/.test(u))bad('Username: 3-32 letters, digits or _');if(p.length<8)bad('Password must be 8+ characters');
  if(db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(u))bad('Username taken',409);
  const id=db.prepare('INSERT INTO users(username,email,pass_hash) VALUES(?,?,?)').run(u,String(q.body.email||'').slice(0,120),bcrypt.hashSync(p,11)).lastInsertRowid;
  const row=db.prepare('SELECT * FROM users WHERE id=?').get(id);s.json({token:sign(row),user:pub(row)})}));
app.post('/api/auth/login',authLimit,w((q,s)=>{
  const u=db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(String(q.body.username||''));
  if(!u||!u.pass_hash||!bcrypt.compareSync(String(q.body.password||''),u.pass_hash)||u.banned)bad('Invalid username or password',401);
  s.json({token:sign(u),user:pub(u)})}));
app.post('/api/auth/telegram',authLimit,w((q,s)=>{
  if(!E.BOT_TOKEN)bad('Telegram login not configured',501);
  const p=new URLSearchParams(String(q.body.initData||'')),h=p.get('hash');p.delete('hash');
  const chk=[...p].map(([k,v])=>`${k}=${v}`).sort().join('\n'),sk=crypto.createHmac('sha256','WebAppData').update(E.BOT_TOKEN).digest(),c=crypto.createHmac('sha256',sk).update(chk).digest('hex');
  if(!h||h.length!==c.length||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(c)))bad('Invalid Telegram data',401);
  if(Date.now()/1e3-Number(p.get('auth_date'))>86400)bad('Telegram session expired',401);
  const t=JSON.parse(p.get('user')),tg=String(t.id);let u=db.prepare('SELECT * FROM users WHERE tg_id=?').get(tg);
  if(!u){let name=(t.username||'tg'+tg).replace(/\W/g,'_');if(db.prepare('SELECT 1 FROM users WHERE username=?').get(name))name+='_'+tg;
    u=db.prepare('SELECT * FROM users WHERE id=?').get(db.prepare('INSERT INTO users(username,tg_id) VALUES(?,?)').run(name,tg).lastInsertRowid)}
  if(u.banned)bad('Banned',403);s.json({token:sign(u),user:pub(u)})}));
app.get('/api/me',auth,(q,s)=>s.json(pub(q.user)));
app.post('/api/me/password',auth,w((q,s)=>{
  if(!q.user.pass_hash||!bcrypt.compareSync(String(q.body.old||''),q.user.pass_hash))bad('Current password is wrong');
  if(String(q.body.new||'').length<8)bad('Password must be 8+ characters');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(q.body.new,11),q.user.id);s.json({ok:1})}));
app.get('/api/notifications',auth,(q,s)=>s.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(q.user.id)));
app.get('/api/promos',auth,(q,s)=>s.json(db.prepare('SELECT code,title,bonus_percent FROM promos WHERE active=1').all()));
// SMM
app.get('/api/smm/services',auth,(q,s)=>s.json(db.prepare('SELECT id,category,name,description,price,min_qty,max_qty,delivery FROM services WHERE enabled=1 ORDER BY category,id').all()));
app.post('/api/smm/order',auth,w(async(q,s)=>{
  const sv=db.prepare('SELECT * FROM services WHERE id=? AND enabled=1').get(q.body.service_id);if(!sv)bad('Service not found',404);
  const link=str(q.body.link,500),qty=parseInt(q.body.quantity);
  if(!/^https?:\/\/\S+$/i.test(link)&&!/^@?\w{3,64}$/.test(link))bad('Invalid link');
  if(!(qty>=sv.min_qty&&qty<=sv.max_qty))bad(`Quantity must be ${sv.min_qty}-${sv.max_qty}`);
  const charge=r4(sv.price*qty/1000); // price always computed server-side
  const id=db.transaction(()=>{money(q.user.id,-charge,'purchase',`SMM service #${sv.id} x${qty}`);
    return db.prepare('INSERT INTO smm_orders(user_id,service_id,link,quantity,charge) VALUES(?,?,?,?,?)').run(q.user.id,sv.id,link,qty,charge).lastInsertRowid})();
  await submit(id);s.json(db.prepare('SELECT * FROM smm_orders WHERE id=?').get(id))}));
app.get('/api/smm/orders',auth,(q,s)=>s.json(db.prepare('SELECT o.*,s.name service_name,s.category FROM smm_orders o JOIN services s ON s.id=o.service_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 100').all(q.user.id)));
// Store
const stockSql=`CASE WHEN delivery_type='auto' THEN (SELECT COUNT(*) FROM inventory i WHERE i.product_id=products.id AND i.sold_order IS NULL) ELSE stock END`;
app.get('/api/store/products',auth,(q,s)=>s.json(db.prepare(`SELECT id,category,name,description,image,price,delivery_type,${stockSql} AS stock FROM products WHERE enabled=1 ORDER BY id DESC`).all()));
app.post('/api/store/buy',auth,w((q,s)=>{
  const qty=parseInt(q.body.quantity||1);if(!(qty>=1&&qty<=20))bad('Invalid quantity');
  const out=db.transaction(()=>{
    const p=db.prepare('SELECT * FROM products WHERE id=? AND enabled=1').get(q.body.product_id);if(!p)bad('Product not found',404);
    const total=r4(p.price*qty);let delivery=null,status='Pending',rows=[];
    if(p.delivery_type==='auto'){rows=db.prepare('SELECT * FROM inventory WHERE product_id=? AND sold_order IS NULL LIMIT ?').all(p.id,qty);
      if(rows.length<qty)bad('Out of stock',409);delivery=enc(rows.map(r=>dec(r.secret)).join('\n'));status='Delivered'}
    else{if(p.stock<qty)bad('Out of stock',409);db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty,p.id)}
    money(q.user.id,-total,'purchase',`${p.name} x${qty}`);
    const id=db.prepare('INSERT INTO digital_orders(user_id,product_id,product_name,quantity,price,status,delivery) VALUES(?,?,?,?,?,?,?)').run(q.user.id,p.id,p.name,qty,total,status,delivery).lastInsertRowid;
    for(const r of rows)db.prepare('UPDATE inventory SET sold_order=? WHERE id=?').run(id,r.id);return id})();
  s.json({id:out})}));
app.get('/api/store/orders',auth,(q,s)=>s.json(db.prepare('SELECT * FROM digital_orders WHERE user_id=? ORDER BY id DESC LIMIT 100').all(q.user.id).map(o=>({...o,delivery:o.delivery?dec(o.delivery):null}))));
// Wallet
app.get('/api/wallet',auth,(q,s)=>s.json({balance:q.user.balance,
  transactions:db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 50').all(q.user.id),
  payments:db.prepare('SELECT * FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 20').all(q.user.id),
  instructions:{name:setting('aba_name'),account:setting('aba_account'),qr:setting('khqr_image'),min:Number(setting('min_deposit','1'))}}));
app.post('/api/wallet/deposit',auth,w((q,s)=>{
  const amount=num(q.body.amount,Number(setting('min_deposit','1')),10000);let bonus=0;
  if(q.body.promo){const pr=db.prepare('SELECT * FROM promos WHERE code=? COLLATE NOCASE AND active=1').get(String(q.body.promo));if(!pr)bad('Invalid promo code');bonus=r4(amount*pr.bonus_percent/100)}
  const ref='DP'+crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('INSERT INTO payments(user_id,amount,bonus,ref) VALUES(?,?,?,?)').run(q.user.id,amount,bonus,ref);
  s.json({ref,amount,bonus})}));
// Provider webhook: your KHQR provider posts {ref, amount, tx_id}. Adapt field names to the provider docs.
app.post('/api/payments/webhook',w((q,s)=>{
  const a=Buffer.from(String(q.headers['x-webhook-secret']||'')),b=Buffer.from(E.PAYMENT_WEBHOOK_SECRET||'\0');
  if(!E.PAYMENT_WEBHOOK_SECRET||a.length!==b.length||!crypto.timingSafeEqual(a,b))bad('Forbidden',403);
  confirmPayment(str(q.body.ref,40),q.body.tx_id,q.body.amount,null);s.json({ok:1})}));
// Tickets
app.get('/api/tickets',auth,(q,s)=>s.json(db.prepare(`SELECT t.*,u.username FROM tickets t JOIN users u ON u.id=t.user_id ${q.user.role==='admin'?'':'WHERE t.user_id='+q.user.id} ORDER BY t.id DESC LIMIT 100`).all()));
app.post('/api/tickets',auth,w((q,s)=>{db.transaction(()=>{const id=db.prepare('INSERT INTO tickets(user_id,subject) VALUES(?,?)').run(q.user.id,str(q.body.subject,120)).lastInsertRowid;db.prepare('INSERT INTO ticket_msgs(ticket_id,user_id,body) VALUES(?,?,?)').run(id,q.user.id,str(q.body.message,2000))})();s.json({ok:1})}));
const tk=(q)=>{const t=db.prepare('SELECT * FROM tickets WHERE id=?').get(q.params.id);if(!t||(t.user_id!==q.user.id&&q.user.role!=='admin'))bad('Not found',404);return t};
app.get('/api/tickets/:id',auth,w((q,s)=>{const t=tk(q);s.json({ticket:t,messages:db.prepare('SELECT * FROM ticket_msgs WHERE ticket_id=? ORDER BY id').all(t.id)})}));
app.post('/api/tickets/:id/reply',auth,w((q,s)=>{const t=tk(q),ad=q.user.role==='admin'?1:0;
  db.prepare('INSERT INTO ticket_msgs(ticket_id,user_id,is_admin,body) VALUES(?,?,?,?)').run(t.id,q.user.id,ad,str(q.body.message,2000));
  db.prepare('UPDATE tickets SET status=? WHERE id=?').run(ad?'answered':'open',t.id);if(ad)notify(t.user_id,`Support replied to ticket #${t.id}`);s.json({ok:1})}));
// ---------- admin ----------
A.get('/stats',(q,s)=>{const c=x=>db.prepare(x).get().n;s.json({users:c('SELECT COUNT(*) n FROM users'),balances:c('SELECT COALESCE(SUM(balance),0) n FROM users'),
  revenue:c("SELECT COALESCE(-SUM(amount),0) n FROM transactions WHERE type='purchase'"),deposits:c("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='paid'"),
  smm_active:c("SELECT COUNT(*) n FROM smm_orders WHERE status IN('Pending','Processing')"),digital_pending:c("SELECT COUNT(*) n FROM digital_orders WHERE status='Pending'"),
  pending_payments:c("SELECT COUNT(*) n FROM payments WHERE status='pending'"),open_tickets:c("SELECT COUNT(*) n FROM tickets WHERE status='open'")})});
A.get('/users',(q,s)=>s.json(db.prepare('SELECT id,username,email,tg_id,balance,role,banned,created FROM users ORDER BY id DESC LIMIT 200').all()));
A.post('/users/:id/balance',w((q,s)=>{const amt=num(q.body.amount,-1e6,1e6);if(!amt)bad('Amount required');
  db.transaction(()=>money(Number(q.params.id),amt,'adjustment',str(q.body.note,200)+` (by admin ${q.user.username})`))();log(q.user.id,'balance_adjust',`user ${q.params.id} ${amt}: ${q.body.note}`);s.json({ok:1})}));
A.post('/users/:id/ban',w((q,s)=>{if(Number(q.params.id)===q.user.id)bad('Cannot ban yourself');db.prepare('UPDATE users SET banned=? WHERE id=?').run(q.body.banned?1:0,q.params.id);log(q.user.id,'ban',q.params.id+':'+q.body.banned);s.json({ok:1})}));
A.get('/payments',(q,s)=>s.json(db.prepare('SELECT p.*,u.username FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 200').all()));
A.post('/payments/:id/confirm',w((q,s)=>{const p=db.prepare('SELECT ref FROM payments WHERE id=?').get(q.params.id);if(!p)bad('Not found',404);confirmPayment(p.ref,q.body.tx_id||null,null,q.user.id);s.json({ok:1})}));
A.post('/payments/:id/reject',w((q,s)=>{db.prepare("UPDATE payments SET status='rejected' WHERE id=? AND status='pending'").run(q.params.id);log(q.user.id,'payment_reject',q.params.id);s.json({ok:1})}));
const SF=['category','name','description','price','cost','min_qty','max_qty','delivery','supplier_service','enabled'];
A.get('/services',(q,s)=>s.json(db.prepare('SELECT * FROM services ORDER BY category,id').all()));
A.post('/services',w((q,s)=>{const b=q.body;s.json({id:db.prepare('INSERT INTO services(category,name,description,price,cost,min_qty,max_qty,delivery,supplier_service) VALUES(?,?,?,?,?,?,?,?,?)').run(str(b.category,40),str(b.name,200),String(b.description||''),num(b.price,0),num(b.cost||0,0),num(b.min_qty,1),num(b.max_qty,1),String(b.delivery||''),b.supplier_service||null).lastInsertRowid})}));
A.put('/services/:id',w((q,s)=>{upd('services',q.params.id,q.body,SF);log(q.user.id,'service_edit',q.params.id);s.json({ok:1})}));
A.delete('/services/:id',w((q,s)=>{try{db.prepare('DELETE FROM services WHERE id=?').run(q.params.id)}catch{bad('Service has orders; disable it instead')}s.json({ok:1})}));
A.get('/supplier/status',w(async(q,s)=>{try{const r=await sup({action:'balance'});s.json({connected:!r.error,balance:r.balance,currency:r.currency,error:r.error})}catch(e){s.json({connected:false,error:e.message})}}));
A.post('/services/import',w(async(q,s)=>{
  const markup=num(q.body.markup??30,0,1000),list=await sup({action:'services'});if(!Array.isArray(list))bad('Supplier returned an error: '+(list&&list.error));
  const cat=n=>/tiktok/i.test(n)?'TikTok':/facebook|fb/i.test(n)?'Facebook':/telegram/i.test(n)?'Telegram':null;let added=0,updated=0;
  db.transaction(()=>{for(const x of list){const c=cat(x.category+' '+x.name);if(!c)continue;const cost=Number(x.rate),price=r4(cost*(1+markup/100)),ex=db.prepare('SELECT id FROM services WHERE supplier_service=?').get(String(x.service));
    if(ex){db.prepare('UPDATE services SET cost=?,price=?,min_qty=?,max_qty=? WHERE id=?').run(cost,price,+x.min,+x.max,ex.id);updated++}
    else{db.prepare('INSERT INTO services(category,name,price,cost,min_qty,max_qty,supplier_service,enabled) VALUES(?,?,?,?,?,?,?,0)').run(c,String(x.name).slice(0,200),price,cost,+x.min,+x.max,String(x.service));added++}}})();
  log(q.user.id,'service_import',`${added} new, ${updated} updated`);s.json({added,updated,note:'New services are imported disabled; review and enable them.'})}));
const PF=['category','name','description','image','price','delivery_type','stock','enabled'];
A.get('/products',(q,s)=>s.json(db.prepare(`SELECT *,(SELECT COUNT(*) FROM inventory i WHERE i.product_id=products.id AND i.sold_order IS NULL) inv FROM products ORDER BY id DESC`).all()));
A.post('/products',w((q,s)=>{const b=q.body;s.json({id:db.prepare('INSERT INTO products(category,name,description,image,price,delivery_type,stock) VALUES(?,?,?,?,?,?,?)').run(str(b.category,40),str(b.name,200),String(b.description||''),String(b.image||''),num(b.price,0),b.delivery_type==='manual'?'manual':'auto',parseInt(b.stock)||0).lastInsertRowid})}));
A.put('/products/:id',w((q,s)=>{upd('products',q.params.id,q.body,PF);s.json({ok:1})}));
A.delete('/products/:id',w((q,s)=>{db.prepare('DELETE FROM products WHERE id=?').run(q.params.id);log(q.user.id,'product_delete',q.params.id);s.json({ok:1})}));
A.post('/products/:id/stock',w((q,s)=>{const lines=String(q.body.codes||'').split('\n').map(x=>x.trim()).filter(Boolean);if(!lines.length)bad('No codes');
  db.transaction(()=>{for(const l of lines)db.prepare('INSERT INTO inventory(product_id,secret) VALUES(?,?)').run(q.params.id,enc(l))})();s.json({added:lines.length})}));
A.get('/orders/smm',(q,s)=>s.json(db.prepare('SELECT o.*,u.username,s.name service_name FROM smm_orders o JOIN users u ON u.id=o.user_id JOIN services s ON s.id=o.service_id ORDER BY o.id DESC LIMIT 200').all()));
A.post('/orders/smm/sync',w(async(q,s)=>{await syncOrders();s.json({ok:1})}));
A.post('/orders/smm/:id/status',w((q,s)=>{const st=Object.values(MAP).find(x=>x===q.body.status);if(!st)bad('Invalid status');const o=db.prepare('SELECT * FROM smm_orders WHERE id=?').get(q.params.id);if(!o)bad('Not found',404);
  if(FINAL.includes(st))finish(o,st,parseInt(q.body.remains)||0);else db.prepare('UPDATE smm_orders SET status=? WHERE id=?').run(st,o.id);log(q.user.id,'smm_status',`${o.id}->${st}`);s.json({ok:1})}));
A.get('/orders/digital',(q,s)=>s.json(db.prepare('SELECT d.id,d.product_name,d.quantity,d.price,d.status,d.created,u.username FROM digital_orders d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 200').all()));
A.post('/orders/digital/:id/deliver',w((q,s)=>{const o=db.prepare('SELECT * FROM digital_orders WHERE id=?').get(q.params.id);if(!o)bad('Not found',404);if(o.status!=='Pending')bad('Already handled');
  db.prepare("UPDATE digital_orders SET status='Delivered',delivery=? WHERE id=?").run(enc(str(q.body.text,4000)),o.id);notify(o.user_id,`Your order #${o.id} (${o.product_name}) was delivered`);log(q.user.id,'manual_delivery',o.id);s.json({ok:1})}));
A.get('/promos',(q,s)=>s.json(db.prepare('SELECT * FROM promos').all()));
A.post('/promos',w((q,s)=>{db.prepare('INSERT INTO promos(code,title,bonus_percent) VALUES(?,?,?)').run(str(q.body.code,30),String(q.body.title||''),num(q.body.bonus_percent,0,500));s.json({ok:1})}));
A.delete('/promos/:id',(q,s)=>{db.prepare('DELETE FROM promos WHERE id=?').run(q.params.id);s.json({ok:1})});
const SK=['brand','announcement','aba_name','aba_account','khqr_image','min_deposit'];
A.get('/settings',(q,s)=>s.json(Object.fromEntries(SK.map(k=>[k,setting(k)]))));
A.put('/settings',(q,s)=>{for(const k of SK)if(q.body[k]!==undefined)db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(q.body[k]).slice(0,1000));log(q.user.id,'settings','updated');s.json({ok:1})});
A.get('/logs',(q,s)=>s.json(db.prepare('SELECT l.*,u.username FROM logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 200').all()));
app.use(express.static(path.join(__dirname,'public')));
app.use('/api',(q,s)=>s.status(404).json({error:'Not found'}));
app.use((e,q,s,n)=>{if(e instanceof HttpErr)return s.status(e.code).json({error:e.message});console.error(e);s.status(500).json({error:'Server error'})});
if(E.ADMIN_USERNAME&&E.ADMIN_PASSWORD&&!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()){
  db.prepare("INSERT INTO users(username,pass_hash,role) VALUES(?,?,'admin')").run(E.ADMIN_USERNAME,bcrypt.hashSync(E.ADMIN_PASSWORD,11));console.log('Admin created:',E.ADMIN_USERNAME)}
app.listen(E.PORT||3000,'0.0.0.0',()=>console.log('Running on :'+(E.PORT||3000)));
