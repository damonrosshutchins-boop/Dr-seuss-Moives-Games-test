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
wisp.options.hostname_whitelist=[/^wasm\.rip$/i,/^([a-z0-9-]+\.)+wasm\.rip$/i,/^shuttletv\.pk$/i,/^([a-z0-9-]+\.)+shuttletv\.pk$/i];
wisp.options.port_whitelist=[80,443];
wisp.options.allow_udp_streams=false;
wisp.options.allow_tcp_streams=true;
wisp.options.allow_direct_ip=false;
wisp.options.allow_private_ips=false;
wisp.options.allow_loopback_ips=false;
wisp.options.stream_limit_total=36;
wisp.options.stream_limit_per_host=12;
app.use((req,res,next)=>{
 res.setHeader("Cross-Origin-Opener-Policy","same-origin");
 res.setHeader("Cross-Origin-Embedder-Policy","require-corp");
 res.setHeader("X-Content-Type-Options","nosniff");
 next();
});
app.get("/health",(req,res)=>res.json({ok:true,service:"seuss-cinema-scramjet-wisp",restricted:true}));
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
