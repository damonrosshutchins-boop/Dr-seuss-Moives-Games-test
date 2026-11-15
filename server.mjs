import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
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
// Seuss Search v2 runs over an unrestricted public-web relay: any hostname,
// any port, TCP and UDP. wisp-js checks the whitelist with a truthiness test,
// so `null` is the only value that disables it - an empty array blocks all.
wisp.options.hostname_whitelist=null;
wisp.options.port_whitelist=null;
wisp.options.allow_udp_streams=true;
wisp.options.allow_tcp_streams=true;
wisp.options.allow_direct_ip=true;
// Private, loopback and reserved ranges stay blocked so this open relay cannot
// be used to probe Render's own network or a self-hoster's LAN. Opt in with
// WISP_ALLOW_PRIVATE_IPS=1 / WISP_ALLOW_LOOPBACK_IPS=1 if that is really wanted.
wisp.options.allow_private_ips=process.env.WISP_ALLOW_PRIVATE_IPS==="1";
wisp.options.allow_loopback_ips=process.env.WISP_ALLOW_LOOPBACK_IPS==="1";
// Avoid wisp-js 0.4.1 stream-limit bug (connection.streams not iterable).
// Browser Origins are still verified before the relay accepts a socket.
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
app.get("/health",(req,res)=>res.json({ok:true,service:"seuss-cinema-scramjet-wisp",restricted:false,coep:"credentialless",relayOriginPolicy:"any-public-host",privateRanges:"blocked",search:true}));

