/* Orbit Clash: the room host runs the simulation and broadcasts snapshots. */
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), waiting = $('waiting'), gameScreen = $('game');
const canvas = $('game-canvas'), ctx = canvas.getContext('2d');
let peer = null, connection = null, isHost = false, playerNumber = 0, soloMode = false, coopMode = false, connectionTimer = null, handshakeComplete = false;
let state = null, lastTime = 0, animationId = 0, input = {};
let audioContext = null, soundEnabled = true;
let paused = false, shake = 0, banner = { text: '', life: 0 }, lastCountdown = 0;
const WORLD = { width: 1280, height: 720 };
const stars = Array.from({ length: 150 }, (_, i) => ({ x: (i * 83) % WORLD.width, y: (i * 137) % WORLD.height, r: i % 5 === 0 ? 1.5 : .7, a: .25 + (i % 7) / 12 }));

function show(screen) { [lobby, waiting, gameScreen].forEach((x) => x.classList.add('hidden')); screen.classList.remove('hidden'); }
function message(text) { $('connection-message').textContent = text; }
function roomId() { return 'orbit-' + Math.random().toString(36).slice(2, 8); }
function fail(text) {
  message(text);
  if (connectionTimer) clearTimeout(connectionTimer);
  if (peer) peer.destroy();
  peer = null; connection = null; handshakeComplete = false;
}

function startConnectionTimeout(text) {
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = setTimeout(() => {
    if (!handshakeComplete) fail(text);
  }, 12000);
}

$('solo-mode').onclick = () => { soloMode = true; playerNumber = 1; startSoloGame(); };

$('create-pve').onclick = () => createRoom('coop');

$('create-room').onclick = () => {
  createRoom('duel');
};

function createRoom(mode) {
  isHost = true; playerNumber = 1; soloMode = false; coopMode = mode === 'coop'; message('Создаём комнату...');
  peer = new Peer(roomId(), { debug: 1 });
  peer.on('open', (id) => { $('room-code-display').textContent = id.slice(6).toUpperCase(); peer.roomId = id; show(waiting); });
  peer.on('connection', (conn) => { if (connection) { conn.close(); return; } connection = conn; setupConnection(); });
  peer.on('error', (error) => fail(peerError(error, 'Не удалось создать комнату.')));
}

$('join-room').onclick = () => {
  const code = $('room-code').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4) return message('Введи код комнаты.');
  isHost = false; playerNumber = 2; message('Подключаемся к комнате...');
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    connection = peer.connect('orbit-' + code, { reliable: true, serialization: 'json' });
    setupConnection();
    startConnectionTimeout('Не удалось подключиться. Проверь код комнаты и попроси создателя открыть новую комнату.');
  });
  peer.on('error', (error) => fail(peerError(error, 'Комната не найдена или уже закрыта.')));
};

