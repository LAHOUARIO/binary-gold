require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  RSI, MACD, SMA, EMA, StochasticRSI, BollingerBands, CCI, ADX
} = require("technicalindicators");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// 🟡 الصفحة الرئيسية هي صفحة تسجيل الدخول
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auth.html"));
});

// ✅ تسجيل الدخول + التحقق من الاشتراك
app.post("/login", (req, res) => {
  const { username, code } = req.body;
  const filePath = path.join(__dirname, "users.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ allowed: false, message: "لا يوجد مستخدمون" });
  }

  const users = JSON.parse(fs.readFileSync(filePath));
  const matched = users.find(user => user.username === username && user.code === code);

  if (!matched) {
    return res.status(401).json({ allowed: false, message: "❌ اسم المستخدم أو الكود غير صحيح!" });
  }

  let expires = new Date(matched.createdAt);
  if (matched.price == 10) expires.setMonth(expires.getMonth() + 2);
  else if (matched.price == 20) expires.setMonth(expires.getMonth() + 5);
  else expires.setMonth(expires.getMonth() + 1);

  return res.json({ allowed: true, expires });
});

// ✅ API لإرجاع قائمة المستخدمين + تاريخ انتهاء الاشتراك
app.get("/admin/users", (req, res) => {
  const filePath = path.join(__dirname, "users.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json([]);
  }

  const users = JSON.parse(fs.readFileSync(filePath));

  const enriched = users.map(user => {
    let expires = new Date(user.createdAt);
    if (user.price == 10) expires.setMonth(expires.getMonth() + 2);
    else if (user.price == 20) expires.setMonth(expires.getMonth() + 5);
    else expires.setMonth(expires.getMonth() + 1);
    return { ...user, expires };
  });

  res.json(enriched);
});

// ✅ إضافة مستخدم جديد من صفحة admin
app.post("/admin/add-user", (req, res) => {
  const { username, code, price } = req.body;
  const filePath = path.join(__dirname, "users.json");
  let users = [];

  if (fs.existsSync(filePath)) {
    users = JSON.parse(fs.readFileSync(filePath));
  }

  const exists = users.find(u => u.username === username);
  if (exists) {
    return res.status(400).json({ message: "📛 اسم المستخدم موجود مسبقًا." });
  }

  const newUser = {
    username,
    code,
    price,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
  res.json({ message: "✅ تم إضافة المستخدم بنجاح!" });
});

// ✅ تحليل البيانات الفنية
app.post("/analyze", async (req, res) => {
  const { symbol, timeframe } = req.body;
  const intervalMap = {
    "1": "1min",
    "5": "5min",
    "15": "15min"
  };
  const interval = intervalMap[timeframe] || "5min";

  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&apikey=${process.env.TWELVE_API_KEY}&outputsize=50`;

  try {
    const response = await fetch(url);
    const result = await response.json();
    const candles = result?.values;

    if (!candles || candles.length < 30) {
      return res.status(500).json({ error: "❌ بيانات غير كافية للتحليل." });
    }

    const closes = candles.map(c => parseFloat(c.close)).reverse();
    const highs = candles.map(c => parseFloat(c.high)).reverse();
    const lows = candles.map(c => parseFloat(c.low)).reverse();

    const rsi = RSI.calculate({ values: closes, period: 14 });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const sma = SMA.calculate({ values: closes, period: 14 });
    const ema = EMA.calculate({ values: closes, period: 21 });
    const stoch = StochasticRSI.calculate({
      values: closes,
      rsiPeriod: 14,
      stochasticPeriod: 14,
      kPeriod: 3,
      dPeriod: 3
    });
    const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const cci = CCI.calculate({ high: highs, low: lows, close: closes, period: 20 });
    const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

    const lastRSI = rsi.at(-1);
    const lastMACD = macd.at(-1);
    const lastStoch = stoch.at(-1);
    const lastCCI = cci.at(-1);
    const lastADX = adx.at(-1);
    const lastBB = bb.at(-1);
    const lastPrice = closes.at(-1);
    const lastSMA = sma.at(-1);
    const lastEMA = ema.at(-1);

    let conditions = [];

    if (lastRSI < 30) conditions.push("RSI: Oversold");
    if (lastRSI > 70) conditions.push("RSI: Overbought");

    if (lastMACD?.MACD > lastMACD?.signal) conditions.push("MACD: Bullish");
    if (lastMACD?.MACD < lastMACD?.signal) conditions.push("MACD: Bearish");

    if (lastStoch?.k < 20 && lastStoch?.d < 20) conditions.push("StochRSI: Oversold");
    if (lastStoch?.k > 80 && lastStoch?.d > 80) conditions.push("StochRSI: Overbought");

    if (lastCCI > 100) conditions.push("CCI: Bullish");
    if (lastCCI < -100) conditions.push("CCI: Bearish");

    if (lastADX?.adx > 20) conditions.push("ADX: Trending");

    if (lastBB && lastPrice < lastBB.lower) conditions.push("Bollinger: Below Band");
    if (lastBB && lastPrice > lastBB.upper) conditions.push("Bollinger: Above Band");

    if (lastPrice > lastSMA) conditions.push("Price > SMA");
    if (lastPrice > lastEMA) conditions.push("Price > EMA");

    let signal = "↔ لا توجد إشارة قوية";
    const strengthNum = conditions.length;
    const strength = `${(strengthNum / 10) * 100}%`;

    if (strengthNum >= 2) {
      const buySignals = ["RSI: Oversold", "MACD: Bullish", "StochRSI: Oversold", "CCI: Bullish", "Bollinger: Below Band", "Price > SMA", "Price > EMA"];
      const sellSignals = ["RSI: Overbought", "MACD: Bearish", "StochRSI: Overbought", "CCI: Bearish", "Bollinger: Above Band"];

      const buyMatches = buySignals.filter(c => conditions.includes(c)).length;
      const sellMatches = sellSignals.filter(c => conditions.includes(c)).length;

      if (buyMatches > sellMatches) signal = "⬆ CALL";
      else if (sellMatches > buyMatches) signal = "⬇ PUT";
    }

    const now = new Date();
    now.setSeconds(0, 0);
    if (timeframe === "1") now.setMinutes(now.getMinutes() + 1);
    else if (timeframe === "15") now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15);
    else now.setMinutes(Math.ceil(now.getMinutes() / 5) * 5);

    const entryTime = now.toTimeString().split(" ")[0].slice(0, 5);

    res.json({
      pair: symbol,
      timeframe: `M${timeframe}`,
      time: entryTime,
      signal,
      strength,
      conditions,
      values: {
        RSI: lastRSI?.toFixed(2),
        MACD: lastMACD ? `${lastMACD.MACD.toFixed(2)} / ${lastMACD.signal.toFixed(2)}` : "N/A",
        StochK: lastStoch?.k?.toFixed(2),
        StochD: lastStoch?.d?.toFixed(2),
        CCI: lastCCI?.toFixed(2),
        ADX: lastADX?.adx?.toFixed(2),
        Price: lastPrice?.toFixed(4),
        SMA: lastSMA?.toFixed(4),
        EMA: lastEMA?.toFixed(4),
        BBUpper: lastBB?.upper?.toFixed(4),
        BBLower: lastBB?.lower?.toFixed(4)
      }
    });

  } catch (err) {
    console.error("❌ خطأ في التحليل:", err.message);
    res.status(500).json({ error: "⚠️ فشل الاتصال أو التحليل." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