// Two pinned, path-restricted approved game resource routes. This is NOT a
// general-purpose HTTP proxy: client-supplied hostnames, URLs and redirects
// are never accepted. The Render connection is reused without adding domains
// to the Wisp allowlist.
const balatroAssets = new Set([
  "manifest.json","love.js","love.wasm","game.js",
  ...Array.from({length:7},(_,i)=>"game-"+String(i).padStart(2,"0")+".bin")
]);
const balatroRoot="https://cdn.jsdelivr.net/gh/3cfl/balatro-webport@cb01302a4ee9d3712676daa7a8bf58e04f9e8fa8/";
const cheeseRoot="https://raw.githubusercontent.com/SomeRandomFella/portsandrips/9546494b3052e8e078fb28df7430ac35f42a8787/CheeseRollingWeb/";
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
async function serveApprovedGameFile(req,res,upstreamUrl,timeoutMs){
 try{
   const headers={};
   if(req.get("Range"))headers.Range=req.get("Range");
   const response=await fetch(upstreamUrl,{
     method:req.method==="HEAD"?"HEAD":"GET",
     headers,redirect:"error",signal:AbortSignal.timeout(timeoutMs??(
       upstreamUrl.startsWith("https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/")&&upstreamUrl.endsWith(".wasm")?90000:30000))
   });
   if(!response.ok){
     res.status(response.status).type("text/plain").send("Approved game file unavailable at its source ("+response.status+")");
     await response.body?.cancel();
     return;
   }
   res.status(response.status);
   const isPinnedRuffle=upstreamUrl.startsWith("https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/");
   const isCheese=upstreamUrl.startsWith(cheeseRoot);
   const contentType=isCheese&&upstreamUrl.endsWith(".js")?"application/javascript; charset=utf-8":
     isCheese&&upstreamUrl.endsWith(".css")?"text/css; charset=utf-8":
     isCheese&&upstreamUrl.endsWith(".webmanifest")?"application/manifest+json":
     isCheese&&upstreamUrl.endsWith(".png")?"image/png":
     isCheese&&upstreamUrl.endsWith(".ico")?"image/x-icon":
     isPinnedRuffle&&upstreamUrl.endsWith(".wasm")?"application/wasm":
     isPinnedRuffle&&upstreamUrl.endsWith(".js")?"application/javascript; charset=utf-8":
     response.headers.get("content-type")||"application/octet-stream";
   res.setHeader("Content-Type",contentType);
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
// Cheese Rolling: exact files from the provided Unity WebGL port, at a pinned
// Git commit. Only these paths are available; clients cannot select a host,
// redirect destination, arbitrary repository path, or different revision.
const cheeseAllowedFiles=new Set([
  "index.html",
  "manifest.webmanifest",
  "ServiceWorker.js",
  "Build/CheeseRollingWeb.loader.js",
  "Build/CheeseRollingWeb.framework.js",
  "Build/CheeseRollingWeb.data.part001",
  "Build/CheeseRollingWeb.data.part002",
  "Build/CheeseRollingWeb.data.part003",
  "Build/CheeseRollingWeb.data.part004",
  "Build/CheeseRollingWeb.data.part005",
  "Build/CheeseRollingWeb.wasm.part001",
  "Build/CheeseRollingWeb.wasm.part002",
  "TemplateData/favicon.ico",
  "TemplateData/style.css",
  "TemplateData/progress-bar-empty-dark.png",
  "TemplateData/progress-bar-empty-light.png",
  "TemplateData/progress-bar-full-dark.png",
  "TemplateData/progress-bar-full-light.png",
  "TemplateData/unity-logo-dark.png",
  "TemplateData/unity-logo-light.png",
  "TemplateData/icons/unity-logo-dark.png",
  "TemplateData/icons/unity-logo-light.png"
]);
const cheeseBasePath="/approved-games/cheese/";
const cheeseCheckFiles=["index.html","Build/CheeseRollingWeb.loader.js","Build/CheeseRollingWeb.data.part001"];
async function serveCheeseIndex(req,res){
 try{
   const upstream=await fetch(cheeseRoot+"index.html",{
     method:req.method==="HEAD"?"HEAD":"GET",redirect:"error",
     signal:AbortSignal.timeout(30000)
   });
   if(!upstream.ok){
     await upstream.body?.cancel();
     return res.status(502).type("text/plain").send("Approved Cheese Rolling entry unavailable ("+upstream.status+")");
   }
   // Override the upstream absolute CDN <base>. All Unity scripts and split
   // data/wasm parts must stay on our restricted Render routes.
   if(req.method==="HEAD"){
     await upstream.body?.cancel();
     return res.status(200).type("html").end();
   }
   const html=await upstream.text();
   if(!/<base\b[^>]*>/i.test(html))throw Error("Pinned Cheese Rolling HTML has no expected base element");
   res.status(200).type("html").send(
     html.replace(/<base\b[^>]*>/i,'<base href="/approved-games/cheese/">')
   );
 }catch(error){
   console.error("Cheese Rolling entry fetch failed:",String(error));
   if(res.headersSent)res.destroy();
   else res.status(502).type("text/plain").send("The pinned Cheese Rolling entry cannot be loaded through Render.");
 }
}
app.get("/approved-games/cheese/status",async(req,res)=>{
 if(!approvedGameCors(req,res))return;
 try{
   const checks=await Promise.all(cheeseCheckFiles.map(async file=>{
     const response=await fetch(cheeseRoot+file,{
       method:"HEAD",redirect:"error",signal:AbortSignal.timeout(30000)
     });
     await response.body?.cancel();
     return {file,ok:response.ok,status:response.status};
   }));
   const ok=checks.every(check=>check.ok);
   res.status(ok?200:502).json({
     ok,source:"SomeRandomFella/portsandrips/CheeseRollingWeb",
     revision:"9546494b3052e8e078fb28df7430ac35f42a8787",checks,
     note:ok?"Pinned Unity game entry, loader and first data part reachable":"One or more pinned game files are unavailable"
   });
 }catch(error){
   console.error("Cheese Rolling upstream probe failed:",String(error));
   res.status(502).json({ok:false,note:"Pinned Cheese Rolling files could not be reached"});
 }
});
function serveCheeseFile(req,res){
 if(!approvedGameCors(req,res))return;
 const file=req.params[0]||"index.html";
 if(!cheeseAllowedFiles.has(file))return res.sendStatus(404);
 if(file==="index.html")return void serveCheeseIndex(req,res);
 // Large Unity part files can take longer to stream on Render's free tier.
 void serveApprovedGameFile(req,res,cheeseRoot+file,120000);
}
app.get("/approved-games/cheese/*",serveCheeseFile);
app.head("/approved-games/cheese/*",serveCheeseFile);

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


// Approved imported games: fixed CDN origins and fixed path prefixes only.
// No user-provided upstream URLs, protocols, hostnames or redirect following.
const importedAssetRoots=Object.freeze({
  "emu":"https://cdn.jsdelivr.net/gh/bubblfan/emu@main/",
  "emu-stable":"https://cdn.emulatorjs.org/stable/data/",
  "1v1":"https://cdn.jsdelivr.net/gh/n-101-1/1@main/"
});
const importedExactAssets=Object.freeze({
  "tomb-mask/UnityLoader.js":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/UnityLoader.js",
  "tomb-mask/totm.json":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.json",
  "tomb-mask/totm.data.unityweb":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.data.unityweb",
  "tomb-mask/totm.wasm.code.unityweb":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.wasm.code.unityweb",
  "tomb-mask/totm.wasm.framework.unityweb":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.wasm.framework.unityweb",
  "tomb-mask/UnityProgress.js":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/UnityProgress.js",
  "tomb-mask/style.css":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/style.css",
  "snow-rider/Build/UnityLoader.js":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/UnityLoader.js",
  "snow-rider/Build/SnowRider3D-gd-1.json":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.json",
  "snow-rider/Build/SnowRider3D-gd-1.data.unityweb":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.data.unityweb",
  "snow-rider/Build/SnowRider3D-gd-1.wasm.code.unityweb":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.wasm.code.unityweb",
  "snow-rider/Build/SnowRider3D-gd-1.wasm.framework.unityweb.js":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.wasm.framework.unityweb.js",
  "snow-rider/Build/SnowRider3D-gd-1.wasm.framework.unityweb":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.wasm.framework.unityweb",
  "snow-rider/TemplateData/UnityProgress.js":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/UnityProgress.js",
  "snow-rider/TemplateData/style.css":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/style.css",
  "snow-rider/TemplateData/logo.png":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/logo.png",
  "snow-rider/TemplateData/gears.gif":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/gears.gif",
  "run2/Run2.swf":"https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@f69cc42a2ca577ff18acdf1158d3dc6940afd3d3/Run2.swf",
  "run2/ruffle.js":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/ruffle.js",
  "run2/core.ruffle.9085ee9763de4e85853c.js":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/core.ruffle.9085ee9763de4e85853c.js",
  "run2/core.ruffle.ae1054522f49580946c0.js":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/core.ruffle.ae1054522f49580946c0.js",
  "run2/4d882486fa9bfce731b9.wasm":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/4d882486fa9bfce731b9.wasm",
  "run2/f7f28eb60b84863611ca.wasm":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/f7f28eb60b84863611ca.wasm",
  "zelda-oot/rom.n64.part1":"https://cdn.jsdelivr.net/gh/bubbls/ugss@ffa46738ce21236742f4a44db08d87160fed6c7d/ocarinaoftime/Legend%20of%20Zelda%2C%20The%20-%20Ocarina%20of%20Time%20(USA).n64.part1",
  "zelda-oot/rom.n64.part2":"https://cdn.jsdelivr.net/gh/bubbls/ugss@ffa46738ce21236742f4a44db08d87160fed6c7d/ocarinaoftime/Legend%20of%20Zelda%2C%20The%20-%20Ocarina%20of%20Time%20(USA).n64.part2",
  "centipede/rom.zip":"https://cdn.jsdelivr.net/gh/ap-math-class/exams@main/mame/centiped.zip",
  "fnae/Build/fnae.loader.js":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.loader.js",
  "fnae/Build/fnae.framework.js":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.framework.js",
  "fnae/TemplateData/style.css":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/style.css",
  "fnae/TemplateData/favicon.ico":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/favicon.ico",
  "fnae/TemplateData/progress-bar-empty-dark.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-empty-dark.png",
  "fnae/TemplateData/progress-bar-empty-light.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-empty-light.png",
  "fnae/TemplateData/progress-bar-full-dark.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-full-dark.png",
  "fnae/TemplateData/progress-bar-full-light.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-full-light.png",
  "fnae/TemplateData/unity-logo-dark.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/unity-logo-dark.png",
  "fnae/TemplateData/unity-logo-light.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/unity-logo-light.png",
  "fnae/TemplateData/webmemd-icon.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/webmemd-icon.png",
  "fnae/StreamingAssets/UnityServicesProjectConfiguration.json":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/UnityServicesProjectConfiguration.json",
  "fnae/Build/fnae.data.part1":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.data.part1",
  "fnae/Build/fnae.data.part2":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.data.part2",
  "fnae/Build/fnae.data.part3":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.data.part3",
  "fnae/Build/fnae.wasm.part1":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.wasm.part1",
  "fnae/Build/fnae.wasm.part2":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.wasm.part2",
  "fnae/StreamingAssets/202512191935.webm.part1":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/202512191935.webm.part1",
  "fnae/StreamingAssets/202512191935.webm.part2":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/202512191935.webm.part2",
  "fnae/StreamingAssets/202512191935.webm.part3":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/202512191935.webm.part3",
  "mario-kart/rom.zip":"https://cdn.jsdelivr.net/gh/a456pur/seraph@ae2fcc6d6a9cd051654fcc0519080db1f79cf2a7/games/mariokart64/mariokart64.zip",
});
function importedAssetUrl(req){
  let asset;
  try { asset=decodeURIComponent(req.params[0]||""); }catch{return null;}
  if(!asset||asset.length>400||asset.startsWith("/")||asset.includes("//")||
     !/^[a-zA-Z0-9_./()\- %]+$/.test(asset)||
     asset.split("/").some(x=>x==="."||x===".."))return null;
  if(importedExactAssets[asset])return importedExactAssets[asset];
  const pvz="pvz/rom.nds";
  if(asset.startsWith(pvz+".part")&&/^pvz\/rom\.nds\.part[1-4]$/.test(asset))
    return "https://cdn.jsdelivr.net/gh/greeniYT/ROM-s@main/pvz/5495%20-%20Plants%20vs.%20Zombies%20(U).nds"+asset.slice(pvz.length);
  const slash=asset.indexOf("/");
  if(slash<0)return null;
  const category=asset.slice(0,slash),file=asset.slice(slash+1);
  const root=importedAssetRoots[category];
  if(!root||!file)return null;
  return root+file.split("/").map(encodeURIComponent).join("/");
}
function importedHandler(req,res){
  if(!approvedGameCors(req,res))return;
  const url=importedAssetUrl(req);
  if(!url)return res.sendStatus(404);
  const asset=decodeURIComponent(req.params[0]||"");
  // These are exact, pinned Unity files, never a domain-wide proxy.
  // Retry the same immutable GitHub commit when jsDelivr evicts an asset.
  const pinnedUnitySources=[
    ["tomb-mask/","https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/","https://raw.githubusercontent.com/bubbls/UGS-Assets/9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/"],
    ["snow-rider/","https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/","https://raw.githubusercontent.com/Vrkids2009/snowrider3d/6b7c2b9167b592528b221428414e63f06c4640b9/"]
  ];
  for(const [prefix,primaryBase,fallbackBase] of pinnedUnitySources){
    if(asset.startsWith(prefix)&&Object.hasOwn(importedExactAssets,asset)&&url.startsWith(primaryBase)){
      const assetFile=url.slice(primaryBase.length);
      void servePinnedFallbackGameFile(req,res,url,fallbackBase+assetFile);
      return;
    }
  }
  void serveApprovedGameFile(req,res,url);
}
async function servePinnedFallbackGameFile(req,res,primary,fallback){
  for(const [i,url] of [primary,fallback].entries()){
    try{
      const headers={};
      if(req.get("Range"))headers.Range=req.get("Range");
      const response=await fetch(url,{method:req.method==="HEAD"?"HEAD":"GET",
        redirect:"error",headers,signal:AbortSignal.timeout(45000)});
      if(!response.ok){
        console.warn("Pinned Unity game asset unavailable",i?"GitHub raw":"jsDelivr",response.status,new URL(url).pathname);
        await response.body?.cancel();
        if(i===0)continue;
        return res.status(502).type("text/plain").send("Pinned game asset unavailable from both approved sources ("+response.status+").");
      }
      res.status(response.status);
      // GitHub raw serves some .js/.css files as text/plain. Explicit
      // types are required because the app sets X-Content-Type-Options: nosniff.
      const contentType=url.endsWith(".unityweb")?"application/octet-stream":
        url.endsWith(".js")?"application/javascript; charset=utf-8":
        url.endsWith(".css")?"text/css; charset=utf-8":
        url.endsWith(".json")?"application/json; charset=utf-8":
        url.endsWith(".png")?"image/png":
        url.endsWith(".gif")?"image/gif":
        response.headers.get("content-type")||"application/octet-stream";
      res.setHeader("Content-Type",contentType);
      if(response.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",response.headers.get("accept-ranges"));
      if(response.headers.get("content-range"))res.setHeader("Content-Range",response.headers.get("content-range"));
      // Undici may decode an HTTP-compressed upstream response. Omitting
      // Content-Encoding and Content-Length avoids mismatched wire payloads.
      if(req.method==="HEAD"||!response.body){res.end();return;}
      await pipeline(Readable.fromWeb(response.body),res);
      return;
    }catch(error){
      console.warn("Pinned Unity game asset error",i?"GitHub raw":"jsDelivr",String(error));
      if(res.headersSent){res.destroy();return;}
      if(i===1)return res.status(502).type("text/plain").send("Both approved game asset hosts were unreachable.");
    }
  }
}
// A fixed, approved two-part Ocarina file assembled as one .n64 response.
// EmulatorJS expects a normal URL with an extension, not a browser File object.
// Neither filename nor upstream destination is supplied by the requester.
const approvedZeldaParts=[
  importedExactAssets["zelda-oot/rom.n64.part1"],
  importedExactAssets["zelda-oot/rom.n64.part2"]
];
async function approvedZeldaRom(req,res){
  if(!approvedGameCors(req,res))return;
  res.setHeader("Content-Type","application/octet-stream");
  res.setHeader("Cache-Control","public, max-age=3600");
  res.setHeader("Accept-Ranges","none");
  if(req.method==="HEAD")return res.status(200).end();
  try{
    // Append the exact pinned parts in order without buffering the whole ROM.
    for(const url of approvedZeldaParts){
      const source=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(90000)});
      if(!source.ok||!source.body){
        await source.body?.cancel();
        if(res.headersSent){res.destroy();return;}
        return res.status(502).type("text/plain").send("Approved Ocarina source unavailable ("+source.status+")");
      }
      await pipeline(Readable.fromWeb(source.body),res,{end:false});
    }
    res.end();
  }catch(error){
    console.error("Approved Ocarina game stream failed:",String(error));
    if(res.headersSent)res.destroy();
    else res.status(502).type("text/plain").send("Approved Ocarina game source could not be streamed.");
  }
}
app.get("/approved-assets/imported/zelda-oot/rom.n64",approvedZeldaRom);
app.head("/approved-assets/imported/zelda-oot/rom.n64",approvedZeldaRom);
// UwU Client is a single offline HTML split into two immutable ~19.4 MB parts.
// Only these exact source files are allowed; clients cannot choose a URL or path.
// The client executes on the Render origin in a sandboxed frame in the Arcade.
const uwuClientParts=Object.freeze([
  "https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@ba062f533d86966ff2bcddec4f5859aab7c23346/uwuclient/cluwuclient.html.part1",
  "https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@ba062f533d86966ff2bcddec4f5859aab7c23346/uwuclient/cluwuclient.html.part2"
]);
async function serveUwuClient(req,res){
  if(!approvedGameCors(req,res))return;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Cache-Control","public, max-age=300");
  if(req.method==="HEAD"){
    try{
      // Check both sources instead of returning a misleading 200 for missing parts.
      const responses=await Promise.all(uwuClientParts.map(url=>fetch(url,{
        method:"HEAD",redirect:"error",signal:AbortSignal.timeout(45000)
      })));
      const failed=responses.find(response=>!response.ok);
      for(const response of responses)await response.body?.cancel();
      if(failed)return res.status(502).type("text/plain").send("Pinned UwU Client part unavailable ("+failed.status+")");
      return res.status(200).end();
    }catch(error){
      console.error("UwU Client HEAD check failed",String(error));
      return res.status(502).type("text/plain").send("Approved UwU Client sources unavailable");
    }
  }
  // Start both upstream fetches before sending an HTML status; on failure, a
  // meaningful 502 can still be returned to the game's launcher.
  const sources=[];
  try{
    for(const url of uwuClientParts){
      const source=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(120000)});
      if(!source.ok||!source.body){
        for(const prior of sources)await prior.body?.cancel();
        await source.body?.cancel();
        return res.status(502).type("text/plain").send("Approved UwU Client source unavailable ("+source.status+")");
      }
      sources.push(source);
    }
    res.status(200);
    for(const source of sources){
      await pipeline(Readable.fromWeb(source.body),res,{end:false});
    }
    res.end();
  }catch(error){
    console.error("UwU Client stream failed:",String(error));
    if(res.headersSent)res.destroy();
    else res.status(502).type("text/plain").send("Could not stream the approved UwU Client.");
  }
}
app.get("/approved-games/uwu-client/index.html",serveUwuClient);
app.head("/approved-games/uwu-client/index.html",serveUwuClient);
app.options("/approved-games/uwu-client/index.html",(req,res)=>{
  if(!approvedGameCors(req,res))return;
  res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
  res.sendStatus(204);
});
// Bloons TD 6: explicitly scoped to this licensed, pinned Unity web build.
// The upstream's large WebGL files are split into 19 MB pieces; the upstream
// split-loader verifies sizes and SHA-256 checksums. No user-supplied host,
// external redirects or paths outside the btd6 source folder are accepted.
const btd6Commit="9546494b3052e8e078fb28df7430ac35f42a8787";
const btd6Primary="https://cdn.jsdelivr.net/gh/SomeRandomFella/portsandrips@"+btd6Commit+"/btd6/";
const btd6Fallback="https://raw.githubusercontent.com/SomeRandomFella/portsandrips/"+btd6Commit+"/btd6/";
function btd6ApprovedAsset(req){
  let file;
  try{file=decodeURIComponent(req.params[0]||"");}catch{return null;}
  if(!file||file.startsWith("/")||file.includes("//")||!(/^[A-Za-z0-9._/#-]+$/.test(file))||
     file.split("/").includes("..")||file.split("/").includes("."))return null;
  if(!(file.startsWith("Build/")||file.startsWith("StreamingAssets/")||
       file.startsWith("TemplateData/")||file==="split-loader.js"||file==="manifest.json"))
    return null;
  // Encode # in the one pinned WebGL asset filename; never turn it into a URL fragment.
  return file.split("/").map(encodeURIComponent).join("/");
}
async function serveBtd6Asset(req,res){
  if(!approvedGameCors(req,res))return;
  const file=btd6ApprovedAsset(req);
  if(!file)return res.status(404).type("text/plain").send("Unapproved Bloons TD 6 file");
  res.setHeader("Cache-Control","public, max-age=86400, immutable");
  for(const [index,base] of [btd6Primary,btd6Fallback].entries()){
    const url=base+file;
    try{
      const headers={};
      if(req.get("Range"))headers.Range=req.get("Range");
      const source=await fetch(url,{redirect:"error",headers,
        method:req.method==="HEAD"?"HEAD":"GET",
        signal:AbortSignal.timeout(120000)});
      if(!source.ok){
        await source.body?.cancel();
        if(index===0)continue;
        return res.status(502).type("text/plain").send("Pinned Bloons TD 6 asset unavailable ("+source.status+")");
      }
      const p=file.toLowerCase();
      const mime=p.endsWith(".js")?"application/javascript; charset=utf-8":
        p.endsWith(".json")?"application/json; charset=utf-8":
        p.endsWith(".wasm")?"application/wasm":
        p.endsWith(".css")?"text/css; charset=utf-8":
        p.endsWith(".png")?"image/png":
        p.endsWith(".jpg")||p.endsWith(".jpeg")?"image/jpeg":
        p.endsWith(".gif")?"image/gif":
        p.endsWith(".ico")?"image/x-icon":
        p.endsWith(".xml")?"application/xml; charset=utf-8":
        "application/octet-stream";
      res.status(source.status);
      res.setHeader("Content-Type",mime);
      if(source.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",source.headers.get("accept-ranges"));
      if(source.headers.get("content-range"))res.setHeader("Content-Range",source.headers.get("content-range"));
      // Node fetch may transparently decompress responses. Do not forward
      // Content-Encoding or Content-Length from the upstream transfer.
      if(req.method==="HEAD"||!source.body){res.end();return;}
      await pipeline(Readable.fromWeb(source.body),res);
      return;
    }catch(error){
      console.warn("Bloons TD 6 pinned asset error:",index?"GitHub raw":"jsDelivr",String(error));
      if(res.headersSent){res.destroy();return;}
      if(index===1)return res.status(502).type("text/plain").send("Approved Bloons TD 6 asset hosts unavailable");
    }
  }
}
// R.E.P.O. WebGL: restricted to the licensed, immutable Halloween build.
// This never forwards user-supplied URLs or hosts; all assets come from one
// pinned GitHub tree and are guarded by the existing arcade Origin policy.
const repoHalloweenCommit="edd5e11fae76bfe8966633f19a6e43935874a8b4";
const repoHalloweenCdn="https://cdn.jsdelivr.net/gh/Vanta-git/repo-halloween-v1@"+repoHalloweenCommit+"/";
const repoHalloweenRaw="https://raw.githubusercontent.com/Vanta-git/repo-halloween-v1/"+repoHalloweenCommit+"/";
function approvedRepoHalloweenFile(req){
  let file;
  try{file=decodeURIComponent(req.params[0]||"");}catch{return null;}
  if(!file||file.startsWith("/")||file.includes("//")||file.includes("\\")||
     file.split("/").some(segment=>segment===".."||segment==="."||!segment)||
     !/^[A-Za-z0-9._/()# -]+$/.test(file))return null;
  if(file==="split-manifest.json" || file==="Build/1234.loader.js" ||
     file==="Build/1234.framework.js.unityweb")return file;
  const data=file.match(/^Build\/1234\.data\.unityweb\.part(\d{3})$/);
  if(data&&Number(data[1])<237)return file;
  const wasm=file.match(/^Build\/1234\.wasm\.unityweb\.part(\d{2})$/);
  if(wasm&&Number(wasm[1])<7)return file;
  if(file.startsWith("StreamingAssets/"))return file;
  return null;
}
async function serveRepoHalloweenFile(req,res){
  if(!approvedGameCors(req,res))return;
  const asset=approvedRepoHalloweenFile(req);
  if(!asset)return res.status(404).type("text/plain").send("Not an approved R.E.P.O. game file");
  const encoded=asset.split("/").map(encodeURIComponent).join("/");
  res.setHeader("Cache-Control","public, max-age=86400, immutable");
  for(const [i,root] of [repoHalloweenCdn,repoHalloweenRaw].entries()){
    try{
      const headers={};
      if(req.get("Range"))headers.Range=req.get("Range");
      const upstream=await fetch(root+encoded,{
        method:req.method==="HEAD"?"HEAD":"GET",
        redirect:"error",headers,
        signal:AbortSignal.timeout(120000)
      });
      if(!upstream.ok){
        await upstream.body?.cancel();
        if(i===0)continue;
        return res.status(502).type("text/plain").send("Pinned R.E.P.O. asset unavailable: HTTP "+upstream.status);
      }
      const lower=asset.toLowerCase();
      const mime=lower.endsWith(".js")?"application/javascript; charset=utf-8":
        lower.endsWith(".json")?"application/json; charset=utf-8":
        lower.endsWith(".wasm")?"application/wasm":
        lower.endsWith(".css")?"text/css; charset=utf-8":
        lower.endsWith(".png")?"image/png":
        lower.endsWith(".jpg")||lower.endsWith(".jpeg")?"image/jpeg":
        lower.endsWith(".txt")?"text/plain; charset=utf-8":
        lower.endsWith(".xml")?"application/xml; charset=utf-8":
        lower.endsWith(".ogg")?"audio/ogg":
        "application/octet-stream";
      res.status(upstream.status);
      res.setHeader("Content-Type",mime);
      if(upstream.headers.get("content-range"))res.setHeader("Content-Range",upstream.headers.get("content-range"));
      if(upstream.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",upstream.headers.get("accept-ranges"));
      // Node fetch may decompress upstream content, so do not forward a
      // potentially incorrect Content-Encoding or Content-Length.
      if(req.method==="HEAD"||!upstream.body){res.end();return;}
      await pipeline(Readable.fromWeb(upstream.body),res);
      return;
    }catch(error){
      console.warn("R.E.P.O. pinned asset fetch failed:",i?"raw":"jsDelivr",String(error));
      if(res.headersSent){res.destroy();return;}
      if(i===1)return res.status(502).type("text/plain").send("R.E.P.O. game sources unavailable");
    }
  }
}
app.get("/approved-assets/repo-halloween/*",serveRepoHalloweenFile);
app.head("/approved-assets/repo-halloween/*",serveRepoHalloweenFile);
app.options("/approved-assets/repo-halloween/*",(req,res)=>{
  if(!approvedGameCors(req,res))return;
  if(!approvedRepoHalloweenFile(req))return res.sendStatus(404);
  res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
  res.sendStatus(204);
});
app.get("/approved-assets/btd6/*",serveBtd6Asset);
app.head("/approved-assets/btd6/*",serveBtd6Asset);
app.options("/approved-assets/btd6/*",(req,res)=>{
  if(!approvedGameCors(req,res))return;
  if(!btd6ApprovedAsset(req))return res.sendStatus(404);
  res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
  res.sendStatus(204);
});

// Garten of Banban browser port. Every allowed file is present in this
// immutable GitHub tree. No arbitrary URL, host, or upstream path is accepted.
const gartenCommit="a82c94ea3e9a2f2cbc2e1d925007947134b4f156";
const gartenFiles=new Set(["game/clay/content/paks/clay-windows.pak.0","game/clay/content/paks/clay-windows.pak.1","game/clay/content/paks/clay-windows.ucas.0","game/clay/content/paks/clay-windows.ucas.1","game/clay/content/paks/clay-windows.ucas.10","game/clay/content/paks/clay-windows.ucas.11","game/clay/content/paks/clay-windows.ucas.12","game/clay/content/paks/clay-windows.ucas.13","game/clay/content/paks/clay-windows.ucas.2","game/clay/content/paks/clay-windows.ucas.3","game/clay/content/paks/clay-windows.ucas.4","game/clay/content/paks/clay-windows.ucas.5","game/clay/content/paks/clay-windows.ucas.6","game/clay/content/paks/clay-windows.ucas.7","game/clay/content/paks/clay-windows.ucas.8","game/clay/content/paks/clay-windows.ucas.9","game/clay/content/paks/clay-windows.utoc.0","game/clay/content/paks/global.ucas.0","game/clay/content/paks/global.utoc.0","game/clay/content/paks/zzz_breadbb_p.pak.0","game/clay/content/paks/zzz_breadbb_p.ucas.0","game/clay/content/paks/zzz_breadbb_p.utoc.0","game/engine/content/slate/cursor/invisible.cur.0","gbb.js","gbb.wasm.part1","gbb.wasm.part10","gbb.wasm.part11","gbb.wasm.part12","gbb.wasm.part13","gbb.wasm.part14","gbb.wasm.part15","gbb.wasm.part16","gbb.wasm.part17","gbb.wasm.part18","gbb.wasm.part19","gbb.wasm.part2","gbb.wasm.part20","gbb.wasm.part21","gbb.wasm.part3","gbb.wasm.part4","gbb.wasm.part5","gbb.wasm.part6","gbb.wasm.part7","gbb.wasm.part8","gbb.wasm.part9","gbb_fflean.1.wasm.part1","gbb_fflean.1.wasm.part2","gbb_fflean.1.wasm.part3","gbb_fflean.1.wasm.part4","gbb_fflean.2.wasm.part1","gbb_fflean.2.wasm.part2","gbb_fflean.2.wasm.part3","gbb_fflean.2.wasm.part4","gbb_fflean.3.wasm.part1","gbb_fflean.3.wasm.part2","gbb_fflean.3.wasm.part3","gbb_fflean.3.wasm.part4","gbb_fflean.4.wasm.part1","gbb_fflean.4.wasm.part2","gbb_fflean.4.wasm.part3","gbb_fflean.4.wasm.part4","gbb_fflean.5.wasm.part1","gbb_fflean.5.wasm.part2","gbb_fflean.5.wasm.part3","gbb_fflean.5.wasm.part4","gbb_fflean.js","gbb_fflean.wasm.part1","gbb_fflean.wasm.part2","gbb_fflean.wasm.part3","gbb_fflean.wasm.part4","gbb_gfx.js","gbb_gfx.wasm","gfx_worker.js","image.bin.part1","image.bin.part2","image.bin.part3","image.bin.part4","image.bin.part5","image.bin.part6","image.bin.part7","image.bin.part8","image.bin.part9","manifest.json","preload.json","programs.json","range_cache.js","seed.json","shadow_store.js","split-assets.json","split-loader.js"]);
const gartenCdn="https://cdn.jsdelivr.net/gh/web-ports/garten-of-banban@"+gartenCommit+"/";
const gartenRaw="https://raw.githubusercontent.com/web-ports/garten-of-banban/"+gartenCommit+"/";
function approvedGartenAsset(req){
  let name;
  try{name=decodeURIComponent(req.params[0]||"");}catch{return null;}
  return gartenFiles.has(name)?name:null;
}
async function serveGartenAsset(req,res){
  if(!approvedGameCors(req,res))return;
  const asset=approvedGartenAsset(req);
  if(!asset)return res.status(404).type("text/plain").send("Not an approved Garten of Banban asset");
  res.setHeader("Cache-Control","public, max-age=86400, immutable");
  for(const [index,root] of [gartenCdn,gartenRaw].entries()){
    try{
      const headers={};
      if(req.get("Range"))headers.Range=req.get("Range");
      const upstream=await fetch(root+asset.split("/").map(encodeURIComponent).join("/"),{
        method:req.method==="HEAD"?"HEAD":"GET",headers,
        redirect:"error",signal:AbortSignal.timeout(120000)
      });
      if(!upstream.ok){
        await upstream.body?.cancel();
        if(index===0)continue;
        return res.status(502).type("text/plain").send("Pinned Garten of Banban asset unavailable ("+upstream.status+")");
      }
      const lower=asset.toLowerCase();
      const mime=lower.endsWith(".js")?"application/javascript; charset=utf-8":
        lower.endsWith(".json")?"application/json; charset=utf-8":
        lower.endsWith(".wasm")?"application/wasm":
        lower.endsWith(".css")?"text/css; charset=utf-8":
        lower.endsWith(".png")?"image/png":
        "application/octet-stream";
      res.status(upstream.status);
      res.setHeader("Content-Type",mime);
      if(upstream.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",upstream.headers.get("accept-ranges"));
      if(upstream.headers.get("content-range"))res.setHeader("Content-Range",upstream.headers.get("content-range"));
      // Streaming decompression in fetch can change byte counts.
      if(req.method==="HEAD"||!upstream.body){res.end();return;}
      await pipeline(Readable.fromWeb(upstream.body),res);
      return;
    }catch(error){
      console.warn("Garten pinned asset fetch failed:",index?"GitHub":"CDN",String(error));
      if(res.headersSent){res.destroy();return;}
      if(index===1)return res.status(502).type("text/plain").send("Garten approved asset hosts unavailable");
    }
  }
}
app.get("/approved-assets/garten/*",serveGartenAsset);
app.head("/approved-assets/garten/*",serveGartenAsset);
app.options("/approved-assets/garten/*",(req,res)=>{
  if(!approvedGameCors(req,res))return;
  if(!approvedGartenAsset(req))return res.sendStatus(404);
  res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
  res.sendStatus(204);
});
app.get("/approved-assets/imported/*",importedHandler);
app.head("/approved-assets/imported/*",importedHandler);
app.options("/approved-assets/imported/*",(req,res)=>{
  if(!approvedGameCors(req,res))return;
  res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
  res.sendStatus(204);
});

// Gamble With Your Friends — camzzz's ~1.2 GB solo Unity web port.
// The upstream build is committed as 69 fixed 18 MB parts under `game/`.
// Only those exact file shapes are served, and only from one pinned commit:
// no user-supplied host, URL, port or redirect is ever accepted. When a local
// copy of the upstream `game/` folder exists (GAMBLE_LOCAL_DIR or
// local-games/gamble-with-your-friends), it is served instead of the network
// so the game can run fully offline from this host.
const gambleCommit="d7b3ac61ce6d2cb98e212dfa01ba0df413539a53";
const gambleCdn="https://cdn.jsdelivr.net/gh/Camzzz-vrgt/gamble-with-your-friends-web@"+gambleCommit+"/game/";
const gambleRaw="https://raw.githubusercontent.com/Camzzz-vrgt/gamble-with-your-friends-web/"+gambleCommit+"/game/";
const gambleRoute="/approved-games/gamble-with-your-friends/";
const gambleLocalRoot=path.resolve(process.env.GAMBLE_LOCAL_DIR||path.join(process.cwd(),"local-games","gamble-with-your-friends"));
function approvedGambleFile(req){
 let file;
 try{file=decodeURIComponent(req.params[0]||"");}catch{return null;}
 if(!file)file="index.html";
 if(file.length>400||file.startsWith("/")||file.includes("//")||file.includes("\\")||
    file.endsWith("/")||! /^[A-Za-z0-9._/()# -]+$/.test(file))return null;
 if(file.split("/").some(segment=>!segment||segment==="."||segment===".."))return null;
 if(["index.html","Build/build.loader.js","Build/build.framework.js",
     "assets/port-by-camzzz.png","StreamingAssets/aa/catalog.bin",
     "StreamingAssets/aa/catalog.hash","StreamingAssets/aa/settings.json"].includes(file))return file;
 const chunk=file.match(/^chunks\/build\.(data|wasm)\.part(\d{3})$/);
 if(chunk){
   const lastPart=chunk[1]==="data"?50:19;
   if(Number(chunk[2])>=1&&Number(chunk[2])<=lastPart)return file;
 }
 if(/^StreamingAssets\/aa\/StandaloneWindows64\/[A-Za-z0-9._() -]+\.bundle$/.test(file))return file;
 return null;
}
function gambleMime(file){
 const lower=file.toLowerCase();
 if(lower.endsWith(".html"))return "text/html; charset=utf-8";
 if(lower.endsWith(".js"))return "application/javascript; charset=utf-8";
 if(lower.endsWith(".json"))return "application/json; charset=utf-8";
 if(lower.endsWith(".png"))return "image/png";
 return "application/octet-stream";
}
function gambleLocalPath(file){
 const resolved=path.resolve(gambleLocalRoot,file);
 if(!resolved.startsWith(gambleLocalRoot+path.sep))return null;
 return resolved;
}
async function serveGambleFile(req,res){
 if(!approvedGameCors(req,res))return;
 const file=approvedGambleFile(req);
 if(!file)return res.status(404).type("text/plain").send("Not an approved Gamble With Your Friends file");
 const cacheControl=file==="index.html"?"public, max-age=300":"public, max-age=86400, immutable";
 const local=gambleLocalPath(file);
 if(local&&existsSync(local)){
   res.setHeader("Content-Type",gambleMime(file));
   res.setHeader("Cache-Control",cacheControl);
   res.setHeader("X-Game-Source","local");
   return res.sendFile(local);
 }
 const encoded=file.split("/").map(encodeURIComponent).join("/");
 // jsDelivr answers a byte-range request with an empty 206 body, so ranged
 // reads go straight to GitHub raw, which honours ranges correctly.
 const sources=req.get("Range")
   ?[[gambleRaw,"github-raw"]]
   :[[gambleCdn,"jsdelivr"],[gambleRaw,"github-raw"]];
 for(const [index,[root,source]] of sources.entries()){
   try{
     const headers={"Accept-Encoding":"identity"};
     if(req.get("Range"))headers.Range=req.get("Range");
     const upstream=await fetch(root+encoded,{
       method:req.method==="HEAD"?"HEAD":"GET",
       redirect:"error",headers,signal:AbortSignal.timeout(120000)
     });
     if(!upstream.ok){
       await upstream.body?.cancel();
       if(index<sources.length-1)continue;
       return res.status(502).type("text/plain")
         .send("Pinned Gamble With Your Friends asset unavailable: HTTP "+upstream.status);
     }
     res.status(upstream.status);
     res.setHeader("Content-Type",gambleMime(file));
     res.setHeader("Cache-Control",cacheControl);
     res.setHeader("X-Game-Source",source);
     if(upstream.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",upstream.headers.get("accept-ranges"));
     if(upstream.headers.get("content-range"))res.setHeader("Content-Range",upstream.headers.get("content-range"));
     // Node fetch may decompress the upstream body, so never forward its
     // Content-Encoding or Content-Length.
     if(req.method==="HEAD"||!upstream.body){res.end();return;}
     await pipeline(Readable.fromWeb(upstream.body),res);
     return;
   }catch(error){
     console.warn("Gamble With Your Friends asset failed:",source,file,String(error));
     if(res.headersSent){res.destroy();return;}
     if(index===sources.length-1)return res.status(502).type("text/plain")
       .send("The approved Gamble With Your Friends game sources are unreachable.");
   }
 }
}
// Fixed-route availability probe used by the published arcade launcher.
app.get(gambleRoute+"status",async(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Cache-Control","no-store");
 const local=gambleLocalPath("index.html");
 if(local&&existsSync(local))
   return res.json({ok:true,source:"local game folder",note:"Serving the local upstream game/ copy"});
 try{
   const probe=await fetch(gambleCdn+"index.html",{
     method:"HEAD",redirect:"error",signal:AbortSignal.timeout(15000)
   });
   await probe.body?.cancel();
   if(!probe.ok)
     return res.status(502).json({ok:false,note:"Pinned game entry unavailable (HTTP "+probe.status+")"});
   res.json({ok:true,source:"pinned GitHub upstream",commit:gambleCommit,parts:69});
 }catch(error){
   console.error("Gamble With Your Friends probe failed",String(error));
   res.status(502).json({ok:false,note:"The approved game source could not be reached"});
 }
});
app.get(gambleRoute+"*",serveGambleFile);
app.head(gambleRoute+"*",serveGambleFile);
app.options(gambleRoute+"*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 if(!approvedGambleFile(req))return res.sendStatus(404);
 res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
 res.sendStatus(204);
});

// Buckshot Roulette — Godot 4 web export committed upstream as 17 pck parts and
// 3 wasm parts (~594 MB). Same fixed-route rules as the other approved games:
// one pinned commit and an exact filename allowlist. No client-chosen host,
// URL, subdirectory or redirect is ever accepted.
const buckshotCommit="f8a263b4da11c181e02e31086e5a5c8bc2dd1457";
const buckshotCdn="https://cdn.jsdelivr.net/gh/Random-Red-Dude-809-4456/buckshot@"+buckshotCommit+"/";
const buckshotRaw="https://raw.githubusercontent.com/Random-Red-Dude-809-4456/buckshot/"+buckshotCommit+"/";
const buckshotRoute="/approved-games/buckshot/";
const buckshotLocalRoot=path.resolve(process.env.BUCKSHOT_LOCAL_DIR||path.join(process.cwd(),"local-games","buckshot"));
const buckshotFiles=new Set([
  "index.html","main.js","style.css","buckshot-roulette.js",
  "buckshot-roulette.icon.png","buckshot-roulette.apple-touch-icon.png",
  "buckshot-roulette.png","buckshot-roulette.audio.worklet.js",
  "buckshot-roulette.audio.position.worklet.js"
]);
function approvedBuckshotFile(req){
 let file;
 try{file=decodeURIComponent(req.params[0]||"");}catch{return null;}
 if(!file)file="index.html";
 // The upstream export is flat: no subdirectories, no separators, no traversal.
 if(file.length>120||file.includes("/")||file.includes("\\")||
    !/^[A-Za-z0-9._-]+$/.test(file))return null;
 if(buckshotFiles.has(file))return file;
 const part=file.match(/^buckshot-roulette\.(pck|wasm)\.part(\d{1,2})$/);
 if(part){
   const lastPart=part[1]==="pck"?17:3;
   if(Number(part[2])>=1&&Number(part[2])<=lastPart)return file;
 }
 return null;
}
function buckshotMime(file){
 const lower=file.toLowerCase();
 if(lower.endsWith(".html"))return "text/html; charset=utf-8";
 if(lower.endsWith(".js"))return "application/javascript; charset=utf-8";
 if(lower.endsWith(".css"))return "text/css; charset=utf-8";
 if(lower.endsWith(".png"))return "image/png";
 return "application/octet-stream";
}
function buckshotLocalPath(file){
 const resolved=path.resolve(buckshotLocalRoot,file);
 if(!resolved.startsWith(buckshotLocalRoot+path.sep))return null;
 return resolved;
}
async function serveBuckshotFile(req,res){
 if(!approvedGameCors(req,res))return;
 const file=approvedBuckshotFile(req);
 if(!file)return res.status(404).type("text/plain").send("Not an approved Buckshot Roulette file");
 const cacheControl=file==="index.html"?"public, max-age=300":"public, max-age=86400, immutable";
 const local=buckshotLocalPath(file);
 if(local&&existsSync(local)){
   res.setHeader("Content-Type",buckshotMime(file));
   res.setHeader("Cache-Control",cacheControl);
   res.setHeader("X-Game-Source","local");
   return res.sendFile(local);
 }
 // jsDelivr answers a byte-range request with an empty 206 body, so ranged reads
 // go straight to GitHub raw, which honours ranges correctly.
 const sources=req.get("Range")
   ?[[buckshotRaw,"github-raw"]]
   :[[buckshotCdn,"jsdelivr"],[buckshotRaw,"github-raw"]];
 for(const [index,[root,source]] of sources.entries()){
   try{
     const headers={"Accept-Encoding":"identity"};
     if(req.get("Range"))headers.Range=req.get("Range");
     const upstream=await fetch(root+file,{
       method:req.method==="HEAD"?"HEAD":"GET",
       redirect:"error",headers,signal:AbortSignal.timeout(180000)
     });
     if(!upstream.ok){
       await upstream.body?.cancel();
       if(index<sources.length-1)continue;
       return res.status(502).type("text/plain")
         .send("Pinned Buckshot Roulette asset unavailable: HTTP "+upstream.status);
     }
     res.status(upstream.status);
     res.setHeader("Content-Type",buckshotMime(file));
     res.setHeader("Cache-Control",cacheControl);
     res.setHeader("X-Game-Source",source);
     if(upstream.headers.get("accept-ranges"))res.setHeader("Accept-Ranges",upstream.headers.get("accept-ranges"));
     if(upstream.headers.get("content-range"))res.setHeader("Content-Range",upstream.headers.get("content-range"));
     if(req.method==="HEAD"||!upstream.body){res.end();return;}
     await pipeline(Readable.fromWeb(upstream.body),res);
     return;
   }catch(error){
     console.warn("Buckshot Roulette asset failed:",source,file,String(error));
     if(res.headersSent){res.destroy();return;}
     if(index===sources.length-1)return res.status(502).type("text/plain")
       .send("The approved Buckshot Roulette game sources are unreachable.");
   }
 }
}
app.get(buckshotRoute+"status",async(req,res)=>{
 if(!approvedGameCors(req,res))return;
 res.setHeader("Cache-Control","no-store");
 const local=buckshotLocalPath("index.html");
 if(local&&existsSync(local))
   return res.json({ok:true,source:"local game folder",note:"Serving the local upstream copy"});
 try{
   const probe=await fetch(buckshotCdn+"index.html",{
     method:"HEAD",redirect:"error",signal:AbortSignal.timeout(15000)
   });
   await probe.body?.cancel();
   if(!probe.ok)
     return res.status(502).json({ok:false,note:"Pinned game entry unavailable (HTTP "+probe.status+")"});
   res.json({ok:true,source:"pinned GitHub upstream",commit:buckshotCommit,parts:20});
 }catch(error){
   console.error("Buckshot Roulette probe failed",String(error));
   res.status(502).json({ok:false,note:"The approved game source could not be reached"});
 }
});
app.get(buckshotRoute+"*",serveBuckshotFile);
app.head(buckshotRoute+"*",serveBuckshotFile);
app.options(buckshotRoute+"*",(req,res)=>{
 if(!approvedGameCors(req,res))return;
 if(!approvedBuckshotFile(req))return res.sendStatus(404);
 res.setHeader("Access-Control-Allow-Methods","GET, HEAD, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Range, Content-Type");
 res.sendStatus(204);
});

app.use("/scram/",express.static(scramjetPath));
app.use("/utils/",express.static(dirOf("@mercuryworkshop/scramjet-utils")));
app.use("/controller/",express.static(dirOf("@mercuryworkshop/scramjet-controller")));
app.use("/libcurl/",express.static(dirOf("@mercuryworkshop/libcurl-transport")));
app.use("/epoxy/",express.static(dirOf("@mercuryworkshop/epoxy-transport")));
// Publish only the frontend entrypoints, not server source or configuration files.
for (const file of ["index.html","proxy-client.js","sw.js","calls.js","calls.css","seuss-search.html","search-client.js"]) {
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
