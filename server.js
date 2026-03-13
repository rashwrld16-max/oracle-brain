// ══════════════════════════════════════════════
// ORACLE BRAIN SERVER
// Runs 24/7 on Railway. Watches all 8 Deriv markets
// continuously. Builds intelligence forever.
// Bot connects here to get the latest brain.
// ══════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_ID = '1089';
const WS_URL = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOLS = ['R_100','R_75','R_50','R_25','R_10','1HZ100V','1HZ25V','1HZ10V'];
const SYM_LBL = {R_100:'Vol 100',R_75:'Vol 75',R_50:'Vol 50',R_25:'Vol 25',R_10:'Vol 10','1HZ100V':'V100 Idx','1HZ25V':'V25 Idx','1HZ10V':'V10 Idx'};
const BRAIN_FILE = path.join(__dirname, 'brain.json');
const PORT = process.env.PORT || 3000;

// ── BRAIN STATE ──
let brain = {_meta:{updated:new Date().toISOString(),totalTicks:0,totalPatterns:0}};
if(fs.existsSync(BRAIN_FILE)){
  try{ brain = JSON.parse(fs.readFileSync(BRAIN_FILE,'utf8')); console.log('Brain loaded from disk'); }
  catch(e){ console.log('Fresh brain'); }
}

// Per-symbol live data
const SD = {};
SYMBOLS.forEach(s=>{
  SD[s] = {
    digits: [],
    counts: new Array(10).fill(0),
    pipSize: null,
    tickCount: 0,
    // Quad tracking: 0-1 / 3-4 / 5-6 / 8-9 (2 and 7 are dividers)
    quadCounts: {q01:0, q34:0, q56:0, q89:0, div:0},
    // Hour tracking
    hourStats: Array.from({length:24},()=>({over3w:0,over3l:0,under6w:0,under6l:0})),
    // Change detection baseline
    baseline: null,
    lastChangeDetected: null,
    // Pattern memory
    patterns: {},
  };
  // Load existing brain data for this symbol
  if(brain[s]){
    if(brain[s].patterns) SD[s].patterns = brain[s].patterns;
    if(brain[s].hourStats) SD[s].hourStats = brain[s].hourStats;
    if(brain[s].lastChangeDetected) SD[s].lastChangeDetected = brain[s].lastChangeDetected;
  }
});

// ── HELPERS ──
function inferPip(price){
  const s=String(price),dot=s.indexOf('.');
  if(dot===-1) return 1;
  return Math.pow(10,-(s.length-dot-1));
}
function extractDigit(price,pip){
  return Math.round(price/pip)%10;
}
function getQuad(d){
  if(d===0||d===1) return 'q01';
  if(d===3||d===4) return 'q34';
  if(d===5||d===6) return 'q56';
  if(d===8||d===9) return 'q89';
  return 'div'; // 2 and 7 are dividers
}
function fingerprintSig(deficit, streak, dir){
  return `${Math.min(9,Math.round(deficit/10))}_${Math.min(9,streak)}_${dir==='over3'?1:0}`;
}

