const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
 process.env.SUPABASE_URL,
 process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);
const app = express();

app.use(cors());
app.use(express.json());

const SECRET = process.env.QR_SECRET;
const QR_TTL_MS = 5 * 60 * 1000;
const BOT_CONNECT_BONUS = 50;

if(!SECRET){
 throw new Error("QR_SECRET is required");
}

function isCashierRequest(req){
 const pin = req.get("x-cashier-pin") || req.body?.pin;
 return Boolean(process.env.CASHIER_PIN && pin === process.env.CASHIER_PIN);
}

function isAdminRequest(req){
 const pin = req.get("x-admin-pin") || req.body?.pin;
 const adminPin = process.env.ADMIN_PIN || process.env.CASHIER_PIN;
 return Boolean(adminPin && pin === adminPin);
}

async function fetchAllUsers(){
 const pageSize = 1000;
 let from = 0;
 let allUsers = [];
 let includeUsername = true;

 while(true){
   const columns = includeUsername
     ? "id,username,balance,total_spent,history,referral_count,referral_bonus,referred_by"
     : "id,balance,total_spent,history,referral_count,referral_bonus,referred_by";
   const { data, error } = await supabase
     .from("users")
     .select(columns)
     .range(from, from + pageSize - 1);

   if(error){
     if(includeUsername && String(error.message || "").includes("username")){
       includeUsername = false;
       continue;
     }

     throw error;
   }

   allUsers = allUsers.concat(data || []);

   if(!data || data.length < pageSize){
     break;
   }

   from += pageSize;
 }

 return allUsers;
}

async function updateUsernameIfSupported(userId, username){
 if(!username){
   return;
 }

 const { error } = await supabase
   .from("users")
   .update({ username })
   .eq("id", userId);

 if(error && !String(error.message || "").includes("username")){
   throw error;
 }
}

function normalizeUsername(username){
 if(!username){
   return "";
 }

 return String(username).replace(/^@+/, "").trim();
}

function getUserDisplayUsername(user){
 const directUsername = normalizeUsername(user?.username);

 if(directUsername){
   return directUsername;
 }

 const history = Array.isArray(user?.history) ? user.history : [];
 const historyItem = history.find(item => normalizeUsername(item?.username));

 return historyItem ? normalizeUsername(historyItem.username) : "";
}

function historyWithUsername(history, username){
 const cleanUsername = normalizeUsername(username);

 if(!cleanUsername){
   return history;
 }

 return history.map(item=>({
   ...item,
   username:normalizeUsername(item?.username) || cleanUsername
 }));
}

function parseHistoryTime(value){
 const timestamp = Date.parse(value || "");
 return Number.isFinite(timestamp) ? timestamp : 0;
}

function verifyTelegramInitData(initData){
 if(!process.env.BOT_TOKEN){
   return null;
 }

 if(!initData){
   return null;
 }

 const params = new URLSearchParams(initData);
 const hash = params.get("hash");

 if(!hash){
   return null;
 }

 params.delete("hash");

 const dataCheckString = [...params.entries()]
   .sort(([a],[b]) => a.localeCompare(b))
   .map(([key,value]) => `${key}=${value}`)
   .join("\n");

 const secretKey = crypto
   .createHmac("sha256", "WebAppData")
   .update(process.env.BOT_TOKEN)
   .digest();

 const expectedHash = crypto
   .createHmac("sha256", secretKey)
   .update(dataCheckString)
   .digest("hex");

 const validHash =
   hash.length === expectedHash.length &&
   crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));

 if(!validHash){
   return null;
 }

 const authDate = Number(params.get("auth_date") || 0) * 1000;

 if(authDate && Date.now() - authDate > 24 * 60 * 60 * 1000){
   return null;
 }

 const userRaw = params.get("user");

 if(!userRaw){
   return null;
 }

 try{
   return JSON.parse(userRaw);
 } catch{
   return null;
 }
}

function parseAndVerifyQR(qr){
 const parts = String(qr || "").split(":");

 if(parts.length !== 3){
   return { error: "Invalid QR format" };
 }

 const [id, timestamp, receivedHash] = parts;

 if(!/^\d+$/.test(id) || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(receivedHash)){
   return { error: "Invalid QR format" };
 }

 const data = `${id}:${timestamp}`;
 const expectedHash = crypto
   .createHmac("sha256", SECRET)
   .update(data)
   .digest("hex");

 const validHash =
   receivedHash.length === expectedHash.length &&
   crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash));

 if(!validHash){
   return { error: "Invalid QR signature" };
 }

 if(Date.now() - Number(timestamp) > QR_TTL_MS){
   return { error: "QR expired" };
 }

 return { id, timestamp };
}

