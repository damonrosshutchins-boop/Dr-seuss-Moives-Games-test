import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
const require=createRequire(import.meta.url);
const dirOf=(pkg)=>path.dirname(require.resolve(pkg));
const app=express();
const allowedOrigin=new Set(["https://damonrosshutchins-boop.github.io",...(process.env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean)]);
// Exact ShuttleTV dependency observed in Wisp logs; no wildcard third-party host access.
wisp.options.hostname_whitelist=[/^mclegacy\.pages\.dev$/i,/^wasm\.rip$/i,/^([a-z0-9-]+\.)+wasm\.rip$/i,/^shuttletv\.pk$/i,/^api\.themoviedb\.org$/i,/^image\.tmdb\.org$/i,/^cinesrc\.st$/i,/^a\.cineflix\.st$/i,/^a2\.cineflix\.st$/i,/^([a-z0-9-]+\.)+shuttletv\.pk$/i,/^raw\.githack\.com$/i,/^cdn\.jsdelivr\.net$/i,/^ripjaw1219\.github\.io$/i,/^monoxide\.dev$/i,/^c00lkiddtech\.github\.io$/i,/^linkawaken1979-alt\.github\.io$/i,/^mollomm1\.github\.io$/i,/^sagaofowlz\.github\.io$/i];
wisp.options.port_whitelist=[80,443];
wisp.options.allow_udp_streams=false;
wisp.options.allow_tcp_streams=true;
wisp.options.allow_direct_ip=false;
wisp.options.allow_private_ips=false;
wisp.options.allow_loopback_ips=false;
// Avoid wisp-js 0.4.1 stream-limit bug (connection.streams not iterable).
// Keep the destination allowlist, network restrictions, and origin checks.
app.use((req,res,next)=>{
 res.setHeader("Cross-Origin-Opener-Policy","same-origin");
 // Credentialless allows public cross-origin assets while keeping Wisp Origin checks separate.
 res.setHeader("Cross-Origin-Embedder-Policy","credentialless");
 res.setHeader("X-Content-Type-Options","nosniff");
 // Allow browser runtime files on the other approved website origin.
 if (/^\/(?:scram|utils|controller|libcurl|epoxy)\//.test(req.path)) {
   res.setHeader("Cross-Origin-Resource-Policy","cross-origin");
   res.setHeader("Access-Control-Allow-Origin","*");
 }
 next();
});
app.get("/health",(req,res)=>res.json({ok:true,service:"seuss-cinema-scramjet-wisp",restricted:true,coep:"credentialless",relayOriginPolicy:"allowlist"}));

// Two pinned, path-restricted approved game resource routes. This is NOT a
// general-purpose HTTP proxy: client-supplied hostnames, URLs and redirects
// are never accepted. The Render connection is reused without adding domains
// to the Wisp allowlist.
const balatroAssets = new Set([
  "manifest.json","love.js","love.wasm","game.js",
  ...Array.from({length:7},(_,i)=>"game-"+String(i).padStart(2,"0")+".bin")
]);
const balatroRoot="https://cdn.jsdelivr.net/gh/3cfl/balatro-webport@cb01302a4ee9d3712676daa7a8bf58e04f9e8fa8/";
const cheeseRoot="https://wasm.rip/files/cheese-rolling/";
function approvedGameCors(req,res){
 const origin=req.get("Origin");
 if(origin && !allowedOrigin.has(origin) && origin!=="https://seuss-cinema-arcade.onrender.com"){
   res.status(403).send("Unapproved arcade origin");
   return false;
 }
 if(origin){
   res.setHeader("Access-Control-Allow-Origin",origin);
   res.setHeader("Vary","Origin");
 }
 res.setHeader("Cross-Origin-Resource-Policy","cross-origin");
 res.setHeader("Cache-Control","public, max-age=3600");
 return true;
}
async function serveApprovedGameFile(req,res,upstreamUrl){
 try{
   const headers={};
   if(req.get("Range"))headers.Range=req.get("Range");
   const response=await fetch(upstreamUrl,{
     method:req.method==="HEAD"?"HEAD":"GET",
     headers,redirect:"error",signal:AbortSignal.timeout(30000)
   });
   if(!response.ok){
     res.status(response.status).type("text/plain").send("Approved game file unavailable at its source ("+response.status+")");
     await response.body?.cancel();
     return;
   }
   res.status(response.status);
   res.setHeader("Content-Type",response.headers.get("content-type")||"application/octet-stream");
   if(response.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",response.headers.get("accept-ranges"));
   if(response.headers.get("content-range"))res.setHeader("Content-Range",response.headers.get("content-range"));
   // Node fetch may decompress the body. Do not copy Content-Encoding or
   // Content-Length because that could corrupt the streamed response.
   if(req.method==="HEAD"||!response.body){res.end();return;}
   await pipeline(Readable.fromWeb(response.body),res);
 }catch(error){
   console.error("Pinned game asset fetch failed",new URL(upstreamUrl).hostname,String(error));
   if(res.headersSent)res.destroy();
   else res.status(502).type("text/plain").send("The approved game's source server could not be reached.");
 }
}
app.options("/approved-assets/balatro/:file",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
 res.sendStatus(204);
});
app.get("/approved-assets/balatro/:file",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 const file=req.params.file;
 if(!balatroAssets.has(file))return res.sendStatus(404);
 void serveApprovedGameFile(req,res,balatroRoot+file);
});
app.head("/approved-assets/balatro/:file",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 const file=req.params.file;
 if(!balatroAssets.has(file))return res.sendStatus(404);
 void serveApprovedGameFile(req,res,balatroRoot+file);
});
// Cheese Rolling is kept in a single approved upstream directory. Block
// path traversal and URL redirects so this cannot reach other hostnames.
function cheeseFileUrl(req){
 const file=req.params[0]||"index.html";
 if(!/^[A-Za-z0-9._/-]+$/.test(file)||file.startsWith("/")||file.includes("//")||
    file.split("/").includes(".."))return null;
 const url=new URL(file,cheeseRoot);
 if(!url.href.startsWith(cheeseRoot))return null;
 url.search=new URL(req.originalUrl,"https://seuss-cinema-arcade.onrender.com").search;
 return url.href;
}
app.get("/approved-games/cheese/status",async(req,res)=>{
 if(!approvedGameCors(req,res))return;
 try{
   const response=await fetch(cheeseRoot+"index.html",{
     redirect:"error",signal:AbortSignal.timeout(12000)
   });
   await response.body?.cancel();
   res.status(response.ok?200:502).json({
     ok:response.ok,sourceStatus:response.status,
     note:response.ok?"Approved Cheese Rolling upstream reachable":"Upstream game entry is unavailable"
   });
 }catch(error){
   console.error("Cheese Rolling upstream probe failed:",String(error));
   res.status(502).json({ok:false,note:"Cheese Rolling upstream server cannot be reached"});
 }
});
app.get("/approved-games/cheese/*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 const url=cheeseFileUrl(req);
 if(!url)return res.sendStatus(404);
 void serveApprovedGameFile(req,res,url);
});
app.head("/approved-games/cheese/*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 const url=cheeseFileUrl(req);
 if(!url)return res.sendStatus(404);
 void serveApprovedGameFile(req,res,url);
});


 // Minecraft 26.3 Horizon: serve the exact user-supplied standalone HTML on
 // Render so the top-level page receives the isolation headers above.
 // The file is reassembled from checked-in chunks by npm start.
