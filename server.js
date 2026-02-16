// ═══════════════════════════════════════════════════════════
// Планетарный Хаос 2D — Сервер v0.5
// ═══════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname)));

// ── Хранилище ─────────────────────────────────────────────
const players = {};       // ключ — nick
const missions = [];      // летящие флоты и шахтёры
const asteroids = [];     // астероидные поля

// ── Константы ─────────────────────────────────────────────
const TICK_RATE = 1000;
const MISSION_TICK = 50;           // обновление миссий (мс)
const MAP_W = 4000;
const MAP_H = 3000;
const NICK_MIN = 3;
const NICK_MAX = 16;

// Экономика
const RES_PER_LVL = 8;
const LVL_COST_BASE = 100;
const LVL_COST_MULT = 1.6;
const FLEET_COST = 10;
const DEFENSE_COST = 15;

// Боевая система
const ATTACK_THRESHOLD = 0.6;
const FLEET_SPEED = 120;           // px/сек
const ATTACK_COOLDOWN = 30000;     // 30 сек между атаками

// Дерево улучшений
const MIL_COST_BASE = 120;
const MIL_COST_MULT = 1.7;
const FORT_COST_BASE = 100;
const FORT_COST_MULT = 1.5;
const MIL_BONUS = 0.05;            // +5% урона за lvl
const FORT_DEF_REGEN = 0.5;        // +0.5 defense/тик за lvl fortification
const FORT_MAX_DEF_PER_LVL = 10;   // +10 макс defense за lvl

// Астероиды
const ASTEROID_COUNT = 12;
const ASTEROID_MIN_RES = 50;
const ASTEROID_MAX_RES = 200;
const ASTEROID_RESPAWN = 60000;     // 60 сек
const MINER_SPEED = 80;            // px/сек (медленнее флота)

// ── Утилиты ───────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function createPlayer(nick) {
  return {
    nick,
    x: randInt(200, MAP_W - 200),
    y: randInt(200, MAP_H - 200),
    lvl: 1,
    res: 50,
    fleet: 0,
    defense: 0,
    militaryLvl: 0,
    fortLvl: 0,
    lastAttack: 0,
    last_seen: Date.now(),
    online: true,
    color: `hsl(${randInt(0, 360)}, 70%, 55%)`
  };
}

function lvlUpCost(lvl) {
  return Math.floor(LVL_COST_BASE * Math.pow(LVL_COST_MULT, lvl - 1));
}
function milUpCost(lvl) {
  return Math.floor(MIL_COST_BASE * Math.pow(MIL_COST_MULT, lvl));
}
function fortUpCost(lvl) {
  return Math.floor(FORT_COST_BASE * Math.pow(FORT_COST_MULT, lvl));
}
function maxDefense(fortLvl) {
  return 5 + fortLvl * FORT_MAX_DEF_PER_LVL;
}

// ── Астероиды ─────────────────────────────────────────────
function spawnAsteroid() {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    x: randInt(100, MAP_W - 100),
    y: randInt(100, MAP_H - 100),
    res: randInt(ASTEROID_MIN_RES, ASTEROID_MAX_RES),
    alive: true
  };
}

// Начальная генерация
for (let i = 0; i < ASTEROID_COUNT; i++) {
  asteroids.push(spawnAsteroid());
}

// Респавн астероидов
setInterval(() => {
  const alive = asteroids.filter(a => a.alive).length;
  if (alive < ASTEROID_COUNT) {
    const missing = ASTEROID_COUNT - alive;
    // Респавним по 1-2 за тик
    const toSpawn = Math.min(missing, 2);
    for (let i = 0; i < toSpawn; i++) {
      // Заменяем мёртвый или добавляем
      const deadIdx = asteroids.findIndex(a => !a.alive);
      if (deadIdx >= 0) {
        asteroids[deadIdx] = spawnAsteroid();
      } else {
        asteroids.push(spawnAsteroid());
      }
    }
  }
}, ASTEROID_RESPAWN);

// ── Экономический тик (1 сек) ────────────────────────────
setInterval(() => {
  for (const nick in players) {
    const p = players[nick];
    // Доход ресурсов
    p.res += p.lvl * RES_PER_LVL;
    // Реген защиты (fortification)
    if (p.fortLvl > 0) {
      const max = maxDefense(p.fortLvl);
      if (p.defense < max) {
        p.defense = Math.min(max, p.defense + p.fortLvl * FORT_DEF_REGEN);
      }
    }
  }
  io.emit('state', getPublicState());
}, TICK_RATE);

