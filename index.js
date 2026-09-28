// 자산운영하기 - 온라인 멀티플레이 서버 (외부 패키지 없이 Node 기본 기능만 사용)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const GAME_SECONDS = +process.env.GAME_SECONDS || 600;
const START_MONEY = 100000;
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));

const stockNames = ['대한전자','한빛중공업','미래바이오','청연푸드','은하항공','별빛제약','동방화학','금강건설','태양금융','새벽반도체',
'무한게임즈','청출모터스','진성에너지','대성통신','한울조선','백두유통','해오름스틸','신성섬유','정도로보틱스','고려플랫폼',
'단풍홀딩스','소망리조트','이든엔터','파랑물류','불꽃정유','하늘메디컬','땅끝소프트','푸른데이터','황금우주','천년농산'];
const coinNames = ['도지비트','루나코인','비트베어','이더문','스타코인','네온체인','퀀텀비트','실버체인','골드체인','코스모코인',
'판타코인','제노체인','노바코인','세이버코인','트리톤체인','헬릭스코인','오르카체인','픽셀코인','사이버체인','매트릭스코인',
'볼트코인','레이저체인','플라즈마코인','에코체인','미라지코인','옵시디언체인','크리스탈코인','선더체인','제트코인','인피니티체인'];

const stockWeights = [[1,70],[5,20],[10,50],[50,3],['delist',1]];
const coinWeights  = [[5,20],[10,50],[50,5],['delist',1]];

function weightedPick(table){
  const sum = table.reduce((a,b)=>a+b[1],0);
  let r = Math.random()*sum;
  for(const [v,w] of table){ if(r<w) return v; r-=w; }
  return table[table.length-1][0];
}
// 상장폐지 위험을 보정해 10분 보유 시 기대값이 rtp가 되도록 상승 확률 계산
function calcUpProb(weights, ticks, rtp){
  const total = weights.reduce((a,b)=>a+b[1],0);
  const dl = weights.find(w=>w[0]==='delist')[1];
  const moveW = total-dl;
  const meanMag = weights.filter(w=>w[0]!=='delist').reduce((a,w)=>a+w[0]*w[1],0)/moveW/100;
  const need = Math.pow(rtp,1/ticks)*total/moveW - 1;
  return (1 + need/meanMag)/2;
}
const STOCK_UP = calcUpProb(stockWeights, GAME_SECONDS/10, 0.975);
const COIN_UP  = calcUpProb(coinWeights, GAME_SECONDS/5, 0.975);

const rooms = new Map();

function makeMarket(names, base){
  return names.map(n=>({ name:n, price:Math.round(base*(0.8+Math.random()*0.4)), change:0, delisted:false }));
}
function itemOf(room, key){ return (key[0]==='s' ? room.stocks : room.coins)[+key.slice(1)]; }
function totalOf(room, p){
  let t = p.money;
  for(const k in p.holdings){ const it = itemOf(room,k); if(!it.delisted) t += p.holdings[k].qty*it.price; }
  return t;
}
function snapshot(room, pid){
  const me = room.players.get(pid);
  const board = [...room.players.entries()].map(([id,p])=>({id, name:p.name, total:Math.round(totalOf(room,p)), online:p.online}))
    .sort((a,b)=>b.total-a.total);
  return { code:room.code, phase:room.phase, timeLeft:room.timeLeft, hostId:room.hostId,
    me:{ id:pid, name:me.name, money:me.money, holdings:me.holdings, total:Math.round(totalOf(room,me)) },
    board, stocks:room.stocks, coins:room.coins };
}
function broadcast(room){
  for(const [pid,res] of room.clients){ res.write('data: '+JSON.stringify(snapshot(room,pid))+'\n\n'); }
}

function tickMarket(room, kind){
  const list = kind==='s' ? room.stocks : room.coins;
  const w = kind==='s' ? stockWeights : coinWeights;
  const up = kind==='s' ? STOCK_UP : COIN_UP;
  list.forEach((it,i)=>{
    if(it.delisted) return;
    const mag = weightedPick(w);
    if(mag==='delist'){
      it.delisted = true; it.price = 0; it.change = -100;
      for(const p of room.players.values()) delete p.holdings[kind+i];
      return;
    }
    const pct = (Math.random()<up ? 1 : -1)*mag;
    it.price = Math.max(1, Math.round(it.price*(1+pct/100)));
    it.change = pct;
  });
}

function startGame(room){
  room.phase = 'playing';
  room.timeLeft = GAME_SECONDS;
  room.timers = [
    setInterval(()=>{ room.timeLeft--; if(room.timeLeft<=0) endGame(room); else broadcast(room); }, 1000),
    setInterval(()=> tickMarket(room,'s'), 10000),
    setInterval(()=> tickMarket(room,'c'), 5000),
  ];
  broadcast(room);
}
function endGame(room){
  (room.timers||[]).forEach(clearInterval);
  room.timers = [];
  room.phase = 'ended';
  room.timeLeft = 0;
  room.endedAt = Date.now();
  broadcast(room);
}

function cleanName(n){
  n = String(n||'').trim().slice(0,10);
  if(!n) throw new Error('닉네임을 입력하세요');
  return n;
}
function newPlayer(name){ return { name, money:START_MONEY, holdings:{}, online:false }; }