const minecraftStandalone=path.join(process.cwd(),"games","minecraft-26.3","index.html");
app.get("/approved-games/minecraft/",(req,res)=>{
 res.setHeader("Cache-Control","public, max-age=3600");
 res.sendFile(minecraftStandalone);
});
// Sound assets are pinned to one version of one repo. No client-supplied
// upstream URLs, domain selection, redirects, or path traversal permitted.
const minecraftSoundRoot="https://raw.githubusercontent.com/AlexBoops/mc-rust-onweb/b21a7ae704b415182631429a7e71c797287661df/";
const minecraftSounds=new Set(["parts.json",...Array.from({length:18},(_,i)=>
 "fs/res/assets/minecraft/sound.tar.gz.part"+i)]);
app.options("/approved-games/minecraft-sounds/*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
 res.sendStatus(204);
});
for(const method of ["get","head"]){
 app[method]("/approved-games/minecraft-sounds/*",(req,res)=>{
  if(!approvedGameCors(req,res))return;
  const file=req.params[0];
  if(!minecraftSounds.has(file))return res.sendStatus(404);
  void serveApprovedGameFile(req,res,minecraftSoundRoot+file);
 });
}

app.use("/scram/",express.static(scramjetPath));
app.use("/utils/",express.static(dirOf("@mercuryworkshop/scramjet-utils")));
app.use("/controller/",express.static(dirOf("@mercuryworkshop/scramjet-controller")));
app.use("/libcurl/",express.static(dirOf("@mercuryworkshop/libcurl-transport")));
app.use("/epoxy/",express.static(dirOf("@mercuryworkshop/epoxy-transport")));
// Publish only the frontend entrypoints, not server source or configuration files.
for (const file of ["index.html","proxy-client.js","sw.js","calls.js","calls.css"]) {
 const route=file==="index.html"?"/":"/"+file;
 app.get(route,(req,res)=>res.sendFile(path.join(process.cwd(),file),{
  headers:{"Cache-Control":file==="index.html"?"no-cache":"no-store"}
 }));
}
const server=http.createServer(app);
server.on("upgrade",(req,socket,head)=>{
 try{
 const pathname=new URL(req.url??"/","http://localhost").pathname;
 const origin=req.headers.origin;
 const isOwnOrigin=typeof origin==="string"&&origin===("https://"+req.headers.host);
 if(pathname!=="/wisp/"||typeof origin!=="string"||(!allowedOrigin.has(origin)&&!isOwnOrigin)){socket.destroy();return;}
 req.url=pathname;wisp.routeRequest(req,socket,head);
 }catch{socket.destroy();}
});
const port=Number(process.env.PORT||10000);
server.listen(port,"0.0.0.0",()=>console.log("Seuss Scramjet/Wisp listening on "+port));
