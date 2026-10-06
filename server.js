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
function statsOf(room, p){
  const st = Object.assign({}, p.stats, {stock:0, coin:0});
  for(const k in p.realized) st[k[0]==='s'?'stock':'coin'] += p.realized[k];
  for(const k in p.holdings){ const it = itemOf(room,k); st[k[0]==='s'?'stock':'coin'] += (it.price-p.holdings[k].avg)*p.holdings[k].qty; }
  for(const k in st) st[k] = Math.round(st[k]);
  return st;
}
function snapshot(room, pid){
  const me = room.players.get(pid);
  const board = [...room.players.entries()].map(([id,p])=>({id, name:p.name, total:Math.round(totalOf(room,p)), online:p.online}))
    .sort((a,b)=>b.total-a.total);
  return { code:room.code, phase:room.phase, timeLeft:room.timeLeft, hostId:room.hostId,
    me:{ id:pid, name:me.name, money:me.money, holdings:me.holdings, realized:me.realized, total:Math.round(totalOf(room,me)),
      rps:me.rps, aoji:me.aoji, stats:statsOf(room,me) },
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
      for(const p of room.players.values()){ const h=p.holdings[kind+i]; if(h){ p.realized[kind+i]=(p.realized[kind+i]||0)-h.avg*h.qty; delete p.holdings[kind+i]; } }
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
  const now = Date.now();
  for(const p of room.players.values()) p.lastAction = now;
  room.timers = [
    setInterval(()=>{ room.timeLeft--; if(room.timeLeft<=0) endGame(room); else broadcast(room); }, 1000),
    setInterval(()=> tickMarket(room,'s'), 10000),
    setInterval(()=> tickMarket(room,'c'), 5000),
    setInterval(()=> applyIdlePenalty(room), 1000),
  ];
  broadcast(room);
}
// 15초마다 아무 행동도 하지 않은 참가자는 5,000원씩 차감 (방치 방지)
const IDLE_MS = 15000, IDLE_FINE = 5000;
function applyIdlePenalty(room){
  const now = Date.now();
  let changed = false;
  for(const p of room.players.values()){
    if(now - p.lastAction >= IDLE_MS){
      if(p.money > 0){ p.money = Math.max(0, p.money - IDLE_FINE); changed = true; }
      p.lastAction += IDLE_MS;
    }
  }
  if(changed) broadcast(room);
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
function newPlayer(name){
  return { name, money:START_MONEY, holdings:{}, realized:{}, online:false, aoji:0, shell:null, lastAction:0,
    rps:{pot:0,streak:0}, stats:{rps:0,shell:0,chin:0,horse:0,slot:0,lotto:0,roulette:0,aoji:0} };
}

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
    const amount = qty*it.price;
    if(body.type==='buy'){
      if(amount < TRADE_MIN) throw new Error('최소 주문 금액은 '+TRADE_MIN.toLocaleString('ko-KR')+'원입니다 (잔돈 매매로 무활동 패널티를 피할 수 없도록 제한됩니다)');
      if(amount>p.money) throw new Error('돈이 부족합니다');
      const h = p.holdings[key] || (p.holdings[key] = {qty:0, avg:0});
      p.money -= amount;
      h.avg = (h.avg*h.qty + amount)/(h.qty+qty);
      h.qty += qty;
    } else {
      const h = p.holdings[key];
      if(!h || qty>h.qty) throw new Error('보유 수량이 부족합니다');
      const isFullSell = qty===h.qty;
      if(!isFullSell && amount < TRADE_MIN) throw new Error('최소 주문 금액은 '+TRADE_MIN.toLocaleString('ko-KR')+'원입니다 (전량 매도는 금액 제한 없이 가능합니다)');
      p.money += amount;
      p.realized[key] = (p.realized[key]||0) + (it.price-h.avg)*qty;
      h.qty -= qty;
      if(h.qty===0) delete p.holdings[key];
    }
    p.lastAction = Date.now();
    broadcast(room);
    return { ok:true };
  }
  if(body.type==='game') return gameAction(room,p,body);
  throw new Error('알 수 없는 요청');
}