function setupConnection() {
  if (!connection) return;
  connection.on('open', () => {
    message(isHost ? 'Товарищ подключился, запускаем игру...' : 'Соединение установлено, ждём подтверждение комнаты...');
    if (isHost) {
      connection.send({ type: 'room-accepted', mode: coopMode ? 'coop' : 'duel' });
    } else {
      connection.send({ type: 'ready' });
    }
  });
  connection.on('data', (data) => {
    if (data.type === 'room-accepted' && !isHost) {
      coopMode = data.mode === 'coop';
      handshakeComplete = true;
      if (connectionTimer) clearTimeout(connectionTimer);
      connection.send({ type: 'ready' });
      message('Подключено. Запускаем игру...');
    }
    if (data.type === 'ready' && isHost) {
      handshakeComplete = true;
      if (connectionTimer) clearTimeout(connectionTimer);
      startGame();
      connection.send({ type: 'game-start' });
    }
    if (data.type === 'game-start' && !isHost) {
      soloMode = false;
      show(gameScreen);
      configureHud();
      resizeCanvas();
      $('game-message').classList.add('hidden');
      if (coopMode) $('p2-label').textContent = 'НАПАРНИК';
      message('');
    }
    if (data.type === 'input' && isHost && state && state.players[1]) state.players[1].input = normalizeInput(data.input);
    if (data.type === 'shop-buy' && isHost && state && coopMode) buyItem(data.id);
    if (data.type === 'continue-wave' && isHost && state && coopMode) continueWave();
    if (data.type === 'state' && !isHost) {
      state = data.state;
      paused = !!state.paused;
      if (gameScreen.classList.contains('hidden')) { show(gameScreen); configureHud(); resizeCanvas(); }
      draw(); updateHud();
    }
    if (data.type === 'restart' && isHost) { startGame(); connection.send({ type: 'game-restart' }); sound('start'); }
    if (data.type === 'game-restart' && !isHost) {
      if (state) state.running = true;
      $('game-message').classList.add('hidden');
      $('shop-panel').classList.add('hidden');
      sound('start');
    }
  });
  connection.on('close', () => { if (connectionTimer) clearTimeout(connectionTimer); if (!gameScreen.classList.contains('hidden')) showDisconnect(); else message('Подключение закрыто.'); });
  connection.on('error', (error) => fail(peerError(error, 'Соединение прервано.')));
}

function peerError(error, fallback) {
  const known = { 'peer-unavailable': 'Комната не найдена или уже закрыта.', 'unavailable-id': 'Не удалось создать уникальную комнату. Попробуй ещё раз.', network: 'PeerJS не может подключиться к сети.', 'server-error': 'Сервис соединения временно недоступен.' };
  return known[error && error.type] || fallback;
}
function normalizeInput(next) { return { up: !!next.up, down: !!next.down, left: !!next.left, right: !!next.right, fire: !!next.fire, dash: !!next.dash }; }

function initAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume();
}
function sound(kind) {
  if (!soundEnabled) return;
  initAudio();
  const now = audioContext.currentTime;
  const settings = { click: [520, .045, 'square', .035], fire: [150, .09, 'sawtooth', .055], hit: [78, .16, 'triangle', .08], kill: [280, .22, 'square', .065], damage: [62, .3, 'sawtooth', .08], buy: [760, .16, 'square', .055], wave: [340, .35, 'triangle', .06], start: [440, .4, 'square', .05], win: [660, .5, 'triangle', .06], lose: [110, .55, 'sawtooth', .06], dash: [210, .12, 'sawtooth', .05], shield: [900, .18, 'square', .06], count: [560, .1, 'square', .04], pickup: [1000, .2, 'triangle', .05], boss: [90, .6, 'sawtooth', .08] };
  const [frequency, duration, type, volume] = settings[kind] || settings.click;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(35, frequency * .55), now + duration);
  gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(.001, now + duration);
  oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(now); oscillator.stop(now + duration);
}
function sendGuestInput() {
  if (!connection || !connection.open || isHost) return;
  connection.send({ type: 'input', input: normalizeInput({ up: !!input.ArrowUp, down: !!input.ArrowDown, left: !!input.ArrowLeft, right: !!input.ArrowRight, fire: !!input.Enter, dash: !!input.ShiftLeft || !!input.ShiftRight }) });
}