function getTier(totalSpent){
 if(totalSpent >= 15000){
   return {name:"BLACK", cashback:10, next:null, progress:100};
 }
 if(totalSpent >= 5000){
   return {
     name:"GOLD",
     cashback:7,
     next:"BLACK",
     progress:Math.round((totalSpent/15000)*100)
   };
 }
 if(totalSpent >= 1000){
   return {
     name:"SILVER",
     cashback:5,
     next:"GOLD",
     progress:Math.round((totalSpent/5000)*100)
   };
 }

 return {
   name:"CORE",
   cashback:2.5,
   next:"SILVER",
   progress:Math.round((totalSpent/1000)*100)
 };
}

function getReferralLevel(referralCount){
 const count = Number(referralCount || 0);

 if(count >= 10) return { name:"DIAMOND", rewardPercent:9 };
 if(count >= 5) return { name:"GOLD", rewardPercent:8 };
 if(count >= 3) return { name:"SILVER", rewardPercent:7 };
 if(count >= 1) return { name:"BRONZE", rewardPercent:6 };
 return { name:"STARTER", rewardPercent:5 };
}

app.get("/",(req,res)=>{
 res.send("Bot backend works");
});

app.get("/user/:id", async (req,res)=>{
 const id = String(req.params.id);
 const ref = req.query.ref && /^\d+$/.test(String(req.query.ref))
   ? String(req.query.ref)
   : null;
 const telegramUser = verifyTelegramInitData(req.get("x-telegram-init-data"));

 if(!/^\d+$/.test(id)){
   return res.status(400).json({ error: "Invalid user id" });
 }

 if(process.env.BOT_TOKEN && !isCashierRequest(req)){
   if(!telegramUser || String(telegramUser.id) !== id){
     return res.status(401).json({ error: "Invalid Telegram initData" });
   }
 }

let { data: user, error } = await supabase
  .from("users")
  .select("*")
  .eq("id", id)
  .single();

if(error && error.code !== "PGRST116"){
  return res.status(500).json({ error: error.message });
}
// Create user if missing.
if(!user){
  const { data: newUser, error: insertError } = await supabase.from("users").insert({
    id: id,
    balance: 0,
    total_spent: 0,
    history: [],
    referred_by: ref && ref !== id ? ref : null,
    referral_rewarded: false
  })
    .select("*")
    .single();

  if(insertError){
    return res.status(500).json({ error: insertError.message });
  }

  user = newUser;

  try{
    const username = normalizeUsername(telegramUser?.username || req.query.username);
    await updateUsernameIfSupported(id, username);
    user.username = username || user.username;
  } catch(usernameError){
    return res.status(500).json({ error: usernameError.message });
  }
}
else{
  // Bind referral only before the first purchase.
if(
 ref &&
 ref !== id &&
 !user.referred_by &&
 Number(user.total_spent || 0) === 0 &&
 user.referral_rewarded !== true
){
    await supabase
      .from("users")
      .update({ referred_by: ref })
      .eq("id", id);

    user.referred_by = ref;
  }
  try{
    const username = normalizeUsername(telegramUser?.username || req.query.username);
    await updateUsernameIfSupported(id, username);
    user.username = username || user.username;
  } catch(usernameError){
    return res.status(500).json({ error: usernameError.message });
  }
}
 const tier = getTier(Number(user.total_spent || 0));

 res.json({
   id: user.id,
   balance: Number(user.balance || 0),
   totalSpent: Number(user.total_spent || 0),
   history: user.history || [],
   referralCount: Number(user.referral_count || 0),
   referralBonus: Number(user.referral_bonus || 0),
   referredBy: user.referred_by || null,
   tier: tier
 });
});

app.get("/qr/:id",(req,res)=>{
 const id = String(req.params.id);
 const telegramUser = verifyTelegramInitData(req.get("x-telegram-init-data"));

 if(!/^\d+$/.test(id)){
   return res.status(400).json({ error: "Invalid user id" });
 }

 if(process.env.BOT_TOKEN){
   if(!telegramUser || String(telegramUser.id) !== id){
     return res.status(401).json({ error: "Invalid Telegram initData" });
   }
 }

 const timestamp=Date.now();
 const data=`${id}:${timestamp}`;

 const hash=crypto
 .createHmac("sha256",SECRET)
 .update(data)
 .digest("hex");

res.json({
  qr:`${data}:${hash}`
});

});

