// server.js
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json());

// === 1. 初始化数据库 ===
const db = new Database("gacha.db");

// 建表：用户
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    draw_count INTEGER NOT NULL DEFAULT 0
  )
`).run();

// 情侣绑定表
db.prepare(`
  CREATE TABLE IF NOT EXISTS couples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL
  )
`).run();

// 抽卡请求
db.prepare(`
  CREATE TABLE IF NOT EXISTS draw_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    partner_id INTEGER NOT NULL,
    requester_confirmed INTEGER NOT NULL DEFAULT 0,
    partner_confirmed INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0
  )
`).run();

// 抽卡记录
db.prepare(`
  CREATE TABLE IF NOT EXISTS draw_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    card_text TEXT NOT NULL,
    rarity TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`).run();

// === 2. 定义卡池和概率（这里先写简单版，你可以填入你完整卡池） ===
const rarityRates = [
  { rarity: "SSR", rate: 0.05 },
  { rarity: "SR",  rate: 0.20 },
  { rarity: "R",   rate: 0.35 },
  { rarity: "N",   rate: 0.40 }
];

// TODO: 这里为了示例只放了少量卡，你可以替换成你完整那套
const cardPool = {
  SSR: [
    "小心愿卡：下次见面你提出一个“小心愿”，我在合理范围内无条件帮你实现",
    "解决烦心事卡：你最近最烦的一件小事，我帮你搞定"
  ],
  SR: [
    "奶茶/饮料卡：我帮你点一杯你喜欢的奶茶或饮料",
    "小物品代购卡：我帮你买 / 带一件你需要的小东西"
  ],
  R: [
    "问题查询卡：你委托我查一个问题，我帮你查清楚",
    "提醒服务卡：帮你做一次简单的提醒"
  ],
  N: [
    "餐馆推荐卡：帮你搜一个好吃、便宜、离你近的餐馆推荐",
    "地点清单卡：给你整理一份附近可去的地点清单"
  ]
};

function rollRarity() {
  const r = Math.random();
  let acc = 0;
  for (const item of rarityRates) {
    acc += item.rate;
    if (r <= acc) return item.rarity;
  }
  return "N";
}

function drawCard() {
  const rarity = rollRarity();
  const list = cardPool[rarity];
  const index = Math.floor(Math.random() * list.length);
  return { rarity, text: list[index] };
}

// === 3. 接口设计 ===

// 3.1 登录 / 注册
// POST /api/login  { name }
app.post("/api/login", (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name 必须是字符串" });
  }

  // 先查
  let user = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
  if (!user) {
    // 没有就创建
    const info = db.prepare("INSERT INTO users (name) VALUES (?)").run(name);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  }

  // 查情侣绑定
  const couple = db.prepare(`
    SELECT * FROM couples WHERE user_a_id = ? OR user_b_id = ?
  `).get(user.id, user.id);

  let partner = null;
  if (couple) {
    const partnerId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id;
    partner = db.prepare("SELECT id, name, draw_count FROM users WHERE id = ?").get(partnerId);
  }

  res.json({
    user: { id: user.id, name: user.name, draw_count: user.draw_count },
    partner
  });
});

// 3.2 绑定另一半
// POST /api/bind  { userId, partnerName }
app.post("/api/bind", (req, res) => {
  const { userId, partnerName } = req.body;
  if (!userId || !partnerName) {
    return res.status(400).json({ error: "缺少参数" });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const partner = db.prepare("SELECT * FROM users WHERE name = ?").get(partnerName);
  if (!partner) return res.status(404).json({ error: "未找到这个昵称的用户（让 TA 先登录一次）" });

  // 先查是否已经绑定过
  const exists = db.prepare(`
    SELECT * FROM couples 
    WHERE (user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)
  `).get(user.id, partner.id, partner.id, user.id);

  if (exists) {
    return res.json({ message: "已经绑定过了", partner: { id: partner.id, name: partner.name, draw_count: partner.draw_count } });
  }

  db.prepare("INSERT INTO couples (user_a_id, user_b_id) VALUES (?, ?)").run(user.id, partner.id);

  return res.json({ 
    message: "绑定成功！", 
    partner: { id: partner.id, name: partner.name, draw_count: partner.draw_count }
  });
});

// 3.3 查询当前状态（包括未处理的抽卡请求）
// GET /api/status?userId=xxx
app.get("/api/status", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const couple = db.prepare(`
    SELECT * FROM couples WHERE user_a_id = ? OR user_b_id = ?
  `).get(user.id, user.id);

  let partner = null;
  if (couple) {
    const partnerId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id;
    partner = db.prepare("SELECT id, name, draw_count FROM users WHERE id = ?").get(partnerId);
  }

  // 找到与我有关的抽卡请求
  const requests = db.prepare(`
    SELECT dr.*, u1.name AS requester_name, u2.name AS partner_name
    FROM draw_requests dr
    JOIN users u1 ON dr.requester_id = u1.id
    JOIN users u2 ON dr.partner_id = u2.id
    WHERE requester_id = ? OR partner_id = ?
    ORDER BY dr.id DESC
    LIMIT 20
  `).all(user.id, user.id);

  res.json({
    user: { id: user.id, name: user.name, draw_count: user.draw_count },
    partner,
    requests
  });
});

// 3.4 发起“申请我抽卡”
// POST /api/request-draw  { userId }
app.post("/api/request-draw", (req, res) => {
  const { userId } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const couple = db.prepare(`
    SELECT * FROM couples WHERE user_a_id = ? OR user_b_id = ?
  `).get(user.id, user.id);
  if (!couple) return res.status(400).json({ error: "你还没有绑定另一半" });

  const partnerId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id;

  // 新建一条请求：自己已确认，对方未确认
  const info = db.prepare(`
    INSERT INTO draw_requests (requester_id, partner_id, requester_confirmed, partner_confirmed, used)
    VALUES (?, ?, 1, 0, 0)
  `).run(user.id, partnerId);

  res.json({ message: "已发出抽卡申请，等待对方同意", requestId: info.lastInsertRowid });
});

// 3.5 对方同意某个请求
// POST /api/approve-draw  { userId, requestId }
app.post("/api/approve-draw", (req, res) => {
  const { userId, requestId } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const request = db.prepare("SELECT * FROM draw_requests WHERE id = ?").get(requestId);
  if (!request) return res.status(404).json({ error: "请求不存在" });

  if (request.partner_id !== user.id) {
    return res.status(403).json({ error: "你不是这个请求的另一方，不能同意" });
  }
  if (request.used) {
    return res.status(400).json({ error: "这个请求已经被使用过了" });
  }

  db.prepare(`
    UPDATE draw_requests SET partner_confirmed = 1 WHERE id = ?
  `).run(requestId);

  res.json({ message: "已同意对方抽卡" });
});

// 3.6 真正执行抽卡
// POST /api/draw  { userId }
app.post("/api/draw", (req, res) => {
  const { userId } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  // 找到一条对我发起的请求：我是 requester，并且双方都确认，且未 used
  const request = db.prepare(`
    SELECT * FROM draw_requests
    WHERE requester_id = ? AND requester_confirmed = 1 AND partner_confirmed = 1 AND used = 0
    ORDER BY id ASC
  `).get(user.id);

  if (!request) {
    return res.status(400).json({ error: "没有可用的已同意的抽卡请求，请先申请并让对方同意" });
  }

  // 抽卡
  const card = drawCard();

  // 标记请求已使用
  db.prepare("UPDATE draw_requests SET used = 1 WHERE id = ?").run(request.id);

  // 累计次数 + 记录日志
  db.prepare("UPDATE users SET draw_count = draw_count + 1 WHERE id = ?").run(user.id);
  db.prepare(`
    INSERT INTO draw_logs (user_id, card_text, rarity, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(user.id, card.text, card.rarity);

  const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);

  res.json({
    message: "抽卡成功",
    card,
    user: { id: updatedUser.id, name: updatedUser.name, draw_count: updatedUser.draw_count }
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

app.listen(PORT, () => {
  console.log("Server running at http://localhost:" + PORT);
});