// ── Тик миссий (50мс — плавное движение) ─────────────────
setInterval(() => {
  const dt = MISSION_TICK / 1000;
  for (let i = missions.length - 1; i >= 0; i--) {
    const m = missions[i];
    const dx = m.tx - m.x;
    const dy = m.ty - m.y;
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d < m.speed * dt + 5) {
      // Прибыл
      if (m.type === 'attack') {
        resolveAttack(m);
      } else if (m.type === 'mine') {
        resolveMining(m);
      } else if (m.type === 'return') {
        resolveReturn(m);
      }
      missions.splice(i, 1);
    } else {
      // Двигаем
      m.x += (dx / d) * m.speed * dt;
      m.y += (dy / d) * m.speed * dt;
    }
  }
  // Рассылаем позиции миссий
  if (missions.length > 0) {
    io.emit('missions', getMissionsPublic());
  }
}, MISSION_TICK);

// ── Разрешение атаки при прибытии ─────────────────────────
function resolveAttack(m) {
  const attacker = players[m.owner];
  const target = players[m.targetNick];
  if (!attacker || !target) return;

  const milBonus = 1 + (attacker.militaryLvl * MIL_BONUS);
  const attackPower = m.fleetCount * milBonus;
  const defensePower = (target.fleet + target.defense) * ATTACK_THRESHOLD;
  const win = attackPower > defensePower;

  if (win) {
    const stolenRes = Math.floor(target.res * 0.5);
    attacker.res += stolenRes;

    io.emit('explosion', { x: target.x, y: target.y, big: true });
    io.emit('chat', { from: '⚔ бой', text: `${m.owner} уничтожил планету ${m.targetNick}! Украдено ${stolenRes} res` });

    // Возвращаем выживший флот (30% потерь)
    const surviving = Math.floor(m.fleetCount * 0.7);
    if (surviving > 0) {
      attacker.fleet += surviving;
    }

    // Уничтожаем планету цели — отправляем экран поражения
    const defeatData = {
      killedBy: m.owner,
      lostRes: target.res,
      hadLvl: target.lvl,
      hadFleet: target.fleet
    };

    // Убираем миссии цели
    for (let i = missions.length - 1; i >= 0; i--) {
      if (missions[i].owner === m.targetNick) missions.splice(i, 1);
    }

    // Удаляем игрока из мира
    delete players[m.targetNick];

    // Отправляем defeated всем сокетам этого ника
    for (const [, s] of io.sockets.sockets) {
      if (s._currentNick === m.targetNick) {
        s.emit('defeated', defeatData);
        s._currentNick = null;
      }
    }
  } else {
    // Поражение атакующего — весь посланный флот теряется
    target.defense = Math.max(0, target.defense - Math.floor(m.fleetCount * 0.3));
    io.emit('explosion', { x: m.x, y: m.y, big: false });
    io.emit('chat', { from: '⚔ бой', text: `${m.owner} атаковал ${m.targetNick} и проиграл! Флот уничтожен.` });
  }

  io.emit('state', getPublicState());
}

// ── Разрешение добычи ─────────────────────────────────────
function resolveMining(m) {
  const asteroid = asteroids.find(a => a.id === m.asteroidId && a.alive);
  if (!asteroid) {
    // Астероид уже собран — шахтёр возвращается с пустыми руками
    missions.push({
      type: 'return',
      owner: m.owner,
      x: m.x, y: m.y,
      tx: players[m.owner]?.x || m.x,
      ty: players[m.owner]?.y || m.y,
      speed: MINER_SPEED,
      cargo: 0
    });
    return;
  }

  const cargo = asteroid.res;
  asteroid.alive = false;

  // Шахтёр летит обратно с грузом
  const owner = players[m.owner];
  if (owner) {
    missions.push({
      type: 'return',
      owner: m.owner,
      x: m.x, y: m.y,
      tx: owner.x, ty: owner.y,
      speed: MINER_SPEED,
      cargo
    });
  }

  io.emit('chat', { from: '⛏', text: `${m.owner} добыл астероид (+${cargo} res в пути)` });
}

