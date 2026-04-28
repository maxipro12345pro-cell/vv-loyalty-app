const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

let users = {
  1: { id:1, balance:0 }
};

app.get("/", (req,res)=>{
  res.send("Bot backend works");
});


app.post("/add",(req,res)=>{
  const {id, amount} = req.body;

  const bonus = amount * 0.05;

  users[id].balance += bonus;

  res.json({
     balance: users[id].balance
  });
});


app.listen(3000,()=>{
 console.log("Server running on 3000");
});