// ── SIGNAL COMPUTATION ──
function computeSignals(digits){
  const n = digits.length;
  if(n < 100) return null;
  const win = Math.min(Math.max(100,Math.floor(n*0.65)),1000);
  const sample = digits.slice(-win);
  const total = sample.length;
  const cnt = new Array(10).fill(0);
  sample.forEach(d=>cnt[d]++);
  const exp = total*0.1;
  const def = cnt.map(c=>exp-c);

  const o3D=[4,5,6,7,8,9].reduce((a,i)=>a+Math.max(0,def[i]),0);
  const u6D=[0,1,2,3,4,5].reduce((a,i)=>a+Math.max(0,def[i]),0);
  const loQ=[0,1,2,3].reduce((a,i)=>a+cnt[i],0)/total;
  const hiQ=[6,7,8,9].reduce((a,i)=>a+cnt[i],0)/total;
  const evR=[0,2,4,6,8].reduce((a,i)=>a+cnt[i],0)/total;
  const ovlp=(cnt[4]+cnt[5])/total;
  const loPr=Math.max(0,0.4-loQ)/0.4;
  const hiPr=Math.max(0,0.4-hiQ)/0.4;

  const tail=digits.slice(-10);
  let sH=0,sL=0;
  for(let i=tail.length-1;i>=0;i--){if(tail[i]>3)sH++;else break;}
  for(let i=tail.length-1;i>=0;i--){if(tail[i]<6)sL++;else break;}

  const r7=digits.slice(-7);
  const r7a=r7.reduce((a,b)=>a+b,0)/7;
  const momS=r7a>5.5?-1:r7a<3.5?1:0;
  const strDir=sH>=5?-1:sL>=5?1:0;

  const sc={
    over3:(o3D/exp*30)+(hiPr*25)+(strDir===1?20:0)+(momS>0?momS*15:0),
    under6:(u6D/exp*30)+(loPr*25)+(strDir===-1?20:0)+(momS<0?Math.abs(momS)*15:0),
  };
  const bestType = sc.over3>=sc.under6?'over3':'under6';
  const defSig = Math.min(100,(Math.max(o3D,u6D)/exp)*40);
  const strSig = Math.min(100,Math.max(sH,sL)*10);

  return {bestType,defSig,strSig,o3D,u6D,exp,loQ,hiQ,evR,ovlp,sH,sL,momS};
}

// ── CHANGE DETECTION ──
// Build baseline from first 1000 ticks, detect deviation after
function updateChangeDetection(sym){
  const sd = SD[sym];
  const n = sd.digits.length;

  // Build baseline at 1000 ticks
  if(n === 1000 && !sd.baseline){
    const sample = sd.digits.slice(-1000);
    const cnt = new Array(10).fill(0);
    sample.forEach(d=>cnt[d]++);
    const runs = [];
    let runLen=1, runDir=sample[0]>=5?'h':'l';
    for(let i=1;i<sample.length;i++){
      const d=sample[i]>=5?'h':'l';
      if(d===runDir) runLen++;
      else{ runs.push(runLen); runDir=d; runLen=1; }
    }
    runs.push(runLen);
    sd.baseline = {
      digitFreq: cnt.map(c=>c/1000),
      avgRunLen: runs.reduce((a,b)=>a+b,0)/runs.length,
      evenRatio: [0,2,4,6,8].reduce((a,i)=>a+cnt[i],0)/1000,
      established: Date.now(),
    };
    console.log(`[${SYM_LBL[sym]}] Baseline established`);
    return;
  }

  // Check for deviation every 500 ticks after baseline
  if(sd.baseline && n>1000 && n%500===0){
    const recent = sd.digits.slice(-200);
    const cnt = new Array(10).fill(0);
    recent.forEach(d=>cnt[d]++);
    const recentFreq = cnt.map(c=>c/200);
    const recentEven = [0,2,4,6,8].reduce((a,i)=>a+cnt[i],0)/200;

    // Calculate deviation from baseline
    let totalDev = 0;
    for(let i=0;i<10;i++) totalDev += Math.abs(recentFreq[i]-sd.baseline.digitFreq[i]);
    const evenDev = Math.abs(recentEven-sd.baseline.evenRatio);

    // If significant deviation — flag as change
    if(totalDev > 0.15 || evenDev > 0.08){
      sd.lastChangeDetected = new Date().toISOString();
      console.log(`[${SYM_LBL[sym]}] ⚠ CPRNG CHANGE DETECTED · dev:${totalDev.toFixed(3)} · evenDev:${evenDev.toFixed(3)}`);
      // Rebuild baseline with recent data so we adapt
      sd.baseline.digitFreq = recentFreq;
      sd.baseline.evenRatio = recentEven;
    }
  }
}