app.post("/scan", async (req,res)=>{
const {qr,amount,product,pin}=req.body;

if(!isCashierRequest(req)){
 return res.status(403).json({error:"Invalid cashier PIN"});
}
 if(!qr){
   return res.status(400).json({error:"QR is required"});
 }

 const numericAmount = Number(amount);

 if(!Number.isFinite(numericAmount) || numericAmount <= 0){
   return res.status(400).json({error:"Enter valid purchase amount"});
 }

 const verifiedQR = parseAndVerifyQR(qr);

 if(verifiedQR.error){
   return res.status(400).json({ error: verifiedQR.error });
 }

 const id=String(verifiedQR.id);
 const qrHash = crypto.createHash("sha256").update(String(qr)).digest("hex");

 let { data: user, error } = await supabase
   .from("users")
   .select("*")
   .eq("id", id)
   .single();

 if(error && error.code !== "PGRST116"){
   return res.status(500).json({ error: error.message });
 }

 if(!user){
   const { data: newUser, error: insertError } = await supabase
     .from("users")
     .insert({
       id:id,
       balance:0,
       total_spent:0,
       history:[]
     })
     .select()
     .single();

   if(insertError){
     return res.status(500).json({ error: insertError.message });
   }

   user = newUser;
 }

 const oldHistory = user.history || [];

 if(oldHistory.some(item => item.qrHash === qrHash)){
   return res.status(409).json({ error:"QR already used" });
 }

 const newTotalSpent = Number(user.total_spent || 0) + numericAmount;
 const tier = getTier(newTotalSpent);
 const bonus = Math.round(numericAmount * (tier.cashback / 100) * 100) / 100;
 const newBalance = Number(user.balance || 0) + bonus;

 const newHistory = [
   {
      type:"purchase",
      amount:numericAmount,
      bonus:bonus,
      product:product || "Purchase",
      qrHash:qrHash,
      date:new Date().toLocaleString()
    },
   ...oldHistory
 ];

 const { error: updateError } = await supabase
   .from("users")
   .update({
     balance:newBalance,
     total_spent:newTotalSpent,
     history:newHistory
   })
   .eq("id", id);

 if(updateError){
   return res.status(500).json({ error:updateError.message });
 }
if(
 user.referred_by &&
 user.referred_by !== id &&
 user.referral_rewarded !== true &&
 Number(user.total_spent || 0) === 0 &&
 (user.history || []).length === 0 &&
 numericAmount >= 500
){
 const { data: referrer, error: referrerError } = await supabase
   .from("users")
   .select("*")
   .eq("id", user.referred_by)
   .single();

 if(!referrerError && referrer){
   const referralLevel = getReferralLevel(referrer.referral_count);
   const referralReward =
     Math.round(numericAmount * (referralLevel.rewardPercent / 100) * 100) / 100;
   const { data: rewardMarker, error: rewardMarkerError } = await supabase
     .from("users")
     .update({
       referral_rewarded: true
     })
     .eq("id", id)
     .or("referral_rewarded.is.null,referral_rewarded.eq.false")
     .select("id")
     .single();

   if(rewardMarkerError || !rewardMarker){
     return res.json({
       success:true,
       balance:newBalance,
       totalSpent:newTotalSpent,
       history:newHistory,
       tier:tier
     });
   }

   const referrerHistory = referrer.history || [];

   await supabase
     .from("users")
     .update({
       balance: Number(referrer.balance || 0) + referralReward,
       referral_count: Number(referrer.referral_count || 0) + 1,
       referral_bonus: Number(referrer.referral_bonus || 0) + referralReward,
       history: [
         {
           type:"referral",
           bonus: referralReward,
           referralLevel: referralLevel.name,
           referralPercent: referralLevel.rewardPercent,
           invitedUser: id,
           date: new Date().toLocaleString()
         },
         ...referrerHistory
       ]
      })
      .eq("id", user.referred_by);
  }
}

 res.json({
   success:true,
   balance:newBalance,
   totalSpent:newTotalSpent,
   history:newHistory,
   tier:tier
 });
});
app.post("/redeem", async (req,res)=>{
const {id,points,pin,purchaseAmount}=req.body;

if(!isCashierRequest(req)){
 return res.status(403).json({error:"Invalid cashier PIN"});
}
 const numericPoints = Number(points);
 const numericPurchaseAmount = Number(purchaseAmount || 0);
 const userId = String(id || "");

 if(!/^\d+$/.test(userId)){
   return res.status(400).json({error:"Invalid user id"});
 }

 if(!Number.isFinite(numericPoints) || numericPoints<=0){
   return res.status(400).json({error:"Enter valid points amount"});
 }

 if(!Number.isFinite(numericPurchaseAmount) || numericPurchaseAmount < 0){
   return res.status(400).json({error:"Enter valid purchase amount"});
 }

 let { data:user, error } = await supabase
   .from("users")
   .select("*")
   .eq("id", userId)
   .single();

 if(error && error.code === "PGRST116"){
   return res.status(404).json({error:"User not found"});
 }

 if(error){
   return res.status(500).json({error:error.message});
 }

 if(Number(user.balance) < numericPoints){
   return res.status(400).json({error:"Not enough points"});
 }

 const history = Array.isArray(user.history) ? user.history : [];
 const hasWelcomeBonus = history.some(item => item.type === "bot_bonus");
 const alreadyRedeemed = history
   .filter(item => item.type === "redeem")
   .reduce((sum,item)=>sum + Number(item.points || 0), 0);
 const welcomePointsRemaining = hasWelcomeBonus
   ? Math.max(0, BOT_CONNECT_BONUS - alreadyRedeemed)
   : 0;

 if(welcomePointsRemaining > 0 && numericPoints > 0 && numericPurchaseAmount < 200){
   return res.status(400).json({
     error:"First 50 welcome points can be redeemed only with purchase amount from 200 MDL"
   });
 }

 const newBalance =
   Number(user.balance) - numericPoints;

 const newHistory = [
{
  type:"redeem",
  points:numericPoints,
  amount:numericPurchaseAmount,
  date:new Date().toLocaleString()
},
...history
];

 const { error:updateError } = await supabase
   .from("users")
   .update({
      balance:newBalance,
      history:newHistory
   })
   .eq("id", userId);

 if(updateError){
   return res.status(500).json({error:updateError.message});
 }

 const tier=getTier(Number(user.total_spent||0));

 res.json({
   success:true,
   balance:newBalance,
   totalSpent:Number(user.total_spent||0),
   history:newHistory,
   tier:tier
 });
});

