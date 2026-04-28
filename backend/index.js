const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
 process.env.SUPABASE_URL,
 process.env.SUPABASE_KEY
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


 if(loadedUsers[id].history === undefined){
   loadedUsers[id].history = [];
 }

}

   return loadedUsers;
 }

 return {
   1:{id:1,balance:0,totalSpent:0}
 };
}



app.get("/",(req,res)=>{
 res.send("Bot backend works");
});

app.get("/user/:id",(req,res)=>{
 const id=req.params.id;

 if(!users[id]){
   users[id]={id:id,balance:0,totalSpent:0,history:[]};
   saveUsers();
 }

 const tier = getTier(users[id].totalSpent);

 res.json({
   ...users[id],
   tier:tier
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

app.post("/scan",(req,res)=>{
 const {qr,amount,product}=req.body;

 if(!qr){
   return res.status(400).json({error:"QR is required"});
 }

 if(!amount || amount<=0){
   return res.status(400).json({error:"Enter purchase amount"});
 }

 const parts=qr.split(":");
 const id=parts[0];

 if(!users[id]){
   users[id]={id:id,balance:0,totalSpent:0,history:[]};
 }

 if(users[id].totalSpent === undefined){
   users[id].totalSpent = 0;
 }

 users[id].totalSpent += amount;

 const tier = getTier(users[id].totalSpent);
 const bonus = amount * (tier.cashback / 100);

users[id].balance += bonus;

users[id].history.unshift({
 type:"purchase",
 amount:amount,
 bonus:bonus,
 product:product || "Purchase",
 date:new Date().toLocaleString()
});

saveUsers();

 res.json({
   success:true,
   balance:users[id].balance,
   totalSpent:users[id].totalSpent,
   tier:tier
 });
});

app.post("/redeem",(req,res)=>{
 const {id,points}=req.body;

 if(!points || points<=0){
   return res.status(400).json({error:"Enter points amount"});
 }

 if(!users[id]){
   users[id]={id:id,balance:0,totalSpent:0,history:[]};
 }

 if(users[id].balance < points){
   return res.status(400).json({error:"Not enough points"});
 }

users[id].balance -= points;

users[id].history.unshift({
 type:"redeem",
 points:points,
 date:new Date().toLocaleString()
});

saveUsers();

 const tier = getTier(users[id].totalSpent);

 res.json({
   success:true,
   balance:users[id].balance,
   totalSpent:users[id].totalSpent,
   tier:tier
 });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
 console.log("Server running on " + PORT);
});