function newPlayer(x, color, angle) { return { x, y: WORLD.height / 2, angle, color, health: 3, maxHealth: 3, shield: 0, shieldTimer: 0, cooldown: 0, dash: 0, input: {} }; }
function startGame() {
  soloMode = false;
  state = { running: true, winner: 0, bullets: [], sparks: [], players: [newPlayer(250, 'blue', 0), newPlayer(1030, 'red', Math.PI)], wins: [0, 0], round: 1, countdown: 3, paused: false };
  if (coopMode) { state.coop = true; state.enemies = []; state.drops = []; state.wave = 1; state.score = 0; state.combo = 0; state.comboTimer = 0; state.shopOpen = false; state.upgrades = { maxHealth: 3, speed: 260, cooldown: .28, shots: 1 }; state.players[0].x = 280; state.players[1].x = 1000; spawnWave(); }
  show(gameScreen); configureHud(); $('shop-panel').classList.add('hidden'); resizeCanvas(); $('game-message').classList.add('hidden'); lastTime = performance.now(); cancelAnimationFrame(animationId); animationId = requestAnimationFrame(loop);
  startCountdown();
}
function startSoloGame() {
  soloMode = true;
  state = { running: true, winner: 0, bullets: [], sparks: [], players: [newPlayer(250, 'blue', 0)], enemies: [], drops: [], wave: 1, score: 0, combo: 0, comboTimer: 0, waveDelay: 0, shopOpen: false, upgrades: { maxHealth: 3, speed: 260, cooldown: .28, shots: 1, shield: 0 } };
  show(gameScreen); configureHud(); $('shop-panel').classList.add('hidden'); resizeCanvas(); $('game-message').classList.add('hidden'); lastTime = performance.now(); cancelAnimationFrame(animationId); animationId = requestAnimationFrame(loop);
  spawnWave();
}
function configureHud() {
  $('round-state').textContent = soloMode ? '● SOLO' : coopMode ? '● CO-OP' : '● DUEL';
  $('p2-label').textContent = soloMode ? 'ДРОНЫ' : 'ИГРОК 2';
  $('p2-health').textContent = soloMode ? '—' : 'HP 3 / 3';
  $('p1-label').textContent = soloMode ? 'ПИЛОТ' : 'ИГРОК 1';
  $('round-score').textContent = soloMode ? 'СЕРИЯ 0' : `РАУНД ${state && state.wins ? state.wins[0] : 0} : ${state && state.wins ? state.wins[1] : 0}`;
  $('p1-health-bar').style.width = '100%'; $('p2-health-bar').style.width = '100%'; $('p1-shield').textContent = 'ЩИТ 0'; $('p2-shield').textContent = 'ЩИТ 0';
  $('solo-stats').classList.toggle('hidden', !(soloMode || coopMode));
  document.querySelectorAll('.controls-player-two').forEach((element) => element.classList.toggle('hidden', false));
}
function loop(time) {
  const dt = Math.min((time - lastTime) / 1000, .035); lastTime = time;
  if (state && state.running && !state.shopOpen && !paused && !state.countdown && (isHost || soloMode)) update(dt);
  if (banner.life > 0) banner.life -= dt;
  shake = Math.max(0, shake - dt * 18);
  draw(); updateHud();
  animationId = requestAnimationFrame(loop);
}
function update(dt) {
  state.players.forEach((p, idx) => {
    const keys = p.input || {};
    if (keys.left) p.angle -= 3.1 * dt;
    if (keys.right) p.angle += 3.1 * dt;
    const thrust = (keys.up ? 1 : 0) - (keys.down ? .55 : 0);
    const moveSpeed = (soloMode || coopMode) ? state.upgrades.speed : 260;
    p.x += Math.cos(p.angle) * thrust * moveSpeed * dt; p.y += Math.sin(p.angle) * thrust * moveSpeed * dt;
    p.x = Math.max(24, Math.min(WORLD.width - 24, p.x)); p.y = Math.max(24, Math.min(WORLD.height - 24, p.y));
    p.cooldown = Math.max(0, p.cooldown - dt); p.dash = Math.max(0, p.dash - dt); p.shieldTimer = Math.max(0, p.shieldTimer - dt);
    if (keys.dash && p.dash === 0) { p.x += Math.cos(p.angle) * 115; p.y += Math.sin(p.angle) * 115; p.x = Math.max(24, Math.min(WORLD.width - 24, p.x)); p.y = Math.max(24, Math.min(WORLD.height - 24, p.y)); p.dash = 2.4; burst(p.x, p.y, p.color); sound('dash'); }
    if (keys.fire && p.cooldown === 0) { firePlayer(p, idx); p.cooldown = (soloMode || coopMode) ? state.upgrades.cooldown : .28; }
  });
  if (soloMode || coopMode) updateSolo(dt);
  state.bullets.forEach((b) => { b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; });
  state.bullets = state.bullets.filter((b) => b.life > 0 && b.x > -20 && b.x < WORLD.width + 20 && b.y > -20 && b.y < WORLD.height + 20);
  if (soloMode || coopMode) resolveSoloBullets();
  else state.bullets.forEach((b) => { const target = state.players[1 - b.owner]; if (Math.hypot(b.x - target.x, b.y - target.y) < 23) damagePlayer(target, 1, b.owner); });
  state.sparks = state.sparks.filter((s) => (s.life -= dt) > 0);
  if (!soloMode && connection && connection.open) connection.send({ type: 'state', state });
}
function damagePlayer(player, amount, attacker) {
  if (player.shield > 0) { player.shield--; player.shieldTimer = 8; sound('shield'); burst(player.x, player.y, 'cream'); }
  else { player.health -= amount; shake = 6; sound('damage'); burst(player.x, player.y, player.color); }
  if (player.health <= 0) {
    if (soloMode) { state.running = false; state.winner = 0; }
    else if (coopMode) {
      if (state.players.every((pilot) => pilot.health <= 0)) { state.running = false; state.winner = 0; }
    } else finishRound(attacker);
  }
}
function finishRound(winner) {
  state.running = false; state.winner = winner + 1; state.wins[winner]++;
  if (state.wins[winner] >= 3) { banner = { text: `ПОБЕДА ${winner + 1}`, life: 4 }; }
  else { banner = { text: `РАУНД ${state.round} ЗАВЕРШЁН`, life: 3 }; }
}
function startCountdown() {
  state.countdown = 3; lastCountdown = 3; $('countdown').textContent = '3'; $('countdown').classList.remove('hidden');
  const timer = setInterval(() => { if (!state || soloMode) return clearInterval(timer); state.countdown--; if (state.countdown > 0) { $('countdown').textContent = state.countdown; sound('count'); } else { $('countdown').textContent = 'СТАРТ'; sound('start'); setTimeout(() => $('countdown').classList.add('hidden'), 500); clearInterval(timer); } }, 900);
}
function spawnWave() {
  const amount = Math.min(3 + state.wave, 10);
  if (state.wave % 5 === 0) {
    state.enemies.push({ type: 'boss', x: WORLD.width / 2, y: -55, angle: Math.PI / 2, health: 40 + state.wave * 4, maxHealth: 40 + state.wave * 4, cooldown: 1, speed: 28, radius: 40, color: 'red', points: 2000 });
  }
  for (let i = 0; i < amount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const roll = (i + state.wave) % 3; const type = roll === 0 ? 'scout' : roll === 1 ? 'interceptor' : 'armored';
    const config = { scout: [1, 95, 100, 19], interceptor: [2 + Math.floor(state.wave / 5), 62, 180, 25], armored: [5 + Math.floor(state.wave / 3), 38, 300, 32] }[type];
    state.enemies.push({ type, x: side < 0 ? -35 : WORLD.width + 35, y: 70 + ((i * 97 + state.wave * 31) % 580), angle: side < 0 ? 0 : Math.PI, health: config[0], maxHealth: config[0], cooldown: 1 + i * .12, speed: config[1] + state.wave * 2, color: 'red', points: config[2], radius: config[3] });
  }
  state.waveDelay = 0;
}
function firePlayer(player, idx) {
  const count = (soloMode || coopMode) ? state.upgrades.shots : 1;
  for (let i = 0; i < count; i++) {
    const spread = count === 1 ? 0 : (i - (count - 1) / 2) * .14;
    const angle = player.angle + spread;
    state.bullets.push({ x: player.x + Math.cos(angle) * 24, y: player.y + Math.sin(angle) * 24, vx: Math.cos(angle) * 610, vy: Math.sin(angle) * 610, owner: idx, fromEnemy: false, life: 1.5 });
  }
  sound('fire');
}
function updateSolo(dt) {
  const player = state.players[0];
  if (state.enemies.length === 0 && !state.shopOpen) { state.shopOpen = true; openShop(); sound('wave'); }
  state.enemies.forEach((enemy) => {
    const dx = player.x - enemy.x, dy = player.y - enemy.y, distance = Math.hypot(dx, dy) || 1;
    enemy.angle = Math.atan2(dy, dx); enemy.x += dx / distance * enemy.speed * dt; enemy.y += dy / distance * enemy.speed * dt;
    enemy.cooldown -= dt;
    if (enemy.type === 'boss' && enemy.y < 150) enemy.y += 18 * dt;
    if (enemy.cooldown <= 0 && distance < 700) {
      const shots = enemy.type === 'boss' ? 3 : 1;
      for (let shot = 0; shot < shots; shot++) { const targetIndex = coopMode ? (Math.random() < .5 ? 0 : 1) : 0; const target = state.players[targetIndex]; const tx = target.x - enemy.x, ty = target.y - enemy.y, targetAngle = Math.atan2(ty, tx); const spread = (shot - (shots - 1) / 2) * .18; const a = targetAngle + spread; state.bullets.push({ x: enemy.x, y: enemy.y, vx: Math.cos(a) * 280, vy: Math.sin(a) * 280, owner: 0, target: targetIndex, fromEnemy: true, life: 2.2 }); }
      enemy.cooldown = enemy.type === 'boss' ? 1.2 : Math.max(.7, 1.8 - state.wave * .06);
    }
    if (distance < (enemy.radius || 34)) { damagePlayer(player, 1, 0); enemy.x = -100; }
    if (coopMode && state.players[1] && Math.hypot(enemy.x - state.players[1].x, enemy.y - state.players[1].y) < (enemy.radius || 34)) { damagePlayer(state.players[1], 1, 1); enemy.x = -100; }
  });
  state.enemies = state.enemies.filter((enemy) => enemy.x > -80 && enemy.x < WORLD.width + 80 && enemy.y > -80 && enemy.y < WORLD.height + 80);
}
function resolveSoloBullets() {
  const player = state.players[0];
  state.bullets.forEach((bullet) => {
    if (bullet.fromEnemy) {
      const target = coopMode && state.players[1] && bullet.target !== undefined ? state.players[bullet.target] : player;
      if (Math.hypot(bullet.x - target.x, bullet.y - target.y) < 22) { bullet.life = 0; damagePlayer(target, 1, 0); }
      return;
    }
    state.enemies.forEach((enemy) => { if (bullet.life > 0 && Math.hypot(bullet.x - enemy.x, bullet.y - enemy.y) < (enemy.radius || 22)) { bullet.life = 0; enemy.health--; burst(enemy.x, enemy.y, 'red'); sound(enemy.health <= 0 ? 'kill' : 'hit'); if (enemy.health <= 0) { const dropX = enemy.x, dropY = enemy.y; enemy.x = -100; state.combo++; state.comboTimer = 3; const points = Math.round(enemy.points * (1 + state.combo / 5)); state.score += points; if (Math.random() < .28) state.drops.push({ x: dropX, y: dropY, kind: Math.random() < .5 ? 'repair' : 'shield', life: 10 }); } } });
  });
  state.enemies = state.enemies.filter((enemy) => enemy.x !== -100);
  state.drops = state.drops.filter((drop) => { drop.life -= .035; const collector = state.players.find((p) => Math.hypot(drop.x - p.x, drop.y - p.y) < 28); if (collector) { if (drop.kind === 'repair') collector.health = Math.min(collector.maxHealth, collector.health + 1); else collector.shield = Math.min(3, collector.shield + 1); sound('pickup'); return false; } return drop.life > 0; });
  state.comboTimer -= .035; if (state.comboTimer <= 0) state.combo = 0;
}
const SHOP_ITEMS = [
  { id: 'repair', name: 'Ремонт корпуса', description: '+1 HP', price: 150, canBuy: (p) => p.health < state.upgrades.maxHealth, buy: (p) => { p.health++; } },
  { id: 'fullRepair', name: 'Полный ремонт', description: 'Восстановить всё HP', price: 350, canBuy: (p) => p.health < state.upgrades.maxHealth, buy: (p) => { p.health = state.upgrades.maxHealth; } },
  { id: 'hull', name: 'Усиленный корпус', description: '+1 к максимуму HP', price: 500, canBuy: () => state.upgrades.maxHealth < 8, buy: (p) => { state.upgrades.maxHealth++; p.health++; } },
  { id: 'engine', name: 'Усиленный двигатель', description: '+35 к скорости', price: 300, canBuy: () => state.upgrades.speed < 365, buy: () => { state.upgrades.speed += 35; } },
  { id: 'cooldown', name: 'Быстрая перезарядка', description: 'Стрелять на 20% быстрее', price: 400, canBuy: () => state.upgrades.cooldown > .12, buy: () => { state.upgrades.cooldown = Math.max(.12, state.upgrades.cooldown * .8); } },
  { id: 'shots', name: 'Двойной выстрел', description: 'Два снаряда веером', price: 750, canBuy: () => state.upgrades.shots < 2, buy: () => { state.upgrades.shots = 2; } },
  { id: 'triple', name: 'Тройной импульс', description: 'Три снаряда веером', price: 1400, canBuy: () => state.upgrades.shots < 3, buy: () => { state.upgrades.shots = 3; } },
  { id: 'shield', name: 'Щитовой генератор', description: '+1 заряд щита', price: 600, canBuy: (p) => p.shield < 3, buy: (p) => { p.shield++; } }
];
function openShop() {
  if (!(soloMode || coopMode) || !state.running) return;
  $('shop-panel').classList.remove('hidden'); $('game-message').classList.add('hidden'); renderShop();
}
function renderShop() {
  $('shop-score').textContent = state.score;
  $('shop-items').innerHTML = SHOP_ITEMS.map((item) => {
    const available = state.score >= item.price && item.canBuy(state.players[0]);
    return `<button class="shop-item" data-shop-id="${item.id}" ${available ? '' : 'disabled'}><strong>${item.name}</strong><small>${item.description}</small><span class="shop-price">${item.price} очков</span></button>`;
  }).join('');
}
function buyItem(id) {
  const item = SHOP_ITEMS.find((entry) => entry.id === id), player = state.players[0];
  if (!item || state.score < item.price || !item.canBuy(player)) return;
  state.score -= item.price;
  if (coopMode) state.players.forEach((pilot) => item.buy(pilot));
  else item.buy(player);
  sound('buy'); renderShop(); updateHud();
}
function continueWave() { if (!(soloMode || coopMode) || !state || !state.shopOpen) return; initAudio(); sound('wave'); state.shopOpen = false; $('shop-panel').classList.add('hidden'); state.wave++; spawnWave(); }
$('continue-wave').onclick = () => { if (coopMode && !isHost && connection && connection.open) { connection.send({ type: 'continue-wave' }); return; } continueWave(); };
$('shop-items').addEventListener('click', (event) => {
  const button = event.target.closest('[data-shop-id]');
  if (button && !button.disabled) {
    if (coopMode && !isHost && connection && connection.open) connection.send({ type: 'shop-buy', id: button.dataset.shopId });
    else buyItem(button.dataset.shopId);
  }
});
function burst(x, y, color) { for (let i = 0; i < 12; i++) state.sparks.push({ x, y, vx: Math.cos(i) * (30 + i * 3), vy: Math.sin(i) * (30 + i * 3), life: .5, color }); }