// ================= 미니게임 (결과는 전부 서버에서 결정) =================
const BET_MIN=5000, TRADE_MIN=5000, RPS_MULT=1.95, SHELL_MULT=2.2, AOJI_LIMIT=5000;
const LOTTO_PRICE=5000;
const HORSES=[{w:70,odds:2.5},{w:50,odds:3.5},{w:30,odds:5.8},{w:20,odds:8.8},{w:10,odds:17.5}];
const SLOT_W=[['🍒',30],['🍋',25],['🍇',20],['🔔',12],['💎',8],['7️⃣',5]];
const SLOT_PAY={'7️⃣':300,'💎':150,'🔔':50,'🍇':25,'🍋':10,'🍒':5};
const RCOL=['red','red','black','black','red','red','black','black','red','black'];
const rnd=n=>Math.floor(Math.random()*n);
const rd6=()=>1+rnd(6);
function rollChin(){
  let dice=[rd6(),rd6(),rd6()], type='none', point=0;
  for(let a=0;a<3;a++){
    dice=[rd6(),rd6(),rd6()];
    const s=[...dice].sort((x,y)=>x-y);
    if(s[0]===s[1]&&s[1]===s[2]){ type=s[0]===1?'pinzoro':'zorome'; break; }
    if(s.join()==='4,5,6'){ type='shigoro'; break; }
    if(s.join()==='1,2,3'){ type='hifumi'; break; }
    if(s[0]===s[1]||s[1]===s[2]){ point=s[0]===s[1]?s[2]:s[0]; type='point'; break; }
    type='none';
  }
  return {dice,type,point};
}
function chinNet(r){ return {pinzoro:5,zorome:3,shigoro:2,hifumi:-2}[r.type] ?? null; }