function create(body){
  const name = cleanName(body.name);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); } while(rooms.has(code));
  const pid = crypto.randomBytes(8).toString('hex');
  const room = { code, hostId:pid, phase:'lobby', timeLeft:GAME_SECONDS, players:new Map(), clients:new Map(),
    stocks:makeMarket(stockNames,1000), coins:makeMarket(coinNames,500), timers:[], createdAt:Date.now() };
  room.players.set(pid, newPlayer(name));
  rooms.set(code, room);
  return { code, pid };
}
function join(body){
  const name = cleanName(body.name);
  const code = String(body.code||'').trim().toUpperCase();
  const room = rooms.get(code);
  if(!room) throw new Error('방을 찾을 수 없습니다');
  if(room.phase!=='lobby') throw new Error('이미 시작된 방입니다');
  if(room.players.size>=MAX_PLAYERS) throw new Error('방이 가득 찼습니다 (최대 '+MAX_PLAYERS+'명)');
  for(const p of room.players.values()) if(p.name===name) throw new Error('이미 사용 중인 닉네임입니다');
  const pid = crypto.randomBytes(8).toString('hex');
  room.players.set(pid, newPlayer(name));
  broadcast(room);
  return { code, pid };
}
function action(body){
  const room = rooms.get(String(body.code||'').toUpperCase());
  const p = room && room.players.get(body.pid);
  if(!p) throw new Error('방 정보를 찾을 수 없습니다');
  if(body.type==='start'){
    if(body.pid!==room.hostId) throw new Error('방장만 시작할 수 있습니다');
    if(room.phase!=='lobby') throw new Error('이미 시작되었습니다');
    startGame(room);
    return { ok:true };
  }
  if(body.type==='buy' || body.type==='sell'){
    if(room.phase!=='playing') throw new Error('게임 중이 아닙니다');
    const kind = body.kind==='stock' ? 's' : (body.kind==='coin' ? 'c' : null);
    const idx = +body.idx, qty = +body.qty;
    if(!kind) throw new Error('잘못된 요청');
    const it = (kind==='s' ? room.stocks : room.coins)[idx];
    if(!it || it.delisted) throw new Error('거래할 수 없는 종목입니다');
    if(!Number.isInteger(qty) || qty<1 || qty>1e7) throw new Error('수량이 올바르지 않습니다');
    const key = kind+idx;
    if(body.type==='buy'){
      const cost = qty*it.price;
      if(cost>p.money) throw new Error('돈이 부족합니다');
      const h = p.holdings[key] || (p.holdings[key] = {qty:0, avg:0});
      p.money -= cost;
      h.avg = (h.avg*h.qty + cost)/(h.qty+qty);
      h.qty += qty;
    } else {
      const h = p.holdings[key];
      if(!h || qty>h.qty) throw new Error('보유 수량이 부족합니다');
      p.money += qty*it.price;
      h.qty -= qty;
      if(h.qty===0) delete p.holdings[key];
    }
    broadcast(room);
    return { ok:true };
  }
  throw new Error('알 수 없는 요청');
}

function events(req, res, url){
  const room = rooms.get(String(url.searchParams.get('code')||'').toUpperCase());
  const pid = url.searchParams.get('pid');
  const p = room && room.players.get(pid);
  if(!p){ res.writeHead(404); return res.end(); }
  res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.write('retry: 2000\n\n');
  room.clients.set(pid, res);
  p.online = true;
  broadcast(room);
  req.on('close', ()=>{
    if(room.clients.get(pid)===res) room.clients.delete(pid);
    p.online = false;
    if(room.phase==='lobby'){
      setTimeout(()=>{
        if(p.online || !room.players.has(pid)) return;
        room.players.delete(pid);
        if(room.players.size===0){ rooms.delete(room.code); return; }
        if(room.hostId===pid) room.hostId = [...room.players.keys()][0];
        broadcast(room);
      }, 15000);
    }
    broadcast(room);
  });
}

function readBody(req){
  return new Promise((resolve,reject)=>{
    let data = '';
    req.on('data', c=>{ data += c; if(data.length>10000){ reject(new Error('too large')); req.destroy(); } });
    req.on('end', ()=>{ try{ resolve(JSON.parse(data||'{}')); }catch(e){ reject(new Error('잘못된 요청')); } });
  });
}
function send(res, code, obj){
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, 'http://localhost');
  try{
    if(req.method==='GET' && url.pathname==='/'){
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(INDEX);
    }
    if(req.method==='GET' && url.pathname==='/api/events') return events(req,res,url);
    if(req.method==='POST'){
      const body = await readBody(req);
      if(url.pathname==='/api/create') return send(res,200,create(body));
      if(url.pathname==='/api/join') return send(res,200,join(body));
      if(url.pathname==='/api/action') return send(res,200,action(body));
    }
    send(res,404,{error:'not found'});
  }catch(e){ send(res,400,{error:e.message}); }
});

// 연결 유지용 ping, 오래된 방 정리
setInterval(()=>{ for(const r of rooms.values()) for(const c of r.clients.values()) c.write(': ping\n\n'); }, 20000);
setInterval(()=>{
  const now = Date.now();
  for(const [code,r] of rooms){
    const idle = r.clients.size===0;
    if((r.phase==='ended' && now-r.endedAt>30*60000) || (idle && now-r.createdAt>2*3600000)){
      (r.timers||[]).forEach(clearInterval); rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, ()=> console.log('서버 실행 중: http://localhost:'+PORT));
