const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== 静态资源（public/index.html） =====
const STATIC_DIR = path.join(__dirname, "public");
app.use(express.static(STATIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

/**
 * === App 更新接口（给 Android 用）===
 */
const updateInfo = {
  versionCode: 1,
  versionName: "1.0.0",
  apkUrl: "https://your-domain.com/path/to/your-apk.apk",
  changelog: "首次发布版本"
};
app.get("/update.json", (req, res) => res.json(updateInfo));

// ===== 数据库初始化 =====
const db = new Database("gacha.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// users 表
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    draw_count INTEGER NOT NULL DEFAULT 0
  )
`).run();

// 给 users 补 password 字段
try {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const hasPassword = cols.some((c) => c.name === "password");
  if (!hasPassword) {
    db.prepare("ALTER TABLE users ADD COLUMN password TEXT").run();
    console.log("Added password column to users table");
  }
} catch (e) {
  console.error("Check/Add password column failed:", e);
}

// ✅ 给 users 补 avatar_url 字段（头像：用 URL 字符串方式最稳）
try {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const hasAvatar = cols.some((c) => c.name === "avatar_url");
  if (!hasAvatar) {
    db.prepare("ALTER TABLE users ADD COLUMN avatar_url TEXT").run();
    console.log("Added avatar_url column to users table");
  }
} catch (e) {
  console.error("Check/Add avatar_url column failed:", e);
}

// 情侣绑定表（一个人可以绑定多个人）
db.prepare(`
  CREATE TABLE IF NOT EXISTS couples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL
  )
`).run();

// 抽卡请求表（双方同意）
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

// 抽卡日志（可选）
db.prepare(`
  CREATE TABLE IF NOT EXISTS draw_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    card_text TEXT NOT NULL,
    rarity TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`).run();

// 用户抽到的卡
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    card_text TEXT NOT NULL,
    rarity TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`).run();

// 用户自定义卡池（软删除 enabled=0）
db.prepare(`
  CREATE TABLE IF NOT EXISTS custom_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    rarity TEXT NOT NULL,
    text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  )
`).run();

// ✅ 用户隐藏系统默认卡（只对当前 user 生效）
db.prepare(`
  CREATE TABLE IF NOT EXISTS disabled_default_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    rarity TEXT NOT NULL,
    text TEXT NOT NULL,
    UNIQUE(user_id, rarity, text)
  )
`).run();

// ===== 默认卡池 & 概率 =====
const rarityRates = [
  { rarity: "SSR", rate: 0.05 },
  { rarity: "SR", rate: 0.20 },
  { rarity: "R", rate: 0.35 },
  { rarity: "N", rate: 0.40 }
];