// ── QUAD INTELLIGENCE ──
function updateQuadIntelligence(sym, digit){
  const sd = SD[sym];
  const quad = getQuad(digit);
  sd.quadCounts[quad]++;

  // Every 100 ticks analyze quad balance
  if(sd.tickCount % 100 === 0 && sd.tickCount > 0){
    const total = sd.tickCount;
    const expected = total * 0.2; // each quad should be ~20% (ignoring dividers)
    const q01Debt = expected - sd.quadCounts.q01;
    const q34Debt = expected - sd.quadCounts.q34;
    const q56Debt = expected - sd.quadCounts.q56;
    const q89Debt = expected - sd.quadCounts.q89;

    // Store quad intelligence in brain
    if(!brain[sym]) brain[sym]={};
    brain[sym].quadBalance = {
      q01: (sd.quadCounts.q01/total*100).toFixed(1),
      q34: (sd.quadCounts.q34/total*100).toFixed(1),
      q56: (sd.quadCounts.q56/total*100).toFixed(1),
      q89: (sd.quadCounts.q89/total*100).toFixed(1),
      div: (sd.quadCounts.div/total*100).toFixed(1),
      // Which direction has highest debt
      highDebt: q01Debt>q34Debt&&q01Debt>q56Debt&&q01Debt>q89Debt?'low':
                q89Debt>q56Debt&&q89Debt>q01Debt&&q89Debt>q34Debt?'high':'neutral',
      updated: new Date().toISOString(),
    };
  }
}

// ── PATTERN MINING ──
function minePattern(sym, digit){
  const sd = SD[sym];
  const n = sd.digits.length;
  if(n < 200) return;

  // Every 10 ticks compute signals and record outcome
  if(n % 10 !== 0) return;

  const sig = computeSignals(sd.digits.slice(0,-5));
  if(!sig) return;

  // Outcome — what actually happened in last 5 ticks
  const last5 = sd.digits.slice(-5);
  const highC = last5.filter(d=>d>=5).length;
  const actualOver = highC >= 3;
  const actualUnder = last5.filter(d=>d<=4).length >= 3;

  const fp = fingerprintSig(sig.defSig, Math.max(sig.sH,sig.sL), sig.bestType);
  if(!sd.patterns[fp]) sd.patterns[fp]={w:0,l:0};
  if(sig.bestType==='over3'){
    if(actualOver) sd.patterns[fp].w++; else sd.patterns[fp].l++;
  } else {
    if(actualUnder) sd.patterns[fp].w++; else sd.patterns[fp].l++;
  }
}

// ── HOUR INTELLIGENCE ──
function updateHourIntelligence(sym, won, contractType){
  const hr = new Date().getHours();
  const sd = SD[sym];
  if(contractType==='over3'){
    if(won) sd.hourStats[hr].over3w++; else sd.hourStats[hr].over3l++;
  } else {
    if(won) sd.hourStats[hr].under6w++; else sd.hourStats[hr].under6l++;
  }
}

// ── SAVE BRAIN ──
function saveBrain(){
  let totalTicks = 0;
  let totalPatterns = 0;

  SYMBOLS.forEach(sym=>{
    const sd = SD[sym];
    totalTicks += sd.tickCount;
    totalPatterns += Object.keys(sd.patterns).length;

    // Build hour win rates
    const hourWinRates = {};
    sd.hourStats.forEach((h,i)=>{
      const tot = h.over3w+h.over3l+h.under6w+h.under6l;
      if(tot>=5) hourWinRates[i] = (h.over3w+h.under6w)/tot;
    });

    brain[sym] = {
      patterns:            sd.patterns,
      hourWinRates,
      quadBalance:         brain[sym]&&brain[sym].quadBalance||null,
      lastChangeDetected:  sd.lastChangeDetected,
      totalTicks:          sd.tickCount,
      baseline:            sd.baseline ? {digitFreq:sd.baseline.digitFreq,evenRatio:sd.baseline.evenRatio} : null,
    };
  });

  brain._meta = {
    updated:       new Date().toISOString(),
    totalTicks,
    totalPatterns,
    uptime:        Math.floor(process.uptime()/3600)+'h',
    version:       'oracle-brain-v1',
  };

  fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain));
  console.log(`Brain saved · ${(totalTicks/1000).toFixed(0)}k ticks · ${totalPatterns} patterns`);
}

// Auto-save every 10 minutes
setInterval(saveBrain, 10*60*1000);

// ── DERIV CONNECTION ──
let dataWS = null;
let reqId = 1;
let reconnectTimer = null;

