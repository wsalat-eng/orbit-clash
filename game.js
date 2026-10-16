/* Orbit Clash: the room host runs the simulation and broadcasts snapshots. */
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), waiting = $('waiting'), gameScreen = $('game');
const canvas = $('game-canvas'), ctx = canvas.getContext('2d');
let peer = null, connection = null, isHost = false, playerNumber = 0, soloMode = false, connectionTimer = null, handshakeComplete = false;
let state = null, lastTime = 0, animationId = 0, input = {};
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

$('create-room').onclick = () => {
  isHost = true; playerNumber = 1; message('Создаём комнату...');
  peer = new Peer(roomId(), { debug: 1 });
  peer.on('open', (id) => { $('room-code-display').textContent = id.slice(6).toUpperCase(); peer.roomId = id; show(waiting); });
  peer.on('connection', (conn) => { if (connection) { conn.close(); return; } connection = conn; setupConnection(); });
  peer.on('error', (error) => fail(peerError(error, 'Не удалось создать комнату.')));
};

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
      connection.send({ type: 'room-accepted' });
    } else {
      connection.send({ type: 'ready' });
    }
  });
  connection.on('data', (data) => {
    if (data.type === 'room-accepted' && !isHost) {
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
      message('');
    }
    if (data.type === 'input' && isHost && state) state.players[1].input = data.input;
    if (data.type === 'state' && !isHost) {
      state = data.state;
      if (gameScreen.classList.contains('hidden')) { show(gameScreen); configureHud(); resizeCanvas(); }
      draw(); updateHud();
    }
    if (data.type === 'restart') { if (isHost) startGame(); }
  });
  connection.on('close', () => { if (connectionTimer) clearTimeout(connectionTimer); if (!gameScreen.classList.contains('hidden')) showDisconnect(); else message('Подключение закрыто.'); });
  connection.on('error', (error) => fail(peerError(error, 'Соединение прервано.')));
}

function peerError(error, fallback) {
  const known = { peer-unavailable: 'Комната не найдена или уже закрыта.', unavailable-id: 'Не удалось создать уникальную комнату. Попробуй ещё раз.', network: 'PeerJS не может подключиться к сети.', server-error: 'Сервис соединения временно недоступен.' };
  return known[error && error.type] || fallback;
}