const defaultCardPool = {
  SSR: [
    "小心愿卡：下次见面你提出一个“小心愿”，我在合理范围内无条件帮你实现",
    "解决烦心事卡：你最近最烦的一件小事，我帮你搞定（如资料打印、买东西、打电话咨询等）",
    "高级跑腿卡：我负责帮你跑腿一次（拿快递 / 买东西 / 代办简单事务）",
    "请你吃饭卡：下一次约会由我请你吃一顿性价比不错的饭",
    "实用小礼包卡：我给你准备一个有用的小礼包（文具 / 零食 / 小药包等）",
    "排版整理卡：我帮你做一份 PPT / 作业的排版或文档整理（不代写内容）",
    "出行规划卡：我负责查好下一次见面的路线 / 交通方案 / 时间安排",
    "代办差事卡：你最近不想做的一项小差事，我帮你代办（合理范围内）",
    "万能卡：你可以指定我执行卡池里任意一张实用卡（合理范围）",
    "幸运卡：你可以从 SSR/SR 实用卡里任选一张，我必须执行一次"
  ],
  SR: [
    "奶茶/饮料卡：我帮你点一杯你喜欢的奶茶或饮料",
    "小物品代购卡：我帮你买 / 带一件你需要的小东西（纸巾、文具、日常小物）",
    "小活动安排卡：我们下一次线下面见，由我安排一个小活动（散步 / 喝东西 / 随机小逛）",
    "学习信息查询卡：帮你查询与学习相关的信息（选课、课表、考试安排等）",
    "选择纠结解决卡：帮你一起选一个你纠结的小物件（衣服 / 包 / 电子产品等）",
    "云自习卡：陪你在线自习 30 分钟（开不开摄像都行）",
    "小礼物卡：我给你寄一个不贵的小礼物（大概 10～30 元档）",
    "帮你决定吃什么卡：你今天不想决定吃什么，由我来帮你做选择",
    "过河拆桥卡：从你已抽到但未使用的一张普通卡中移除 1 张（不能动 SSR）",
    "无懈可击卡：免疫对方对你使用的一张卡（使用前可以先沟通好范围）",
    "逆转卡：对方对你使用的一张卡，反转成对方自己执行（不含 SSR 实用卡）",
    "共享卡：将一张卡的效果变成两个人一起执行（例如一起自习、一起小出行）"
  ],
  R: [
    "问题查询卡：你委托我查一个问题，我帮你查清楚（查资料 / 看攻略等）",
    "提醒服务卡：帮你做一次简单的提醒（例如某个截止时间 / 报名 / 作业）",
    "零食携带卡：下次线下面见，我给你带点小零食",
    "选择困难解决卡：遇到 2～3 个选项纠结时，由我帮你选一个",
    "约会地点推荐卡：我帮你挑一个近期适合一起去的小地方（咖啡馆 / 公园 / 商圈）",
    "线上小游戏卡：和你一起玩一个轻量级线上小游戏（比如成语接龙 / 益智小游戏）",
    "优惠选择卡：帮你从各种优惠券 / 活动中选一个相对最省钱的方案",
    "日程提示卡：我帮你梳理并提醒你明天的安排（课程 / 会议 / 需要携带的东西）",
    "道歉卡：可以要求对方为一件“小事”正式向你道歉一次（氛围要轻松）",
    "原谅卡：主动选择原谅对方一件“小失误”（忘回消息 / 轻微迟到等）",
    "偷看卡：可以偷看对方下一张抽到的卡内容",
    "重抽卡：让对方刚抽到的一张卡作废，必须重新抽一张",
    "禁用卡：让对方的一张未使用卡失效一次（不能是 SSR 卡）",
    "延期卡：你可以把自己要执行的一张卡延后到下一次见面再执行"
  ],
  N: [
    "餐馆推荐卡：帮你搜一个好吃、便宜、离你近的餐馆推荐",
    "地点清单卡：给你整理一份“附近可去”的地点清单（咖啡厅 / 公园 / 自习点等）",
    "小建议卡：针对你当前的某个小困扰（穿搭 / 出行 / 作息），给一份实际建议",
    "10 分钟陪伴通话卡：和你语音 / 通话 10 分钟，纯陪伴不催任何事",
    "壁纸/头像推荐卡：帮你找一张适合你的壁纸或头像",
    "轻松放松卡：一起看一个约 5 分钟的搞笑 / 解压视频放松一下",
    "出行提醒卡：帮你查近期的天气并给简单出行建议（要不要带伞 / 外套等）",
    "拍照卡：下次见面时我会专门给你拍一张好看的照片（由你挑一张）"
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

function isCoupled(userId, partnerId) {
  const row = db.prepare(`
    SELECT 1 FROM couples
    WHERE (user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)
    LIMIT 1
  `).get(userId, partnerId, partnerId, userId);
  return !!row;
}

// 获取某用户抽卡用的池（默认卡会过滤掉“已隐藏的默认卡”）
// 自定义卡：自己 + 所有绑定对象 enabled=1
function getUserCardPoolForDraw(userId) {
  const pool = {};
  const rarities = Object.keys(defaultCardPool);

  // 找出所有绑定对象（双向）
  const partners = db.prepare(`
    SELECT user_a_id AS id FROM couples WHERE user_b_id = ?
    UNION
    SELECT user_b_id AS id FROM couples WHERE user_a_id = ?
  `).all(userId, userId).map(r => r.id);

  partners.push(userId);

  // 查用户隐藏的默认卡
  const disabledRows = db.prepare(`
    SELECT rarity, text
    FROM disabled_default_cards
    WHERE user_id = ?
  `).all(userId);
  const disabledSet = new Set(disabledRows.map(r => `${r.rarity}||${r.text}`));

  for (const rarity of rarities) {
    const baseAll = defaultCardPool[rarity] ? defaultCardPool[rarity].slice() : [];
    const base = baseAll.filter(text => !disabledSet.has(`${rarity}||${text}`));

    let customList = [];
    for (const pid of partners) {
      const rows = db.prepare(`
        SELECT text FROM custom_cards
        WHERE user_id = ? AND rarity = ? AND enabled = 1
      `).all(pid, rarity);
      customList = customList.concat(rows.map(r => r.text));
    }

    pool[rarity] = base.concat(customList);
  }
  return pool;
}

function drawCardForUser(userId) {
  const rarity = rollRarity();
  const pool = getUserCardPoolForDraw(userId);
  const list = pool[rarity] || [];
  if (list.length === 0) {
    const fallbackList = defaultCardPool[rarity] || defaultCardPool["N"];
    const idx = Math.floor(Math.random() * fallbackList.length);
    return { rarity, text: fallbackList[idx] };
  }
  const index = Math.floor(Math.random() * list.length);
  return { rarity, text: list[index] };
}

// ===== 接口 =====

// 3.1 登录 / 注册（带密码）
app.post("/api/login", (req, res) => {
  const { name, password } = req.body;
  if (!name || typeof name !== "string" || !password || typeof password !== "string") {
    return res.status(400).json({ error: "name 和 password 必须是字符串" });
  }

  let user = db.prepare("SELECT * FROM users WHERE name = ?").get(name);

  if (!user) {
    const info = db.prepare("INSERT INTO users (name, password) VALUES (?, ?)").run(name, password);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  } else {
    if (!user.password) {
      db.prepare("UPDATE users SET password = ? WHERE id = ?").run(password, user.id);
      user.password = password;
    } else if (user.password !== password) {
      return res.status(400).json({ error: "密码错误" });
    }
  }

  res.json({
    user: {
      id: user.id,
      name: user.name,
      draw_count: user.draw_count,
      avatar_url: user.avatar_url || ""
    }
  });
});

// ✅ 头像设置（先用 URL 字符串方式）
app.post("/api/profile/avatar", (req, res) => {
  const { userId, avatarUrl } = req.body;
  if (!userId || typeof avatarUrl !== "string") {
    return res.status(400).json({ error: "缺少参数 userId 或 avatarUrl" });
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  // 简单长度限制，防止塞超长字符串
  if (avatarUrl.length > 500) {
    return res.status(400).json({ error: "avatarUrl 太长" });
  }

  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl.trim(), userId);

  const updated = db.prepare("SELECT id, name, draw_count, avatar_url FROM users WHERE id = ?").get(userId);
  res.json({ message: "头像已更新", user: updated });
});

// 3.2 绑定对象（可绑定多个）
app.post("/api/bind", (req, res) => {
  const { userId, partnerName } = req.body;
  if (!userId || !partnerName) return res.status(400).json({ error: "缺少参数" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const partner = db.prepare("SELECT * FROM users WHERE name = ?").get(partnerName);
  if (!partner) return res.status(404).json({ error: "未找到这个昵称的用户（让 TA 先登录一次）" });

  if (partner.id === user.id) {
    return res.status(400).json({ error: "不能绑定自己" });
  }

  const exists = db.prepare(`
    SELECT * FROM couples
    WHERE (user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)
  `).get(user.id, partner.id, partner.id, user.id);

  if (!exists) {
    db.prepare("INSERT INTO couples (user_a_id, user_b_id) VALUES (?, ?)").run(user.id, partner.id);
  }

  res.json({
    message: exists ? "已经绑定过了" : "绑定成功！",
    partner: {
      id: partner.id,
      name: partner.name,
      draw_count: partner.draw_count,
      avatar_url: partner.avatar_url || ""
    }
  });
});

// 3.3 登录状态 + 抽卡申请列表
app.get("/api/status", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const requests = db.prepare(`
    SELECT dr.*, u1.name AS requester_name, u2.name AS partner_name
    FROM draw_requests dr
    JOIN users u1 ON dr.requester_id = u1.id
    JOIN users u2 ON dr.partner_id = u2.id
    WHERE requester_id = ? OR partner_id = ?
    ORDER BY dr.id DESC
    LIMIT 50
  `).all(user.id, user.id);

  res.json({
    user: { id: user.id, name: user.name, draw_count: user.draw_count, avatar_url: user.avatar_url || "" },
    requests
  });
});

// 3.3补充：获取所有绑定对象列表
app.get("/api/partners", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const couples = db.prepare(`
    SELECT * FROM couples
    WHERE user_a_id = ? OR user_b_id = ?
  `).all(userId, userId);

  const partnerMap = new Map();
  for (const c of couples) {
    const pid = c.user_a_id === userId ? c.user_b_id : c.user_a_id;
    if (!partnerMap.has(pid)) {
      const p = db.prepare("SELECT id, name, draw_count, avatar_url FROM users WHERE id = ?").get(pid);
      if (p) partnerMap.set(pid, p);
    }
  }

  res.json({ partners: Array.from(partnerMap.values()) });
});

// ✅ 3.4 申请抽卡（改进：必须传 partnerId，支持多绑定对象）
app.post("/api/request-draw", (req, res) => {
  const { userId, partnerId } = req.body;
  if (!userId || !partnerId) return res.status(400).json({ error: "缺少 userId 或 partnerId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const partner = db.prepare("SELECT * FROM users WHERE id = ?").get(partnerId);
  if (!partner) return res.status(404).json({ error: "对方用户不存在" });

  if (!isCoupled(userId, partnerId)) {
    return res.status(400).json({ error: "你们还没有绑定，不能发起抽卡申请" });
  }

  const info = db.prepare(`
    INSERT INTO draw_requests (requester_id, partner_id, requester_confirmed, partner_confirmed, used)
    VALUES (?, ?, 1, 0, 0)
  `).run(userId, partnerId);

  res.json({ message: "已发出抽卡申请，等待对方同意", requestId: info.lastInsertRowid });
});

// 3.5 对方同意抽卡
app.post("/api/approve-draw", (req, res) => {
  const { userId, requestId } = req.body;
  if (!userId || !requestId) return res.status(400).json({ error: "缺少参数" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const request = db.prepare("SELECT * FROM draw_requests WHERE id = ?").get(requestId);
  if (!request) return res.status(404).json({ error: "请求不存在" });

  if (request.partner_id !== user.id) {
    return res.status(403).json({ error: "你不是这个请求的另一方，不能同意" });
  }
  if (request.used) return res.status(400).json({ error: "这个请求已经被使用过了" });

  db.prepare("UPDATE draw_requests SET partner_confirmed = 1 WHERE id = ?").run(requestId);
  res.json({ message: "已同意对方抽卡" });
});

// 3.6 抽卡（双方已同意）
app.post("/api/draw", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  // 仍沿用你原本逻辑：只有“申请方 requester”可以抽
  const request = db.prepare(`
    SELECT * FROM draw_requests
    WHERE requester_id = ? AND requester_confirmed = 1 AND partner_confirmed = 1 AND used = 0
    ORDER BY id ASC
  `).get(userId);

  if (!request) {
    return res.status(400).json({ error: "没有可用的已同意抽卡请求，请先申请并让对方同意" });
  }

  const card = drawCardForUser(userId);

  db.prepare("UPDATE draw_requests SET used = 1 WHERE id = ?").run(request.id);
  db.prepare("UPDATE users SET draw_count = draw_count + 1 WHERE id = ?").run(userId);

  db.prepare(`
    INSERT INTO draw_logs (user_id, card_text, rarity, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId, card.text, card.rarity);

  db.prepare(`
    INSERT INTO user_cards (user_id, card_text, rarity, used, created_at)
    VALUES (?, ?, ?, 0, datetime('now'))
  `).run(userId, card.text, card.rarity);

  const updatedUser = db.prepare("SELECT id, name, draw_count, avatar_url FROM users WHERE id = ?").get(userId);

  res.json({
    message: "抽卡成功",
    card,
    user: updatedUser
  });
});

// 3.7 查询自己的卡片
app.get("/api/cards", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const cards = db.prepare(`
    SELECT id, user_id, card_text, rarity, used, created_at
    FROM user_cards
    WHERE user_id = ?
    ORDER BY used ASC, created_at DESC, id DESC
  `).all(userId);

  res.json({ cards });
});

// 3.8 查看绑定对象的卡片
app.get("/api/partner-cards", (req, res) => {
  const userId = Number(req.query.userId);
  const partnerId = Number(req.query.partnerId);
  if (!userId || !partnerId) return res.status(400).json({ error: "缺少 userId 或 partnerId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const partner = db.prepare("SELECT * FROM users WHERE id = ?").get(partnerId);
  if (!user || !partner) return res.status(404).json({ error: "用户不存在" });

  if (!isCoupled(userId, partnerId)) {
    return res.status(403).json({ error: "你们还没有绑定，不能查看对方卡片" });
  }

  const cards = db.prepare(`
    SELECT id, user_id, card_text, rarity, used, created_at
    FROM user_cards
    WHERE user_id = ?
    ORDER BY used ASC, created_at DESC, id DESC
  `).all(partnerId);

  res.json({ cards });
});

// 3.9 使用自己的卡片
app.post("/api/use-card", (req, res) => {
  const { userId, cardId } = req.body;
  if (!userId || !cardId) return res.status(400).json({ error: "缺少参数" });

  const card = db.prepare("SELECT * FROM user_cards WHERE id = ? AND user_id = ?").get(cardId, userId);
  if (!card) return res.status(404).json({ error: "找不到这张卡，或这张卡不属于你" });
  if (card.used) return res.status(400).json({ error: "这张卡已经使用过了" });

  db.prepare("UPDATE user_cards SET used = 1 WHERE id = ?").run(cardId);
  res.json({ message: "卡片已标记为已使用" });
});

// 3.10 自定义卡：获取
app.get("/api/custom-cards", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const cards = db.prepare(`
    SELECT id, rarity, text, enabled
    FROM custom_cards
    WHERE user_id = ?
    ORDER BY rarity ASC, id DESC
  `).all(userId);

  res.json({ cards });
});

// 3.11 自定义卡：新增
app.post("/api/custom-cards/add", (req, res) => {
  const { userId, rarity, text } = req.body;
  if (!userId || !rarity || !text) return res.status(400).json({ error: "缺少参数" });

  const allowed = ["SSR", "SR", "R", "N"];
  if (!allowed.includes(rarity)) return res.status(400).json({ error: "rarity 必须是 SSR/SR/R/N 之一" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  db.prepare(`
    INSERT INTO custom_cards (user_id, rarity, text, enabled)
    VALUES (?, ?, ?, 1)
  `).run(userId, rarity, String(text).trim());

  res.json({ message: "已添加自定义卡" });
});

// 3.12 自定义卡：删除（软删除）
app.post("/api/custom-cards/delete", (req, res) => {
  const { userId, cardId } = req.body;
  if (!userId || !cardId) return res.status(400).json({ error: "缺少参数" });

  const card = db.prepare("SELECT * FROM custom_cards WHERE id = ? AND user_id = ?").get(cardId, userId);
  if (!card) return res.status(404).json({ error: "找不到这张自定义卡，或这张卡不属于你" });

  db.prepare("UPDATE custom_cards SET enabled = 0 WHERE id = ?").run(cardId);
  res.json({ message: "已删除自定义卡（不会再被抽到）" });
});

// ✅ 3.13 查看卡库（默认卡+自定义卡，并标记默认卡是否 disabled）
app.get("/api/card-pool", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const rarities = Object.keys(defaultCardPool);

  // 找出所有绑定对象
  const couples = db.prepare(`
    SELECT * FROM couples WHERE user_a_id = ? OR user_b_id = ?
  `).all(userId, userId);

  const partnerIds = [];
  for (const c of couples) {
    const pid = c.user_a_id === userId ? c.user_b_id : c.user_a_id;
    if (!partnerIds.includes(pid)) partnerIds.push(pid);
  }

  // 用户隐藏的默认卡
  const disabledRows = db.prepare(`
    SELECT rarity, text
    FROM disabled_default_cards
    WHERE user_id = ?
  `).all(userId);
  const disabledSet = new Set(disabledRows.map(r => `${r.rarity}||${r.text}`));

  const pool = {};

  // 默认卡（全部返回，disabled 标记决定前端展示隐藏/恢复）
  for (const rarity of rarities) {
    pool[rarity] = [];
    const baseList = defaultCardPool[rarity] || [];
    for (const text of baseList) {
      pool[rarity].push({
        type: "default",
        rarity,
        text,
        disabled: disabledSet.has(`${rarity}||${text}`)
      });
    }
  }

  // 自定义卡（自己 + 绑定对象）
  const allOwnerIds = [userId, ...partnerIds];
  if (allOwnerIds.length) {
    const placeholders = allOwnerIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT c.id, c.user_id, c.rarity, c.text, c.enabled, u.name AS owner_name
      FROM custom_cards c
      JOIN users u ON c.user_id = u.id
      WHERE c.user_id IN (${placeholders})
      ORDER BY c.rarity ASC, c.id DESC
    `).all(...allOwnerIds);

    for (const c of rows) {
      if (!pool[c.rarity]) pool[c.rarity] = [];
      pool[c.rarity].push({
        type: "custom",
        id: c.id,
        owner_id: c.user_id,
        owner_name: c.owner_name,
        rarity: c.rarity,
        text: c.text,
        enabled: !!c.enabled,
        is_self: c.user_id === userId
      });
    }
  }

  res.json({ pool });
});

// ✅ 3.14 隐藏一张系统默认卡（只对当前用户生效）
app.post("/api/default-cards/disable", (req, res) => {
  const { userId, rarity, text } = req.body;
  if (!userId || !rarity || !text) return res.status(400).json({ error: "缺少参数" });

  const allowed = ["SSR", "SR", "R", "N"];
  if (!allowed.includes(rarity)) return res.status(400).json({ error: "rarity 必须是 SSR/SR/R/N 之一" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  const base = defaultCardPool[rarity] || [];
  if (!base.includes(text)) return res.status(400).json({ error: "只能隐藏系统默认卡" });

  db.prepare(`
    INSERT OR IGNORE INTO disabled_default_cards (user_id, rarity, text)
    VALUES (?, ?, ?)
  `).run(userId, rarity, text);

  res.json({ message: "已从你的卡池中隐藏该默认卡" });
});

// ✅ 3.15 恢复一张系统默认卡（只对当前用户生效）
app.post("/api/default-cards/enable", (req, res) => {
  const { userId, rarity, text } = req.body;
  if (!userId || !rarity || !text) return res.status(400).json({ error: "缺少参数" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });

  db.prepare(`
    DELETE FROM disabled_default_cards
    WHERE user_id = ? AND rarity = ? AND text = ?
  `).run(userId, rarity, text);

  res.json({ message: "已恢复该默认卡" });
});

// ✅（可选）拿到“我隐藏的默认卡列表”，前端要单独展示时用
app.get("/api/default-cards/disabled", (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const rows = db.prepare(`
    SELECT rarity, text
    FROM disabled_default_cards
    WHERE user_id = ?
    ORDER BY rarity ASC, id DESC
  `).all(userId);

  res.json({ disabled: rows });
});

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
