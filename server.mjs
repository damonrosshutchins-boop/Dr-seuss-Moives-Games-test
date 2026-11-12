import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
const require=createRequire(import.meta.url);
const dirOf=(pkg)=>path.dirname(require.resolve(pkg));
const app=express();
const allowedOrigin=new Set(["https://damonrosshutchins-boop.github.io",...(process.env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean)]);
wisp.options.hostname_whitelist=[/^wasm\.rip$/i,/^([a-z0-9-]+\.)+wasm\.rip$/i,/^shuttletv\.pk$/i,/^([a-z0-9-]+\.)+shuttletv\.pk$/i,/^raw\.githack\.com$/i,/^cdn\.jsdelivr\.net$/i,/^ripjaw1219\.github\.io$/i,/^monoxide\.dev$/i,/^c00lkiddtech\.github\.io$/i,/^linkawaken1979-alt\.github\.io$/i,/^mollomm1\.github\.io$/i,/^sagaofowlz\.github\.io$/i];
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
app.use("/scram/",express.static(scramjetPath));
app.use("/utils/",express.static(dirOf("@mercuryworkshop/scramjet-utils")));
app.use("/controller/",express.static(dirOf("@mercuryworkshop/scramjet-controller")));
app.use("/libcurl/",express.static(dirOf("@mercuryworkshop/libcurl-transport")));
app.use("/epoxy/",express.static(dirOf("@mercuryworkshop/epoxy-transport")));
// Publish only the frontend entrypoints, not server source or configuration files.
for (const file of ["index.html","proxy-client.js","sw.js"]) {
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
