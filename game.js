/* Orbit Clash: the room host runs the simulation and broadcasts snapshots. */
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), waiting = $('waiting'), gameScreen = $('game');
const canvas = $('game-canvas'), ctx = canvas.getContext('2d');
let peer = null, connection = null, isHost = false, playerNumber = 0, soloMode = false;
let state = null, lastTime = 0, animationId = 0, input = {};
const WORLD = { width: 1280, height: 720 };
const stars = Array.from({ length: 150 }, (_, i) => ({ x: (i * 83) % WORLD.width, y: (i * 137) % WORLD.height, r: i % 5 === 0 ? 1.5 : .7, a: .25 + (i % 7) / 12 }));

function show(screen) { [lobby, waiting, gameScreen].forEach((x) => x.classList.add('hidden')); screen.classList.remove('hidden'); }
function message(text) { $('connection-message').textContent = text; }
function roomId() { return 'orbit-' + Math.random().toString(36).slice(2, 8); }
function fail(text) { message(text); if (peer) peer.destroy(); peer = null; connection = null; }

$('solo-mode').onclick = () => { soloMode = true; playerNumber = 1; startSoloGame(); };

$('create-room').onclick = () => {
  isHost = true; playerNumber = 1; message('Создаём комнату...');
  peer = new Peer(roomId());
  peer.on('open', (id) => { $('room-code-display').textContent = id.slice(6).toUpperCase(); peer.roomId = id; show(waiting); });
  peer.on('connection', (conn) => { if (connection) return; connection = conn; setupConnection(); });
  peer.on('error', () => fail('Не удалось создать комнату. Попробуй ещё раз.'));
};

$('join-room').onclick = () => {
  const code = $('room-code').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4) return message('Введи код комнаты.');
  isHost = false; playerNumber = 2; message('Подключаемся к комнате...');
  peer = new Peer();
  peer.on('open', () => { connection = peer.connect('orbit-' + code, { reliable: true }); setupConnection(); });
  peer.on('error', () => fail('Комната не найдена или уже закрыта.'));
};

function setupConnection() {
  connection.on('open', () => {
    if (isHost) startGame();
    else { connection.send({ type: 'ready' }); message('Подключено.'); }
  });
  connection.on('data', (data) => {
    if (data.type === 'ready' && isHost) startGame();
    if (data.type === 'input' && isHost && state) state.players[1].input = data.input;
    if (data.type === 'state' && !isHost) { state = data.state; draw(); updateHud(); }
    if (data.type === 'restart') { if (isHost) startGame(); }
  });
  connection.on('close', () => { if (!gameScreen.classList.contains('hidden')) showDisconnect(); });
  connection.on('error', () => message('Соединение прервано.'));
}