function resizeCanvas() { const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio; }
function draw() {
  if (!state) return; const sx = canvas.width / WORLD.width, sy = canvas.height / WORLD.height; ctx.save(); ctx.scale(sx, sy);
  ctx.fillStyle = '#090b0b'; ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  ctx.strokeStyle = '#d8bf7540'; ctx.lineWidth = 1;
  for (let x = 40; x < WORLD.width; x += 80) { ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, WORLD.height - 20); ctx.stroke(); }
  for (let y = 40; y < WORLD.height; y += 80) { ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(WORLD.width - 20, y); ctx.stroke(); }
  stars.forEach((s) => { ctx.globalAlpha = s.a * .55; ctx.fillStyle = '#e5c777'; ctx.fillRect(s.x, s.y, s.r, s.r); }); ctx.globalAlpha = 1;
  ctx.strokeStyle = '#e5c777'; ctx.lineWidth = 2; ctx.setLineDash([8, 14]); ctx.strokeRect(18, 18, WORLD.width - 36, WORLD.height - 36); ctx.setLineDash([]);
  ctx.strokeStyle = '#5fc4d850'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(WORLD.width / 2, WORLD.height / 2, 130, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(WORLD.width / 2, WORLD.height / 2, 170, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#e5c777'; ctx.font = '12px Space Mono'; ctx.fillText('СЕКТОР 07-A', 34, 42); ctx.fillText('ОРБИТАЛЬНАЯ СЕТЬ // 1961', WORLD.width - 245, 42);
  state.bullets.forEach((b) => { ctx.strokeStyle = b.fromEnemy ? '#e5c777' : (b.owner === 0 ? '#5fc4d8' : '#e34b3f'); ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(b.x - b.vx / 80, b.y - b.vy / 80); ctx.lineTo(b.x, b.y); ctx.stroke(); });
  state.sparks.forEach((s) => { ctx.globalAlpha = s.life * 2; ctx.fillStyle = s.color === 'blue' ? '#42a9ff' : '#ff5b73'; ctx.fillRect(s.x, s.y, 4, 4); }); ctx.globalAlpha = 1;
  state.players.forEach(drawShip); if (soloMode || coopMode) state.enemies.forEach(drawEnemy); if (soloMode || coopMode) state.drops?.forEach(drawDrop); ctx.restore();
}
function drawShip(p) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); const c = p.color === 'blue' ? '#5fc4d8' : '#e34b3f'; ctx.shadowBlur = 14; ctx.shadowColor = c; ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(27, 0); ctx.lineTo(-9, -16); ctx.lineTo(-17, -8); ctx.lineTo(-13, 0); ctx.lineTo(-17, 8); ctx.lineTo(-9, 16); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = '#f4ead5'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#f4ead5'; ctx.fillRect(-5, -4, 10, 8); if (p.input && p.input.up) { ctx.fillStyle = '#e5c777'; ctx.beginPath(); ctx.moveTo(-14, -5); ctx.lineTo(-30, 0); ctx.lineTo(-14, 5); ctx.fill(); } ctx.restore(); }
function drawEnemy(enemy) { ctx.save(); ctx.translate(enemy.x, enemy.y); ctx.rotate(enemy.angle); ctx.fillStyle = '#e34b3f'; ctx.shadowBlur = 13; ctx.shadowColor = '#e34b3f'; ctx.beginPath(); ctx.moveTo(19, 0); ctx.lineTo(-12, -12); ctx.lineTo(-7, 0); ctx.lineTo(-12, 12); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#e5c777'; ctx.stroke(); ctx.fillStyle = '#e5c777'; ctx.fillRect(-15, -3, 7, 6); ctx.restore(); }
function drawDrop(drop) { ctx.save(); ctx.translate(drop.x, drop.y); ctx.rotate(performance.now() / 500); ctx.fillStyle = drop.kind === 'repair' ? '#61d39a' : '#e5c777'; ctx.strokeStyle = '#f4ead5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.rect(-9, -9, 18, 18); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#111316'; ctx.font = 'bold 12px Space Mono'; ctx.textAlign = 'center'; ctx.fillText(drop.kind === 'repair' ? '+' : 'S', 0, 5); ctx.restore(); }
function updateHud() {
  if (!state) return;
  const player = state.players[0], opponent = state.players[1];
  const maxHealth = (soloMode || coopMode) ? state.upgrades.maxHealth : 3;
  $('p1-health').textContent = `HP ${Math.max(0, player.health)} / ${maxHealth}`;
  $('p1-health-bar').style.width = `${Math.max(0, Math.min(100, player.health / maxHealth * 100))}%`;
  if (!soloMode) {
    $('p2-health').textContent = `HP ${Math.max(0, opponent.health)} / 3`;
    $('p2-health-bar').style.width = `${Math.max(0, opponent.health / 3 * 100)}%`;
  }
  if (soloMode || coopMode) { $('wave-value').textContent = state.wave; $('enemy-value').textContent = state.enemies.length; $('score-value').textContent = state.score; if (state.shopOpen && $('shop-panel').classList.contains('hidden')) openShop(); }
  $('p1-shield').textContent = `ЩИТ ${player.shield || 0}`;
  if (opponent) $('p2-shield').textContent = `ЩИТ ${opponent.shield || 0}`;
  $('round-score').textContent = (soloMode || coopMode) ? `СЕРИЯ ${state.combo || 0}` : `РАУНД ${state.wins[0]} : ${state.wins[1]}`;
  if (!state.running) showWinner();
}
function showWinner() { const msg = $('game-message'); $('shop-panel').classList.add('hidden'); if (!msg.classList.contains('hidden')) return; const title = soloMode ? 'ИГРА ОКОНЧЕНА' : coopMode ? 'РУБЕЖ ПРОРВАН' : (state.winner === playerNumber ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'); const details = (soloMode || coopMode) ? `<small>Счёт: ${state.score} · Волна: ${state.wave}</small>` : ''; msg.innerHTML = `<strong>${title}</strong>${details}<button class="button button-light" id="restart">ИГРАТЬ СНОВА</button>`; msg.classList.remove('hidden'); sound(soloMode || coopMode ? 'lose' : (state.winner === playerNumber ? 'win' : 'lose')); $('restart').onclick = () => { sound('click'); if (soloMode) startSoloGame(); else if (isHost) { startGame(); if (connection && connection.open) connection.send({ type: 'game-restart' }); } else if (connection && connection.open) connection.send({ type: 'restart' }); }; }
function showDisconnect() { $('round-state').textContent = '● ИГРОК ВЫШЕЛ'; $('game-message').innerHTML = '<strong>СОЕДИНЕНИЕ ПРЕРВАНО</strong>'; $('game-message').classList.remove('hidden'); }

window.addEventListener('keydown', (e) => { if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault(); if (!input[e.code]) sound('click'); input[e.code] = true; sendGuestInput(); });
window.addEventListener('keyup', (e) => { input[e.code] = false; sendGuestInput(); });
setInterval(sendGuestInput, 40);
setInterval(() => { if (!state || !state.running) return; const localInput = { up: !!input.KeyW, down: !!input.KeyS, left: !!input.KeyA, right: !!input.KeyD, fire: !!input.Space }; if (soloMode) state.players[0].input = localInput; else if (isHost && connection && connection.open) state.players[0].input = localInput; }, 40);
window.addEventListener('resize', resizeCanvas); resizeCanvas();
$('room-code-display').onclick = async () => { try { await navigator.clipboard.writeText($('room-code-display').textContent); $('copy-hint').textContent = 'Код скопирован'; } catch { $('copy-hint').textContent = 'Скопируй код вручную'; } };
$('cancel-room').onclick = () => { if (peer) peer.destroy(); peer = null; connection = null; show(lobby); message(''); };
$('sound-toggle').onclick = () => { soundEnabled = !soundEnabled; if (soundEnabled) { initAudio(); sound('click'); } $('sound-toggle').textContent = `ЗВУК: ${soundEnabled ? 'ВКЛ' : 'ВЫКЛ'}`; };
document.querySelectorAll('button').forEach((button) => { button.addEventListener('click', () => { if (button.id !== 'sound-toggle') { initAudio(); sound('click'); } }); });