function newPlayer(x, color, angle) { return { x, y: WORLD.height / 2, angle, color, health: 3, cooldown: 0, input: {} }; }
function startGame() {
  soloMode = false;
  state = { running: true, winner: 0, bullets: [], sparks: [], players: [newPlayer(250, 'blue', 0), newPlayer(1030, 'red', Math.PI)] };
  show(gameScreen); configureHud(); $('shop-panel').classList.add('hidden'); resizeCanvas(); $('game-message').classList.add('hidden'); lastTime = performance.now(); cancelAnimationFrame(animationId); animationId = requestAnimationFrame(loop);
}
function startSoloGame() {
  state = { running: true, winner: 0, bullets: [], sparks: [], players: [newPlayer(250, 'blue', 0)], enemies: [], wave: 1, score: 0, waveDelay: 0, shopOpen: false, upgrades: { maxHealth: 3, speed: 260, cooldown: .28, shots: 1 } };
  show(gameScreen); configureHud(); $('shop-panel').classList.add('hidden'); resizeCanvas(); $('game-message').classList.add('hidden'); lastTime = performance.now(); cancelAnimationFrame(animationId); animationId = requestAnimationFrame(loop);
  spawnWave();
}
function configureHud() {
  $('round-state').textContent = soloMode ? '● SOLO' : '● ONLINE';
  $('p2-label').textContent = soloMode ? 'ДРОНЫ' : 'ИГРОК 2';
  $('p2-health').textContent = soloMode ? '—' : '♥ ♥ ♥';
  $('p1-health-bar').style.width = '100%'; $('p2-health-bar').style.width = '100%';
  $('solo-stats').classList.toggle('hidden', !soloMode);
  document.querySelectorAll('.controls-player-two').forEach((element) => element.classList.toggle('hidden', soloMode));
}
function loop(time) {
  const dt = Math.min((time - lastTime) / 1000, .035); lastTime = time;
  if (state && state.running && !state.shopOpen && (isHost || soloMode)) update(dt);
  draw(); updateHud();
  animationId = requestAnimationFrame(loop);
}
function update(dt) {
  state.players.forEach((p, idx) => {
    const keys = p.input || {};
    if (keys.left) p.angle -= 3.1 * dt;
    if (keys.right) p.angle += 3.1 * dt;
    const thrust = (keys.up ? 1 : 0) - (keys.down ? .55 : 0);
    const moveSpeed = soloMode ? state.upgrades.speed : 260;
    p.x += Math.cos(p.angle) * thrust * moveSpeed * dt; p.y += Math.sin(p.angle) * thrust * moveSpeed * dt;
    p.x = Math.max(24, Math.min(WORLD.width - 24, p.x)); p.y = Math.max(24, Math.min(WORLD.height - 24, p.y));
    p.cooldown = Math.max(0, p.cooldown - dt);
    if (keys.fire && p.cooldown === 0) { firePlayer(p, idx); p.cooldown = soloMode ? state.upgrades.cooldown : .28; }
  });
  if (soloMode) updateSolo(dt);
  state.bullets.forEach((b) => { b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; });
  state.bullets = state.bullets.filter((b) => b.life > 0 && b.x > -20 && b.x < WORLD.width + 20 && b.y > -20 && b.y < WORLD.height + 20);
  if (soloMode) resolveSoloBullets();
  else state.bullets.forEach((b) => { const target = state.players[1 - b.owner]; if (Math.hypot(b.x - target.x, b.y - target.y) < 23) { target.health--; b.life = 0; burst(target.x, target.y, target.color); if (target.health <= 0) { state.running = false; state.winner = b.owner + 1; } } });
  state.sparks = state.sparks.filter((s) => (s.life -= dt) > 0);
  if (!soloMode && connection && connection.open) connection.send({ type: 'state', state });
}
function spawnWave() {
  const amount = Math.min(3 + state.wave, 10);
  for (let i = 0; i < amount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    state.enemies.push({ x: side < 0 ? -35 : WORLD.width + 35, y: 70 + ((i * 97 + state.wave * 31) % 580), angle: side < 0 ? 0 : Math.PI, health: 1 + Math.floor(state.wave / 4), cooldown: 1 + i * .12, speed: 42 + state.wave * 4, color: 'red' });
  }
  state.waveDelay = 0;
}
function firePlayer(player, idx) {
  const count = soloMode ? state.upgrades.shots : 1;
  for (let i = 0; i < count; i++) {
    const spread = count === 1 ? 0 : (i - (count - 1) / 2) * .14;
    const angle = player.angle + spread;
    state.bullets.push({ x: player.x + Math.cos(angle) * 24, y: player.y + Math.sin(angle) * 24, vx: Math.cos(angle) * 610, vy: Math.sin(angle) * 610, owner: idx, fromEnemy: false, life: 1.5 });
  }
}
function updateSolo(dt) {
  const player = state.players[0];
  if (state.enemies.length === 0 && !state.shopOpen) { state.shopOpen = true; openShop(); }
  state.enemies.forEach((enemy) => {
    const dx = player.x - enemy.x, dy = player.y - enemy.y, distance = Math.hypot(dx, dy) || 1;
    enemy.angle = Math.atan2(dy, dx); enemy.x += dx / distance * enemy.speed * dt; enemy.y += dy / distance * enemy.speed * dt;
    enemy.cooldown -= dt;
    if (enemy.cooldown <= 0 && distance < 600) { state.bullets.push({ x: enemy.x, y: enemy.y, vx: dx / distance * 280, vy: dy / distance * 280, owner: 0, fromEnemy: true, life: 2.2 }); enemy.cooldown = Math.max(.7, 1.8 - state.wave * .06); }
    if (distance < 34) { player.health -= 1; enemy.x = -100; burst(player.x, player.y, 'blue'); if (player.health <= 0) { state.running = false; state.winner = 0; } }
  });
  state.enemies = state.enemies.filter((enemy) => enemy.x > -80 && enemy.x < WORLD.width + 80 && enemy.y > -80 && enemy.y < WORLD.height + 80);
}
function resolveSoloBullets() {
  const player = state.players[0];
  state.bullets.forEach((bullet) => {
    if (bullet.fromEnemy) {
      if (Math.hypot(bullet.x - player.x, bullet.y - player.y) < 22) { bullet.life = 0; player.health--; burst(player.x, player.y, 'blue'); if (player.health <= 0) { state.running = false; state.winner = 0; } }
      return;
    }
    state.enemies.forEach((enemy) => { if (bullet.life > 0 && Math.hypot(bullet.x - enemy.x, bullet.y - enemy.y) < 22) { bullet.life = 0; enemy.health--; burst(enemy.x, enemy.y, 'red'); if (enemy.health <= 0) { enemy.x = -100; state.score += 100; } } });
  });
  state.enemies = state.enemies.filter((enemy) => enemy.x !== -100);
}
const SHOP_ITEMS = [
  { id: 'repair', name: 'Ремонт корпуса', description: '+1 HP', price: 150, canBuy: (p) => p.health < state.upgrades.maxHealth, buy: (p) => { p.health++; } },
  { id: 'fullRepair', name: 'Полный ремонт', description: 'Восстановить всё HP', price: 350, canBuy: (p) => p.health < state.upgrades.maxHealth, buy: (p) => { p.health = state.upgrades.maxHealth; } },
  { id: 'hull', name: 'Усиленный корпус', description: '+1 к максимуму HP', price: 500, canBuy: () => state.upgrades.maxHealth < 8, buy: (p) => { state.upgrades.maxHealth++; p.health++; } },
  { id: 'engine', name: 'Усиленный двигатель', description: '+35 к скорости', price: 300, canBuy: () => state.upgrades.speed < 365, buy: () => { state.upgrades.speed += 35; } },
  { id: 'cooldown', name: 'Быстрая перезарядка', description: 'Стрелять на 20% быстрее', price: 400, canBuy: () => state.upgrades.cooldown > .12, buy: () => { state.upgrades.cooldown = Math.max(.12, state.upgrades.cooldown * .8); } },
  { id: 'shots', name: 'Двойной выстрел', description: 'Два снаряда веером', price: 750, canBuy: () => state.upgrades.shots < 2, buy: () => { state.upgrades.shots = 2; } }
];
function openShop() {
  if (!soloMode || !state.running) return;
  $('shop-panel').classList.remove('hidden'); $('game-message').classList.add('hidden'); renderShop();
}
function renderShop() {
  $('shop-score').textContent = state.score;
  $('shop-items').innerHTML = SHOP_ITEMS.map((item) => {
    const available = state.score >= item.price && item.canBuy(state.players[0]);
    return `<button class="shop-item" data-shop-id="${item.id}" ${available ? '' : 'disabled'}><strong>${item.name}</strong><small>${item.description}</small><span class="shop-price">${item.price} очков</span></button>`;
  }).join('');
  document.querySelectorAll('[data-shop-id]').forEach((button) => { button.onclick = () => buyItem(button.dataset.shopId); });
}
function buyItem(id) {
  const item = SHOP_ITEMS.find((entry) => entry.id === id), player = state.players[0];
  if (!item || state.score < item.price || !item.canBuy(player)) return;
  state.score -= item.price; item.buy(player); renderShop(); updateHud();
}
$('continue-wave').onclick = () => { if (!soloMode || !state || !state.shopOpen) return; state.shopOpen = false; $('shop-panel').classList.add('hidden'); state.wave++; spawnWave(); };
function burst(x, y, color) { for (let i = 0; i < 12; i++) state.sparks.push({ x, y, vx: Math.cos(i) * (30 + i * 3), vy: Math.sin(i) * (30 + i * 3), life: .5, color }); }