function newPlayer(x, color, angle) { return { x, y: WORLD.height / 2, angle, color, health: 3, cooldown: 0, input: {} }; }
function startGame() {
  soloMode = false;
  state = { running: true, winner: 0, bullets: [], sparks: [], players: [newPlayer(250, 'blue', 0), newPlayer(1030, 'red', Math.PI)] };
  show(gameScreen); configureHud(); resizeCanvas(); $('game-message').classList.add('hidden'); lastTime = performance.now(); cancelAnimationFrame(animationId); animationId = requestAnimationFrame(loop);
}
function startSoloGame() {
  state = { running: true, winner: 0, bullets: [], sparks: [], players: [newPlayer(250, 'blue', 0)], enemies: [], wave: 1, score: 0, spawnTimer: 0, waveDelay: 0 };
  show(gameScreen); configureHud(); resizeCanvas(); $('game-message').classList.add('hidden'); lastTime = performance.now(); cancelAnimationFrame(animationId); animationId = requestAnimationFrame(loop);
  spawnWave();
}
function configureHud() {
  $('round-state').textContent = soloMode ? '● SOLO' : '● ONLINE';
  $('p2-label').textContent = soloMode ? 'ДРОНЫ' : 'ИГРОК 2';
  $('p2-health').textContent = soloMode ? '—' : '♥ ♥ ♥';
  $('solo-stats').classList.toggle('hidden', !soloMode);
  document.querySelectorAll('.controls-player-two').forEach((element) => element.classList.toggle('hidden', soloMode));
}
function loop(time) {
  const dt = Math.min((time - lastTime) / 1000, .035); lastTime = time;
  if (state && state.running && (isHost || soloMode)) update(dt);
  draw(); updateHud();
  animationId = requestAnimationFrame(loop);
}
function update(dt) {
  state.players.forEach((p, idx) => {
    const keys = p.input || {};
    if (keys.left) p.angle -= 3.1 * dt;
    if (keys.right) p.angle += 3.1 * dt;
    const thrust = (keys.up ? 1 : 0) - (keys.down ? .55 : 0);
    p.x += Math.cos(p.angle) * thrust * 260 * dt; p.y += Math.sin(p.angle) * thrust * 260 * dt;
    p.x = Math.max(24, Math.min(WORLD.width - 24, p.x)); p.y = Math.max(24, Math.min(WORLD.height - 24, p.y));
    p.cooldown = Math.max(0, p.cooldown - dt);
    if (keys.fire && p.cooldown === 0) { state.bullets.push({ x: p.x + Math.cos(p.angle) * 24, y: p.y + Math.sin(p.angle) * 24, vx: Math.cos(p.angle) * 610, vy: Math.sin(p.angle) * 610, owner: idx, fromEnemy: false, life: 1.5 }); p.cooldown = .28; }
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
function updateSolo(dt) {
  const player = state.players[0];
  if (state.enemies.length === 0) { state.waveDelay += dt; if (state.waveDelay > 1.4) { state.wave++; spawnWave(); } }
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
function updateHud() { if (!state) return; const hearts = (n) => '♥ '.repeat(Math.max(0, n)).trim() || '—'; $('p1-health').textContent = hearts(state.players[0].health); if (!soloMode) $('p2-health').textContent = hearts(state.players[1].health); if (soloMode) { $('wave-value').textContent = state.wave; $('enemy-value').textContent = state.enemies.length; $('score-value').textContent = state.score; } if (!state.running) showWinner(); }
function showWinner() { const msg = $('game-message'); if (!msg.classList.contains('hidden')) return; const title = soloMode ? 'ИГРА ОКОНЧЕНА' : (state.winner === playerNumber ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'); const details = soloMode ? `<small>Счёт: ${state.score} · Волна: ${state.wave}</small>` : ''; msg.innerHTML = `<strong>${title}</strong>${details}<button class="button button-light" id="restart">Играть снова</button>`; msg.classList.remove('hidden'); $('restart').onclick = () => { if (soloMode) startSoloGame(); else if (isHost) startGame(); else if (connection && connection.open) connection.send({ type: 'restart' }); }; }
function showDisconnect() { $('round-state').textContent = '● ИГРОК ВЫШЕЛ'; $('game-message').innerHTML = '<strong>СОЕДИНЕНИЕ ПРЕРВАНО</strong>'; $('game-message').classList.remove('hidden'); }

window.addEventListener('keydown', (e) => { if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) e.preventDefault(); input[e.code] = true; });
window.addEventListener('keyup', (e) => { input[e.code] = false; });
setInterval(() => { if (!connection || !connection.open || isHost) return; connection.send({ type: 'input', input: { up: !!input.ArrowUp, down: !!input.ArrowDown, left: !!input.ArrowLeft, right: !!input.ArrowRight, fire: !!input.Enter } }); }, 40);
setInterval(() => { if (!state || !state.running) return; const localInput = { up: !!input.KeyW, down: !!input.KeyS, left: !!input.KeyA, right: !!input.KeyD, fire: !!input.Space }; if (soloMode) state.players[0].input = localInput; else if (isHost && connection && connection.open) state.players[0].input = localInput; }, 40);
window.addEventListener('resize', resizeCanvas); resizeCanvas();
$('room-code-display').onclick = async () => { try { await navigator.clipboard.writeText($('room-code-display').textContent); $('copy-hint').textContent = 'Код скопирован'; } catch { $('copy-hint').textContent = 'Скопируй код вручную'; } };
$('cancel-room').onclick = () => { if (peer) peer.destroy(); peer = null; connection = null; show(lobby); message(''); };