app.get("/admin/stats", async (req,res)=>{
 if(!isAdminRequest(req)){
   return res.status(403).json({ error:"Invalid admin PIN" });
 }

 try{
   const users = await fetchAllUsers();
   const operations = [];

   const totals = users.reduce((acc,user)=>{
     const history = Array.isArray(user.history) ? user.history : [];

     acc.users += 1;
     acc.activeUsers += history.length > 0 ? 1 : 0;
     acc.totalSpent += Number(user.total_spent || 0);
     acc.outstandingBalance += Number(user.balance || 0);
     acc.referralCount += Number(user.referral_count || 0);
     acc.referralBonusRecorded += Number(user.referral_bonus || 0);

   history.forEach(item=>{
       const username = getUserDisplayUsername(user) || normalizeUsername(item.username);
       const operation = {
         userId:String(user.id),
         username,
         type:item.type || "unknown",
         amount:Number(item.amount || 0),
         bonus:Number(item.bonus || 0),
         points:Number(item.points || 0),
         product:item.product || "",
         invitedUser:item.invitedUser || "",
         date:item.date || "",
         timestamp:parseHistoryTime(item.date)
       };

       operations.push(operation);

       if(item.type === "purchase"){
         acc.purchaseCount += 1;
         acc.purchaseAmount += Number(item.amount || 0);
         acc.cashbackAwarded += Number(item.bonus || 0);
       }

       if(item.type === "redeem"){
         acc.redeemCount += 1;
         acc.redeemedPoints += Number(item.points || 0);
       }

       if(item.type === "referral"){
         acc.referralRewardCount += 1;
         acc.referralBonusPaid += Number(item.bonus || 0);
       }

       if(item.type === "bot_bonus"){
         acc.botBonusCount += 1;
         acc.botBonusPaid += Number(item.bonus || 0);
       }
      });

     return acc;
   }, {
     users:0,
     activeUsers:0,
     totalSpent:0,
     outstandingBalance:0,
     purchaseCount:0,
     purchaseAmount:0,
     cashbackAwarded:0,
     redeemCount:0,
     redeemedPoints:0,
     referralCount:0,
     referralRewardCount:0,
     referralBonusPaid:0,
     referralBonusRecorded:0,
     botBonusCount:0,
     botBonusPaid:0
   });

   totals.netBonusIssued =
     totals.cashbackAwarded + totals.referralBonusPaid + totals.botBonusPaid - totals.redeemedPoints;
   totals.operationCount = operations.length;

   const recentOperations = operations
     .sort((a,b)=>b.timestamp - a.timestamp)
     .slice(0,50);

   const userById = new Map(
     users.map(user=>[String(user.id), user])
   );

   const topUsers = users
     .map(user=>({
       id:String(user.id),
       username:getUserDisplayUsername(user),
       referredBy:user.referred_by ? String(user.referred_by) : "",
       referredByUsername:user.referred_by && userById.get(String(user.referred_by))
         ? getUserDisplayUsername(userById.get(String(user.referred_by)))
         : "",
       balance:Number(user.balance || 0),
       totalSpent:Number(user.total_spent || 0),
       referralCount:Number(user.referral_count || 0),
       referralBonus:Number(user.referral_bonus || 0)
     }))
     .sort((a,b)=>b.totalSpent - a.totalSpent)
     .slice(0,30);

   res.json({
     success:true,
     generatedAt:new Date().toISOString(),
     totals,
     recentOperations,
     topUsers
   });
 } catch(error){
   res.status(500).json({ error:error.message });
 }
});