function connect(){
  console.log('Connecting to Deriv...');
  dataWS = new WebSocket(WS_URL);

  dataWS.on('open', ()=>{
    console.log('Connected. Loading history...');
    // Load 5000 ticks history per symbol
    SYMBOLS.forEach((sym,i)=>{
      setTimeout(()=>{
        dataWS.send(JSON.stringify({
          ticks_history:sym, count:5000, end:'latest', style:'ticks',
          req_id:reqId++, passthrough:{sym}
        }));
      }, i*500);
    });
    // Keepalive
    setInterval(()=>{ if(dataWS.readyState===1) dataWS.send(JSON.stringify({ping:1})); },25000);
  });

  dataWS.on('message', (raw)=>{
    try{
      const data = JSON.parse(raw);
      if(!data||data.error) return;

      if(data.msg_type==='history'){
        const sym = data.passthrough&&data.passthrough.sym;
        if(!sym||!SD[sym]) return;
        const sd = SD[sym];
        const prices = data.history&&data.history.prices;
        if(!prices) return;
        prices.forEach(p=>{
          const pf = parseFloat(p);
          if(!sd.pipSize) sd.pipSize = inferPip(p);
          const d = extractDigit(pf, sd.pipSize);
          if(d<0||d>9) return;
          sd.digits.push(d);
          sd.counts[d]++;
          if(sd.digits.length>50000) sd.digits.shift();
        });
        sd.tickCount += prices.length;
        console.log(`[${SYM_LBL[sym]}] History loaded: ${sd.digits.length} ticks`);
        // Build baseline from history
        if(sd.digits.length>=1000 && !sd.baseline) updateChangeDetection(sym);
        // Subscribe to live ticks
        dataWS.send(JSON.stringify({ticks:sym, subscribe:1, req_id:reqId++}));
        return;
      }

      if(data.msg_type==='tick'){
        const sym = data.tick.symbol;
        const sd = SD[sym];
        if(!sd) return;
        const pf = parseFloat(data.tick.quote);
        if(!sd.pipSize) sd.pipSize = inferPip(data.tick.quote);
        const d = extractDigit(pf, sd.pipSize);
        if(d<0||d>9) return;

        sd.digits.push(d);
        sd.counts[d]++;
        if(sd.digits.length>50000) sd.digits.shift();
        sd.tickCount++;

        // Intelligence updates on every tick
        updateQuadIntelligence(sym, d);
        minePattern(sym, d);
        updateChangeDetection(sym);

        // Log every 10k ticks
        if(sd.tickCount%10000===0){
          console.log(`[${SYM_LBL[sym]}] ${sd.tickCount.toLocaleString()} ticks processed · ${Object.keys(sd.patterns).length} patterns`);
        }
      }
    } catch(e){ console.error('Parse error:', e.message); }
  });

  dataWS.on('close', ()=>{
    console.log('Disconnected. Reconnecting in 3s...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });

  dataWS.on('error', (e)=>{
    console.error('WS error:', e.message);
  });
}

// ── HTTP SERVER — serves brain to the bot ──
const server = http.createServer((req, res)=>{
  // CORS — allow bot to fetch from any domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  if(req.url==='/brain'||req.url==='/'){
    // Serve full brain
    res.writeHead(200);
    res.end(JSON.stringify(brain));
    return;
  }

  if(req.url==='/status'){
    // Quick status check
    const status = {
      alive: true,
      uptime: Math.floor(process.uptime())+'s',
      markets: SYMBOLS.map(s=>({
        sym: SYM_LBL[s],
        ticks: SD[s].tickCount,
        patterns: Object.keys(SD[s].patterns).length,
        changeDetected: SD[s].lastChangeDetected,
      })),
      brain: brain._meta,
    };
    res.writeHead(200);
    res.end(JSON.stringify(status,null,2));
    return;
  }

  res.writeHead(404);
  res.end('{"error":"not found"}');
});

server.listen(PORT, ()=>{
  console.log(`Oracle Brain Server running on port ${PORT}`);
  console.log(`Brain endpoint: http://localhost:${PORT}/brain`);
  console.log(`Status: http://localhost:${PORT}/status`);
});

// ── START ──
connect();
console.log('Oracle Brain Server started. Watching all 8 markets 24/7.');
