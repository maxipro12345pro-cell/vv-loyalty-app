const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
 process.env.SUPABASE_URL,
 process.env.SUPABASE_SERVICE_KEY
);
const app = express();

app.use(cors());
app.use(express.json());

const SECRET = "vv_secret";

function getTier(totalSpent){
 if(totalSpent >= 30000){
   return {name:"BLACK", cashback:10, next:null, progress:100};
 }
 if(totalSpent >= 15000){
   return {
     name:"GOLD",
     cashback:8,
     next:"BLACK",
     progress:Math.round((totalSpent/30000)*100)
   };
 }
 if(totalSpent >= 5000){
   return {
     name:"SILVER",
     cashback:7,
     next:"GOLD",
     progress:Math.round((totalSpent/15000)*100)
   };
 }

 return {
   name:"CORE",
   cashback:5,
   next:"SILVER",
   progress:Math.round((totalSpent/5000)*100)
 };
}

app.get("/",(req,res)=>{
 res.send("Bot backend works");
});

app.get("/user/:id", async (req,res)=>{
 const id = String(req.params.id);
 const ref = req.query.ref ? String(req.query.ref) : null;

let { data: user, error } = await supabase
  .from("users")
  .select("*")
  .eq("id", id)
  .single();

// если пользователя нет — создаём
if(!user){
  await supabase.from("users").insert({
    id: id,
    balance: 0,
    total_spent: 0,
    history: [],
    referred_by: ref || null,
    referral_rewarded: false
  });

  const { data: newUser } = await supabase
    .from("users")
    .select("*")
    .eq("id", id)
    .single();

  user = newUser;
}
else{
  // если пользователь уже есть, но ещё без реферала — записываем
if(
 ref &&
 ref !== id &&
 !user.referred_by &&
 Number(user.total_spent || 0) === 0
){
    await supabase
      .from("users")
      .update({ referred_by: ref })
      .eq("id", id);

    user.referred_by = ref;
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
 const timestamp=Date.now();
 const data=`${req.params.id}:${timestamp}`;

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

if(pin !== process.env.CASHIER_PIN){
 return res.status(403).json({error:"Invalid cashier PIN"});
}
 if(!qr){
   return res.status(400).json({error:"QR is required"});
 }

 if(!amount || amount<=0){
   return res.status(400).json({error:"Enter purchase amount"});
 }

 const parts=qr.split(":");
 const id=String(parts[0]);

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
 const newTotalSpent = Number(user.total_spent || 0) + Number(amount);
 const tier = getTier(newTotalSpent);
 const bonus = Number(amount) * (tier.cashback / 100);
 const newBalance = Number(user.balance || 0) + bonus;

 const newHistory = [
   {
     type:"purchase",
     amount:Number(amount),
     bonus:bonus,
     product:product || "Purchase",
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
 Number(user.total_spent || 0) === 0
){
const referralReward =
 Math.round(Number(amount) * 0.05 * 100) / 100;
 const { data: referrer, error: referrerError } = await supabase
   .from("users")
   .select("*")
   .eq("id", user.referred_by)
   .single();

 if(!referrerError && referrer){
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
           invitedUser: id,
           date: new Date().toLocaleString()
         },
         ...referrerHistory
       ]
     })
     .eq("id", user.referred_by);

   await supabase
     .from("users")
     .update({
       referral_rewarded: true
     })
     .eq("id", id);
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
const {id,points,pin}=req.body;

if(pin !== process.env.CASHIER_PIN){
 return res.status(403).json({error:"Invalid cashier PIN"});
}
 if(!points || points<=0){
   return res.status(400).json({error:"Enter points amount"});
 }

 let { data:user, error } = await supabase
   .from("users")
   .select("*")
   .eq("id", String(id))
   .single();

 if(error){
   return res.status(500).json({error:error.message});
 }

 if(Number(user.balance) < Number(points)){
   return res.status(400).json({error:"Not enough points"});
 }

 const newBalance =
   Number(user.balance) - Number(points);

 const newHistory = [
 {
   type:"redeem",
   points:Number(points),
   date:new Date().toLocaleString()
 },
 ...(user.history || [])
 ];

 const { error:updateError } = await supabase
   .from("users")
   .update({
      balance:newBalance,
      history:newHistory
   })
   .eq("id", String(id));

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
const TelegramBot = require("node-telegram-bot-api");

if(process.env.BOT_TOKEN){
 const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.onText(/^\/start(?:\s(.*))?$/, async (msg, match)=>{

 const chatId = msg.chat.id;
 const userId = String(msg.from.id);
 const payload = match[1];

 let referredBy = null;

 if(payload && payload.startsWith("ref_")){
   referredBy = payload.replace("ref_", "");
 }

 let { data: existingUser } = await supabase
   .from("users")
   .select("*")
   .eq("id", userId)
   .single();

 if(!existingUser){
   await supabase.from("users").insert({
     id: userId,
     balance: 0,
     total_spent: 0,
     history: [],
     referred_by: referredBy,
     referral_rewarded: false
   });
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
   bot.sendMessage(
   chatId,
   "Bine ai venit în V&V Privilege Club ✨"
 );

});

}

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
 console.log("Server running on " + PORT);
});