// ── Возврат шахтёра ───────────────────────────────────────
function resolveReturn(m) {
  const owner = players[m.owner];
  if (owner && m.cargo > 0) {
    owner.res += m.cargo;
    io.emit('chat', { from: '⛏', text: `Шахтёр ${m.owner} вернулся с ${m.cargo} res` });
  }
  // Шахтёр-единица fleet не возвращается (потрачена)
}

// ── Публичное состояние ───────────────────────────────────
function getPublicState() {
  const list = [];
  for (const nick in players) {
    const p = players[nick];
    list.push({
      nick: p.nick,
      x: p.x, y: p.y,
      lvl: p.lvl,
      res: p.res,
      fleet: p.fleet,
      defense: Math.floor(p.defense),
      militaryLvl: p.militaryLvl,
      fortLvl: p.fortLvl,
      lastAttack: p.lastAttack,
      online: p.online,
      color: p.color
    });
  }
  return list;
}

function getMissionsPublic() {
  return missions.map(m => ({
    type: m.type,
    owner: m.owner,
    x: m.x, y: m.y,
    tx: m.tx, ty: m.ty,
    targetNick: m.targetNick || null,
    cargo: m.cargo || 0
  }));
}

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentNick = null;

  // Геттер/сеттер для синхронизации _currentNick на сокете
  function setNick(nick) {
    currentNick = nick;
    socket._currentNick = nick;
  }

  // Регистрация / восстановление
  socket.on('join', (nick, callback) => {
    if (typeof nick !== 'string') return callback({ ok: false, msg: 'Неверный ник' });
    nick = nick.trim();
    if (nick.length < NICK_MIN || nick.length > NICK_MAX) {
      return callback({ ok: false, msg: `Ник: ${NICK_MIN}–${NICK_MAX} символов` });
    }

    if (players[nick]) {
      players[nick].online = true;
      players[nick].last_seen = Date.now();
      setNick(nick);
      callback({ ok: true, restored: true, player: players[nick] });
    } else {
      players[nick] = createPlayer(nick);
      setNick(nick);
      callback({ ok: true, restored: false, player: players[nick] });
    }

    // Отправить текущее состояние подключившемуся
    socket.emit('state', getPublicState());
    socket.emit('missions', getMissionsPublic());
    socket.emit('asteroids', asteroids.filter(a => a.alive));

    io.emit('state', getPublicState());
    io.emit('chat', { from: '⚙ система', text: `${nick} присоединился` });
  });

  // ── Улучшение Economy (lvl) ─────────────────────────────
  socket.on('upgradeLvl', () => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    const cost = lvlUpCost(p.lvl);
    if (p.res >= cost) {
      p.res -= cost;
      p.lvl += 1;
      socket.emit('upgraded', { type: 'lvl', lvl: p.lvl, res: p.res });
    }
  });

  // ── Улучшение Military ──────────────────────────────────
  socket.on('upgradeMilitary', () => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    const cost = milUpCost(p.militaryLvl);
    if (p.res >= cost) {
      p.res -= cost;
      p.militaryLvl += 1;
      socket.emit('upgraded', { type: 'military', militaryLvl: p.militaryLvl, res: p.res });
    }
  });

  // ── Улучшение Fortification ─────────────────────────────
  socket.on('upgradeFort', () => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    const cost = fortUpCost(p.fortLvl);
    if (p.res >= cost) {
      p.res -= cost;
      p.fortLvl += 1;
      socket.emit('upgraded', { type: 'fort', fortLvl: p.fortLvl, res: p.res });
    }
  });

  // ── Покупка флота ───────────────────────────────────────
  socket.on('buyFleet', (amount) => {
    if (!currentNick || !players[currentNick]) return;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    const p = players[currentNick];
    const cost = amount * FLEET_COST;
    if (p.res >= cost) {
      p.res -= cost;
      p.fleet += amount;
      socket.emit('fleetBought', { fleet: p.fleet, res: p.res });
    }
  });

  // ── Покупка защиты ──────────────────────────────────────
  socket.on('buyDefense', (amount) => {
    if (!currentNick || !players[currentNick]) return;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    const p = players[currentNick];
    const max = maxDefense(p.fortLvl);
    const canBuy = Math.min(amount, Math.floor(max - p.defense));
    if (canBuy <= 0) return socket.emit('info', 'Максимум defense для текущего уровня Fort');
    const cost = canBuy * DEFENSE_COST;
    if (p.res >= cost) {
      p.res -= cost;
      p.defense += canBuy;
      socket.emit('defenseBought', { defense: Math.floor(p.defense), res: p.res });
    }
  });

  // ── Атака (отправка флота) ──────────────────────────────
  socket.on('attack', (data) => {
    if (!currentNick || !players[currentNick]) return;
    const targetNick = typeof data === 'string' ? data : data?.target;
    const sendCount = typeof data === 'object' ? Math.floor(Number(data.count) || 0) : 0;

    if (typeof targetNick !== 'string' || !players[targetNick]) return;
    if (targetNick === currentNick) return;

    const attacker = players[currentNick];

    // Кулдаун
    const now = Date.now();
    if (now - attacker.lastAttack < ATTACK_COOLDOWN) {
      const remain = Math.ceil((ATTACK_COOLDOWN - (now - attacker.lastAttack)) / 1000);
      return socket.emit('attackResult', { ok: false, msg: `Кулдаун: ${remain} сек` });
    }

    // Сколько флота отправляем
    const fleetToSend = sendCount > 0 ? Math.min(sendCount, attacker.fleet) : attacker.fleet;
    if (fleetToSend <= 0) {
      return socket.emit('attackResult', { ok: false, msg: 'Нет флота для атаки' });
    }

    const target = players[targetNick];
    attacker.fleet -= fleetToSend;
    attacker.lastAttack = now;

    // Создаём миссию
    const speed = FLEET_SPEED * (1 + attacker.militaryLvl * 0.1);
    missions.push({
      type: 'attack',
      owner: currentNick,
      targetNick,
      fleetCount: fleetToSend,
      x: attacker.x, y: attacker.y,
      tx: target.x, ty: target.y,
      speed
    });

    const d = dist(attacker.x, attacker.y, target.x, target.y);
    const eta = Math.ceil(d / speed);

    socket.emit('attackResult', { ok: true, launched: true, fleetSent: fleetToSend, eta });
    io.emit('chat', { from: '⚔ бой', text: `${currentNick} отправил ${fleetToSend} кораблей к ${targetNick} (ETA ~${eta} сек)` });
    io.emit('state', getPublicState());
  });

  // ── Отправить шахтёра на астероид ───────────────────────
  socket.on('mine', (asteroidId) => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    if (p.fleet < 1) return socket.emit('info', 'Нужен хотя бы 1 fleet для добычи');

    const asteroid = asteroids.find(a => a.id === asteroidId && a.alive);
    if (!asteroid) return socket.emit('info', 'Астероид уже собран');

    p.fleet -= 1;

    missions.push({
      type: 'mine',
      owner: currentNick,
      asteroidId,
      x: p.x, y: p.y,
      tx: asteroid.x, ty: asteroid.y,
      speed: MINER_SPEED
    });

    socket.emit('minerSent', { fleet: p.fleet });
    io.emit('state', getPublicState());
  });

  // ── Самоуничтожение ─────────────────────────────────────
  socket.on('selfDestruct', () => {
    if (!currentNick || !players[currentNick]) return;
    const nick = currentNick;
    io.emit('explosion', { x: players[nick].x, y: players[nick].y, big: true });
    io.emit('chat', { from: '💥', text: `${nick} самоуничтожился` });
    // Удалить миссии этого игрока
    for (let i = missions.length - 1; i >= 0; i--) {
      if (missions[i].owner === nick) missions.splice(i, 1);
    }
    delete players[nick];
    setNick(null);
    socket.emit('destroyed');
    io.emit('state', getPublicState());
  });

  // ── Отключение ──────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentNick && players[currentNick]) {
      players[currentNick].online = false;
      players[currentNick].last_seen = Date.now();
      io.emit('state', getPublicState());
    }
  });
});

// ── Рассылка астероидов (каждые 2 сек) ────────────────────
setInterval(() => {
  io.emit('asteroids', asteroids.filter(a => a.alive));
}, 2000);

// ── Запуск ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🪐 Планетарный Хаос v0.5 запущен на http://localhost:${PORT}`);
});