function gameAction(room, p, b){
  if(room.phase!=='playing') throw new Error('게임 중이 아닙니다');
  const before = p.money;
  const bet = +b.bet;
  const chk = ()=>{
    if(!Number.isInteger(bet) || bet<BET_MIN) throw new Error('최소 배팅 금액은 '+BET_MIN.toLocaleString('ko-KR')+'원입니다');
    if(bet>p.money) throw new Error('돈이 부족합니다');
  };
  let res = {};
  switch(b.game){
    case 'rps': {
      if(b.op==='collect'){ if(p.rps.streak<=0) throw new Error('수령할 연승 판돈이 없습니다'); p.rps={pot:0,streak:0}; res={pot:0,streak:0}; break; }
      if(!['rock','paper','scissors'].includes(b.hand)) throw new Error('잘못된 요청');
      const streaking = p.rps.streak>0;
      let stake;
      if(streaking){
        stake = p.rps.pot;
        if(stake>p.money){ p.rps={pot:0,streak:0}; throw new Error('연승 판돈이 부족해 연승이 종료되었습니다'); }
      } else { chk(); stake = bet; }
      p.money -= stake;
      const cpu = ['rock','paper','scissors'][rnd(3)];
      const h = b.hand;
      const result = h===cpu ? 'draw' : (((h==='rock'&&cpu==='scissors')||(h==='scissors'&&cpu==='paper')||(h==='paper'&&cpu==='rock')) ? 'win' : 'lose');
      let payout=0, auto=false;
      if(result==='win'){
        payout = Math.round(stake*RPS_MULT); p.money += payout;
        p.rps = {pot:payout, streak:streaking?p.rps.streak+1:1};
        if(p.rps.streak>=10){ auto=true; p.rps={pot:0,streak:0}; }
      } else if(result==='draw'){ p.money += stake; }
      else p.rps = {pot:0,streak:0};
      res = {cpu,result,payout,stake,auto,pot:p.rps.pot,streak:p.rps.streak};
      break;
    }
    case 'shell': {
      if(b.op==='start'){
        chk();
        if(p.shell && Date.now()-p.shell.t<30000) throw new Error('진행 중인 야바위가 있습니다');
        p.money -= bet;
        const ballCup=rnd(3), pos=[0,1,2], swaps=[], n=16+rnd(8);
        for(let k=0;k<n;k++){ const i=rnd(3); let j=rnd(3); while(j===i) j=rnd(3); [pos[i],pos[j]]=[pos[j],pos[i]]; swaps.push([i,j]); }
        p.shell = {bet,ballCup,pos,t:Date.now()};
        res = {ballCup,swaps};
      } else {
        if(!p.shell) throw new Error('진행 중인 게임이 없습니다');
        const sl=+b.slot;
        if(![0,1,2].includes(sl)) throw new Error('잘못된 요청');
        const sh=p.shell; p.shell=null;
        const win = sh.pos[sl]===sh.ballCup;
        let payout=0;
        if(win){ payout=Math.round(sh.bet*SHELL_MULT); p.money+=payout; }
        res = {win,payout,ballCup:sh.ballCup,ballSlot:sh.pos.indexOf(sh.ballCup)};
      }
      break;
    }
    case 'chin': {
      chk();
      if(bet*5>p.money) throw new Error('친치로는 특수패(최대 5배 손실)에 대비해 보유금의 1/5까지만 배팅할 수 있습니다.');
      const banker=rollChin(), bn=chinNet(banker);
      let player=null, net;
      if(bn!==null) net=-bn;
      else {
        player=rollChin();
        const pn=chinNet(player);
        if(pn!==null) net=pn;
        else {
          const pp=player.type==='point'?player.point:0, bp=banker.type==='point'?banker.point:0;
          net = pp>bp?1:(pp<bp?-1:0);
        }
      }
      p.money = Math.max(0, p.money + bet*net);
      res = {banker,player,net};
      break;
    }
    case 'horse': {
      chk();
      const hi=+b.horse;
      if(!Number.isInteger(hi)||hi<0||hi>4) throw new Error('잘못된 요청');
      p.money -= bet;
      const winner = weightedPick(HORSES.map((x,i)=>[i,x.w]));
      let win=0;
      if(winner===hi){ win=Math.round(bet*HORSES[hi].odds); p.money+=win; }
      res = {winner,win};
      break;
    }
    case 'slot': {
      chk();
      p.money -= bet;
      const results=[weightedPick(SLOT_W),weightedPick(SLOT_W),weightedPick(SLOT_W)];
      let win=0;
      if(results[0]===results[1]&&results[1]===results[2]) win=bet*SLOT_PAY[results[0]];
      else if(results.filter(r=>r==='🍒').length>=2) win=Math.round(bet*1.5);
      p.money += win;
      res = {results,win};
      break;
    }
    case 'lotto': {
      if(p.money<LOTTO_PRICE) throw new Error('돈이 부족합니다');
      p.money -= LOTTO_PRICE;
      const prize = weightedPick([[1,1],[2,5],[3,10],[0,84]]);
      const win = Math.round({1:50,2:5.5,3:2,0:0}[prize]*LOTTO_PRICE);
      p.money += win;
      res = {prize,win};
      break;
    }
    case 'roulette': {
      chk();
      const t=b.betType, v=b.value;
      const ok = (t==='number' && Number.isInteger(v) && v>=1 && v<=10) || (t==='color' && (v==='red'||v==='black')) || (t==='oddeven' && (v==='odd'||v==='even'));
      if(!ok) throw new Error('배팅 옵션이 올바르지 않습니다');
      p.money -= bet;
      const n=1+rnd(10), col=RCOL[n-1];
      let win=0;
      if(t==='number' && v===n) win=Math.round(bet*9.75);
      if(t==='color' && v===col) win=Math.round(bet*1.9);
      if(t==='oddeven' && v===(n%2?'odd':'even')) win=Math.round(bet*1.9);
      p.money += win;
      res = {n,win};
      break;
    }
    case 'aoji': {
      if(p.money>=AOJI_LIMIT) throw new Error('아직 돈이 남아있는 사람은 들어올 수 없습니다. (보유 현금 5,000원 미만만 입장)');
      p.aoji++;
      let gain=0;
      if(p.aoji>=10){ p.aoji=0; gain=Math.random()<0.01?10000:1000; p.money+=gain; }
      res = {clicks:p.aoji,gain};
      break;
    }
    default: throw new Error('알 수 없는 게임입니다');
  }
  p.stats[b.game] += p.money - before;
  p.lastAction = Date.now();
  broadcast(room);
  return Object.assign({ok:true}, res);
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