function resizeCanvas() { const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * devicePixelRatio; canvas.height = rect.height * devicePixelRatio; }
function draw() {
  if (!state) return; const sx = canvas.width / WORLD.width, sy = canvas.height / WORLD.height; ctx.save(); ctx.scale(sx, sy);
  ctx.fillStyle = '#070b15'; ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  stars.forEach((s) => { ctx.globalAlpha = s.a; ctx.fillStyle = '#d9e8ff'; ctx.fillRect(s.x, s.y, s.r, s.r); }); ctx.globalAlpha = 1;
  ctx.strokeStyle = '#172b4a'; ctx.lineWidth = 2; ctx.setLineDash([8, 14]); ctx.strokeRect(18, 18, WORLD.width - 36, WORLD.height - 36); ctx.setLineDash([]);
  ctx.strokeStyle = '#16233b'; ctx.beginPath(); ctx.arc(WORLD.width / 2, WORLD.height / 2, 130, 0, Math.PI * 2); ctx.stroke();
  state.bullets.forEach((b) => { ctx.strokeStyle = b.fromEnemy ? '#ffb15c' : (b.owner === 0 ? '#67c3ff' : '#ff7187'); ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(b.x - b.vx / 80, b.y - b.vy / 80); ctx.lineTo(b.x, b.y); ctx.stroke(); });
  state.sparks.forEach((s) => { ctx.globalAlpha = s.life * 2; ctx.fillStyle = s.color === 'blue' ? '#42a9ff' : '#ff5b73'; ctx.fillRect(s.x, s.y, 4, 4); }); ctx.globalAlpha = 1;
  state.players.forEach(drawShip); if (soloMode) state.enemies.forEach(drawEnemy); ctx.restore();
}
function drawShip(p) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); const c = p.color === 'blue' ? '#42a9ff' : '#ff5b73'; ctx.shadowBlur = 18; ctx.shadowColor = c; ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(-17, -15); ctx.lineTo(-11, 0); ctx.lineTo(-17, 15); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0; ctx.fillStyle = '#f5fbff'; ctx.beginPath(); ctx.arc(1, 0, 4, 0, Math.PI * 2); ctx.fill(); if (p.input && p.input.up) { ctx.fillStyle = '#ffcf66'; ctx.beginPath(); ctx.moveTo(-14, -6); ctx.lineTo(-29, 0); ctx.lineTo(-14, 6); ctx.fill(); } ctx.restore(); }
function drawEnemy(enemy) { ctx.save(); ctx.translate(enemy.x, enemy.y); ctx.rotate(enemy.angle); ctx.fillStyle = '#ff5b73'; ctx.shadowBlur = 13; ctx.shadowColor = '#ff5b73'; ctx.beginPath(); ctx.moveTo(19, 0); ctx.lineTo(-12, -12); ctx.lineTo(-7, 0); ctx.lineTo(-12, 12); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#ffcf66'; ctx.fillRect(-15, -3, 7, 6); ctx.restore(); }
function updateHud() {
  if (!state) return;
  const player = state.players[0], opponent = state.players[1];
  $('p1-health').textContent = `HP ${Math.max(0, player.health)} / ${soloMode ? state.upgrades.maxHealth : 3}`;
  $('p1-health-bar').style.width = `${Math.max(0, Math.min(100, player.health / (soloMode ? state.upgrades.maxHealth : 3) * 100))}%`;
  if (!soloMode) {
    $('p2-health').textContent = `HP ${Math.max(0, opponent.health)} / 3`;
    $('p2-health-bar').style.width = `${Math.max(0, opponent.health / 3 * 100)}%`;
  }
  if (soloMode) { $('wave-value').textContent = state.wave; $('enemy-value').textContent = state.enemies.length; $('score-value').textContent = state.score; if (state.shopOpen) renderShop(); }
  if (!state.running) showWinner();
}
function showWinner() { const msg = $('game-message'); $('shop-panel').classList.add('hidden'); if (!msg.classList.contains('hidden')) return; const title = soloMode ? 'ИГРА ОКОНЧЕНА' : (state.winner === playerNumber ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'); const details = soloMode ? `<small>Счёт: ${state.score} · Волна: ${state.wave}</small>` : ''; msg.innerHTML = `<strong>${title}</strong>${details}<button class="button button-light" id="restart">Играть снова</button>`; msg.classList.remove('hidden'); $('restart').onclick = () => { if (soloMode) startSoloGame(); else if (isHost) startGame(); else if (connection && connection.open) connection.send({ type: 'restart' }); }; }
function showDisconnect() { $('round-state').textContent = '● ИГРОК ВЫШЕЛ'; $('game-message').innerHTML = '<strong>СОЕДИНЕНИЕ ПРЕРВАНО</strong>'; $('game-message').classList.remove('hidden'); }

window.addEventListener('keydown', (e) => { if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) e.preventDefault(); input[e.code] = true; });
window.addEventListener('keyup', (e) => { input[e.code] = false; });
setInterval(() => { if (!connection || !connection.open || isHost) return; connection.send({ type: 'input', input: { up: !!input.ArrowUp, down: !!input.ArrowDown, left: !!input.ArrowLeft, right: !!input.ArrowRight, fire: !!input.Enter } }); }, 40);
setInterval(() => { if (!state || !state.running) return; const localInput = { up: !!input.KeyW, down: !!input.KeyS, left: !!input.KeyA, right: !!input.KeyD, fire: !!input.Space }; if (soloMode) state.players[0].input = localInput; else if (isHost && connection && connection.open) state.players[0].input = localInput; }, 40);
window.addEventListener('resize', resizeCanvas); resizeCanvas();
$('room-code-display').onclick = async () => { try { await navigator.clipboard.writeText($('room-code-display').textContent); $('copy-hint').textContent = 'Код скопирован'; } catch { $('copy-hint').textContent = 'Скопируй код вручную'; } };
$('cancel-room').onclick = () => { if (peer) peer.destroy(); peer = null; connection = null; show(lobby); message(''); };