const TelegramBot = require("node-telegram-bot-api");

if(process.env.BOT_TOKEN){
 const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.onText(/^\/start(?:\s(.*))?$/, async (msg, match)=>{

 const chatId = msg.chat.id;
 const userId = String(msg.from.id);
 const telegramUsername = normalizeUsername(msg.from.username);
 const payload = match[1];

 let referredBy = null;

 if(payload && payload.startsWith("ref_")){
   const payloadRef = payload.replace("ref_", "");
   referredBy = /^\d+$/.test(payloadRef) && payloadRef !== userId
     ? payloadRef
     : null;
 }

 let { data: existingUser } = await supabase
   .from("users")
   .select("*")
   .eq("id", userId)
   .single();

 if(!existingUser){
   await supabase.from("users").insert({
     id: userId,
     balance: BOT_CONNECT_BONUS,
     total_spent: 0,
     history: [{
       type:"bot_bonus",
       bonus:BOT_CONNECT_BONUS,
       username:telegramUsername,
       date:new Date().toLocaleString()
     }],
     referred_by: referredBy,
     referral_rewarded: false
    });
   await updateUsernameIfSupported(userId, telegramUsername);
 } else {
if(
 referredBy &&
 referredBy !== userId &&
 !existingUser.referred_by &&
 Number(existingUser.total_spent || 0) === 0 &&
 existingUser.referral_rewarded !== true
){
  await supabase
    .from("users")
    .update({
      referred_by: referredBy
    })
    .eq("id", userId);
 }

 const existingHistory = Array.isArray(existingUser.history)
   ? existingUser.history
   : [];
 const botBonusAlreadyPaid =
   existingHistory.some(item => item.type === "bot_bonus");
 const existingHistoryWithUsername = historyWithUsername(existingHistory, telegramUsername);
 const shouldRefreshHistoryUsername =
   telegramUsername && JSON.stringify(existingHistoryWithUsername) !== JSON.stringify(existingHistory);

 if(!botBonusAlreadyPaid){
  await supabase
    .from("users")
    .update({
      balance:Number(existingUser.balance || 0) + BOT_CONNECT_BONUS,
      history:[
        {
          type:"bot_bonus",
          bonus:BOT_CONNECT_BONUS,
          username:telegramUsername,
          date:new Date().toLocaleString()
        },
        ...existingHistoryWithUsername
      ]
    })
    .eq("id", userId);
 } else if(shouldRefreshHistoryUsername){
  await supabase
    .from("users")
    .update({
      history:existingHistoryWithUsername
    })
    .eq("id", userId);
 }

 await updateUsernameIfSupported(userId, telegramUsername);
}
   const welcomeOptions = {
     reply_markup: {
       remove_keyboard: true
     }
   };

   bot.sendMessage(
     chatId,
     "Bine ai venit \u00een V&V Privilege Club \u2728\nApas\u0103 butonul Mini App de jos pentru a deschide clubul.",
     welcomeOptions
   );

});

}

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
 console.log("Server running on " + PORT);
});
