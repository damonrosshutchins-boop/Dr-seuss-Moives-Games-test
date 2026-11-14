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

// Horizon 26.3 audio: pinned exact-revision and only 18 numbered
// sound parts plus parts.json. No arbitrary hostname or path accepted.
const horizonRoot="https://raw.githubusercontent.com/AlexBoops/mc-rust-onweb/b21a7ae704b415182631429a7e71c797287661df/";
app.get("/approved-games/horizon/parts.json",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 void serveApprovedGameFile(req,res,horizonRoot+"parts.json");
});
app.get("/approved-games/horizon/fs/res/assets/minecraft/:file",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 const file=req.params.file;
 if(!/^sound[.]tar[.]gz[.]part(0|[1-9]|1[0-7])$/.test(file))return res.sendStatus(404);
 void serveApprovedGameFile(req,res,horizonRoot+"fs/res/assets/minecraft/"+file);
});
app.options("/approved-games/horizon/*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
 res.sendStatus(204);
});


// God of War: Ghost of Sparta — fixed-source Surge reverse route.
// Keep this separate from Wisp: clients may request paths from ONE
// owner-approved host only; they cannot choose a URL, port or destination.
const spartaUpstream="https://psp-web-damon.surge.sh/";
const spartaRoute="/approved-games/gow-sparta/";
function spartaFileUrl(req){
 const file=req.params[0]||"index.html";
 if(file.length>800||! /^[A-Za-z0-9._/\-]+$/.test(file) ||
   file.startsWith("/")||file.includes("//")||
   file.split("/").some(part=>part===".."||part==="."))return null;
 const url=new URL(file,spartaUpstream);
 if(url.origin!==new URL(spartaUpstream).origin)return null;
 // A query may select a game setting or asset version, never a hostname.
 url.search=new URL(req.originalUrl,"https://seuss-cinema-arcade.onrender.com").search;
 return url.href;
}
function spartaRewriteRootPaths(source){
 // Keep first-party absolute links and root-relative HTML/CSS resources
 // on this fixed Render game route, not on the original Surge origin.
 return source
   .replaceAll(spartaUpstream,"https://seuss-cinema-arcade.onrender.com"+spartaRoute)
   .replace(/\b(src|href|poster|data|action|srcset)\s*=\s*(["'])\/(?!\/)/gi,
     (_full,attr,quote)=>attr+"="+quote+spartaRoute)
   .replace(/url\(\s*(["']?)\/(?!\/)/gi,
     (_full,quote)=>"url("+quote+spartaRoute);
}
function spartaRewriteHtml(html){
 let page=spartaRewriteRootPaths(html);
 // Common inline loaders use absolute fetch/worker paths.
 page=page.replace(/\b(fetch|Worker|SharedWorker|register)\s*\(\s*(["'])\/(?!\/)/g,
   (_full,fn,quote)=>fn+"("+quote+spartaRoute);
 // Rewrite first-party root-absolute runtime requests without exposing
 // a browser-chosen destination host or an open HTTP proxy.
 const bridge='<script>(()=>{'+
  'const upstream="https://psp-web-damon.surge.sh";'+
  'const route="/approved-games/gow-sparta/";'+
  'const reroute=(input)=>{try{const value=String(input);'+
   'if(value.startsWith(route))return value;'+
   'if(value.startsWith("/")&&!value.startsWith("//"))return route+value.slice(1);'+
   'const u=new URL(value,location.href);'+
   'if(u.origin===upstream)return route+u.pathname.replace(/^\\//,"")+u.search+u.hash;'+
   '}catch(e){}return input;};'+
  'const nativeFetch=window.fetch;window.fetch=function(resource,options){'+
   'if(typeof resource==="string"||resource instanceof URL)'+
    'return nativeFetch.call(this,reroute(resource),options);'+
   'if(resource instanceof Request){const rewritten=reroute(resource.url);'+
    'if(rewritten!==resource.url)return nativeFetch.call(this,new Request(rewritten,resource),options);}'+
   'return nativeFetch.call(this,resource,options);};'+
  'const originalOpen=XMLHttpRequest.prototype.open;'+
  'XMLHttpRequest.prototype.open=function(method,url,...rest){return originalOpen.call(this,method,reroute(url),...rest);};'+
  '})();</script>'; // encoded close to avoid terminating the outer JS string
 const base='<base href="'+spartaRoute+'">'+bridge;
 if(/<head\b[^>]*>/i.test(page))
   page=page.replace(/<head\b[^>]*>/i,match=>match+"\n"+base);
 else page=base+page;
 // A visible same-tab route back to the arcade; never a destination picker.
 const back='<nav id="seuss-sparta-back" style="position:fixed;z-index:2147483646;top:8px;left:8px">'+
   '<a href="https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/" '+
   'style="display:inline-block;padding:8px 11px;background:#152821ef;color:#fff;'+
   'border:1px solid #82c9a1;border-radius:8px;font:13px system-ui;text-decoration:none">'+
   '← Back to Seuss Arcade</a></nav>';
 if(/<body\b[^>]*>/i.test(page))
   page=page.replace(/<body\b[^>]*>/i,match=>match+"\n"+back);
 return page;
}
app.get("/approved-games/gow-sparta/status",async(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Cache-Control","no-store");
 try{
   const response=await fetch(spartaUpstream,{
     redirect:"error",signal:AbortSignal.timeout(12000)
   });
   await response.body?.cancel();
   res.status(response.ok?200:502).json({
     ok:response.ok,upstreamStatus:response.status,
     source:"fixed Surge game host",
     note:response.ok?"Surge source reachable":"Surge source returned an error"
   });
 }catch(error){
   console.error("Ghost of Sparta upstream status failed",String(error));
   res.status(502).json({ok:false,note:"The approved Surge game source is not reachable from Render"});
 }
});
// Express 4 ignores trailing slashes by default. A plain redirect handler
// for the slashless route would ALSO match the canonical trailing-slash URL,
// causing an infinite 308 redirect loop. Pass the canonical URL through to
// the wildcard file handler below instead.
app.get("/approved-games/gow-sparta",(req,res,next)=>{
 if(req.path===spartaRoute)return next();
 res.redirect(308,spartaRoute);
});
async function serveSpartaFile(req,res){
 if(!approvedGameCors(req,res))return;
 const upstreamUrl=spartaFileUrl(req);
 if(!upstreamUrl)return res.sendStatus(404);
 try{
   const headers={"Accept-Encoding":"identity"};
   const range=req.get("Range");
   if(range){
     if(!/^bytes=\d*-\d*$/.test(range))return res.sendStatus(416);
     headers.Range=range;
   }
   const response=await fetch(upstreamUrl,{
     method:req.method==="HEAD"?"HEAD":"GET",
     headers,redirect:"error",signal:AbortSignal.timeout(120000)
   });
   if(!response.ok){
     await response.body?.cancel();
     return res.status(response.status).type("text/plain")
       .send("The approved Surge game file is unavailable ("+response.status+")");
   }
   res.status(response.status);
   const contentType=response.headers.get("content-type")||"application/octet-stream";
   res.setHeader("Content-Type",contentType);
   if(response.headers.get("accept-ranges"))
     res.setHeader("Accept-Ranges",response.headers.get("accept-ranges"));
   if(response.headers.get("content-range"))
     res.setHeader("Content-Range",response.headers.get("content-range"));
   res.setHeader("Cache-Control","public, max-age=300");
   // Never forward upstream cookies, redirects, CSP, encoding or user-supplied URLs.
   if(req.method==="HEAD"||!response.body){res.end();return;}
   const contentLength=Number(response.headers.get("content-length")||0);
   const encoding=response.headers.get("content-encoding");
   if(/text\/html/i.test(contentType)&&(!contentLength||contentLength<=8000000)){
     const html=await response.text();
     if(html.length>8000000)
       return res.status(502).type("text/plain").send("Game HTML exceeds safe rewrite size");
     res.setHeader("Cache-Control","no-store");
     return res.send(spartaRewriteHtml(html));
   }
   if(/text\/css/i.test(contentType)&&(!contentLength||contentLength<=2000000)){
     const css=await response.text();
     if(css.length>2000000)
       return res.status(502).type("text/plain").send("Game CSS exceeds safe rewrite size");
     return res.send(spartaRewriteRootPaths(css));
   }
   // Range-sensitive ROM/WASM resources stream unmodified.
   if((!encoding||encoding==="identity")&&response.headers.get("content-length"))
     res.setHeader("Content-Length",response.headers.get("content-length"));
   await pipeline(Readable.fromWeb(response.body),res);
 }catch(error){
   console.error("Ghost of Sparta approved file fetch failed",String(error));
   if(res.headersSent)res.destroy();
   else res.status(502).type("text/plain").send("The approved Surge game file could not be fetched");
 }
}
app.options("/approved-games/gow-sparta/*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
 res.sendStatus(204);
});
app.get("/approved-games/gow-sparta/*",(req,res)=>void serveSpartaFile(req,res));
app.head("/approved-games/gow-sparta/*",(req,res)=>void serveSpartaFile(req,res));


// Minecraft 1.8 fixed-file Render routes. Both supplied Google Drive IDs are
// public HTML files, not arbitrary browser-supplied URLs:
//  - clwurst.html: 27,847,113 bytes (EaglercraftX 1.8 offline)
//  - cleaglerforge.html: 1,035-byte EaglerForge loader
// Each file ID and each EaglerForge part is immutable in this allowlist.
const mc18Sources=new Map([
 ["minecraft-18-wrust",{
   id:"1TBtrBMMw9w9lqc3Z3aw4CARG_O04abIM",
   filename:"clwurst.html",
   expectedSize:27847113
 }],
 ["minecraft-18-mods",{
   id:"17mqNnsALl6ZvDVOtarz4EuP5pS8E4-R9",
   filename:"cleaglerforge.html",
   expectedSize:1035
 }]
]);
const mc18ForgeCommit="ba062f533d86966ff2bcddec4f5859aab7c23346";
const mc18ForgeBase="https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@"+
  mc18ForgeCommit+"/PineTools.com_files/cleaglerforge.html.part";
const mc18ForgeRoute="/approved-games/minecraft-18-mods/assets/forge-part";
const mc18DriveURL=(item)=>{
 const u=new URL("https://drive.usercontent.google.com/download");
 u.searchParams.set("id",item.id);
 u.searchParams.set("export","download");
 u.searchParams.set("confirm","t");
 return u.href;
};
// Fixed route: never accepts a URL, hostname, file ID or redirect from users.
async function serveMc18DriveHtml(req,res,item){
 if(!approvedGameCors(req,res))return;
 try{
   const response=await fetch(mc18DriveURL(item),{
     method:"GET",redirect:"error",signal:AbortSignal.timeout(150000),
     headers:{"User-Agent":"Mozilla/5.0"}
   });
   if(!response.ok){
     await response.body?.cancel();
     return res.status(502).type("text/plain").send("Approved Drive file is unavailable ("+response.status+")");
   }
   const disposition=response.headers.get("content-disposition")||"";
   const size=Number(response.headers.get("content-length")||0);
   // Google may return an HTML login or quota notice with status 200.
   if(!disposition.toLowerCase().includes(item.filename.toLowerCase())||
      (size&&size!==item.expectedSize)){
     await response.body?.cancel();
     return res.status(502).type("text/plain").send(
       "The approved Google Drive game file is unavailable or changed. Check its public sharing and version.");
   }
   res.setHeader("Content-Type","text/html; charset=utf-8");
   res.setHeader("Cache-Control","public, max-age=3600");
   if(req.method==="HEAD"){await response.body?.cancel();return res.status(200).end();}
   res.status(200);
   if(item.id==="17mqNnsALl6ZvDVOtarz4EuP5pS8E4-R9"){
     const html=await response.text();
     if(html.length>10000)
       return res.status(502).type("text/plain").send("The mod launcher changed format");
     let modified=html;
     for(let i=1;i<=4;i++){
       const source="https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@main/PineTools.com_files/cleaglerforge.html.part"+i;
       if(!modified.includes(source))
         return res.status(502).type("text/plain").send("Expected Forge launcher asset is missing");
       modified=modified.replaceAll(source,mc18ForgeRoute+i);
     }
     return res.send(modified);
   }
   if(!response.body)return res.end();
   await pipeline(Readable.fromWeb(response.body),res);
 }catch(error){
   console.error("Approved Minecraft Drive file fetch failed",item.filename,String(error));
   if(res.headersSent)res.destroy();
   else res.status(502).type("text/plain").send("Minecraft game source is temporarily unavailable");
 }
}
for(const [slug,item] of mc18Sources){
 const route="/approved-games/"+slug+"/index.html";
 app.get(route,(req,res)=>{void serveMc18DriveHtml(req,res,item);});
 app.head(route,(req,res)=>{void serveMc18DriveHtml(req,res,item);});
 app.options(route,(req,res)=>{
   if(!approvedGameCors(req,res))return;
   res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
   res.sendStatus(204);
 });
 // Very small status probe: check headers and cancel the full download.
 app.get("/approved-games/"+slug+"/status",async(req,res)=>{
   if(!approvedGameCors(req,res))return;
   res.setHeader("Cache-Control","no-store");
   try{
     const upstream=await fetch(mc18DriveURL(item),{
       redirect:"error",signal:AbortSignal.timeout(20000),
       headers:{"User-Agent":"Mozilla/5.0"}
     });
     const disposition=upstream.headers.get("content-disposition")||"";
     const size=Number(upstream.headers.get("content-length")||0);
     const ok=upstream.ok&&disposition.toLowerCase().includes(item.filename.toLowerCase())&&
       (!size||size===item.expectedSize);
     await upstream.body?.cancel();
     res.status(ok?200:502).json({ok,file:item.filename,source:"fixed Google Drive file ID",
       message:ok?"Approved game file reachable":"Approved game file unavailable or changed"});
   }catch(error){
     console.error("Minecraft Drive probe failed",item.filename,String(error));
     res.status(502).json({ok:false,message:"The approved game file could not be reached"});
   }
 });
}
// The forge loader has four declared files at one pinned Git commit.
// Keep the exact same-origin URLs: no generic CDN path passthrough.
for(let i=1;i<=4;i++){
 const route=mc18ForgeRoute+i;
 const serve=(req,res)=>{
   if(!approvedGameCors(req,res))return;
   void (async()=>{
     try{
       const response=await fetch(mc18ForgeBase+i,{
         method:"GET",redirect:"error",signal:AbortSignal.timeout(150000)
       });
       if(!response.ok){
         await response.body?.cancel();
         return res.status(502).type("text/plain").send("Approved Forge part unavailable ("+i+")");
       }
       res.setHeader("Content-Type","text/plain; charset=utf-8");
       res.setHeader("Cache-Control","public, max-age=86400, immutable");
       if(req.method==="HEAD"){await response.body?.cancel();return res.status(200).end();}
       res.status(200);
       if(response.body)await pipeline(Readable.fromWeb(response.body),res);
       else res.end();
     }catch(error){
       console.error("Pinned Minecraft Forge part failed",i,String(error));
       if(res.headersSent)res.destroy();
       else res.status(502).type("text/plain").send("Approved Forge asset could not be reached");
     }
   })();
 };
 app.get(route,serve);
 app.head(route,serve);
 app.options(route,(req,res)=>{
   if(!approvedGameCors(req,res))return;
   res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
   res.sendStatus(204);
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
